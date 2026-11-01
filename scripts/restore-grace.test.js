/** Restored seats get the normal reconnect grace instead of living forever (audit CONN-4). */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const GRACE_MS = 200;
const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-restore-grace-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');
// config.ts reads this at import time, so it must be set before the dynamic imports below.
process.env.RECONNECT_GRACE_MS = String(GRACE_MS);

await import('./make-sample-pack.ts');
const [{ Room }, { listPacks, loadPack }, { persistRoom, restoreRoom }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
  import('../server/game/persistence.ts'),
]);
const { markHandoverReady } = await import('../server/game/moderationHandover.ts');
const loaded = await loadPack((await listPacks()).find((pack) => pack.name.includes('v5')).file);
after(async () => rm(root, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outlastGrace = () => sleep(GRACE_MS + 150);
let stateCounter = 0;

function cleanup(t, room) {
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
}

/** Host + player + spectator, all connected; `start` decides whether a game is running. */
function createRoom(t, { start = true } = {}) {
  const room = new Room();
  cleanup(t, room);
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');
  const spectator = room.join('Spectator').participant;
  room.attach(spectator.id, 'spectator-socket');
  room.setRole(spectator.id, spectator.id, 'spectator');
  room.setPack(loaded);
  room.updateSettings(host.id, { timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  if (start) room.engine.start();
  return { room, host, player, spectator };
}

/** Saves `room`, optionally edits the saved JSON, and restores it into a fresh room. */
async function saveAndRestore(t, room, edit = () => {}) {
  const stateFile = path.join(root, `state-${++stateCounter}.json`);
  await persistRoom(room, stateFile)();
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  edit(saved);
  await writeFile(stateFile, JSON.stringify(saved));
  const restored = new Room();
  cleanup(t, restored);
  await restoreRoom(restored, stateFile);
  return restored;
}

test('(a) a saved lobby releases offline ghosts after grace', async (t) => {
  const { room } = createRoom(t, { start: false });
  const restored = await saveAndRestore(t, room);
  assert.equal(restored.participants.size, 3);
  await outlastGrace();
  assert.equal(restored.participants.size, 0);
  assert.equal(restored.host(), null);
  // Names and the host seat are free again for the next arrivals.
  const again = restored.join('Host').participant;
  assert.equal(restored.ownerId, again.id);
});

test('(b) a saved board keeps seats and scores after grace', async (t) => {
  const { room, host, player } = createRoom(t);
  room.adjustScore(host.id, player.id, 300);
  const restored = await saveAndRestore(t, room);
  assert.equal(restored.engine.phase, 'board');
  await outlastGrace();
  assert.equal(restored.participants.get(player.id).score, 300);
  assert.equal(restored.participants.get(host.id).role, 'host');
});

test('(c) a saved board with its pack missing still keeps seats and scores', async (t) => {
  const { room, host, player } = createRoom(t);
  room.adjustScore(host.id, player.id, 300);
  const restored = await saveAndRestore(t, room, (saved) => { saved.packFile = 'removed-pack.siq'; });
  assert.equal(restored.engine.phase, 'lobby');
  await outlastGrace();
  assert.equal(restored.participants.get(player.id).score, 300);
  assert.equal(restored.participants.get(host.id).role, 'host');
});

test("(c') after a missing-pack restore the owner can replace the ghost host and start", async (t) => {
  // Own setup: the owner must be a player, unlike createRoom where the host owns the room.
  const room = new Room();
  cleanup(t, room);
  const P = room.join('P').participant;
  room.attach(P.id, 'p-socket');
  room.chooseInitialRole(P.id, 'player');
  const H = room.join('H').participant;
  room.attach(H.id, 'h-socket');
  room.setRole(P.id, H.id, 'host');
  const Q = room.join('Q').participant;
  room.attach(Q.id, 'q-socket');
  room.setPack(loaded);
  room.updateSettings(H.id, { timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  assert.equal(room.ownerId, P.id);

  const restored = await saveAndRestore(t, room, (saved) => { saved.packFile = 'removed-pack.siq'; });
  restored.attach(P.id, 'p-again');
  restored.attach(Q.id, 'q-again');
  // H stays offline: the ghost host. After the handover wait (UX-7), the owner moderates.
  // The handover is ended by a direct call; grace timers below run on real time.
  markHandoverReady(restored, H.id);
  assert.equal(restored.canModerate(P.id), true);
  restored.setRole(P.id, H.id, 'spectator');
  restored.setRole(P.id, Q.id, 'host');
  restored.setPack(await loadPack(loaded.file));
  // releaseExpiredSeats skips seats whose grace timer is still pending, so wait it out.
  await outlastGrace();
  restored.engine.start();
  assert.equal(restored.participants.has(H.id), false);
  assert.equal(restored.host()?.id, Q.id);
  assert.equal(restored.engine.phase, 'board');
});

test('(d) a saved game over keeps player seats, releases spectators, and start() frees offline seats', async (t) => {
  const { room, host, player, spectator } = createRoom(t);
  room.adjustScore(host.id, player.id, 500);
  room.engine.phase = 'gameOver';
  const restored = await saveAndRestore(t, room);
  assert.equal(restored.engine.phase, 'gameOver');
  await outlastGrace();
  assert.equal(restored.participants.get(player.id).score, 500);
  assert.equal(restored.participants.get(host.id).role, 'host');
  assert.equal(restored.participants.has(spectator.id), false);
  restored.releaseExpiredSeats();
  assert.equal(restored.participants.size, 0);
});

test('(e) reconnecting first does not take ownership while the owner is in grace', async (t) => {
  const { room, host, player } = createRoom(t);
  const restored = await saveAndRestore(t, room);
  restored.attach(player.id, 'player-again');
  assert.equal(restored.ownerId, host.id);
  // The owner guard in Room.attach only sees timers in this map.
  assert.ok(restored.removalTimers.has(host.id));
  await outlastGrace();
  assert.equal(restored.ownerId, player.id);
});

test('(f) restore grace timers do not keep the process alive', async (t) => {
  const { room } = createRoom(t);
  const restored = await saveAndRestore(t, room);
  assert.equal(restored.removalTimers.size, 3);
  for (const timer of restored.removalTimers.values()) assert.equal(timer.hasRef(), false);
});

test('(g) a reconnect clears restore keep mode, so a later lobby drop is released', async (t) => {
  const { room, player } = createRoom(t);
  const restored = await saveAndRestore(t, room);
  restored.attach(player.id, 'player-again');
  restored.engine.stop();
  assert.equal(restored.engine.phase, 'lobby');
  restored.detach(player.id, 'player-again');
  await outlastGrace();
  assert.equal(restored.participants.has(player.id), false);
});
