/** Active game seats must not leave stale chooser or auction assignments. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-engine-recovery-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function game(t) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const players = ['Alice', 'Bob', 'Carol'].map((name, i) => {
    const p = room.join(name).participant;
    room.attach(p.id, `player-${i}`);
    return p;
  });
  room.setPack({ ...loaded, pack: structuredClone(loaded.pack) });
  // These cases check reading timers directly, so skip the chosen-cell intro.
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  players.forEach((p) => { p.score = 600; });
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players };
}

test('a removed answerer does not become the next chooser', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  assert.equal(engine.phase, 'answering');
  room.remove(alice.id);
  engine.judge(true);
  engine.next();
  assert.equal(engine.chooserId, bob.id);
  engine.selectQuestion(bob.id, false, 0, 1);
  assert.equal(engine.phase, 'reading');
});

test('undo restores the latest regular verdict and rejects stale or advanced questions', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  const chooser = engine.chooserId;
  const presentationId = engine.current.presentationId;
  engine.judge(false);
  assert.equal(alice.score, 500);
  assert.equal(engine.phase, 'buzzerOpen');
  assert.equal(engine.buzzer.attempted.has(alice.id), true);
  assert.equal(room.snapshotFor(bob.id).game.undoJudgment, null);
  assert.deepEqual(room.snapshotFor(host.id).game.undoJudgment,
    { presentationId, judgmentId: 1, playerId: alice.id });
  assert.throws(() => engine.undoJudgment('stale', 1), /verdict has changed/);
  assert.deepEqual(engine.undoJudgment(presentationId, 1), { playerId: alice.id, delta: 100 });
  assert.equal(alice.score, 600);
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, alice.id);
  assert.equal(engine.buzzer.attempted.has(alice.id), false);
  assert.equal(engine.timer?.name, 'answering');
  assert.equal(engine.current.judgments.length, 0);
  assert.equal(engine.chooserId, chooser);

  engine.judge(true);
  assert.equal(engine.phase, 'reveal');
  assert.equal(engine.current.answerShown, true);
  assert.equal(alice.score, 700);
  assert.throws(() => engine.undoJudgment(presentationId, 1), /verdict has changed/);
  engine.undoJudgment(presentationId, 2);
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.current.answerShown, false);
  assert.equal(alice.score, 600);
  assert.equal(engine.chooserId, chooser);
  engine.judge(true);
  engine.next();
  assert.throws(() => engine.undoJudgment(presentationId, 1), /no verdict to undo/);
});

test('written answers are private, single-use, and survive a socket reconnect', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.stop();
  room.updateSettings(host.id, { oral: false });
  engine.start();
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);

  assert.throws(() => engine.judge(true), /Wait for the written answer/);
  assert.throws(() => engine.submitAnswer(bob.id, 'steal'), /current answerer/);
  assert.throws(() => engine.submitAnswer(alice.id, ' '.repeat(351)), /1–350/);
  engine.submitAnswer(alice.id, '  Paris  ');
  assert.throws(() => engine.submitAnswer(alice.id, 'London'), /already submitted|time has ended/i);
  assert.deepEqual(room.snapshotFor(host.id).game.buzzer.typedAnswer,
    { text: 'Paris', submitted: true, closed: true });
  assert.deepEqual(room.snapshotFor(bob.id).game.buzzer.typedAnswer,
    { text: null, submitted: true, closed: true });
  room.detach(alice.id, 'player-0');
  room.attach(alice.id, 'replacement');
  assert.equal(room.snapshotFor(alice.id).game.buzzer.typedAnswer.text, 'Paris');
  assert.throws(() => room.updateSettings(host.id, { oral: true }), /before starting/);
  engine.judge(true);
  assert.equal(alice.score, 100);
});

test('written answer deadline closes input but leaves the host verdict open', async (t) => {
  const { room, host, players: [alice] } = game(t);
  const engine = room.engine;
  engine.stop();
  room.updateSettings(host.id, { oral: false });
  // Below the 5 s host minimum, set directly so the deadline passes quickly.
  room.settings.timeForPrintingAnswer = 1;
  engine.start();
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  await delay(1050);
  assert.equal(engine.phase, 'answering');
  assert.equal(room.snapshotFor(alice.id).game.buzzer.typedAnswer.closed, true);
  assert.throws(() => engine.submitAnswer(alice.id, 'too late'), /time has ended/);
  engine.judge(false);
  assert.equal(alice.score, -100);
});

test('pausing a written answer keeps its remaining submission time', async (t) => {
  const { room, host, players: [alice] } = game(t);
  const engine = room.engine;
  engine.stop();
  room.updateSettings(host.id, { oral: false });
  // Below the 5 s host minimum, set directly so the deadline passes quickly.
  room.settings.timeForPrintingAnswer = 1;
  engine.start();
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  engine.pause();
  await delay(1050);
  engine.resume();
  assert.equal(room.snapshotFor(alice.id).game.buzzer.typedAnswer.closed, false);
  engine.submitAnswer(alice.id, 'still open');
  assert.equal(room.snapshotFor(host.id).game.buzzer.typedAnswer.text, 'still open');
});

test('oral answers reject typed submissions', (t) => {
  const { room, host, players: [alice] } = game(t);
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  assert.equal(room.snapshotFor(alice.id).game.buzzer.typedAnswer, null);
  assert.throws(() => engine.submitAnswer(alice.id, 'Paris'), /Written answers are disabled/);
});

test('waitForFinish media advances only from the current presentation acknowledgment', (t) => {
  const { room, host } = game(t);
  const engine = room.engine;
  const questions = room.loadedPack.pack.rounds[0].themes[0].questions;
  questions[0].content = [{ type: 'video', value: 'clip', waitForFinish: true }];
  engine.selectQuestion(host.id, true, 0, 0);
  const firstId = room.snapshotFor(host.id).game.current.presentationId;
  assert.equal(engine.phase, 'reading');
  assert.equal(engine.timer, null);
  assert.deepEqual(engine.contentFinished('stale'), { advanced: false });
  engine.pause();
  assert.deepEqual(engine.contentFinished(firstId), { advanced: false });
  engine.resume();
  assert.equal(engine.timer, null);
  assert.deepEqual(engine.contentFinished(firstId), { advanced: true });
  assert.equal(engine.phase, 'buzzerOpen');
  assert.deepEqual(engine.contentFinished(firstId), { advanced: false });
  engine.next();
  questions[1].content = [{ type: 'audio', value: 'next', waitForFinish: true }];
  engine.selectQuestion(host.id, true, 0, 1);
  assert.notEqual(engine.current.presentationId, firstId);
  assert.deepEqual(engine.contentFinished(firstId), { advanced: false });
  assert.equal(engine.phase, 'reading');
  engine.openBuzzer();
  assert.equal(engine.phase, 'buzzerOpen', 'manual host opening still works');
});

test('ordinary media keeps its reading timer but opens buzzers early once the clip ends; for-all wait media opens answer slots', (t) => {
  const { room, host } = game(t);
  const engine = room.engine;
  const questions = room.loadedPack.pack.rounds[0].themes[0].questions;
  questions[0].content = [{ type: 'audio', value: 'short', waitForFinish: false, duration: 1 }];
  engine.selectQuestion(host.id, true, 0, 0);
  assert.equal(engine.timer?.name, 'reading');
  assert.deepEqual(engine.contentFinished(engine.current.presentationId), { advanced: true });
  assert.equal(engine.phase, 'buzzerOpen');
  engine.next();
  questions[1].type = 'forAll';
  questions[1].content = [{ type: 'audio', value: 'long', waitForFinish: true }];
  engine.selectQuestion(host.id, true, 0, 1);
  assert.equal(engine.timer, null);
  assert.deepEqual(engine.contentFinished(engine.current.presentationId), { advanced: true });
  assert.equal(engine.phase, 'forAllAnswering');
  assert.equal(engine.timer?.name, 'forAll');
});

test('false-start-off questions can buzz during waiting media without an estimated auto-open', (t) => {
  const { room, host, players: [alice] } = game(t);
  room.updateSettings(host.id, { falseStart: false });
  const engine = room.engine;
  const questions = room.loadedPack.pack.rounds[0].themes[0].questions;
  questions[0].content = [{ type: 'video', value: 'clip', waitForFinish: true }];
  engine.selectQuestion(host.id, true, 0, 0);
  assert.equal(engine.phase, 'reading');
  assert.equal(engine.timer, null);
  assert.equal(engine.buzz(alice.id).result, 'accepted');
  assert.equal(engine.phase, 'answering');
  assert.deepEqual(engine.contentFinished(engine.current.presentationId), { advanced: false });
});

test('reading estimate includes each configured media start delay', (t) => {
  const { room, host } = game(t);
  room.updateSettings(host.id, { timeForMediaDelay: 2 });
  const question = room.loadedPack.pack.rounds[0].themes[0].questions[0];
  question.content = [
    { type: 'audio', duration: 1, waitForFinish: false },
    { type: 'video', duration: 1, waitForFinish: false },
  ];
  assert.equal(room.engine.estimateReadingSeconds(question), 6);
  question.content = [{ type: 'text', value: 'Hi' }];
  assert.equal(room.engine.estimateReadingSeconds(question), 1);
});

test('a reseated stake bidder cannot keep the turn or win the question', (t) => {
  const { room, host, players: [alice, bob, carol] } = game(t);
  const engine = room.engine;
  engine.chooserId = alice.id;
  engine.selectQuestion(host.id, true, 0, 4);
  engine.bidStake(alice.id, 500);
  assert.equal(engine.auctionTurnId(), bob.id);
  room.setRole(host.id, bob.id, 'spectator');
  assert.equal(engine.auctionTurnId(), carol.id);
  room.setRole(host.id, alice.id, 'spectator');
  engine.passStake(carol.id);
  assert.equal(engine.phase, 'reveal');
  assert.equal(engine.current.assignedId, null);
});

test('removing the current stake bidder advances immediately', (t) => {
  const { room, host, players: [alice, bob, carol] } = game(t);
  const engine = room.engine;
  engine.chooserId = alice.id;
  engine.selectQuestion(host.id, true, 0, 4);
  assert.equal(engine.auctionTurnId(), alice.id);
  room.remove(alice.id);
  assert.equal(engine.auctionTurnId(), bob.id);
  engine.passStake(bob.id);
  engine.passStake(carol.id);
  assert.equal(engine.phase, 'reveal');
});

test('a queued press before the buzzer deadline is accepted when its random window ends later', async (t) => {
  const { room, host, players: [alice] } = game(t);
  room.updateSettings(host.id, {
    buttonPressMode: 'randomWithinInterval',
    buttonPressIntervalMs: 1000,
  });
  // Below the 3 s host minimum, set directly so the deadline passes quickly.
  room.settings.timeForThinkingOnQuestion = 1;
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  assert.equal(engine.buzz(alice.id).result, 'queued');
  await delay(1100);
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, alice.id);
  assert.equal(engine.buzzer.remainingMs, 1000);
});

test('timestamp-synced presses retain their ordering when the buzzer deadline ends the collection window', async (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  room.updateSettings(host.id, {
    buzzSyncMode: 'clientTimestamp',
    buzzSyncWindowMs: 500,
  });
  // Below the 3 s host minimum, set directly so the deadline cuts the window short.
  room.settings.timeForThinkingOnQuestion = 1;
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  const openedAt = engine.buzzer.openedAt;
  // The window opens at 650 ms and the 1 s deadline cuts it short. Presses arrive 200-250 ms after
  // they were made: inside the 500 ms a player clock is trusted (audit SEC-4 narrowed this from
  // 2 s), with room for timer lag under a parallel test run, so their order still decides the winner.
  await delay(650);
  assert.equal(engine.buzz(alice.id, { clientAt: openedAt + 450 }).result, 'queued');
  assert.equal(engine.buzz(bob.id, { clientAt: openedAt + 400 }).result, 'queued');
  await delay(450);
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, bob.id);
  assert.equal(engine.buzzer.winnerInfo.mode, 'clientTimestamp');
  assert.equal(engine.buzzer.winnerInfo.contenders, 2);
});

test('a repeated press does not create an untracked buzzer collection timer', (t) => {
  for (const mode of ['randomWithinInterval', 'clientTimestamp']) {
    const { room, host, players: [alice] } = game(t);
    room.updateSettings(host.id, mode === 'randomWithinInterval'
      ? { buttonPressMode: mode, buttonPressIntervalMs: 1000 }
      : { buzzSyncMode: mode, buzzSyncWindowMs: 500 });
    const engine = room.engine;
    engine.selectQuestion(host.id, true, 0, 0);
    engine.openBuzzer();
    assert.equal(engine.buzz(alice.id, { clientAt: Date.now() }).result, 'queued');
    const firstWindow = engine.buzzWindowHandle;
    assert.ok(firstWindow);
    assert.equal(engine.buzz(alice.id, { clientAt: Date.now() }).result, 'queued');
    assert.equal(engine.buzzWindowHandle, firstWindow, `${mode} must retain its first timer`);
  }
});

test('queued presses keep their collection mode if settings change before resolution', async (t) => {
  for (const initialMode of ['randomWithinInterval', 'clientTimestamp']) {
    const { room, host, players: [alice, bob] } = game(t);
    room.updateSettings(host.id, initialMode === 'randomWithinInterval'
      ? { buttonPressMode: initialMode, buttonPressIntervalMs: 30 }
      : { buzzSyncMode: initialMode, buzzSyncWindowMs: 30 });
    const engine = room.engine;
    engine.selectQuestion(host.id, true, 0, 0);
    engine.openBuzzer();
    assert.equal(engine.buzz(alice.id, { clientAt: Date.now() }).result, 'queued');
    room.updateSettings(host.id, initialMode === 'randomWithinInterval'
      ? { buttonPressMode: 'firstWins', buzzSyncMode: 'clientTimestamp' }
      : { buttonPressMode: 'randomWithinInterval' });
    assert.equal(engine.buzz(bob.id, { clientAt: Date.now() }).result, 'queued');
    assert.equal(engine.phase, 'buzzerOpen');
    await delay(45);
    assert.equal(engine.phase, 'answering');
    assert.equal(engine.buzzer.winnerInfo.mode,
      initialMode === 'randomWithinInterval' ? 'random' : 'clientTimestamp');
  }
});

test('pausing a queued buzzer press preserves the remaining collection window', async (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  room.updateSettings(host.id, { buzzSyncMode: 'clientTimestamp', buzzSyncWindowMs: 80 });
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  const openedAt = engine.buzzer.openedAt;
  assert.equal(engine.buzz(alice.id, { clientAt: openedAt + 40 }).result, 'queued');
  engine.pause();
  await delay(100);
  assert.equal(engine.phase, 'paused');
  engine.resume();
  assert.equal(engine.phase, 'buzzerOpen');
  assert.equal(engine.buzz(bob.id, { clientAt: openedAt + 20 }).result, 'queued');
  await delay(100);
  assert.equal(engine.buzzer.winnerId, alice.id);
  assert.equal(engine.buzzer.winnerInfo.contenders, 2);
});

test('resumed buzzer deadline honors a press queued before its collection window ends', async (t) => {
  const { room, host, players: [alice] } = game(t);
  room.updateSettings(host.id, { buzzSyncMode: 'clientTimestamp', buzzSyncWindowMs: 80 });
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer(0.03);
  assert.equal(engine.buzz(alice.id, { clientAt: Date.now() }).result, 'queued');
  engine.pause();
  engine.resume();
  const deadline = Date.now() + 500;
  while (engine.phase === 'buzzerOpen' && Date.now() < deadline) await delay(10);
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, alice.id);
});

test('a disconnected queued buzzer cannot beat a connected player', async (t) => {
  for (const mode of ['randomWithinInterval', 'clientTimestamp']) {
    const { room, host, players: [alice, bob] } = game(t);
    room.updateSettings(host.id, mode === 'randomWithinInterval'
      ? { buttonPressMode: mode, buttonPressIntervalMs: 30 }
      : { buzzSyncMode: mode, buzzSyncWindowMs: 30 });
    const engine = room.engine;
    engine.selectQuestion(host.id, true, 0, 0);
    engine.openBuzzer();
    assert.equal(engine.buzz(alice.id).result, 'queued');
    room.detach(alice.id, 'player-0');
    assert.equal(engine.buzz(bob.id).result, 'queued');
    await delay(45);
    assert.equal(engine.phase, 'answering');
    assert.equal(engine.buzzer.winnerId, bob.id);
  }
});

test('a disconnected queued buzzer leaves no winner at the deadline', async (t) => {
  const { room, host, players: [alice] } = game(t);
  room.updateSettings(host.id, { buttonPressMode: 'randomWithinInterval', buttonPressIntervalMs: 80 });
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer(0.03);
  assert.equal(engine.buzz(alice.id).result, 'queued');
  room.detach(alice.id, 'player-0');
  const deadline = Date.now() + 500;
  while (engine.phase === 'buzzerOpen' && Date.now() < deadline) await delay(10);
  assert.equal(engine.phase, 'reveal');
  assert.equal(engine.buzzer.winnerId, null);
});
