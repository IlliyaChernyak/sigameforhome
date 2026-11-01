/** Every answer closes on its own: an answer clip when the host's device reports its end, the rest on a clock. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-answer-close-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

const SONG = { type: 'audio', value: 'song.mp3', url: '/media/song.mp3', placement: 'background', waitForFinish: true };

/** Theme 0 question 0 is a plain question; `answer` replaces what its reveal shows. */
function revealed(t, answer = {}) {
  const engine = presented(t, answer);
  engine.revealAnswer();
  assert.equal(engine.phase, 'reveal');
  return engine;
}

/** Theme 0 question 0 with `changes` applied, past its intro: reading, or buzzers open. */
function presented(t, changes = {}) {
  const pack = structuredClone(loaded.pack);
  Object.assign(pack.rounds[0].themes[0].questions[0], changes);
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const alice = room.join('Alice').participant;
  room.attach(alice.id, 'alice-socket');
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  const engine = room.engine;
  engine.start();
  t.after(() => {
    engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  engine.selectQuestion(null, true, 0, 0);
  if (engine.phase === 'intro') {
    clearTimeout(engine.timer?.handle);
    engine.beginQuestion();
  }
  return engine;
}

test('an answer clip holds the question until the host device reports its end', (t) => {
  const engine = revealed(t, { answerContent: [SONG] });
  assert.equal(engine.timer, null, 'no clock cuts the song short');
  const id = engine.current.presentationId;
  // A late report about the question's own clip must not close the answer.
  assert.deepEqual(engine.contentFinished(id), { advanced: false });
  assert.deepEqual(engine.answerFinished('stale'), { advanced: false });
  assert.equal(engine.phase, 'reveal');
  assert.deepEqual(engine.answerFinished(id), { advanced: true });
  assert.equal(engine.phase, 'board');
});

test('an answer without a clip closes on the reveal clock, even after the host revealed it', (t) => {
  const engine = revealed(t, { answerContent: [] });
  assert.equal(engine.timer?.name, 'reveal');
  assert.deepEqual(engine.answerFinished(engine.current.presentationId), { advanced: false });
});

test('a point answer shows on the picture, so its clips do not hold the question', (t) => {
  const engine = revealed(t, { answerType: 'point', right: ['0.5,0.5'], answerContent: [SONG] });
  assert.equal(engine.timer?.name, 'reveal');
});

/*
 * Only the host's device reports a clip's end. A host who drops, locks the phone, or whose
 * browser blocks playback never does, so a hidden server guard stands in for the report.
 */

const OPTIONS = { answerType: 'select', options: [{ label: 'A', value: 'One' }, { label: 'B', value: 'Two' }], right: ['A'] };

test('an answer clip with no reported end closes after the guard limit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const engine = revealed(t, { answerContent: [SONG] });
  assert.equal(engine.timer, null, 'the guard is not a clock players see');
  t.mock.timers.tick(179_000);
  assert.equal(engine.phase, 'reveal', 'a whole song may still be playing');
  t.mock.timers.tick(1_000);
  assert.equal(engine.phase, 'board');
});

test('an answer clip with a pack-given duration closes shortly after it should end', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const engine = revealed(t, { answerContent: [{ ...SONG, duration: 20 }] });
  t.mock.timers.tick(29_000);
  assert.equal(engine.phase, 'reveal');
  t.mock.timers.tick(1_000);
  assert.equal(engine.phase, 'board');
});

test('a reported answer end leaves no guard behind to close the next question', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const engine = revealed(t, { answerContent: [SONG] });
  engine.answerFinished(engine.current.presentationId);
  assert.equal(engine.clipReportHandle, undefined);
});

test('a select question clip with no reported end still opens the buzzer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const engine = presented(t, { ...OPTIONS, content: [{ ...SONG, waitForFinish: false }] });
  assert.equal(engine.phase, 'reading');
  assert.equal(engine.timer, null);
  t.mock.timers.tick(180_000);
  assert.equal(engine.phase, 'buzzerOpen');
});

test('pausing over a clip wait drops the guard, and resuming waits afresh', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const engine = revealed(t, { answerContent: [SONG] });
  t.mock.timers.tick(170_000);
  engine.pause();
  t.mock.timers.tick(60_000);
  assert.equal(engine.phase, 'paused', 'the guard does not fire while paused');
  engine.resume();
  t.mock.timers.tick(179_000);
  assert.equal(engine.phase, 'reveal');
  t.mock.timers.tick(1_000);
  assert.equal(engine.phase, 'board');
});
