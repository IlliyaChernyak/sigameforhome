/** Guided stake bidding, turn order, all-in precedence, and answer scoring. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-stakes-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
]);
const pack = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function table(t, scores) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const players = scores.map((score, index) => {
    const player = room.join(`Player ${index + 1}`).participant;
    room.attach(player.id, `player-${index}`);
    return player;
  });
  room.setPack({ ...pack, pack: structuredClone(pack.pack) });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  scores.forEach((score, index) => { players[index].score = score; });
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players };
}

test('auction rotates from chooser in score order and assigns the high bidder', (t) => {
  const { room, host, players: [bob, alice, carol] } = table(t, [300, 500, 700]);
  room.engine.chooserId = bob.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  assert.equal(room.engine.phase, 'stakeAuction');
  assert.equal(room.snapshotFor(bob.id).game.auction.turnId, bob.id);
  assert.deepEqual(room.snapshotFor(bob.id).game.current.content, []);
  assert.equal(room.engine.timer.name, 'stake');
  assert.throws(() => room.engine.bidStake(carol.id, 600), /not your turn/);

  room.engine.bidStake(bob.id, 500);
  assert.equal(room.engine.auctionTurnId(), alice.id);
  room.engine.passStake(alice.id);
  assert.equal(room.engine.auctionTurnId(), carol.id);
  room.engine.bidStake(carol.id, 600);
  assert.equal(room.engine.auctionTurnId(), bob.id);
  room.engine.passStake(bob.id);
  assert.equal(room.engine.phase, 'reading');
  assert.equal(room.engine.current.assignedId, carol.id);
  assert.equal(room.engine.current.price, 600);
  assert.equal(room.snapshotFor(bob.id).game.auction, null);

  room.engine.openBuzzer();
  assert.equal(room.engine.buzzer.winnerId, carol.id);
  room.engine.judge(false);
  assert.equal(carol.score, 100);
  assert.equal(room.engine.phase, 'reveal');
});

test('all-in can only be beaten by a higher all-in', (t) => {
  const { room, host, players: [alice, bob, carol] } = table(t, [700, 900, 1200]);
  room.engine.chooserId = alice.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  room.engine.bidStake(alice.id, 500);
  assert.throws(() => room.engine.bidStake(bob.id, 901), /available stake/);
  assert.throws(() => room.engine.bidStake(bob.id, 800, true), /equal your score/);
  room.engine.bidStake(bob.id, 900, true);
  assert.throws(() => room.engine.bidStake(carol.id, 1000, false), /higher all-in/);
  room.engine.bidStake(carol.id, 1200, true);
  room.engine.passStake(alice.id);
  room.engine.passStake(bob.id);
  assert.equal(room.engine.current.assignedId, carol.id);
  assert.equal(room.engine.current.price, 1200);
  room.engine.openBuzzer();
  room.engine.judge(true);
  assert.equal(carol.score, 2400);
});

test('all-pass spends the question; pause and skip preserve hidden content', (t) => {
  const { room, host, players: [a, b] } = table(t, [600, 700]);
  room.engine.chooserId = a.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  room.engine.pause();
  assert.deepEqual(room.snapshotFor(b.id).game.current.content, []);
  room.engine.resume();
  assert.equal(room.engine.phase, 'stakeAuction');
  room.engine.passStake(a.id);
  room.engine.passStake(b.id);
  assert.equal(room.engine.phase, 'reveal');
  assert.equal(a.score, 600);
  assert.equal(b.score, 700);
  room.engine.next();
  assert.equal(room.engine.phase, 'board');

  room.engine.selectQuestion(host.id, true, 1, 4);
  room.engine.next();
  assert.equal(room.engine.phase, 'board');
  assert.equal(room.engine.auction, null);
});

test('a disconnected high bidder cannot be assigned the answer', (t) => {
  const { room, host, players: [a, b, c] } = table(t, [600, 700, 800]);
  room.engine.chooserId = a.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  room.engine.bidStake(a.id, 500);
  room.detach(a.id, 'player-0');
  room.engine.passStake(b.id);
  room.engine.passStake(c.id);
  assert.equal(room.engine.phase, 'reveal');
  assert.equal(room.engine.current.assignedId, null);
  assert.equal(a.score, 600);
});

test('a dropped bidder keeps the turn for a short grace, then it moves on', (t) => {
  // Device playtest F16: a refresh used to skip the bidder at once and could burn the question.
  const { room, host, players: [a, b, c] } = table(t, [600, 700, 800]);
  room.engine.chooserId = a.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  room.detach(a.id, 'player-0');
  assert.equal(room.engine.auctionTurnId(), a.id, 'the turn waits for a reconnect');
  assert.ok(room.engine.timer.endsAt - Date.now() <= 10_000);
  t.mock.timers.tick(10_000);
  assert.equal(room.engine.auctionTurnId(), b.id, 'still offline: the next bidder is up');
  assert.equal(room.engine.auction.passed.has(a.id), false, 'skipped, not passed');
  room.engine.passStake(b.id);
  room.engine.passStake(c.id);
  assert.equal(room.engine.phase, 'reveal');
  assert.equal(room.engine.current.assignedId, null);
});

test('a bidder back within the grace keeps the turn with a fresh bid clock', (t) => {
  const { room, host, players: [a, b] } = table(t, [600, 700]);
  room.engine.chooserId = a.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  room.detach(a.id, 'player-0');
  t.mock.timers.tick(4_000);
  room.attach(a.id, 'player-0b');
  assert.equal(room.engine.auctionTurnId(), a.id);
  assert.equal(room.engine.timer.endsAt - Date.now(), room.settings.timeForMakingStake * 1000);
  t.mock.timers.tick(10_000);
  assert.equal(room.engine.auctionTurnId(), a.id, 'the old grace no longer moves the turn');
  room.engine.bidStake(a.id, 500);
  assert.equal(room.engine.auctionTurnId(), b.id);
});

test('resuming an auction skips a bidder who left during the pause', (t) => {
  const { room, host, players: [a, b] } = table(t, [600, 700]);
  room.engine.chooserId = a.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  room.engine.pause();
  room.detach(a.id, 'player-0');
  room.engine.resume();
  assert.equal(room.engine.auctionTurnId(), b.id);
  room.engine.passStake(b.id);
  assert.equal(room.engine.phase, 'reveal');
});

test('an offline auction cannot consume a question before anyone can bid', (t) => {
  const { room, host, players: [alice, bob] } = table(t, [600, 700]);
  room.detach(alice.id, 'player-0');
  room.detach(bob.id, 'player-1');
  assert.throws(() => room.engine.selectQuestion(host.id, true, 0, 4), /No connected players can bid/);
  assert.equal(room.engine.phase, 'board');
  assert.equal(room.engine.current, null);
  assert.equal(room.engine.isAvailable(0, 4), true);
});

test('stake timer automatically passes an idle bidder', async (t) => {
  const { room, host, players: [a, b] } = table(t, [600, 700]);
  room.settings.timeForMakingStake = 0.01;
  room.engine.chooserId = a.id;
  room.engine.selectQuestion(host.id, true, 0, 4);
  // Chained auction timers can run late when other test files share the event loop.
  const deadline = Date.now() + 1000;
  while (room.engine.phase !== 'reveal' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(room.engine.phase, 'reveal');
  assert.equal(room.engine.auction, null);
  assert.equal(b.score, 700);
});
