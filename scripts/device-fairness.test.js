/**
 * Fairness between devices of different speed (an iPhone XS next to a 120 Hz iPhone and an M1):
 * the open lead follows each screen's measured delivery, a late green is credited to its press,
 * and the host may stop waiting for a link far laggier than the rest.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-device-fairness-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');

await import('./make-sample-pack.ts');
const [{ Room }, { listPacks, loadPack }, buzzTiming, { LatencyBoard }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
  import('../server/game/buzzTiming.ts'),
  import('../server/game/latencyBoard.ts'),
]);
const loaded = await loadPack((await listPacks()).find((pack) => pack.name.includes('v5')).file);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
after(async () => rm(root, { recursive: true, force: true }));

function createRoom(t, settings = {}, names = ['XS', 'Pro']) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const players = names.map((name) => {
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
  return { room, engine: room.engine, host, players };
}

/* ---- the open lead follows the measured delivery ---- */

const OPEN = { at: 50_000, scheduledLeadMs: 300 };

test('a measured delivery longer than the round trip estimate sets the lead', () => {
  assert.equal(buzzTiming.openLeadMs(300, 20, null), 300);
  assert.equal(buzzTiming.openLeadMs(300, 20, 200), 300, 'a quick screen keeps the host floor');
  assert.equal(buzzTiming.openLeadMs(300, 20, 400), 430, 'measured 400 ms plus 30 ms spare');
  assert.equal(buzzTiming.openLeadMs(300, 20, 5000), buzzTiming.MAX_OPEN_LEAD_MS);
});

test('delivery is the scheduled lead less the arrival lead plus the render time', () => {
  const board = new LatencyBoard();
  // Scheduled 300 ms ahead; the update arrived 40 ms late and took 120 ms to render.
  board.reportSignal('xs', { leadMs: -40, paintMs: 160, clockErrMs: 5, readyMs: 120 }, OPEN);
  assert.equal(board.delivery('xs'), 460);
  assert.equal(board.paintFor('xs', OPEN.at), 160);
  // A report for another open (no scheduled lead) changes the shown lead, not the delivery.
  board.reportSignal('xs', { leadMs: 250, paintMs: 3, clockErrMs: 5 }, null);
  assert.equal(board.paintFor('xs', OPEN.at), null, 'the paint figure belongs to another open now');
  assert.equal(board.delivery('xs'), 460);
  assert.equal(board.signal('xs').leadMs, 250);
  // Older clients send no render time; junk drops the report.
  board.reportSignal('pro', { leadMs: 280, paintMs: 2, clockErrMs: 2 }, OPEN);
  assert.equal(board.delivery('pro'), 20);
  board.reportSignal('pro', { leadMs: 280, paintMs: 2, clockErrMs: 2, readyMs: 'x' }, OPEN);
  assert.equal(board.signal('pro').leadMs, 280);
  assert.equal(board.worstDelivery(['xs', 'pro', 'nobody']), 460);
});

test('one hiccup in eight does not stretch the lead', () => {
  const board = new LatencyBoard();
  for (const readyMs of [30, 30, 30, 30, 30, 30, 30, 700]) {
    board.reportSignal('xs', { leadMs: 250, paintMs: 5, clockErrMs: 5, readyMs }, OPEN);
  }
  assert.equal(board.delivery('xs'), 80, 'the 75th percentile leaves the single 700 ms render out');
});

test('a slow screen\'s green-signal report lengthens the next open lead', (t) => {
  const { room, engine, players: [xs] } = createRoom(t);
  engine.openBuzzer();
  const at = engine.buzzer.openedAt;
  assert.deepEqual(engine.scheduledOpen(at), { at, scheduledLeadMs: 300 });
  assert.equal(engine.scheduledOpen(at - 1), null, 'a report for another open is not matched');
  // The XS got the update 20 ms after the open moment and needed 90 ms to render it.
  room.recordSignal(xs.id, { at, leadMs: -20, paintMs: 110, clockErrMs: 4, readyMs: 90 });
  assert.equal(room.worstPlayerDeliveryMs(), 410);
  assert.equal(engine.openLeadMs(), 440);
});

/* ---- a press is ranked from its own screen's green ---- */

test('paint credit: capped, and nothing for a press before the screen turned green', () => {
  const openedAt = 10_000;
  assert.equal(buzzTiming.paintCreditMs(openedAt + 70, openedAt, 40), 40);
  assert.equal(buzzTiming.paintCreditMs(openedAt + 30, openedAt, 40), 0, 'pressed before its own green: a guess');
  assert.equal(buzzTiming.paintCreditMs(openedAt + 900, openedAt, 600), buzzTiming.MAX_PAINT_CREDIT_MS);
  for (const junk of [undefined, 'x', -5, 0, Number.NaN]) assert.equal(buzzTiming.paintCreditMs(openedAt + 70, openedAt, junk), 0);
});

function closePress(engine, xs, pro) {
  engine.openBuzzer();
  const openedAt = Date.now() - 400;
  engine.buzzer.openedAt = openedAt;
  // The XS turned green 40 ms late and its player reacted in 30 ms; the 120 Hz phone was green
  // after 5 ms and reacted in 45 ms. By raw device time the faster phone pressed first.
  engine.buzz(xs.id, { clientAt: openedAt + 70, paintMs: 40 });
  engine.buzz(pro.id, { clientAt: openedAt + 50, paintMs: 5 });
}

test('the quicker reaction wins although its screen turned green later', (t) => {
  const { engine, players: [xs, pro] } = createRoom(t);
  closePress(engine, xs, pro);
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, xs.id);
  assert.equal(engine.buzzer.winnerInfo.reactionMs, 30, 'reaction counted from its own green');
  assert.equal(engine.buzzer.winnerInfo.transitMs >= 330, true, 'transit stays the real press age');
});

test('with the credit off raw device time decides', (t) => {
  const { engine, players: [xs, pro] } = createRoom(t, { paintCredit: false });
  closePress(engine, xs, pro);
  assert.equal(engine.buzzer.winnerId, pro.id);
});

/* ---- the host may stop waiting for a lagging link ---- */

test('a link far slower than the rest is lagging; a room of equals has none', () => {
  const board = new LatencyBoard();
  for (const [pid, rtt] of [['m1', 8], ['pro', 20], ['xs', 30], ['cell', 900]]) board.report(pid, rtt);
  assert.deepEqual([...board.lagging(['m1', 'pro', 'xs', 'cell'])], ['cell']);
  const fair = new LatencyBoard();
  for (const [pid, rtt] of [['m1', 8], ['pro', 20], ['xs', 30], ['cell', 300]]) fair.report(pid, rtt);
  assert.deepEqual([...fair.lagging(['m1', 'pro', 'xs', 'cell'])], [], '300 ms is under the 400 ms floor');
  const slowRoom = new LatencyBoard();
  for (const [pid, rtt] of [['a', 500], ['b', 600], ['c', 700]]) slowRoom.report(pid, rtt);
  assert.deepEqual([...slowRoom.lagging(['a', 'b', 'c'])], [], 'everyone is slow: nobody is an outlier');
  assert.deepEqual([...board.lagging(['cell'])], [], 'a lone link has nothing to compare with');
});

test('with the setting on a lagging player no longer sets the pace and is flagged', (t) => {
  const { room, host, players: [xs, pro, cell] } = createRoom(t, {}, ['XS', 'Pro', 'Cell']);
  room.latency.report(xs.id, 30);
  room.latency.report(pro.id, 20);
  room.latency.report(cell.id, 900);
  const flagged = () => room.snapshotFor(host.id).participants.find((p) => p.id === cell.id).lagging;
  assert.equal(room.worstPlayerRttMs(), 900, 'off by default: the game waits for everyone');
  assert.equal(flagged(), false);
  room.updateSettings(host.id, { ignoreLaggingLinks: true });
  assert.equal(room.worstPlayerRttMs(), 30);
  assert.equal(flagged(), true);
  assert.equal(room.engine.openLeadMs(), 300, 'the lead falls back to the host floor');
});

test('a press stays fair after the lead grew: the window still closes on time', (t) => {
  const { room, engine, players: [xs, pro] } = createRoom(t, { buzzSyncWindowMs: 100 });
  room.latency.report(xs.id, 40);
  room.latency.report(pro.id, 20);
  engine.openBuzzer();
  const at = engine.buzzer.openedAt;
  room.recordSignal(xs.id, { at, leadMs: 10, paintMs: 30, clockErrMs: 4, readyMs: 200 });
  engine.buzzer.openedAt = Date.now() - 300;
  engine.buzz(pro.id, { clientAt: engine.buzzer.openedAt + 100, paintMs: 4 });
  // Only the XS is left: 40 / 2 + 50 = 70 ms after the leader's press, already past.
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, pro.id);
});

test('the early close allows for the credit a waiting press may still earn', async (t) => {
  const { room, engine, players: [xs, pro] } = createRoom(t, { buzzSyncWindowMs: 400 });
  room.latency.report(xs.id, 20);
  room.latency.report(pro.id, 20); // a press in flight up to 20 / 2 + 50 = 60 ms
  engine.openBuzzer();
  const openedAt = engine.buzzer.openedAt;
  await sleep(openedAt - Date.now() + 20);
  engine.buzz(pro.id, { clientAt: Date.now() - 10, paintMs: 4 });
  const leaderAt = engine.buzzer.pending[0].effectiveAt;
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 2, `${actual} vs ${expected}`);
  // The XS has not reported its green yet, so the full 80 ms credit is allowed for.
  near(engine.buzzWindowEndsAt, leaderAt + 60 + 80);
  // Its report says it turned green 25 ms late: the next pass allows only that.
  room.recordSignal(xs.id, { at: openedAt, leadMs: 200, paintMs: 25, clockErrMs: 3, readyMs: 20 });
  engine.settleSyncWindow(Date.now());
  near(engine.buzzWindowEndsAt, leaderAt + 60 + 25);
});
