/** One socket must never receive another seat's private state or keep stale permissions. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-socket-binding-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room, MAX_ROOM_PARTICIPANTS }, { registerSocketHandlers }, { listPacks, loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/socket/handlers.ts'),
  import('../server/packs/packManager.ts'),
]);
const { markHandoverReady } = await import('../server/game/moderationHandover.ts');
const packFile = (await listPacks()).find((pack) => pack.name.includes('v5')).file;
after(() => rm(root, { recursive: true, force: true }));

class FakeSocket extends EventEmitter {
  constructor(id, address = '127.0.0.1') {
    super();
    this.id = id;
    this.data = {};
    this.handshake = { address };
  }
  join() {}
  leave() {}
  disconnect() { this.emit('disconnect'); }
}

test('room size bounds spectators as well as player seats', () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  for (let index = 0; index < MAX_ROOM_PARTICIPANTS; index++) room.join(`Guest ${index}`);
  assert.throws(() => room.join('One too many'), /room is full/);
  room.remove([...room.participants.keys()][0]);
  assert.doesNotThrow(() => room.join('Replacement'));
});

test('manual score changes retain safe whole-number totals', () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-score');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.adjustScore(host.id, player.id, 1_000_000_000_000);
  assert.equal(player.score, 1_000_000_000_000);
  assert.throws(() => room.adjustScore(host.id, player.id, 1), /safe whole-number/);
  assert.throws(() => room.adjustScore(host.id, player.id, 0.5), /safe whole-number/);
  assert.equal(player.score, 1_000_000_000_000);
});

test('new join attempts are throttled by source address while resume stays available', async () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id, '192.0.2.10');
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
  let firstToken;
  for (let index = 0; index < 20; index++) {
    const joined = await send(connect(`join-${index}`), 'session:join', { nickname: `Guest ${index}` });
    assert.equal(joined.ok, true);
    firstToken ??= joined.token;
  }
  const denied = await send(connect('denied'), 'session:join', { nickname: 'Extra' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Too many join attempts/);
  assert.equal(room.participants.size, 20);

  const resumed = await send(connect('resumed'), 'session:resume', { token: firstToken });
  assert.equal(resumed.resumed, true);
});

test('typed answer socket event accepts only the winner and keeps text private', async (t) => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  Object.assign(room.settings, INSTANT_BUZZER);
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  const hostSocket = connect('oral-host');
  const hostJoin = await send(hostSocket, 'session:join', { nickname: 'Host' });
  await send(hostSocket, 'role:choose', { role: 'host' });
  const winnerSocket = connect('oral-winner');
  const winnerJoin = await send(winnerSocket, 'session:join', { nickname: 'Winner' });
  const otherSocket = connect('oral-other');
  const otherJoin = await send(otherSocket, 'session:join', { nickname: 'Other' });
  const hostId = room.tokens.get(hostJoin.token);
  const winnerId = room.tokens.get(winnerJoin.token);
  const otherId = room.tokens.get(otherJoin.token);
  room.setPack(await loadPack(packFile));
  room.updateSettings(hostId, { oral: false });
  room.engine.start();
  room.engine.selectQuestion(hostId, true, 0, 0);
  room.engine.openBuzzer();
  room.engine.buzz(winnerId);
  t.after(() => room.engine.reset());

  assert.match((await send(otherSocket, 'game:answer', { answer: 'steal' })).error, /current answerer/);
  assert.equal((await send(winnerSocket, 'game:answer', { answer: '  Paris  ' })).ok, true);
  assert.equal(room.snapshotFor(hostId).game.buzzer.typedAnswer.text, 'Paris');
  assert.equal(room.snapshotFor(winnerId).game.buzzer.typedAnswer.text, 'Paris');
  assert.equal(room.snapshotFor(otherId).game.buzzer.typedAnswer.text, null);
  assert.match((await send(winnerSocket, 'game:answer', { answer: 'second' })).error, /time has ended|already submitted/i);
});

test('one socket cannot flood commands while clock sync stays available', async () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const socket = new FakeSocket('command-flood');
  io.sockets.sockets.set(socket.id, socket);
  onConnection(socket);
  const send = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  assert.equal((await send('session:join', { nickname: 'Player' })).ok, true);
  for (let index = 0; index < 119; index++) {
    assert.equal((await send('game:buzz')).ok, true);
  }
  const denied = await send('game:buzz');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Too many commands/);
  for (let index = 0; index < 50; index++) {
    assert.equal((await send('clock:ping')).ok, true);
  }
  assert.match((await send('clock:ping')).error, /Too many clock probes/);
});

test('a repeated false start is ignored without extending its penalty', async () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) =>
    new Promise((resolve) => socket.emit(event, payload, resolve));
  const host = connect('host');
  await send(host, 'session:join', { nickname: 'Host' });
  await send(host, 'role:choose', { role: 'host' });
  const player = connect('player');
  const joined = await send(player, 'session:join', { nickname: 'Player' });
  const pid = room.tokens.get(joined.token);
  room.engine.phase = 'reading';
  let falseStarts = 0;
  room.on('event', (event) => { if (event.type === 'falseStart') falseStarts++; });

  assert.equal((await send(player, 'game:buzz')).result, 'falseStart');
  const penaltyEndsAt = room.engine.buzzer.blockedUntil.get(pid);
  assert.equal((await send(player, 'game:buzz')).result, 'ignored');
  assert.equal(room.engine.buzzer.blockedUntil.get(pid), penaltyEndsAt);
  assert.equal(falseStarts, 1);
});

test('a joined socket cannot switch seats and a replaced socket loses access', async () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) =>
    new Promise((resolve) => socket.emit(event, payload, resolve));

  const first = connect('first');
  const host = await send(first, 'session:join', { nickname: 'Host' });
  assert.equal(host.ok, true);
  assert.equal((await send(first, 'role:choose', { role: 'host' })).ok, true);
  const second = connect('second');
  const player = await send(second, 'session:join', { nickname: 'Player' });
  assert.equal(player.ok, true);

  const switchSeat = await send(first, 'session:resume', { token: player.token });
  assert.equal(switchSeat.ok, false);
  assert.match(switchSeat.error, /Already joined/);
  assert.equal(room.resume(host.token).socketId, first.id);
  assert.equal(room.resume(player.token).socketId, second.id);

  const replacement = connect('replacement');
  assert.equal((await send(replacement, 'session:resume', { token: host.token })).resumed, true);
  const staleAction = await send(first, 'settings:update', { ignoreWrong: true });
  assert.equal(staleAction.ok, false);
  assert.match(staleAction.error, /Session is no longer active/);
  assert.equal(room.settings.ignoreWrong, false);
  assert.equal((await send(replacement, 'settings:update', { ignoreWrong: true })).ok, true);
  assert.equal(room.settings.ignoreWrong, true);
});

test('only the current moderator can finish media after host recovery', async (t) => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) =>
    new Promise((resolve) => socket.emit(event, payload, resolve));
  const hostSocket = connect('host');
  const host = await send(hostSocket, 'session:join', { nickname: 'Host' });
  await send(hostSocket, 'role:choose', { role: 'host' });
  const playerSocket = connect('player');
  await send(playerSocket, 'session:join', { nickname: 'Player' });
  const loaded = await loadPack(packFile);
  const pack = structuredClone(loaded.pack);
  pack.rounds[0].themes[0].questions[0].content = [
    { type: 'video', value: 'clip', waitForFinish: true },
  ];
  room.setPack({ ...loaded, pack });
  room.engine.start();
  room.engine.selectQuestion(room.ownerId, true, 0, 0);
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  const presentationId = room.engine.current.presentationId;
  assert.equal((await send(playerSocket, 'game:contentFinished', { presentationId })).ok, false);
  assert.equal(room.engine.phase, 'reading');
  room.detach(room.ownerId, hostSocket.id);
  const oldHostId = room.tokens.get(host.token);
  clearTimeout(room.removalTimers.get(oldHostId));
  room.expire(oldHostId);
  assert.equal((await send(hostSocket, 'game:contentFinished', { presentationId })).ok, false);
  // UX-7: until the handover wait ends, the owner-player cannot moderate either.
  assert.deepEqual(await send(playerSocket, 'game:contentFinished', { presentationId }),
    { ok: false, error: 'Only the host can do that' });
  assert.equal(room.engine.phase, 'reading');
  markHandoverReady(room, oldHostId);
  assert.deepEqual(await send(playerSocket, 'game:contentFinished', { presentationId }),
    { ok: true, advanced: true });
  assert.deepEqual(await send(playerSocket, 'game:contentFinished', { presentationId }),
    { ok: true, advanced: false });
  assert.equal(room.engine.phase, 'buzzerOpen');
});

test('revoked manager cannot finish a pending pack load', async () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const socket = new FakeSocket('manager');
  io.sockets.sockets.set(socket.id, socket);
  onConnection(socket);
  const send = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  const joined = await send('session:join', { nickname: 'Host' });
  assert.equal(joined.ok, true);
  assert.equal((await send('role:choose', { role: 'host' })).ok, true);

  const pending = send('packs:load', { file: packFile });
  room.remove(room.ownerId);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(room.loadedPack, null);
});

test('only the moderator can undo the current exact judgment', async (t) => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  Object.assign(room.settings, INSTANT_BUZZER);
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  const hostSocket = connect('undo-host');
  const hostJoin = await send(hostSocket, 'session:join', { nickname: 'Host' });
  await send(hostSocket, 'role:choose', { role: 'host' });
  const playerSocket = connect('undo-player');
  const playerJoin = await send(playerSocket, 'session:join', { nickname: 'Player' });
  const hostId = room.tokens.get(hostJoin.token);
  const playerId = room.tokens.get(playerJoin.token);
  room.setPack(await loadPack(packFile));
  room.engine.start();
  room.engine.selectQuestion(hostId, true, 0, 0);
  room.engine.openBuzzer();
  room.engine.buzz(playerId);
  t.after(() => room.engine.reset());

  assert.equal((await send(hostSocket, 'game:judge', { correct: false })).ok, true);
  const target = room.snapshotFor(hostId).game.undoJudgment;
  assert.ok(target);
  assert.equal((await send(playerSocket, 'game:undoJudgment', target)).ok, false);
  assert.equal((await send(hostSocket, 'game:undoJudgment', { ...target, judgmentId: 99 })).ok, false);
  assert.equal(room.engine.current.judgments.length, 1);
  assert.deepEqual(await send(hostSocket, 'game:undoJudgment', target),
    { ok: true, playerId, delta: room.engine.current.price });
  assert.equal(room.engine.phase, 'answering');
  assert.equal(room.engine.current.judgments.length, 0);
});

test('verdict events reject non-boolean values', async () => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const socket = new FakeSocket('moderator');
  io.sockets.sockets.set(socket.id, socket);
  onConnection(socket);
  const send = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  await send('session:join', { nickname: 'Host' });
  await send('role:choose', { role: 'host' });

  let verdicts = 0;
  room.engine.judge = () => { verdicts++; };
  room.engine.judgeForAll = () => { verdicts++; };
  room.engine.judgeFinal = () => { verdicts++; };
  for (const event of ['game:judge', 'game:judgeForAll', 'game:judgeFinal']) {
    const response = await send(event, { playerId: 'someone', correct: 'false' });
    assert.equal(response.ok, false, `${event} must reject a string verdict`);
  }
  assert.equal(verdicts, 0);
  assert.equal((await send('game:judge', { correct: false })).ok, true);
  assert.equal(verdicts, 1);
});

test('a buzz from a socket that has not joined is rejected, not replayed (audit CONN-2)', async () => {
  // socket.io-client flushes a press buffered while offline before the app resumes its
  // session, so it arrives unjoined. The server must refuse it rather than score it later.
  const room = new Room();
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const socket = new FakeSocket('fresh');
  io.sockets.sockets.set(socket.id, socket);
  onConnection(socket);
  const reply = await new Promise((resolve) => socket.emit('game:buzz', {}, resolve));
  assert.deepEqual(reply, { ok: false, error: 'Join the game first' });
});

test('a stand-in host cannot rule on their own answer or score', async (t) => {
  const room = new Room();
  room.settings.timeForQuestionIntro = 0;
  room.settings.timeForQuestionReady = 0;
  Object.assign(room.settings, INSTANT_BUZZER);
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) =>
    new Promise((resolve) => socket.emit(event, payload, resolve));
  const hostSocket = connect('host');
  const host = await send(hostSocket, 'session:join', { nickname: 'Host' });
  await send(hostSocket, 'role:choose', { role: 'host' });
  const aliceSocket = connect('alice');
  const alice = await send(aliceSocket, 'session:join', { nickname: 'Alice' });
  const bobSocket = connect('bob');
  const bob = await send(bobSocket, 'session:join', { nickname: 'Bob' });
  const aliceId = room.tokens.get(alice.token);
  const bobId = room.tokens.get(bob.token);
  const hostId = room.tokens.get(host.token);
  room.setPack(await loadPack(packFile));
  room.engine.start();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  room.engine.selectQuestion(room.ownerId, true, 0, 0);
  room.engine.openBuzzer();
  await send(aliceSocket, 'game:buzz', {});
  assert.equal(room.engine.buzzer.winnerId, aliceId);

  // The host drops mid-answer; after the wait the owner role reaches Alice, the answerer.
  room.detach(hostId, hostSocket.id);
  markHandoverReady(room, hostId);
  assert.equal(room.canModerate(aliceId), true);
  for (const [event, payload] of [['game:judge', { correct: true }], ['game:passAnswer', {}],
    ['game:reveal', {}], ['game:next', {}], ['score:adjust', { targetId: aliceId, delta: 500 }],
    ['game:judgeForAll', { playerId: aliceId, correct: true }], ['game:judgeFinal', { playerId: aliceId, correct: true }]]) {
    assert.deepEqual(await send(aliceSocket, event, payload),
      { ok: false, error: 'Someone else must rule on your own answer' }, `${event} must be refused`);
  }
  assert.equal(room.engine.phase, 'answering');
  assert.equal(room.participants.get(aliceId).score, 0);
  // Ruling on someone else's score is still a stand-in's job.
  assert.equal((await send(aliceSocket, 'score:adjust', { targetId: bobId, delta: 100 })).ok, true);

  // The returning host rules as usual.
  const back = connect('host-back');
  await send(back, 'session:resume', { token: host.token });
  assert.equal((await send(back, 'game:judge', { correct: true })).ok, true);
  assert.equal(room.participants.get(aliceId).score, room.engine.current.price);
});

test('clock probes record a round trip only for the joined socket of a seat', async () => {
  const room = new Room();
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
  const unjoined = connect('clock-unjoined');
  const probe = await send(unjoined, 'clock:ping', { rtt: 900 });
  assert.equal(probe.ok, true);
  assert.ok(Number.isFinite(probe.serverTime));

  const hostSocket = connect('clock-host');
  const hostJoin = await send(hostSocket, 'session:join', { nickname: 'Host' });
  room.chooseInitialRole(hostJoin.you?.id ?? room.ownerId, 'host');
  const playerSocket = connect('clock-player');
  const joined = await send(playerSocket, 'session:join', { nickname: 'Player' });
  assert.equal(joined.ok, true);
  assert.equal(room.worstPlayerRttMs(), null, 'a probe before joining counts for nobody');
  await send(playerSocket, 'clock:ping', { rtt: 240 });
  assert.equal(room.worstPlayerRttMs(), 240);
  // Junk payloads are answered and ignored.
  assert.equal((await send(playerSocket, 'clock:ping', null)).ok, true);
  assert.equal((await send(playerSocket, 'clock:ping', 'x')).ok, true);
  assert.equal(room.worstPlayerRttMs(), 240);
});
