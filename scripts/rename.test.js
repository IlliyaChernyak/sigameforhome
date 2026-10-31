/** Rename keeps seat identity, follows join rules, and supports the new-phone recovery flow (audit QOL-2). */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-rename-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');
await import('./make-sample-pack.ts');
const [{ Room }, { listPacks, loadPack }, { persistRoom, restoreRoom }, { renameParticipant }, { registerSocketHandlers }] =
  await Promise.all([
    import('../server/game/Room.ts'),
    import('../server/packs/packManager.ts'),
    import('../server/game/persistence.ts'),
    import('../server/game/nickname.ts'),
    import('../server/socket/handlers.ts'),
  ]);
const loaded = await loadPack((await listPacks()).find((pack) => pack.name.includes('v5')).file);
after(async () => rm(root, { recursive: true, force: true }));

function cleanup(t, room) {
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
}

function createRoom(t, { start = false } = {}) {
  const room = new Room();
  cleanup(t, room);
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player');
  const other = room.join('Other').participant;
  room.attach(other.id, 'other');
  room.setPack(loaded);
  room.updateSettings(host.id, { timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  if (start) room.engine.start();
  return { room, host, player, other };
}

test('the moderator renames anyone in any phase', (t) => {
  const { room, host, player } = createRoom(t, { start: true });
  renameParticipant(room, host.id, player.id, 'Renamed');
  assert.equal(room.participants.get(player.id).name, 'Renamed');
});

test('a player renames themselves only in the lobby, and never others', (t) => {
  const { room, player, other } = createRoom(t);
  renameParticipant(room, player.id, player.id, 'Me');
  assert.equal(room.participants.get(player.id).name, 'Me');
  assert.throws(() => renameParticipant(room, player.id, other.id, 'You'), /Only the host can rename/);
  room.engine.start();
  assert.throws(() => renameParticipant(room, player.id, player.id, 'Later'), /in the lobby/);
});

test('names follow the join rules', (t) => {
  const { room, host, player } = createRoom(t);
  renameParticipant(room, host.id, player.id, '  A\u0007nn  ');
  assert.equal(room.participants.get(player.id).name, 'Ann');
  renameParticipant(room, host.id, player.id, 'x'.repeat(40));
  assert.equal(room.participants.get(player.id).name.length, 24);
  assert.throws(() => renameParticipant(room, host.id, player.id, '   '), /enter a nickname/);
  assert.throws(() => renameParticipant(room, host.id, player.id, 'OTHER'), /already taken/);
  renameParticipant(room, host.id, player.id, 'ann'); // a participant may keep or recase their own name
  assert.throws(() => room.join('ANN'), /already taken/);
});

test('rename keeps the id, score and seat', (t) => {
  const { room, host, player } = createRoom(t, { start: true });
  room.adjustScore(host.id, player.id, 200);
  renameParticipant(room, host.id, player.id, 'Kept');
  const p = room.participants.get(player.id);
  assert.deepEqual([p.id, p.score, p.role, p.token], [player.id, 200, 'player', player.token]);
});

test('the new-phone flow: remove the ghost, rename the newcomer, restore the score', (t) => {
  const { room, host } = createRoom(t, { start: true });
  const alex = room.join('Alex').participant;
  room.attach(alex.id, 'alex');
  room.adjustScore(host.id, alex.id, 300);
  room.detach(alex.id, 'alex'); // Alex's phone died
  const newcomer = room.join('Alex2').participant;
  room.attach(newcomer.id, 'alex-new');
  room.kick(host.id, alex.id);
  renameParticipant(room, host.id, newcomer.id, 'Alex');
  room.adjustScore(host.id, newcomer.id, 300);
  const alexes = room.snapshotFor(host.id).participants.filter((p) => p.name === 'Alex');
  assert.deepEqual(alexes.map((p) => [p.id, p.score]), [[newcomer.id, 300]]);
});

test('a new name survives a restart', async (t) => {
  const { room, host, player } = createRoom(t);
  renameParticipant(room, host.id, player.id, 'Saved name');
  const stateFile = path.join(root, 'rename-state.json');
  await persistRoom(room, stateFile)();
  const restored = new Room();
  cleanup(t, restored);
  await restoreRoom(restored, stateFile);
  assert.equal(restored.participants.get(player.id).name, 'Saved name');
});

class FakeSocket extends EventEmitter {
  constructor(id) { super(); this.id = id; this.data = {}; this.handshake = { address: '127.0.0.1' }; this.received = []; }
  join() {}
  leave() {}
  disconnect() { this.emit('disconnect'); }
}

test('a rename re-broadcasts the room to everyone', async (t) => {
  const room = new Room();
  cleanup(t, room);
  let onConnection;
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to(id) { return { emit(event, payload) { sockets.get(id)?.received.push([event, payload]); } }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => { const s = new FakeSocket(id); sockets.set(id, s); onConnection(s); return s; };
  const send = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  const hostSocket = connect('host');
  await send(hostSocket, 'session:join', { nickname: 'Host' });
  await send(hostSocket, 'role:choose', { role: 'host' });
  const playerSocket = connect('player');
  await send(playerSocket, 'session:join', { nickname: 'Player' });
  await new Promise(setImmediate);
  playerSocket.received.length = 0;

  const changed = once(room, 'change');
  assert.equal((await send(hostSocket, 'participant:rename', { targetId: playerSocket.data.pid, name: 'Bea' })).ok, true);
  await changed;
  const states = playerSocket.received.filter(([event]) => event === 'room:state');
  assert.ok(states.length > 0, 'the other client receives room:state');
  assert.equal(states.at(-1)[1].you.name, 'Bea');
});
