/** The owner stands in for an absent host only after a wait tied to that host (audit UX-7). */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-handover-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');
await import('./make-sample-pack.ts');
const [{ Room }, { listPacks, loadPack }, { persistRoom, restoreRoom }, { markHandoverReady, HANDOVER_MS }] =
  await Promise.all([
    import('../server/game/Room.ts'),
    import('../server/packs/packManager.ts'),
    import('../server/game/persistence.ts'),
    import('../server/game/moderationHandover.ts'),
  ]);
const loaded = await loadPack((await listPacks()).find((pack) => pack.name.includes('v5')).file);
after(async () => rm(root, { recursive: true, force: true }));

function cleanup(t, room) {
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
}

/** P joins first as a player, so P owns the room; H is appointed host; S is a spectator. */
function createRoom(t) {
  const room = new Room();
  cleanup(t, room);
  const P = room.join('P').participant;
  room.attach(P.id, 'p');
  room.chooseInitialRole(P.id, 'player');
  const H = room.join('H').participant;
  room.attach(H.id, 'h');
  room.setRole(P.id, H.id, 'host');
  const S = room.join('S').participant;
  room.attach(S.id, 's');
  room.setRole(S.id, S.id, 'spectator');
  return { room, P, H, S };
}

test('the owner waits after the host drops, then a change re-broadcasts the new rights', async (t) => {
  const { room, P, H } = createRoom(t);
  room.detach(H.id, 'h');
  assert.equal(room.canModerate(P.id), false);
  assert.equal(room.snapshotFor(P.id).you.canModerate, false);
  await new Promise(setImmediate); // let the detach broadcast settle first
  const changed = once(room, 'change');
  markHandoverReady(room, H.id);
  await changed;
  assert.equal(room.snapshotFor(P.id).you.canModerate, true);
});

test('the handover timer is armed for 10 s with the host id it was started for', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { room, P, H } = createRoom(t);
  room.detach(H.id, 'h');
  mock.timers.tick(HANDOVER_MS - 1);
  assert.equal(room.canModerate(P.id), false);
  mock.timers.tick(1);
  assert.equal(room.canModerate(P.id), true);
});

test('the host coming back clears the handover', (t) => {
  const { room, P, H } = createRoom(t);
  room.detach(H.id, 'h');
  room.attach(H.id, 'h2');
  markHandoverReady(room, H.id);
  room.detach(H.id, 'h2'); // a later drop starts a fresh wait
  assert.equal(room.canModerate(P.id), false);
});

test('a restore with the host offline starts the same wait', async (t) => {
  const { room, P, H } = createRoom(t);
  const stateFile = path.join(root, 'restore.json');
  await persistRoom(room, stateFile)();
  const restored = new Room();
  cleanup(t, restored);
  await restoreRoom(restored, stateFile);
  restored.attach(P.id, 'p-again');
  assert.equal(restored.canModerate(P.id), false);
  markHandoverReady(restored, H.id);
  assert.equal(restored.canModerate(P.id), true);
});

test('a host who also owns the room hands ownership over, so the seat can be reassigned', (t) => {
  const room = new Room();
  cleanup(t, room);
  const H = room.join('H').participant;
  room.attach(H.id, 'h');
  room.chooseInitialRole(H.id, 'host');
  const P = room.join('P').participant;
  room.attach(P.id, 'p');
  room.detach(H.id, 'h');
  assert.equal(room.ownerId, H.id); // a short blip moves nothing
  markHandoverReady(room, H.id);
  assert.equal(room.ownerId, P.id);
  assert.equal(room.canModerate(P.id), true);
  room.setRole(P.id, H.id, 'spectator');
  room.setRole(P.id, P.id, 'host');
  assert.equal(room.host()?.id, P.id);
});

test('a returning host keeps host rights after ownership moved', (t) => {
  const room = new Room();
  cleanup(t, room);
  const H = room.join('H').participant;
  room.attach(H.id, 'h');
  room.chooseInitialRole(H.id, 'host');
  const P = room.join('P').participant;
  room.attach(P.id, 'p');
  room.detach(H.id, 'h');
  markHandoverReady(room, H.id);
  room.attach(H.id, 'h2');
  assert.equal(room.canModerate(H.id), true);
  assert.equal(room.canModerate(P.id), false);
});

test('with no host at all the owner-player moderates at once', (t) => {
  const room = new Room();
  cleanup(t, room);
  const P = room.join('P').participant;
  room.attach(P.id, 'p');
  room.chooseInitialRole(P.id, 'player');
  assert.equal(room.host(), null);
  assert.equal(room.canModerate(P.id), true);
});

test('releasing or kicking the host clears the wait; with no host left the owner moderates', (t) => {
  const released = createRoom(t);
  released.room.detach(released.H.id, 'h');
  markHandoverReady(released.room, released.H.id);
  released.room.setRole(released.P.id, released.H.id, 'spectator');
  assert.equal(released.room.host(), null);
  assert.equal(released.room.canModerate(released.P.id), true);

  const kicked = createRoom(t);
  kicked.room.detach(kicked.H.id, 'h');
  markHandoverReady(kicked.room, kicked.H.id);
  kicked.room.kick(kicked.P.id, kicked.H.id);
  assert.equal(kicked.room.host(), null);
  assert.equal(kicked.room.canModerate(kicked.P.id), true);
});

test('appointing an offline participant as host starts the wait, so the owner is never locked out', (t) => {
  const room = new Room();
  cleanup(t, room);
  const P = room.join('P').participant;
  room.attach(P.id, 'p');
  room.chooseInitialRole(P.id, 'player');
  const X = room.join('X').participant;
  room.attach(X.id, 'x');
  room.detach(X.id, 'x'); // offline but inside the reconnect grace
  room.setRole(P.id, X.id, 'host');
  assert.equal(room.canModerate(P.id), false);
  markHandoverReady(room, X.id);
  assert.equal(room.canModerate(P.id), true);
});

test('a stale timer from an earlier host cannot hand over a newer one', (t) => {
  const { room, P, H: H1, S: H2 } = createRoom(t);
  room.detach(H1.id, 'h');
  markHandoverReady(room, H1.id);
  assert.equal(room.canModerate(P.id), true);
  room.setRole(P.id, H1.id, 'spectator');
  room.setRole(P.id, H2.id, 'host');
  room.detach(H2.id, 's');
  markHandoverReady(room, H1.id); // what H1's leftover timer would do
  assert.equal(room.canModerate(P.id), false);
  markHandoverReady(room, H2.id);
  assert.equal(room.canModerate(P.id), true);
});

test('the handover timer does not keep the process alive', (t) => {
  const { room, H } = createRoom(t);
  const unref = mock.method(globalThis.setTimeout(() => {}, 0).constructor.prototype, 'unref');
  t.after(() => unref.mock.restore());
  room.detach(H.id, 'h');
  // detach arms the reconnect grace timer and the handover timer; every one must be unref'd.
  assert.ok(unref.mock.callCount() >= 2);
});
