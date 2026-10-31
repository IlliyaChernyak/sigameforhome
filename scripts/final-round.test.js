/** Final themes are replayed one by one when the all-final setting is enabled. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-final-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);
const { markHandoverReady } = await import('../server/game/moderationHandover.ts');
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function finalGame(t, playAll = true) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player');
  const pack = structuredClone(loaded.pack);
  const original = pack.rounds[2].themes[0];
  pack.rounds[2].themes = ['A', 'B', 'C'].map((name) => ({
    ...structuredClone(original), name,
    questions: [structuredClone(original.questions[0]), structuredClone(original.questions[0])],
  }));
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { gameMode: 'classic', playAllQuestionsInFinalRound: playAll });
  room.engine.start();
  player.score = 500;
  room.engine.enterRound(2);
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, player };
}

function finishQuestion(room, host, player) {
  const engine = room.engine;
  engine.setFinalWager(player.id, 100);
  engine.openFinal();
  engine.closeFinal();
  engine.judgeFinal(player.id, true);
  assert.equal(engine.phase, 'reveal');
  engine.next();
}

test('all-final setting plays the first question of each theme after repeated eliminations', (t) => {
  const { room, host, player } = finalGame(t);
  const engine = room.engine;
  assert.equal(engine.phase, 'finalThemes');
  assert.equal(engine.isAvailable(0, 1), false, 'later questions in a final theme are never played');
  engine.removeFinalTheme(host.id, true, 0);
  engine.removeFinalTheme(host.id, true, 1);
  assert.equal(engine.phase, 'finalWager', 'the last theme starts without a one-cell board');
  assert.equal(engine.current.themeIndex, 2);
  finishQuestion(room, host, player);
  assert.equal(engine.phase, 'finalThemes');
  assert.deepEqual([...engine.removedFinalThemes], []);
  assert.equal(engine.isAvailable(2, 0), false);
  assert.equal(engine.isAvailable(2, 1), false);

  engine.removeFinalTheme(host.id, true, 0);
  assert.equal(engine.phase, 'finalWager');
  assert.equal(engine.current.themeIndex, 1);
  finishQuestion(room, host, player);
  assert.equal(engine.phase, 'finalWager', 'last remaining theme starts automatically');
  assert.equal(engine.current.themeIndex, 0);
  finishQuestion(room, host, player);
  assert.equal(engine.phase, 'gameOver');
  assert.equal(player.score, 800);
});

test('default final setting ends after one chosen theme', (t) => {
  const { room, host, player } = finalGame(t, false);
  const engine = room.engine;
  engine.removeFinalTheme(host.id, true, 0);
  engine.removeFinalTheme(host.id, true, 1);
  finishQuestion(room, host, player);
  assert.equal(engine.phase, 'gameOver');
});

test('undo restores a final wager verdict and returns to final judging', (t) => {
  const { room, host, player } = finalGame(t, false);
  const engine = room.engine;
  engine.removeFinalTheme(host.id, true, 0);
  engine.removeFinalTheme(host.id, true, 1);
  const presentationId = engine.current.presentationId;
  engine.setFinalWager(player.id, 200);
  engine.openFinal();
  engine.closeFinal();
  engine.judgeFinal(player.id, true);
  assert.equal(engine.phase, 'reveal');
  assert.equal(player.score, 700);

  engine.undoJudgment(presentationId, 1);
  assert.equal(engine.phase, 'finalJudge');
  assert.equal(player.score, 500);
  assert.equal(engine.current.answerShown, false);
  assert.equal(engine.finalJudged.has(player.id), false);
  assert.equal(room.snapshotFor(player.id).game.current.right, null);
  engine.judgeFinal(player.id, false);
  assert.equal(player.score, 300);
  assert.equal(engine.phase, 'reveal');
});

test('final theme countdown uses its own setting and restarts for each elimination', (t) => {
  const { room, host } = finalGame(t);
  const engine = room.engine;
  room.updateSettings(host.id, { timeForChoosingFinalTheme: 7 });
  engine.enterRound(2);
  assert.equal(engine.timer?.name, 'choosingFinalTheme');
  assert.equal(engine.timer?.durationMs, 7000);
  engine.removeFinalTheme(host.id, true, 0);
  assert.equal(engine.timer?.name, 'choosingFinalTheme');
  assert.equal(engine.timer?.durationMs, 7000);
  engine.removeFinalTheme(host.id, true, 1);
  assert.equal(engine.phase, 'finalWager');
  assert.equal(engine.timer, null);
});

test('unavailable final themes are excluded from elimination and repeat play', (t) => {
  const { room } = finalGame(t);
  room.loadedPack.pack.rounds[2].themes[1].questions[0].price = -1;
  room.engine.enterRound(2);
  assert.deepEqual(room.engine.finalThemeIndices(), [0, 2]);
  assert.equal(room.engine.isAvailable(1, 0), false);
});

test('final theme elimination has no round deadline', (t) => {
  const { room, host } = finalGame(t);
  const engine = room.engine;
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 3 * 60 * 60 * 1000;
  engine.removeFinalTheme(host.id, true, 0);
  assert.deepEqual([...engine.removedFinalThemes], [0]);
});

test('a removed finalist cannot block the reveal', (t) => {
  const { room, host, player } = finalGame(t, false);
  const engine = room.engine;
  engine.removeFinalTheme(host.id, true, 0);
  engine.removeFinalTheme(host.id, true, 1);
  engine.setFinalWager(player.id, 200);
  engine.openFinal();
  room.remove(player.id);
  engine.closeFinal();
  assert.equal(engine.phase, 'reveal');
});

test('a disconnected finalist with no wager does not block reveal', (t) => {
  const { room, host, player } = finalGame(t, false);
  const engine = room.engine;
  engine.removeFinalTheme(host.id, true, 0);
  engine.removeFinalTheme(host.id, true, 1);
  room.detach(player.id, 'player');
  engine.openFinal();
  assert.equal(engine.finalWagers.get(player.id), 0);
  engine.closeFinal();
  assert.equal(engine.phase, 'reveal');
});

test('a submitted final wager remains judgeable after disconnect', (t) => {
  const { room, host, player } = finalGame(t, false);
  const engine = room.engine;
  engine.removeFinalTheme(host.id, true, 0);
  engine.removeFinalTheme(host.id, true, 1);
  engine.setFinalWager(player.id, 200);
  room.detach(player.id, 'player');
  engine.openFinal();
  engine.closeFinal();
  assert.equal(engine.phase, 'finalJudge');
  engine.judgeFinal(player.id, true);
  assert.equal(engine.phase, 'reveal');
  assert.equal(player.score, 700);
});

test('a recovered moderator can see wagers for judging without seeing the answer key', (t) => {
  const { room, host, player } = finalGame(t, false);
  const engine = room.engine;
  engine.removeFinalTheme(host.id, true, 0);
  engine.removeFinalTheme(host.id, true, 1);
  engine.setFinalWager(player.id, 200);
  engine.openFinal();
  engine.closeFinal();
  room.detach(host.id, 'host');
  clearTimeout(room.removalTimers.get(host.id));
  room.expire(host.id);
  // UX-7: the owner-player only takes over after the handover wait.
  assert.equal(room.canModerate(player.id), false);
  markHandoverReady(room, host.id);
  assert.equal(room.canModerate(player.id), true);
  assert.deepEqual(room.snapshotFor(player.id).game.final.wagers, { [player.id]: 200 });
  assert.equal(room.snapshotFor(player.id).game.current.right, null);
});
