/** Guided for-all answers stay private until the host judges each player. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-for-all-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);
const { markHandoverReady } = await import('../server/game/moderationHandover.ts');
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function game(t) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const players = ['Alice', 'Bob'].map((name, i) => {
    const p = room.join(name).participant;
    room.attach(p.id, `player-${i}`);
    return p;
  });
  const pack = structuredClone(loaded.pack);
  pack.rounds[0].themes[0].questions[0].type = 'forAll';
  pack.rounds[0].themes[0].questions[1].type = 'forAll';
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  room.engine.selectQuestion(host.id, true, 0, 0);
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players };
}

test('all players submit privately; host judges fixed-price answers separately', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  const price = engine.current.price;
  assert.equal(engine.phase, 'reading');
  assert.throws(() => engine.openBuzzer(), /do not use buttons/);
  engine.openForAllAnswers();
  assert.equal(engine.phase, 'forAllAnswering');
  assert.throws(() => engine.revealAnswer(), /Judge every for-all/);
  engine.submitForAllAnswer(alice.id, 'First answer');
  assert.equal(room.snapshotFor(alice.id).game.forAll.yourAnswer, 'First answer');
  assert.equal(room.snapshotFor(bob.id).game.forAll.yourAnswer, null);
  assert.equal(room.snapshotFor(host.id).game.forAll.answers, null);
  assert.throws(() => engine.submitForAllAnswer(alice.id, 'Second'), /already submitted/);
  engine.submitForAllAnswer(bob.id, 'Other answer');
  assert.equal(engine.phase, 'forAllJudge');
  assert.deepEqual(room.snapshotFor(host.id).game.forAll.answers,
    { [alice.id]: 'First answer', [bob.id]: 'Other answer' });
  assert.equal(room.snapshotFor(alice.id).game.forAll.answers, null);
  room.detach(host.id, 'host');
  clearTimeout(room.removalTimers.get(host.id));
  room.expire(host.id);
  // UX-7: the owner-player only takes over after the handover wait.
  assert.equal(room.canModerate(alice.id), false);
  markHandoverReady(room, host.id);
  assert.equal(room.canModerate(alice.id), true);
  assert.deepEqual(room.snapshotFor(alice.id).game.forAll.answers,
    { [alice.id]: 'First answer', [bob.id]: 'Other answer' });
  assert.equal(room.snapshotFor(alice.id).game.current.right, null);
  engine.judgeForAll(alice.id, true);
  engine.judgeForAll(bob.id, false);
  assert.equal(alice.score, price);
  assert.equal(bob.score, -price);
  assert.equal(engine.phase, 'reveal');
  engine.next();
  assert.equal(engine.forAll, null);
});

test('undo restores for-all judging slots and hides a revealed answer', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'First');
  engine.submitForAllAnswer(bob.id, 'Second');
  const presentationId = engine.current.presentationId;
  engine.judgeForAll(alice.id, true);
  engine.judgeForAll(bob.id, false);
  assert.equal(engine.phase, 'reveal');
  assert.equal(engine.current.answerShown, true);
  assert.equal(alice.score, 100);
  assert.equal(bob.score, -100);

  engine.undoJudgment(presentationId, 2);
  assert.equal(engine.phase, 'forAllJudge');
  assert.equal(engine.current.answerShown, false);
  assert.equal(bob.score, 0);
  assert.deepEqual([...engine.forAll.judged], [alice.id]);
  assert.equal(room.snapshotFor(bob.id).game.current.right, null);
  engine.undoJudgment(presentationId, 1);
  assert.equal(alice.score, 0);
  assert.deepEqual([...engine.forAll.judged], []);
  engine.judgeForAll(alice.id, false);
  assert.equal(alice.score, -100);
});

test('timeout leaves blanks to judge; pause and skip keep answers hidden', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.pause();
  assert.equal(engine.paused.phase, 'reading');
  engine.resume();
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'Known');
  engine.pause();
  assert.equal(engine.paused.phase, 'forAllAnswering');
  assert.equal(room.snapshotFor(bob.id).game.forAll.yourAnswer, null);
  engine.resume();
  engine.closeForAllAnswers();
  assert.equal(room.snapshotFor(host.id).game.forAll.answers[bob.id], '');
  engine.judgeForAll(alice.id, true);
  engine.judgeForAll(bob.id, true);
  assert.equal(bob.score, -engine.current.price);
  assert.equal(engine.phase, 'reveal');
});

test('wrong answers respect ignoreWrong, and host may skip before judging', (t) => {
  const { room, host, players: [alice] } = game(t);
  const engine = room.engine;
  room.settings.ignoreWrong = true;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'Guess');
  engine.closeForAllAnswers();
  engine.judgeForAll(alice.id, false);
  assert.equal(alice.score, 0);
  engine.next();
  assert.equal(engine.phase, 'board');
  room.engine.selectQuestion(host.id, true, 0, 1);
  assert.equal(engine.phase, 'reading');
  engine.next();
  assert.equal(engine.phase, 'board');
  assert.equal(engine.forAll, null);
});

test('answer timer closes collection without exposing other players answers', async (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  room.settings.timeForThinkingOnSpecial = 0.01;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'Private');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(engine.phase, 'forAllJudge');
  assert.equal(room.snapshotFor(bob.id).game.forAll.answers, null);
  assert.equal(room.snapshotFor(host.id).game.forAll.answers[alice.id], 'Private');
  assert.equal(room.snapshotFor(host.id).game.forAll.answers[bob.id], '');
});

test('removed player cannot block judging or reveal', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'Answer');
  room.remove(bob.id);
  assert.equal(engine.phase, 'forAllJudge');
  assert.deepEqual(Object.keys(room.snapshotFor(host.id).game.forAll.answers), [alice.id]);
  engine.judgeForAll(alice.id, true);
  assert.equal(engine.phase, 'reveal');
});

test('disconnecting the last unanswered player closes collection without exposing answers', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'Private answer');
  room.detach(bob.id, 'player-1');
  assert.equal(engine.phase, 'forAllJudge');
  assert.equal(room.snapshotFor(alice.id).game.forAll.answers, null);
  assert.deepEqual(room.snapshotFor(host.id).game.forAll.answers,
    { [alice.id]: 'Private answer', [bob.id]: '' });
});

test('reseating the last unanswered player closes collection', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'Answer');
  room.setRole(host.id, bob.id, 'spectator');
  assert.equal(engine.phase, 'forAllJudge');
  engine.judgeForAll(alice.id, true);
  assert.equal(engine.phase, 'reveal');
});

test('a disconnect while paused closes for-all collection on resume', (t) => {
  const { room, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.openForAllAnswers();
  engine.submitForAllAnswer(alice.id, 'Answer');
  engine.pause();
  room.detach(bob.id, 'player-1');
  assert.equal(engine.phase, 'paused');
  engine.resume();
  assert.equal(engine.phase, 'forAllJudge');
});

test('opening for-all collection with no connected answerers does not run an empty timer', (t) => {
  const { room, players: [alice, bob] } = game(t);
  room.detach(alice.id, 'player-0');
  room.detach(bob.id, 'player-1');
  room.engine.openForAllAnswers();
  assert.equal(room.engine.phase, 'forAllJudge');
});

test('reseated spectator is no longer an eligible answerer', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.openForAllAnswers();
  room.setRole(host.id, bob.id, 'spectator');
  assert.throws(() => engine.submitForAllAnswer(bob.id, 'Answer'), /cannot answer/);
  engine.submitForAllAnswer(alice.id, 'Answer');
  assert.equal(engine.phase, 'forAllJudge');
  engine.judgeForAll(alice.id, true);
  assert.equal(engine.phase, 'reveal');
  assert.equal(bob.score, 0);
});
