/** The pick intro: a phase of its own that hides the question, refuses early actions, and leads into each question type. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-intro-'));
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

// Demo theme 0: 0 plain, 1 plain with an image, 2 secret, 3 gift, 4 stake. Theme 1 question 0 becomes for-all,
// theme 1 question 1 a select question with an option that carries media.
const PLAIN = [0, 0], IMAGE = [0, 1], SECRET = [0, 2], GIFT = [0, 3], STAKE = [0, 4], FOR_ALL = [1, 0], SELECT = [1, 1];

function createRoom(t, settings = {}) {
  const pack = structuredClone(loaded.pack);
  const themes = pack.rounds[0].themes;
  themes[1].questions[0].type = 'forAll';
  // The demo logo is the same picture and the logo is always public, so these items get their own files.
  const picture = themes[0].questions[1].content.find((i) => i.type === 'image');
  const folder = picture.url.slice(0, picture.url.lastIndexOf('/') + 1);
  picture.url = `${folder}question.png`;
  const select = themes[1].questions[1];
  select.answerType = 'select';
  select.answerOptions = [
    { label: 'A', content: [{ type: 'image', url: `${folder}option.png` }] },
    { label: 'B', content: [{ type: 'text', value: 'Second option' }] },
  ];
  select.right = ['A'];
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const alice = room.join('Alice').participant;
  room.attach(alice.id, 'alice-socket');
  const bob = room.join('Bob').participant;
  room.attach(bob.id, 'bob-socket');
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', falseStart: true, timeForQuestionIntro: 2, timeForQuestionReady: 0, ...settings });
  room.engine.start();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, engine: room.engine, host, alice, bob };
}

const pick = (engine, [theme, question]) => engine.selectQuestion(null, true, theme, question);
/** Fires the running intro timer at once, the same way the real timeout would. */
function finishIntro(engine) {
  assert.equal(engine.timer?.name, 'intro');
  engine.timer.handle && clearTimeout(engine.timer.handle);
  engine.beginQuestion();
}

test('every non-final pick starts in the intro and hides content and options from everyone', (t) => {
  for (const cell of [PLAIN, IMAGE, SECRET, GIFT, STAKE, FOR_ALL, SELECT]) {
    const { room, engine, host, alice } = createRoom(t);
    pick(engine, cell);
    assert.equal(engine.phase, 'intro', `cell ${cell}`);
    for (const viewer of [host, alice]) {
      const current = room.snapshotFor(viewer.id).game.current;
      assert.deepEqual(current.content, [], `content for ${viewer.name} at ${cell}`);
      assert.deepEqual(current.answerOptions, [], `options for ${viewer.name} at ${cell}`);
    }
  }
});

test('question media and option media are refused until the intro ends', (t) => {
  const { room, engine, alice } = createRoom(t);
  pick(engine, IMAGE);
  const image = engine.current.question.content.find((item) => item.type === 'image').url;
  assert.equal(room.canAccessMedia(alice.mediaTicket, image), false);
  finishIntro(engine);
  assert.equal(room.canAccessMedia(alice.mediaTicket, image), true);

  const second = createRoom(t);
  pick(second.engine, SELECT);
  const optionImage = second.engine.current.question.answerOptions[0].content[0].url;
  assert.equal(second.room.canAccessMedia(second.alice.mediaTicket, optionImage), false);
  finishIntro(second.engine);
  assert.equal(second.room.canAccessMedia(second.alice.mediaTicket, optionImage), true);
});

test('the intro leads into the step each question type needs', (t) => {
  const cases = [
    [PLAIN, {}, 'reading'],
    [PLAIN, { falseStart: false }, 'buzzerOpen'],
    [STAKE, {}, 'stakeAuction'],
    [SECRET, {}, 'specialSetup'],
    [GIFT, {}, 'specialSetup'],
    [FOR_ALL, {}, 'reading'],
  ];
  for (const [cell, settings, phase] of cases) {
    const { engine } = createRoom(t, settings);
    pick(engine, cell);
    finishIntro(engine);
    assert.equal(engine.phase, phase, `cell ${cell} ${JSON.stringify(settings)}`);
    if (cell === FOR_ALL) assert.ok(engine.forAll, 'for-all answer slots exist');
  }
});

test('the special setup event fires only after the intro', (t) => {
  const { room, engine } = createRoom(t);
  const events = [];
  room.on('event', (evt) => events.push(evt.type));
  pick(engine, SECRET);
  assert.deepEqual(events, ['questionSelected']);
  finishIntro(engine);
  assert.deepEqual(events, ['questionSelected', 'specialSetup']);
});

test('during the intro presses are ignored and host shortcuts are refused', (t) => {
  const { room, engine, alice } = createRoom(t);
  pick(engine, PLAIN);
  assert.equal(engine.buzz(alice.id).result, 'ignored');
  assert.equal(engine.buzzer.blockedUntil.has(alice.id), false, 'an intro press is not a false start');
  assert.throws(() => engine.openBuzzer(), /cannot be opened/);
  assert.throws(() => engine.revealAnswer(), /./);
  assert.deepEqual(engine.contentFinished(engine.current.presentationId), { advanced: false });
  assert.equal(engine.phase, 'intro');

  const stake = createRoom(t);
  pick(stake.engine, STAKE);
  assert.throws(() => stake.engine.bidStake(stake.alice.id, 500), /./);
  const secret = createRoom(t);
  pick(secret.engine, SECRET);
  assert.throws(() => secret.engine.configureSpecial(secret.alice.id, 100), /No special question/);
  assert.equal(room.engine.phase, 'intro');
});

test('Next during the intro starts the question instead of dropping it', (t) => {
  const { engine } = createRoom(t);
  pick(engine, PLAIN);
  const presentationId = engine.current.presentationId;
  engine.next();
  assert.equal(engine.phase, 'reading');
  assert.equal(engine.current.presentationId, presentationId);
  assert.equal(engine.timer?.name, 'reading');
});

test('an auction whose players all leave during the intro goes back to the board', (t) => {
  const { room, engine, alice, bob } = createRoom(t);
  pick(engine, STAKE);
  room.detach(alice.id, 'alice-socket');
  room.detach(bob.id, 'bob-socket');
  finishIntro(engine);
  assert.equal(engine.phase, 'board');
  assert.equal(engine.current, null);
  assert.equal(engine.isAvailable(...STAKE), true);
  assert.equal(engine.timer?.name ?? null, engine.settings.timeForChoosingQuestion > 0 ? 'choosing' : null,
    'the choosing timer restarts as after any question');
});

test('a paused intro keeps the question hidden and resumes into the right step', (t) => {
  const { room, engine, alice } = createRoom(t);
  pick(engine, STAKE);
  engine.pause();
  const view = room.snapshotFor(alice.id).game;
  assert.equal(view.phase, 'paused');
  assert.equal(view.pausedPhase, 'intro');
  assert.deepEqual(view.current.content, []);
  engine.resume();
  assert.equal(engine.phase, 'intro');
  finishIntro(engine);
  assert.equal(engine.phase, 'stakeAuction');
});

test('a saved intro restores to the board with the cell still available', async (t) => {
  const { room, engine } = createRoom(t);
  pick(engine, PLAIN);
  const stateFile = path.join(root, 'intro-state.json');
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

test('switching rounds or stopping during the intro leaves no intro timer behind', (t) => {
  const { engine } = createRoom(t);
  pick(engine, PLAIN);
  engine.nextRound();
  assert.notEqual(engine.timer?.name, 'intro');
  assert.notEqual(engine.phase, 'intro');
  const second = createRoom(t);
  pick(second.engine, PLAIN);
  second.engine.reset();
  assert.equal(second.engine.timer, null);
});

test('a player who joins during a for-all intro gets an answer slot', (t) => {
  const { room, engine } = createRoom(t);
  pick(engine, FOR_ALL);
  const carol = room.join('Carol').participant;
  room.attach(carol.id, 'carol-socket');
  finishIntro(engine);
  assert.ok(engine.forAll.eligibleIds.includes(carol.id));
});

test('options stay hidden during an auction and a special setup', (t) => {
  const { room, engine, alice } = createRoom(t);
  pick(engine, STAKE);
  finishIntro(engine);
  assert.equal(engine.phase, 'stakeAuction');
  engine.current.question.answerOptions = [{ label: 'A', content: [{ type: 'text', value: 'Leaked?' }] }];
  assert.deepEqual(room.snapshotFor(alice.id).game.current.answerOptions, []);
});

test('with the intro set to 0 a pick goes straight to its step', (t) => {
  const { engine } = createRoom(t, { timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  pick(engine, PLAIN);
  assert.equal(engine.phase, 'reading');
  const stake = createRoom(t, { timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  pick(stake.engine, STAKE);
  assert.equal(stake.engine.phase, 'stakeAuction');
});
