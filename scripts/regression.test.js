/** Security and recovery cases that the browser smoke test cannot cover quickly. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-regression-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');

// Config reads environment variables when imported, so create the fixture first.
await import('./make-sample-pack.ts');
const [{ Room }, { listPacks, loadPack }, { persistRoom, restoreRoom }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
  import('../server/game/persistence.ts'),
]);
const { markHandoverReady } = await import('../server/game/moderationHandover.ts');
const file = (await listPacks()).find((pack) => pack.name.includes('v5')).file;
const loaded = await loadPack(file);

after(async () => rm(root, { recursive: true, force: true }));

function createRoom(t, gameMode = 'simple', modifyPack = () => {}) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');
  const spectator = room.join('Spectator').participant;
  room.attach(spectator.id, 'spectator-socket');
  room.setRole(spectator.id, spectator.id, 'spectator');
  // Each test may alter question content or type; keep the shared parsed fixture intact.
  const pack = structuredClone(loaded.pack);
  modifyPack(pack);
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode, timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  // Engine timers keep Node alive after an assertion unless explicitly cleared.
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, player, spectator };
}

test('answer data and media stay private until reveal', (t) => {
  const { room, host, player, spectator } = createRoom(t);
  room.engine.selectQuestion(host.id, true, 0, 1);
  const question = room.engine.current.question;
  const image = question.content.find((item) => item.type === 'image');
  assert.ok(image?.url, 'sample question has an image');
  const answerMedia = { type: 'image', url: `/media/${loaded.packId}/Images/private-answer.png` };
  question.answerContent.push(answerMedia);

  assert.equal(room.snapshotFor(player.id).game.current.right, null);
  assert.equal(room.snapshotFor(player.id).game.current.answerContent, null);
  assert.ok(room.snapshotFor(host.id).game.current.right?.length);
  assert.equal(room.canAccessMedia('', image.url), false);
  assert.equal(room.canAccessMedia('invalid-ticket', image.url), false);
  assert.equal(room.canAccessMedia(player.mediaTicket, image.url), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, answerMedia.url), false);
  assert.equal(room.canAccessMedia(spectator.mediaTicket, answerMedia.url), false);
  assert.equal(room.canAccessMedia(host.mediaTicket, answerMedia.url), true);

  room.engine.revealAnswer();
  assert.ok(room.snapshotFor(player.id).game.current.right?.length);
  assert.equal(room.canAccessMedia(player.mediaTicket, answerMedia.url), true);
});

test('connected player recovers moderation after host grace expires', (t) => {
  const { room, host, player, spectator } = createRoom(t);
  room.detach(host.id, 'host-socket');
  clearTimeout(room.removalTimers.get(host.id));
  room.expire(host.id);

  assert.equal(room.ownerId, player.id);
  assert.equal(room.participants.get(host.id).role, 'host');
  // UX-7: the owner-player only takes over after the handover wait.
  assert.equal(room.canModerate(player.id), false);
  markHandoverReady(room, host.id);
  assert.equal(room.canModerate(player.id), true);
  room.setRole(player.id, host.id, 'spectator');
  room.setRole(player.id, spectator.id, 'host');
  assert.equal(room.canModerate(spectator.id), true);
  assert.equal(room.canModerate(player.id), false);
});

test('a new game waits for a player still within reconnect grace', (t) => {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');
  room.setPack(loaded);
  room.detach(player.id, 'player-socket');
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });

  assert.throws(() => room.engine.start(), /connected player/);
  assert.equal(room.engine.phase, 'lobby');
  assert.equal(room.participants.has(player.id), true, 'the player can still reconnect');
  room.attach(player.id, 'reconnected-socket');
  room.engine.start();
  assert.equal(room.engine.phase, 'board');
  assert.equal(room.engine.activePlayers().length, 1);
});

test('expired in-game seats are released when the game returns to the lobby', (t) => {
  const { room, host, player } = createRoom(t);
  room.updateSettings(host.id, { maxPlayers: 2 });
  const second = room.join('Second').participant;
  room.attach(second.id, 'second-socket');
  const waiting = room.join('Waiting').participant;
  room.attach(waiting.id, 'waiting-socket');
  assert.equal(waiting.role, 'spectator');

  room.detach(player.id, 'player-socket');
  clearTimeout(room.removalTimers.get(player.id));
  room.expire(player.id);
  assert.equal(room.participants.has(player.id), true, 'active games retain departed scores');

  room.engine.stop();
  assert.equal(room.participants.has(player.id), false);
  assert.equal(waiting.role, 'player');
});

test('a new game replaces expired seats with connected waiting spectators', (t) => {
  const { room, host, player } = createRoom(t);
  room.updateSettings(host.id, { maxPlayers: 2 });
  const second = room.join('Second').participant;
  room.attach(second.id, 'second-socket');
  const waiting = room.join('Waiting').participant;
  room.attach(waiting.id, 'waiting-socket');
  room.detach(player.id, 'player-socket');
  clearTimeout(room.removalTimers.get(player.id));
  room.expire(player.id);

  room.engine.finish();
  room.engine.start();
  assert.equal(room.participants.has(player.id), false);
  assert.equal(waiting.role, 'player');
});

test('a disconnected waiting spectator does not take a freed lobby player seat', (t) => {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  room.updateSettings(host.id, { maxPlayers: 2 });
  const players = ['First', 'Second'].map((name) => {
    const p = room.join(name).participant;
    room.attach(p.id, name);
    return p;
  });
  const offline = room.join('Offline').participant;
  room.attach(offline.id, 'offline-socket');
  const online = room.join('Online').participant;
  room.attach(online.id, 'online-socket');
  room.detach(offline.id, 'offline-socket');
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });

  room.remove(players[0].id);
  assert.equal(offline.role, 'spectator');
  assert.equal(online.role, 'player');
  room.remove(players[1].id);
  room.attach(offline.id, 'offline-returned');
  assert.equal(offline.role, 'player');
});

test('display-only TV never inherits a freed player seat', (t) => {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.join('Second player');
  const tv = room.join('TV', true).participant;
  room.updateSettings(host.id, { maxPlayers: 2 });
  room.remove(player.id);
  assert.equal(tv.role, 'spectator');
  assert.equal(tv.displayOnly, true);
  assert.equal(room.players().length, 1);
  t.after(() => room.engine.reset());
});

test('guided secret questions assign one player and use the chosen value', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  room.engine.selectQuestion(host.id, true, 0, 2);
  assert.equal(room.engine.phase, 'specialSetup');
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  room.engine.configureSpecial(player.id, 200);
  assert.equal(room.engine.phase, 'reading');
  assert.equal(room.engine.buzz(player.id).result, 'ignored');
  room.engine.openBuzzer();
  assert.equal(room.engine.buzzer.winnerId, player.id);
  room.engine.judge(false);
  assert.equal(player.score, -200);
});

test('secret assignment countdown uses its setting and stops when a recipient is chosen', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  room.updateSettings(host.id, { timeForGivingACat: 9 });
  room.engine.selectQuestion(host.id, true, 0, 2);
  assert.equal(room.engine.timer?.name, 'givingCat');
  assert.equal(room.engine.timer?.durationMs, 9000);
  room.engine.pause();
  room.engine.resume();
  assert.equal(room.engine.timer?.name, 'givingCat');
  room.engine.configureSpecial(player.id, 200);
  assert.equal(room.engine.phase, 'reading');
  assert.equal(room.engine.timer?.name, 'reading');
});

test('a chosen secret value cannot overflow the recipient score', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  player.score = Number.MAX_SAFE_INTEGER;
  room.engine.selectQuestion(host.id, true, 0, 2);
  assert.throws(() => room.engine.configureSpecial(player.id, 200), /safe score/);
  assert.equal(room.engine.phase, 'specialSetup');
  assert.equal(player.score, Number.MAX_SAFE_INTEGER);
});

test('no-risk question never subtracts points for a wrong answer', (t) => {
  const { room, host, player } = createRoom(t, 'classic', (pack) => {
    pack.rounds[0].themes[0].questions[0].type = 'noRisk';
  });
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  assert.equal(room.engine.buzz(player.id).result, 'accepted');
  room.engine.judge(false);
  assert.equal(player.score, 0);
});

test('secret without a question awards fixed points without exposing content', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  room.engine.selectQuestion(host.id, true, 0, 3);
  assert.equal(room.engine.phase, 'specialSetup');
  const hiddenMedia = { type: 'image', url: `/media/${loaded.packId}/Images/hidden-gift.png` };
  room.engine.current.question.content.push(hiddenMedia);
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  assert.throws(() => room.engine.configureSpecial(player.id, 401), /Value must be/);
  room.engine.configureSpecial(player.id, 400);
  assert.equal(room.engine.phase, 'reveal');
  assert.equal(player.score, 400);
  assert.equal(room.snapshotFor(player.id).game.current.assignedId, player.id);
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  assert.equal(room.snapshotFor(host.id).game.current.right, null);
  assert.equal(room.canAccessMedia(player.mediaTicket, hiddenMedia.url), false);
  room.engine.next();
  assert.equal(room.engine.phase, 'board');
});

test('final wagers stay private and scoring follows each wager', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  room.adjustScore(host.id, player.id, 500);
  room.engine.enterRound(2);
  // A single final theme skips the board and opens wagers directly.
  assert.equal(room.engine.phase, 'finalWager');
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  assert.throws(() => room.engine.openFinal(), /every finalist/);

  room.engine.setFinalWager(player.id, 300);
  assert.equal(room.snapshotFor(player.id).game.final.yourWager, 300);
  assert.equal(room.snapshotFor(player.id).game.final.wagers, null);
  assert.equal(room.snapshotFor(host.id).game.final.wagers, null);
  room.engine.openFinal();
  assert.equal(room.snapshotFor(player.id).game.current.right, null);
  room.engine.closeFinal();
  assert.deepEqual(room.snapshotFor(host.id).game.final.wagers, { [player.id]: 300 });
  room.engine.judgeFinal(player.id, true);
  assert.equal(player.score, 800);
  assert.ok(room.snapshotFor(player.id).game.current.right?.length);
});

test('restart preserves seats and replays an interrupted question', async (t) => {
  const { room, host, player } = createRoom(t);
  const flush = persistRoom(room);
  room.engine.selectQuestion(host.id, true, 0, 1);
  room.changed();
  // Shutdown must save even when the normal 250 ms debounce has not fired.
  await flush();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 1), true);
  assert.equal(restored.participants.get(player.id).connected, false);
  assert.equal(restored.participants.get(host.id).role, 'host');
  restored.attach(player.id, 'reconnected-player');
  // CONN-4: the restored owner is in reconnect grace, so reconnecting first must not take ownership.
  assert.equal(restored.ownerId, host.id);
  assert.ok(restored.removalTimers.has(host.id));
  // Once the owner's grace runs out, the connected player inherits ownership and moderation.
  clearTimeout(restored.removalTimers.get(host.id));
  restored.expire(host.id);
  assert.equal(restored.ownerId, player.id);
  // UX-7: the restored host is offline, so moderation waits for the handover too.
  assert.equal(restored.canModerate(player.id), false);
  markHandoverReady(restored, host.id);
  assert.equal(restored.canModerate(player.id), true);
});

test('restart rolls back partial scoring before replaying a question', async (t) => {
  const { room, host, player } = createRoom(t);
  const second = room.join('Second player').participant;
  room.attach(second.id, 'second-player');
  const stateFile = path.join(root, 'partial-score-state.json');
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  room.engine.buzz(player.id);
  room.engine.judge(false);
  assert.equal(room.engine.phase, 'buzzerOpen');
  assert.ok(player.score < 0);
  await persistRoom(room, stateFile)();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 0), true);
  assert.equal(restored.participants.get(player.id).score, 0);
});

test('restart during an appeal vote replays the question without its old penalty', async (t) => {
  const { room, host, player } = createRoom(t);
  const second = room.join('Second player').participant;
  room.attach(second.id, 'second-player');
  const stateFile = path.join(root, 'appeal-state.json');
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  room.engine.buzz(player.id);
  room.engine.judge(false);
  room.engine.revealAnswer();
  room.engine.requestAppeal(player.id, 1);
  assert.equal(room.engine.phase, 'appealVote');
  await persistRoom(room, stateFile)();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 0), true);
  assert.equal(restored.participants.get(player.id).score, 0);
});

test('restart preserves seats and scores when the selected pack is missing', async (t) => {
  const { room, host, player } = createRoom(t);
  const stateFile = path.join(root, 'missing-pack-state.json');
  room.adjustScore(host.id, player.id, 300);
  await persistRoom(room, stateFile)();
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  saved.packFile = 'removed-pack.siq';
  await writeFile(stateFile, JSON.stringify(saved));

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.loadedPack, null);
  assert.equal(restored.engine.phase, 'lobby');
  assert.equal(restored.participants.get(player.id).score, 300);
  assert.equal(restored.participants.get(host.id).role, 'host');
  restored.attach(player.id, 'reconnected-player');
  // CONN-4: ownership waits for the restored owner's grace, as in the replay test above.
  assert.equal(restored.ownerId, host.id);
  assert.ok(restored.removalTimers.has(host.id));
  clearTimeout(restored.removalTimers.get(host.id));
  restored.expire(host.id);
  // The saved game was not in the lobby, so the seat survives the lobby fallback ('keep' mode).
  assert.equal(restored.participants.get(host.id).role, 'host');
  assert.equal(restored.participants.get(player.id).score, 300);
  assert.equal(restored.ownerId, player.id);
  markHandoverReady(restored, host.id);
  assert.equal(restored.canModerate(player.id), true);
});

test('restart replays an interrupted stake auction from the board', async (t) => {
  const { room, host } = createRoom(t, 'classic');
  const stateFile = path.join(root, 'auction-state.json');
  const flush = persistRoom(room, stateFile);
  room.engine.selectQuestion(host.id, true, 0, 4);
  assert.equal(room.engine.phase, 'stakeAuction');
  room.engine.pause();
  await flush();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'paused');
  restored.engine.resume();
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 4), true);
});

test('restart fits saved settings to the current limits and drops retired ones', async (t) => {
  const { room } = createRoom(t);
  const stateFile = path.join(root, 'old-settings-state.json');
  await persistRoom(room, stateFile)();
  // A save from before the 2026-10-31 timer limits, with the retired round clock.
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  Object.assign(saved.settings, { timeForThinkingOnQuestion: 1, timeForBlockingButton: 30,
    timeForPrintingAnswer: 300, readingSpeed: 'fast', timeOfRound: 660 });
  await writeFile(stateFile, JSON.stringify(saved));

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.settings.timeForThinkingOnQuestion, 3);
  assert.equal(restored.settings.timeForBlockingButton, 10);
  assert.equal(restored.settings.timeForPrintingAnswer, 120);
  assert.equal(restored.settings.readingSpeed, 20);
  assert.equal('timeOfRound' in restored.settings, false);
});

// Rounds have no clock: only an empty board or the host's Next ends one.
test('restart keeps a paused round paused, and no clock ends it after resume', async (t) => {
  const { room } = createRoom(t);
  const stateFile = path.join(root, 'paused-round-state.json');
  room.engine.pause();
  await persistRoom(room, stateFile)();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'paused');
  assert.equal(restored.engine.paused?.phase, 'board');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(restored.engine.phase, 'paused');
  restored.engine.resume();
  assert.equal(restored.engine.phase, 'board');
  assert.equal('roundEndsAt' in restored.engine.getView(null, true), false);
});

test('a round with questions left never ends on time, however long it runs', (t) => {
  const { room, host } = createRoom(t);
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  // Hours pass between picks; the old 11-minute round clock would have ended the round.
  Date.now = () => realNow() + 3 * 60 * 60 * 1000;
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.next();
  assert.equal(room.engine.phase, 'board');
  assert.equal(room.engine.roundHasQuestionsLeft(), true);
});

test('restart replays an interrupted for-all answer session from the board', async (t) => {
  const { room, host } = createRoom(t, 'classic', (pack) => {
    pack.rounds[0].themes[0].questions[0].type = 'forAll';
  });
  const stateFile = path.join(root, 'for-all-state.json');
  const flush = persistRoom(room, stateFile);
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openForAllAnswers();
  assert.equal(room.engine.phase, 'forAllAnswering');
  await flush();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 0), true);
});

test('when everyone is wrong the answer is shown and the board returns on its own', (t) => {
  const { room, host, player, spectator } = createRoom(t);
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  room.engine.buzz(player.id);
  room.engine.judge(false);

  assert.equal(room.engine.phase, 'reveal');
  assert.equal(room.engine.current.answerShown, true);
  assert.ok(room.snapshotFor(player.id).game.current.right?.length);
  assert.ok(room.snapshotFor(spectator.id).game.current.right?.length);
  assert.equal(room.engine.timer?.name, 'reveal');

  room.engine.next();
  room.engine.selectQuestion(host.id, true, 0, 1);
  room.engine.openBuzzer();
  room.engine.buzz(player.id);
  room.engine.judge(true);

  assert.equal(room.engine.phase, 'reveal');
  assert.equal(room.engine.current.answerShown, true);
  assert.ok(room.snapshotFor(player.id).game.current.right?.length);
  assert.equal(room.engine.timer?.name, 'reveal');
});

test('host can navigate to nextRound and prevRound from any active game phase', (t) => {
  const { room, host } = createRoom(t);
  assert.equal(room.engine.roundIndex, 0);
  assert.throws(() => room.engine.prevRound(), /first round/);

  room.engine.nextRound();
  assert.equal(room.engine.roundIndex, 1);
  assert.equal(room.engine.phase, 'board');

  room.engine.prevRound();
  assert.equal(room.engine.roundIndex, 0);
  assert.equal(room.engine.phase, 'board');
});
