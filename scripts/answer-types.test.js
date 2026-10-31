/** Tapped answers (options, picture clicks), automatic reveals, and written final answers. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';
import AdmZip from 'adm-zip';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-answers-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');

await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);

// Mirrors the v5 shapes used by community packs such as "Солянка #8".
const questions = `
<question price="100"><info><showmanComments>Bottom right corner</showmanComments></info><params>
  <param name="question" type="content"><item>Find Morty</item><item type="image" isRef="True">pic.jpg</item></param>
  <param name="answerType">point</param><param name="answerDeviation">0.07</param><param name="answerDuration">35</param>
</params><right><answer>0.93,0.89,1.79</answer></right></question>
<question price="200"><params>
  <param name="question" type="content"><item>Pick the made-up film</item></param>
  <param name="answerType">select</param>
  <param name="answerOptions" type="group">
    <param name="A" type="content"><item>Green Room</item></param>
    <param name="B" type="content"><item>Green Book</item></param>
    <param name="C" type="content"><item>Green Glade</item></param>
  </param>
</params><right><answer>C</answer></right></question>
<question price="300"><params><param name="question" type="content"><item>Plain question</item></param></params>
<right><answer>Plain</answer></right></question>`;
const xml = `<package name="Answer types" version="5"><rounds>
<round name="One"><themes><theme name="T"><questions>${questions}</questions></theme></themes></round>
<round name="Final" type="final"><themes>
  <theme name="F1"><questions><question price="0"><params><param name="question" type="content"><item>F?</item></param></params><right><answer>F</answer></right></question></questions></theme>
</themes></round></rounds></package>`;
const zip = new AdmZip();
zip.addFile('content.xml', Buffer.from(xml));
zip.addFile('Images/pic.jpg', Buffer.from('jpg'));
await writeFile(path.join(process.env.PACKS_DIR, 'Answer types.siq'), zip.toBuffer());
const loaded = await loadPack('Answer types.siq');
after(async () => rm(root, { recursive: true, force: true }));

function createRoom(t, settings = {}) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const alice = room.join('Alice').participant;
  room.attach(alice.id, 'alice-socket');
  const bob = room.join('Bob').participant;
  room.attach(bob.id, 'bob-socket');
  room.setPack({ ...loaded, pack: structuredClone(loaded.pack) });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', oral: true, falseStart: true, timeForQuestionIntro: 0, timeForQuestionReady: 0, ...settings });
  room.engine.start();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, alice, bob };
}

function buzzIn(room, playerId, questionIndex) {
  room.engine.selectQuestion(null, true, 0, questionIndex);
  room.engine.openBuzzer();
  room.engine.buzz(playerId);
  assert.equal(room.engine.phase, 'answering');
}

test('the parser exposes point, select, answer time and host notes', () => {
  const [point, select, plain] = loaded.pack.rounds[0].themes[0].questions;
  assert.equal(point.answerType, 'point');
  assert.equal(point.answerDeviation, 0.07);
  assert.equal(point.answerDuration, 35);
  assert.equal(point.info.showmanComments, 'Bottom right corner');
  assert.equal(select.answerType, 'select');
  assert.deepEqual(select.answerOptions.map((option) => option.label), ['A', 'B', 'C']);
  assert.equal(select.answerOptions[2].content[0].value, 'Green Glade');
  assert.equal(plain.answerType, 'text');
});

test('a click inside the deviation scores and reveals; the pack answer time is used', (t) => {
  const { room, alice } = createRoom(t);
  buzzIn(room, alice.id, 0);
  assert.equal(room.engine.timer?.durationMs, 35_000);
  // Oral mode still shows a tap input for picture questions.
  assert.ok(room.snapshotFor(alice.id).game.buzzer.typedAnswer);
  room.engine.submitAnswer(alice.id, '0.95,0.9');
  assert.equal(alice.score, 100);
  assert.equal(room.engine.phase, 'reveal');
  assert.deepEqual(room.snapshotFor(alice.id).game.current.picks,
    [{ playerId: alice.id, value: '0.95,0.9', correct: true }]);
});

test('a click outside the deviation is wrong and the next player may buzz', (t) => {
  const { room, alice, bob } = createRoom(t);
  buzzIn(room, alice.id, 0);
  room.engine.submitAnswer(alice.id, '0.1,0.1');
  assert.equal(alice.score, -100);
  assert.equal(room.engine.phase, 'buzzerOpen');
  room.engine.buzz(bob.id);
  assert.throws(() => room.engine.submitAnswer(bob.id, '2,2'), /Click on the picture/);
});

test('options are auto-judged and only real letters are accepted', (t) => {
  const { room, alice, bob } = createRoom(t);
  buzzIn(room, alice.id, 1);
  assert.throws(() => room.engine.submitAnswer(alice.id, 'Z'), /Choose one of the options/);
  room.engine.submitAnswer(alice.id, 'A');
  assert.equal(alice.score, -200);
  room.engine.buzz(bob.id);
  room.engine.submitAnswer(bob.id, 'C');
  assert.equal(bob.score, 200);
  assert.equal(room.engine.current.answerShown, true);
});

test('host notes reach the host only', (t) => {
  const { room, host, alice } = createRoom(t);
  room.engine.selectQuestion(null, true, 0, 0);
  assert.equal(room.snapshotFor(host.id).game.current.showmanComments, 'Bottom right corner');
  assert.equal(room.snapshotFor(alice.id).game.current.showmanComments, null);
});

test('an unanswered tap question counts as wrong when its time runs out', (t) => {
  const { room, alice } = createRoom(t);
  buzzIn(room, alice.id, 1);
  room.engine.expireAnswering();
  assert.equal(alice.score, -200);
  assert.equal(room.engine.phase, 'buzzerOpen');
});

test('time up with no buzz shows the answer and schedules the board', (t) => {
  const { room, alice } = createRoom(t);
  room.engine.selectQuestion(null, true, 0, 2);
  room.engine.openBuzzer();
  room.engine.expireBuzzer();
  assert.equal(room.engine.phase, 'reveal');
  assert.equal(room.engine.current.answerShown, true);
  assert.equal(room.engine.timer?.name, 'reveal');
  assert.ok(room.snapshotFor(alice.id).game.current.right?.length);
});

test('finalists write answers the host sees while judging; zero scores sit out', (t) => {
  const { room, host, alice, bob } = createRoom(t);
  alice.score = 500;
  room.engine.enterRound(1);
  assert.equal(room.engine.phase, 'finalWager');
  assert.deepEqual(room.snapshotFor(host.id).game.final.eligibleIds, [alice.id]);
  assert.throws(() => room.engine.setFinalWager(bob.id, 0), /positive score/);
  room.engine.setFinalWager(alice.id, 200);
  room.engine.openFinal();
  room.engine.submitFinalAnswer(alice.id, 'F');
  // The only online finalist answered, so judging starts without waiting for the clock.
  assert.equal(room.engine.phase, 'finalJudge');
  assert.deepEqual(room.snapshotFor(host.id).game.final.answers, { [alice.id]: 'F' });
  assert.equal(room.snapshotFor(bob.id).game.final.answers, null);
  room.engine.judgeFinal(alice.id, true);
  assert.equal(alice.score, 700);
  assert.equal(room.engine.phase, 'reveal');
  // Once every finalist is judged, the whole room sees what each one wrote and wagered.
  assert.deepEqual(room.snapshotFor(bob.id).game.final.answers, { [alice.id]: 'F' });
  assert.deepEqual(room.snapshotFor(bob.id).game.final.wagers, { [alice.id]: 200 });
});

test('the host can award half or double the value for a correct answer', (t) => {
  const { room, alice } = createRoom(t);
  buzzIn(room, alice.id, 2);
  assert.throws(() => room.engine.judge(true, 3), /half, full or double/);
  room.engine.judge(true, 0.5);
  assert.equal(alice.score, 150);
  const second = createRoom(t);
  buzzIn(second.room, second.bob.id, 2);
  second.room.engine.judge(true, 2);
  assert.equal(second.bob.score, 600);
});

// The pick intro has its own suite: scripts/question-intro.test.js.

test('a select question with a clip reads until the host device reports the clip and options are in', (t) => {
  for (const falseStart of [true, false]) {
    const { room } = createRoom(t, { falseStart });
    const engine = room.engine;
    // Its options appear one by one only after the clip ends, so no estimate may open the buttons first.
    engine.pack.rounds[0].themes[0].questions[1].content.push({ type: 'video', value: 'v.mp4', url: '/media/v.mp4' });
    engine.selectQuestion(null, true, 0, 1);
    if (engine.phase === 'intro') { clearTimeout(engine.timer?.handle); engine.beginQuestion(); }
    assert.equal(engine.phase, 'reading', `falseStart ${falseStart}`);
    assert.equal(engine.timer, null, 'no reading estimate');
    assert.deepEqual(engine.contentFinished(engine.current.presentationId), { advanced: true });
    assert.equal(engine.phase, 'buzzerOpen');
  }
});
