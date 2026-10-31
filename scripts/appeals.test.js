import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-appeals-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function game(t, type = 'simple') {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const players = ['Alice', 'Bob', 'Cara', 'Dan'].map((name, index) => {
    const player = room.join(name).participant;
    room.attach(player.id, `player-${index}`);
    return player;
  });
  const pack = structuredClone(loaded.pack);
  pack.rounds[0].themes[0].questions[0].type = type;
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  room.engine.selectQuestion(host.id, true, 0, 0);
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players, engine: room.engine };
}

function answer(engine, player, correct) {
  if (engine.phase === 'reading') engine.openBuzzer();
  engine.buzz(player.id);
  engine.judge(correct);
}

test('accepted rejection appeal reverses later attempts and returns chooser to answerer', (t) => {
  const { room, host, players: [alice, bob, cara, dan], engine } = game(t);
  const price = engine.current.price;
  engine.chooserId = dan.id;
  answer(engine, alice, false);
  assert.equal(room.snapshotFor(cara.id).game.appeals, null);
  answer(engine, bob, true);
  assert.equal(room.snapshotFor(cara.id).game.appeals.judgments.length, 2);
  assert.throws(() => engine.requestAppeal(bob.id, 1), /Only the answerer/);
  const presentationId = engine.current.presentationId;
  engine.requestAppeal(alice.id, 1);
  assert.equal(engine.canUndoJudgment(), false);
  assert.throws(() => engine.undoJudgment(presentationId, 2), /no verdict to undo/);
  assert.equal(engine.phase, 'appealVote');
  assert.equal(room.snapshotFor(cara.id).game.appeals.active.kind, 'for');
  engine.pause();
  assert.equal(engine.paused.phase, 'appealVote');
  engine.resume();
  assert.throws(() => engine.voteAppeal(alice.id, true), /cannot vote/);
  engine.voteAppeal(bob.id, true);
  engine.voteAppeal(cara.id, true);
  engine.voteAppeal(dan.id, false);
  assert.equal(engine.phase, 'reveal');
  assert.equal(engine.canUndoJudgment(), false, 'a resolved appeal still closes undo');
  assert.equal(alice.score, price);
  assert.equal(bob.score, 0);
  assert.equal(engine.chooserId, alice.id);
  assert.equal(engine.current.judgments[1].voided, true);
  engine.rollbackCurrentScores();
  engine.rollbackCurrentScores();
  assert.equal(alice.score, 0);
  assert.equal(bob.score, 0);
  assert.equal(engine.chooserId, engine.current.chooserBeforeQuestion);
  assert.equal(room.snapshotFor(host.id).game.appeals.active, null);
});

test('acceptance challenge requires four players; ties reject; accepted challenge reverses score', (t) => {
  const { room, players: [alice, bob, cara, dan], engine } = game(t);
  const priorChooser = engine.current.chooserBeforeQuestion;
  const price = engine.current.price;
  answer(engine, alice, true);
  room.detach(dan.id, 'player-3');
  assert.throws(() => engine.requestAppeal(bob.id, 1), /four connected/);
  room.attach(dan.id, 'player-3-reconnect');
  engine.requestAppeal(bob.id, 1);
  engine.voteAppeal(cara.id, true);
  engine.voteAppeal(dan.id, false);
  assert.equal(engine.phase, 'reveal');
  assert.equal(alice.score, price);
  assert.equal(engine.current.judgments[0].appealed, true);
  assert.throws(() => engine.requestAppeal(bob.id, 1), /cannot be appealed/);
  // A second question checks acceptance without relying on a second vote on one verdict.
  engine.next();
  engine.selectQuestion(alice.id, true, 0, 1);
  const secondPrice = engine.current.price;
  answer(engine, alice, true);
  engine.requestAppeal(bob.id, 1);
  engine.voteAppeal(cara.id, true);
  engine.voteAppeal(dan.id, true);
  assert.equal(engine.phase, 'reveal');
  assert.equal(alice.score, price - secondPrice);
  assert.equal(engine.chooserId, engine.current.chooserBeforeQuestion);
  assert.equal(priorChooser !== null, true);
});

test('appeals stay hidden before reveal and respect disabled, no-risk and for-all rules', (t) => {
  const { room, host, players: [alice, bob, cara, dan], engine } = game(t, 'noRisk');
  assert.equal(room.snapshotFor(alice.id).game.appeals, null);
  assert.throws(() => engine.requestAppeal(alice.id, 1), /after the answer/);
  answer(engine, alice, false);
  answer(engine, bob, false);
  answer(engine, cara, false);
  answer(engine, dan, false);
  assert.equal(alice.score, 0);
  room.settings.useApellations = false;
  assert.throws(() => engine.requestAppeal(alice.id, 1), /disabled/);
  room.settings.useApellations = true;
  engine.requestAppeal(alice.id, 1);
  engine.resolveAppeal();
  assert.equal(alice.score, 0); // fixed votes tie unless others support
  assert.equal(engine.current.judgments[0].delta, 0);
  engine.requestAppeal(bob.id, 2);
  engine.voteAppeal(alice.id, true);
  engine.voteAppeal(cara.id, true);
  engine.voteAppeal(dan.id, false);
  assert.equal(bob.score, engine.current.price);
  engine.next();
  engine.selectQuestion(host.id, true, 0, 1);
  assert.equal(engine.current.judgments.length, 0);
});

test('for-all appeal changes only its own score and blank answer is ineligible', (t) => {
  const { players: [alice, bob, cara, dan], engine } = game(t, 'forAll');
  const price = engine.current.price;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'A');
  engine.closeForAllAnswers();
  engine.judgeForAll(alice.id, false);
  engine.judgeForAll(bob.id, false);
  engine.judgeForAll(cara.id, false);
  engine.judgeForAll(dan.id, false);
  assert.throws(() => engine.requestAppeal(bob.id, 2), /blank answer/);
  engine.requestAppeal(alice.id, 1);
  engine.voteAppeal(bob.id, true);
  engine.voteAppeal(cara.id, true);
  engine.voteAppeal(dan.id, true);
  assert.equal(alice.score, price);
  assert.equal(bob.score, -price);
  assert.equal(engine.current.judgments[1].voided, false);
});
