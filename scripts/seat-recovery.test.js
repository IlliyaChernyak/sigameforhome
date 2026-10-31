/**
 * A player back on a new device gets their old seat and score from the host in one step
 * (device playtest F7), and the join error points them there.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-seat-recovery-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }, { registerSocketHandlers }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'), import('../server/socket/handlers.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

/** Host and Alice (300 points, chooser) in a started game; Alice's phone has died. */
function lostPhone(t) {
  const room = new Room();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const alice = room.join('Alice').participant;
  room.attach(alice.id, 'alice-old');
  room.setPack(loaded);
  room.updateSettings(host.id, { gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  alice.score = 300;
  room.engine.chooserId = alice.id;
  room.detach(alice.id, 'alice-old');
  return { room, host, alice, oldToken: alice.token };
}

test('the join error for an offline seat points at the way back', (t) => {
  const { room } = lostPhone(t);
  assert.throws(() => room.join('alice'), /offline.*host can give you that seat back/);
});

test('the host gives the offline seat to the newcomer: score, id and turn stay', (t) => {
  const { room, host, alice, oldToken } = lostPhone(t);
  const newcomer = room.join('Alice 2').participant;
  room.attach(newcomer.id, 'alice-new');
  const newToken = newcomer.token;

  assert.equal(room.giveSeat(host.id, alice.id, newcomer.id), 'alice-new');
  assert.equal(room.participants.has(newcomer.id), false, 'the temporary seat is gone');
  const seat = room.participants.get(alice.id);
  assert.deepEqual([seat.name, seat.score, seat.connected, seat.socketId], ['Alice', 300, true, 'alice-new']);
  assert.equal(room.engine.chooserId, alice.id);
  assert.equal(room.resume(newToken)?.id, alice.id, 'the new device reopens the seat after a refresh');
  assert.equal(room.resume(oldToken), null, 'the lost device cannot come back into it');
  assert.equal(room.removalTimers.has(alice.id), false, 'no reconnect timer left on the seat');
});

test('a seat is given back only by the host, only when offline, only between questions', (t) => {
  const { room, host, alice } = lostPhone(t);
  const newcomer = room.join('Alice 2').participant;
  room.attach(newcomer.id, 'alice-new');
  assert.throws(() => room.giveSeat(newcomer.id, alice.id, newcomer.id), /Only the host/);
  assert.throws(() => room.giveSeat(host.id, host.id, newcomer.id), /Only a player seat/);
  assert.throws(() => room.giveSeat(host.id, alice.id, host.id), /host cannot take/);

  room.engine.selectQuestion(host.id, true, 0, 0);
  assert.throws(() => room.giveSeat(host.id, alice.id, newcomer.id), /question is over/);
  room.engine.pause();
  assert.throws(() => room.giveSeat(host.id, alice.id, newcomer.id), /question is over/);
  room.engine.resume();
  room.engine.reset();

  room.attach(alice.id, 'alice-old');
  assert.throws(() => room.giveSeat(host.id, alice.id, newcomer.id), /still connected/);
});

class FakeSocket extends EventEmitter {
  constructor(id) { super(); this.id = id; this.data = {}; this.handshake = { address: '127.0.0.1' }; this.received = []; }
  join() {}
  leave() {}
  disconnect() { this.emit('disconnect'); }
}

test('seat:give rebinds the new device to the old seat', async (t) => {
  const room = new Room();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
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
  const oldPhone = connect('old');
  await send(oldPhone, 'session:join', { nickname: 'Alice' });
  const seatId = oldPhone.data.pid;
  room.participants.get(seatId).score = 300;
  oldPhone.disconnect();
  const newPhone = connect('new');
  await send(newPhone, 'session:join', { nickname: 'Alice 2' });

  const reply = await send(hostSocket, 'seat:give', { seatId, newcomerId: newPhone.data.pid });
  assert.equal(reply.ok, true);
  assert.equal(newPhone.data.pid, seatId);
  // The rebound socket acts as the old seat: it may rename itself in the lobby, as Alice.
  assert.equal((await send(newPhone, 'participant:rename', { name: 'Alice' })).ok, true);
  assert.equal(room.participants.get(seatId).score, 300);
  assert.equal(room.participants.size, 2);
});
