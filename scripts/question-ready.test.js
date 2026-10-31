/** The get-ready countdown: the question is shown, presses are ignored, and reading starts when it ends. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-ready-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }, { persistRoom, restoreRoom }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
  import('../server/game/persistence.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

// Demo theme 0: 0 plain, 2 secret. Theme 1 question 0 becomes for-all.
const PLAIN = [0, 0], SECRET = [0, 2], FOR_ALL = [1, 0];

function createRoom(t, settings = {}) {
  const pack = structuredClone(loaded.pack);
  pack.rounds[0].themes[1].questions[0].type = 'forAll';
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const alice = room.join('Alice').participant;
  room.attach(alice.id, 'alice-socket');
  const bob = room.join('Bob').participant;
  room.attach(bob.id, 'bob-socket');
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { ...INSTANT_BUZZER,
    gameMode: 'classic', falseStart: true, timeForQuestionIntro: 0, timeForQuestionReady: 3, ...settings,
  });
  room.engine.start();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, engine: room.engine, host, alice, bob };
}

const pick = (engine, [theme, question]) => engine.selectQuestion(null, true, theme, question);
/** Fires the running countdown at once, the same way the real timeout would. */
function finishReady(engine) {
  assert.equal(engine.timer?.name, 'ready');
  const { handle } = engine.timer;
  clearTimeout(handle);
  engine.startQuestionReading();
}

test('a pick shows the question with a countdown before reading', (t) => {
  const { room, engine, alice } = createRoom(t);
  pick(engine, PLAIN);
  assert.equal(engine.phase, 'ready');
  assert.equal(engine.timer?.durationMs, 3000);
  const current = room.snapshotFor(alice.id).game.current;
  assert.ok(current.content.length > 0, 'players see the question during the countdown');
  finishReady(engine);
  assert.equal(engine.phase, 'reading');
  assert.equal(engine.timer?.name, 'reading');
});

test('presses during the countdown are ignored, never false starts', (t) => {
  for (const falseStart of [true, false]) {
    const { engine, alice } = createRoom(t, { falseStart });
    pick(engine, PLAIN);
    assert.equal(engine.buzz(alice.id).result, 'ignored');
    assert.equal(engine.buzzer.blockedUntil.has(alice.id), false);
    assert.throws(() => engine.openBuzzer(), /cannot be opened/);
    assert.equal(engine.phase, 'ready');
  }
});

test('the countdown leads into the step each question needs', (t) => {
  const plain = createRoom(t, { falseStart: false });
  pick(plain.engine, PLAIN);
  finishReady(plain.engine);
  assert.equal(plain.engine.phase, 'buzzerOpen');

  const forAll = createRoom(t);
  pick(forAll.engine, FOR_ALL);
  assert.equal(forAll.engine.phase, 'ready');
  finishReady(forAll.engine);
  assert.equal(forAll.engine.phase, 'reading');

  // A secret question gets its countdown once the host has handed it over.
  const secret = createRoom(t);
  pick(secret.engine, SECRET);
  assert.equal(secret.engine.phase, 'specialSetup');
  const { question } = secret.engine.current;
  const target = [secret.alice, secret.bob].find((p) => p.id !== secret.engine.chooserId);
  secret.engine.configureSpecial(target.id, question.typeParams?.price?.minimum ?? question.price);
  assert.equal(secret.engine.phase, 'ready');
  finishReady(secret.engine);
  assert.equal(secret.engine.phase, 'reading');
});

test('Next during the countdown starts reading instead of dropping the question', (t) => {
  const { engine } = createRoom(t);
  pick(engine, PLAIN);
  const presentationId = engine.current.presentationId;
  engine.next();
  assert.equal(engine.phase, 'reading');
  assert.equal(engine.current.presentationId, presentationId);
  assert.equal(engine.timer?.name, 'reading');
});

test('a paused countdown resumes and still leads into reading', (t) => {
  const { room, engine, alice } = createRoom(t);
  pick(engine, PLAIN);
  engine.pause();
  const view = room.snapshotFor(alice.id).game;
  assert.equal(view.pausedPhase, 'ready');
  assert.ok(view.current.content.length > 0);
  engine.resume();
  assert.equal(engine.phase, 'ready');
  finishReady(engine);
  assert.equal(engine.phase, 'reading');
});

test('a saved countdown restores to the board with the cell still available', async (t) => {
  const { room, engine } = createRoom(t);
  pick(engine, PLAIN);
  const stateFile = path.join(root, 'ready-state.json');
  await persistRoom(room, stateFile)();
  const restored = new Room();
  t.after(() => {
    restored.engine.reset();
    for (const timer of restored.removalTimers.values()) clearTimeout(timer);
  });
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(...PLAIN), true);
});

test('with the countdown set to 0 reading starts at once', (t) => {
  const { engine } = createRoom(t, { timeForQuestionReady: 0 });
  pick(engine, PLAIN);
  assert.equal(engine.phase, 'reading');
});
