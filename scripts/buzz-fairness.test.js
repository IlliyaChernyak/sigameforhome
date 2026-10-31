/**
 * Buzzer fairness across slow devices and networks: the open signal is scheduled ahead so all
 * screens turn green together, and presses are compared by calibrated device time.
 * A simulation showed arrival order let a laptop win ~90 % of equal-speed presses.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-buzz-fairness-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');

await import('./make-sample-pack.ts');
const [{ Room }, { listPacks, loadPack }, { defaultSettings }, buzzTiming] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
  import('../server/game/settings.ts'),
  import('../server/game/buzzTiming.ts'),
]);
const loaded = await loadPack((await listPacks()).find((pack) => pack.name.includes('v5')).file);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => rm(root, { recursive: true, force: true }));

function createRoom(t, settings = {}) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const [fast, slow] = ['Fast', 'Slow'].map((name) => {
    const player = room.join(name).participant;
    room.attach(player.id, `${name}-socket`);
    return player;
  });
  room.setPack({ ...loaded, pack: structuredClone(loaded.pack) });
  room.updateSettings(host.id, { gameMode: 'simple', timeForQuestionIntro: 0, timeForQuestionReady: 0, ...settings });
  room.engine.start();
  room.engine.selectQuestion(host.id, true, 0, 1);
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, engine: room.engine, host, fast, slow };
}

test('fair buzzer defaults: device time, a 200 ms window and a 300 ms open lead', () => {
  const settings = defaultSettings();
  assert.equal(settings.buzzSyncMode, 'clientTimestamp');
  assert.equal(settings.buzzSyncWindowMs, 200);
  assert.equal(settings.buzzOpenLeadMs, 300);
});

test('the open signal is scheduled ahead and the countdown keeps its full thinking time', (t) => {
  const { room, engine, fast } = createRoom(t, { timeForThinkingOnQuestion: 5 });
  const before = Date.now();
  engine.openBuzzer();
  assert.equal(engine.phase, 'buzzerOpen');
  assert.ok(engine.buzzer.openedAt >= before + 300 && engine.buzzer.openedAt <= Date.now() + 300);
  assert.equal(engine.timer.durationMs, 5300);
  assert.equal(room.snapshotFor(fast.id).game.buzzer.openedAt, engine.buzzer.openedAt, 'clients wait for this moment');
});

test('a press stamped before the signal is a false start even when it arrives after it', (t) => {
  const { engine, slow } = createRoom(t, { falseStart: true });
  engine.openBuzzer();
  // A weak-Wi-Fi player pressed 50 ms before green; the press reaches the server after green.
  const openedAt = Date.now() - 30;
  engine.buzzer.openedAt = openedAt;
  assert.equal(engine.buzz(slow.id, { clientAt: openedAt - 50 }).result, 'falseStart');
  assert.ok(engine.buzzer.blockedUntil.get(slow.id) > Date.now());
});

test('arrival order also blocks a press that reaches the server before the signal', (t) => {
  const { engine, fast } = createRoom(t, { buzzSyncMode: 'server', falseStart: true });
  engine.openBuzzer();
  assert.equal(engine.buzz(fast.id).result, 'falseStart');
});

test('with false starts off an early press counts as pressed at the signal', async (t) => {
  // Without false starts the buttons open while the question is still shown.
  const { engine, fast } = createRoom(t, { falseStart: false, buzzSyncWindowMs: 20 });
  assert.equal(engine.phase, 'buzzerOpen');
  const openedAt = engine.buzzer.openedAt;
  assert.equal(engine.buzz(fast.id, { clientAt: Date.now() }).result, 'queued');
  assert.equal(engine.buzzer.pending[0].effectiveAt, openedAt);
  await sleep(60);
  assert.equal(engine.buzzer.winnerId, fast.id);
});

test('the earlier device press wins although it arrives later over a slow network', async (t) => {
  const { engine, fast, slow } = createRoom(t, { buzzSyncWindowMs: 40 });
  engine.openBuzzer();
  const openedAt = Date.now() - 400;
  engine.buzzer.openedAt = openedAt; // the signal is showing on every screen
  assert.equal(engine.buzz(fast.id, { clientAt: openedAt + 290 }).result, 'queued');
  assert.equal(engine.buzz(slow.id, { clientAt: openedAt + 260 }).result, 'queued');
  await sleep(80);
  assert.equal(engine.buzzer.winnerId, slow.id);
  assert.equal(engine.buzzer.winnerInfo.reactionMs, 260);
});

test('with false starts off and arrival order a press before the signal wins at once', (t) => {
  const { engine, fast } = createRoom(t, { falseStart: false, buzzSyncMode: 'server' });
  assert.ok(engine.buzzer.openedAt > Date.now());
  assert.equal(engine.buzz(fast.id).result, 'accepted');
  assert.equal(engine.buzzer.winnerId, fast.id);
});

test('resuming open buttons schedules the signal again', (t) => {
  const { engine } = createRoom(t);
  engine.openBuzzer();
  engine.buzzer.openedAt = Date.now() - 2000;
  engine.pause();
  const before = Date.now();
  engine.resume();
  assert.equal(engine.phase, 'buzzerOpen');
  assert.ok(engine.buzzer.openedAt >= before + 300);
});

/* ---- lead and window fit the slowest player's connection ---- */

test('without latency reports the host settings apply as they are', () => {
  assert.equal(buzzTiming.openLeadMs(300, null), 300);
  assert.equal(buzzTiming.syncWindowMs(200, null), 200);
  assert.equal(buzzTiming.openLeadMs(0, null), 0);
});

test('a fast room keeps the host floors; a slow one grows up to the caps', () => {
  // LAN: 20 ms round trip stays under both floors.
  assert.equal(buzzTiming.openLeadMs(300, 20), 300);
  assert.equal(buzzTiming.syncWindowMs(200, 20), 200);
  // Poor mobile data: 600 ms round trip, about 300 ms each way plus margins.
  assert.equal(buzzTiming.openLeadMs(300, 600), 420);
  assert.equal(buzzTiming.syncWindowMs(200, 600), 380);
  // A dead link must not stall every question.
  assert.equal(buzzTiming.openLeadMs(300, 1e9), buzzTiming.MAX_OPEN_LEAD_MS);
  assert.equal(buzzTiming.syncWindowMs(200, 1e9), buzzTiming.MAX_SYNC_WINDOW_MS);
});

test('the latency board ignores junk and caps huge reports', () => {
  const board = new buzzTiming.LatencyBoard();
  for (const junk of [undefined, 'fast', -5, Number.NaN, Infinity, { rtt: 1 }]) board.report('a', junk);
  assert.equal(board.worst(['a']), null);
  board.report('a', 99999);
  board.report('b', 40);
  assert.equal(board.worst(['a', 'b']), 2000);
  assert.equal(board.worst(['b', 'missing']), 40);
  board.forget('a');
  assert.equal(board.worst(['a']), null);
});

test('a slow player lengthens the open lead and the countdown keeps its thinking time', (t) => {
  const { room, engine, slow } = createRoom(t, { timeForThinkingOnQuestion: 5 });
  room.latency.report(slow.id, 600);
  const before = Date.now();
  engine.openBuzzer();
  assert.ok(engine.buzzer.openedAt >= before + 420 && engine.buzzer.openedAt <= Date.now() + 420);
  assert.equal(engine.timer.durationMs, 5420);
});

test('a slow upload still wins with the earlier press once the window fits it', async (t) => {
  const { room, engine, fast, slow } = createRoom(t, { buzzSyncWindowMs: 20 });
  room.latency.report(slow.id, 200); // window grows from 20 to 180 ms
  engine.openBuzzer();
  const openedAt = Date.now() - 400;
  engine.buzzer.openedAt = openedAt;
  assert.equal(engine.buzz(fast.id, { clientAt: openedAt + 300 }).result, 'queued');
  // The slow phone pressed earlier, but its press lands 100 ms later: past the 20 ms floor.
  await sleep(100);
  assert.equal(engine.buzz(slow.id, { clientAt: openedAt + 250 }).result, 'queued');
  await sleep(120);
  assert.equal(engine.buzzer.winnerId, slow.id);
});

test('only connected players set the pace; a new connection is measured afresh', (t) => {
  const { room, host, fast, slow } = createRoom(t);
  room.latency.report(host.id, 1500); // the host's screen shows no buzzer
  room.latency.report(fast.id, 30);
  room.latency.report(slow.id, 900);
  assert.equal(room.worstPlayerRttMs(), 900);
  room.detach(slow.id, 'Slow-socket');
  assert.equal(room.worstPlayerRttMs(), 30);
  room.attach(slow.id, 'Slow-socket-2');
  room.attach(fast.id, 'Fast-socket-2');
  assert.equal(room.worstPlayerRttMs(), null);
});
