/**
 * Ping telemetry and fair buzzer reconciliation over slow links.
 *
 * Merged onto the local buzzer design (buzzTiming.ts): the open lead and comparison window grow
 * from the slowest player's reported round trip, and the podium shows each link's ping and jitter.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-ping-sync-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');

await import('./make-sample-pack.ts');
const [{ Room }, { registerSocketHandlers }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/socket/handlers.ts'),
  import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function setupGame(t, settings = {}) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const fastPlayer = room.join('FastLAN').participant;
  room.attach(fastPlayer.id, 'fast-socket');
  const wifiPlayer = room.join('SlowWiFi').participant;
  room.attach(wifiPlayer.id, 'wifi-socket');

  room.setPack(structuredClone(loaded));
  room.updateSettings(host.id, { gameMode: 'simple', timeForQuestionIntro: 0, timeForQuestionReady: 0, ...settings });
  room.engine.start();

  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });

  return { room, engine: room.engine, host, fastPlayer, wifiPlayer };
}

test('ping tracking records RTT, one-way latency, jitter, and exposes live telemetry in snapshots', (t) => {
  const { room, host, fastPlayer, wifiPlayer } = setupGame(t);

  room.recordPing(host.id, 1);
  room.recordPing(fastPlayer.id, 4);
  room.recordPing(wifiPlayer.id, 80);
  room.recordPing(wifiPlayer.id, 90);
  room.recordPing(wifiPlayer.id, 100);

  // The host's link never paces the buzzer; the slowest seated player's latest report does.
  assert.equal(room.worstPlayerRttMs(), 100);

  const snap = room.snapshotFor(host.id);
  const wifiView = snap.participants.find((p) => p.id === wifiPlayer.id);
  assert.equal(wifiView?.pingMs, 100);
  assert.equal(wifiView?.oneWayMs, 50);
  assert.ok(typeof wifiView?.jitterMs === 'number' && wifiView.jitterMs > 0);
  assert.equal(snap.participants.find((p) => p.id === host.id)?.pingMs, 1);

  // An offline seat shows no stale figure.
  room.detach(wifiPlayer.id, 'wifi-socket');
  assert.equal(room.snapshotFor(host.id).participants.find((p) => p.id === wifiPlayer.id)?.pingMs, null);
});

test('only a noticeable ping change re-broadcasts the room', (t) => {
  const { room, fastPlayer } = setupGame(t);
  room.recordPing(fastPlayer.id, 40);
  let broadcasts = 0;
  room.changed = () => { broadcasts++; };
  room.recordPing(fastPlayer.id, 45);
  assert.equal(broadcasts, 0, 'Wi-Fi noise does not redraw every screen');
  room.recordPing(fastPlayer.id, 60);
  assert.equal(broadcasts, 1);
});

test('fair buzzer reconciliation awards slower-ping player who pressed earlier in synchronized time', async (t) => {
  const { room, engine, host, fastPlayer, wifiPlayer } = setupGame(t);

  room.recordPing(host.id, 0);
  room.recordPing(fastPlayer.id, 4);   // 2ms one-way
  room.recordPing(wifiPlayer.id, 100); // 50ms one-way

  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();

  const openedAt = engine.buzzer.openedAt;
  assert.ok(openedAt > Date.now(), 'openedAt is scheduled in the future by the open lead');

  // Wait until openedAt + 85ms so FastLAN's press at openedAt + 80ms is in the past when it arrives
  await delay(Math.max(10, openedAt - Date.now() + 85));

  // FastLAN pressed at openedAt + 80ms (arrives first at server at ~openedAt + 85ms)
  assert.equal(engine.buzz(fastPlayer.id, { clientAt: openedAt + 80 }).result, 'queued');
  // SlowWiFi pressed earlier at openedAt + 55ms, but packet arrives 30ms later (~openedAt + 115ms)
  await delay(30);
  assert.equal(engine.buzz(wifiPlayer.id, { clientAt: openedAt + 55 }).result, 'queued');

  // The comparison window is the 200 ms floor here (100 ms round trip / 2 + 80 ms margin is less).
  await delay(250);

  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, wifiPlayer.id, 'SlowWiFi wins because they pressed 25ms earlier');
  assert.equal(engine.buzzer.winnerInfo?.mode, 'clientTimestamp');
  assert.equal(engine.buzzer.winnerInfo?.contenders, 2);
});

test('timestamps predating scheduled unlock time are rejected as false starts', (t) => {
  const { room, engine, host, fastPlayer, wifiPlayer } = setupGame(t, { falseStart: true });

  room.recordPing(fastPlayer.id, 4);
  room.recordPing(wifiPlayer.id, 120);

  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  const openedAt = engine.buzzer.openedAt;

  // FastLAN tries to buzz before openedAt
  const res = engine.buzz(fastPlayer.id, { clientAt: openedAt - 50 });
  assert.equal(res.result, 'falseStart');
  assert.ok(engine.buzzer.blockedUntil.get(fastPlayer.id) > Date.now());
});

test('multi-round test game over simulated network with 500-900ms additional ping session', async (t) => {
  const room = new Room();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });

  let onConnection;
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    on(event, cb) {
      if (event === 'connection') onConnection = cb;
    },
    to(socketId) {
      return {
        emit(event, payload) {
          const sock = sockets.get(socketId);
          if (sock) sock._deliverFromServer(event, structuredClone(payload));
        },
      };
    },
  };
  registerSocketHandlers(io, room);

  /**
   * Creates a simulated networked client with configurable one-way latency (RTT = 2 * oneWayMs ± jitter)
   * and an unsynchronized local hardware clock offset (clockSkewMs).
   */
  function createNetworkClient(name, { oneWayMs = 0, jitterMs = 0, clockSkewMs = 0 } = {}) {
    const serverHandlers = new Map();
    const clientHandlers = new Map();
    let clockOffsetMs = 0;
    let bestRtt = Infinity;
    let smoothRtt = null;

    const sampleOneWay = () => {
      const j = jitterMs > 0 ? Math.round((Math.random() * 2 - 1) * jitterMs) : 0;
      return Math.max(0, oneWayMs + j);
    };

    // Unsynchronized local clock
    const localNow = () => Date.now() + clockSkewMs;
    // Synchronized server clock estimate on client
    const serverNow = () => localNow() + clockOffsetMs;

    const socket = {
      id: `sock-${name}`,
      data: {},
      handshake: { address: '127.0.0.1' },
      join() {},
      leave() {},
      on(event, fn) {
        serverHandlers.set(event, fn);
      },
      // Server -> Client delivery (delayed by one-way latency)
      emit(event, payload) {
        this._deliverFromServer(event, structuredClone(payload));
      },
      _deliverFromServer(event, payload) {
        const d = sampleOneWay();
        setTimeout(() => {
          const fn = clientHandlers.get(event);
          if (fn) fn(payload);
        }, d);
      },
    };

    sockets.set(socket.id, socket);
    onConnection(socket);

    const client = {
      name,
      socket,
      state: null,
      events: [],
      unlockedBuzzers: [],          // wallClockMs when client unlocked buzzer
      get clockOffsetMs() { return clockOffsetMs; },
      get smoothRtt() { return smoothRtt; },
      localNow,
      serverNow,
      // Client -> Server emit with ACK (delayed by oneWayMs each way => full RTT)
      emit(event, payload = {}) {
        return new Promise((resolve) => {
          const upDelay = sampleOneWay();
          setTimeout(() => {
            const handler = serverHandlers.get(event);
            if (!handler) return resolve(undefined);
            handler(structuredClone(payload), (ackResponse) => {
              const downDelay = sampleOneWay();
              setTimeout(() => resolve(structuredClone(ackResponse)), downDelay);
            });
          }, upDelay);
        });
      },
      // Runs the client clock sync sample algorithm (matching syncClockSample in client/src/app.ts)
      async syncClockSample() {
        const t0 = localNow();
        const res = await client.emit('clock:ping', smoothRtt == null ? {} : { rtt: Math.round(smoothRtt) });
        const t2 = localNow();
        if (!res || typeof res.serverTime !== 'number') return;
        const rtt = t2 - t0;
        smoothRtt = smoothRtt == null ? rtt : smoothRtt * 0.7 + rtt * 0.3;
        const sampleOffset = res.serverTime + rtt / 2 - t2;
        if (rtt <= bestRtt) {
          bestRtt = rtt;
          clockOffsetMs = sampleOffset;
        } else if (rtt <= bestRtt * 1.5 + 10) {
          clockOffsetMs = clockOffsetMs * 0.8 + sampleOffset * 0.2;
        }
      },
      // Presses the buzzer at a specific wall-clock moment, attaching client's synchronized serverNow()
      async pressBuzzer() {
        const clientAt = Math.round(serverNow());
        return client.emit('game:buzz', { clientAt });
      },
    };

    clientHandlers.set('room:state', (snap) => {
      client.state = snap;
    });

    clientHandlers.set('game:event', (evt) => {
      client.events.push(evt);
      if (evt.type === 'buzzerOpen' && typeof evt.openedAt === 'number') {
        const waitMs = Math.max(0, evt.openedAt - serverNow());
        setTimeout(() => {
          client.unlockedBuzzers.push(Date.now());
        }, waitMs);
      }
    });

    return client;
  }

  // Create 3 sessions:
  // 1. Host (0ms loopback)
  // 2. FastLAN (10ms RTT = 5ms one-way, +300ms local clock skew)
  // 3. HighPingPlayer (~700ms RTT = 350ms one-way, within the 500-900ms additional ping range, -950ms local clock skew)
  const hostClient = createNetworkClient('Host', { oneWayMs: 0, jitterMs: 0, clockSkewMs: 0 });
  const fastLan = createNetworkClient('FastLAN', { oneWayMs: 5, jitterMs: 1, clockSkewMs: 300 });
  const highPing = createNetworkClient('HighPing700ms', { oneWayMs: 350, jitterMs: 10, clockSkewMs: -950 });

  // Join room & assign roles
  const hJoin = await hostClient.emit('session:join', { nickname: 'Host' });
  assert.equal(hJoin.ok, true);
  await hostClient.emit('role:choose', { role: 'host' });

  const fJoin = await fastLan.emit('session:join', { nickname: 'FastLAN' });
  assert.equal(fJoin.ok, true);
  const fId = room.tokens.get(fJoin.token);

  const hpJoin = await highPing.emit('session:join', { nickname: 'HighPing700ms' });
  assert.equal(hpJoin.ok, true);
  const hpId = room.tokens.get(hpJoin.token);

  // Run 4 rounds of clock:ping heartbeats so all clients synchronize clocks and report RTT to server
  for (let i = 0; i < 4; i++) {
    await Promise.all([
      hostClient.syncClockSample(),
      fastLan.syncClockSample(),
      highPing.syncClockSample(),
    ]);
  }

  // Verify clock synchronization accuracy and server ping telemetry
  assert.ok(Math.abs(fastLan.serverNow() - Date.now()) < 25, `FastLAN synced clock within 25ms (err=${fastLan.serverNow() - Date.now()}ms)`);
  assert.ok(Math.abs(highPing.serverNow() - Date.now()) < 35, `HighPing700ms synced clock within 35ms despite 700ms RTT & -950ms skew (err=${highPing.serverNow() - Date.now()}ms)`);

  const maxPing = room.worstPlayerRttMs();
  assert.ok(maxPing >= 650 && maxPing <= 760, `Server tracked HighPing700ms RTT in 500-900ms range: ${maxPing}ms`);

  // Load pack and start game in Simple mode across multiple rounds
  room.setPack(structuredClone(loaded));
  await hostClient.emit('settings:update', {
    gameMode: 'simple',
    timeForQuestionIntro: 0,
    timeForQuestionReady: 0,
    falseStart: true,
  });
  const startRes = await hostClient.emit('game:start');
  assert.equal(startRes.ok, true);
  assert.equal(room.engine.phase, 'board');
  assert.equal(room.engine.roundIndex, 0);

  // --- ROUND 1, QUESTION 1: HighPing700ms buzzes 35ms earlier than FastLAN in synchronized time ---
  const sel1 = await hostClient.emit('game:select', { themeIndex: 0, questionIndex: 0 });
  assert.equal(sel1.ok, true);
  const q1Price = room.engine.current.price;

  assert.equal(room.engine.phase, 'reading');

  // Host opens buzzer for Question 1
  await hostClient.emit('game:openBuzzer');
  const open1At = room.engine.buzzer.openedAt;
  // The open signal must reach the 350 ms one-way client before its screen is due to turn green.
  assert.ok(open1At - Date.now() >= 350, `Buzzer openedAt leads the slowest link (${open1At - Date.now()}ms)`);

  // Wait until buzzer unlocks simultaneously on all clients
  await delay(Math.max(10, open1At - Date.now() + 25));

  // HighPing700ms presses FIRST (at open1At + 25ms), FastLAN presses 35ms LATER (at open1At + 60ms).
  // Note: FastLAN's packet reaches the server ~310ms BEFORE HighPing700ms's packet!
  const hpBuzz1Promise = highPing.pressBuzzer();
  await delay(35);
  const fastBuzz1Promise = fastLan.pressBuzzer();

  await Promise.all([hpBuzz1Promise, fastBuzz1Promise]);
  // Wait for server reconciliation window to complete
  await delay(500);

  assert.equal(room.engine.phase, 'answering');
  assert.equal(
    room.engine.buzzer.winnerId,
    hpId,
    'HighPing700ms won Q1 buzzer despite 350ms one-way latency because they pressed 35ms earlier in synced time',
  );

  // Judge HighPing700ms correct!
  await hostClient.emit('game:judge', { correct: true });
  assert.equal(room.participants.get(hpId).score, q1Price);

  // Advance from reveal to board
  if (room.engine.phase === 'reveal') {
    await hostClient.emit('game:next');
  }
  assert.equal(room.engine.phase, 'board');

  // --- ROUND 1, QUESTION 2: FastLAN presses 40ms earlier than HighPing700ms ---
  await hostClient.emit('game:select', { themeIndex: 0, questionIndex: 1 });
  const q2Price = room.engine.current.price;
  await hostClient.emit('game:openBuzzer');
  const open2At = room.engine.buzzer.openedAt;
  await delay(Math.max(10, open2At - Date.now() + 25));

  const fastBuzz2Promise = fastLan.pressBuzzer();
  await delay(40);
  const hpBuzz2Promise = highPing.pressBuzzer();
  await Promise.all([fastBuzz2Promise, hpBuzz2Promise]);
  await delay(500);

  assert.equal(room.engine.phase, 'answering');
  assert.equal(
    room.engine.buzzer.winnerId,
    fId,
    'FastLAN won Q2 buzzer when physically pressing 40ms before HighPing700ms',
  );

  // FastLAN answers wrong -> buttons reopen -> HighPing700ms buzzes and answers right!
  await hostClient.emit('game:judge', { correct: false });
  assert.equal(room.participants.get(fId).score, -q2Price);
  assert.equal(room.engine.phase, 'buzzerOpen');

  const reopen2At = room.engine.buzzer.openedAt;
  await delay(Math.max(10, reopen2At - Date.now() + 25));
  await highPing.pressBuzzer();
  await delay(500);

  assert.equal(room.engine.phase, 'answering');
  assert.equal(room.engine.buzzer.winnerId, hpId);
  await hostClient.emit('game:judge', { correct: true });
  assert.equal(room.participants.get(hpId).score, q1Price + q2Price);

  if (room.engine.phase === 'reveal') {
    await hostClient.emit('game:next');
  }

  // --- ADVANCE TO ROUND 2 AND PLAY ROUND 2 WITH 700ms PING ---
  const nextRoundRes = await hostClient.emit('game:nextRound');
  assert.equal(nextRoundRes.ok, true);
  assert.equal(room.engine.roundIndex, 1);

  if (room.engine.round.type !== 'final') {
    await hostClient.emit('game:select', { themeIndex: 0, questionIndex: 0 });
    const r2Price = room.engine.current.price;
    await hostClient.emit('game:openBuzzer');
    const openR2At = room.engine.buzzer.openedAt;
    await delay(Math.max(10, openR2At - Date.now() + 25));

    const hpR2Promise = highPing.pressBuzzer();
    await delay(30);
    const fastR2Promise = fastLan.pressBuzzer();
    await Promise.all([hpR2Promise, fastR2Promise]);
    await delay(500);

    assert.equal(room.engine.phase, 'answering');
    assert.equal(room.engine.buzzer.winnerId, hpId, 'HighPing700ms wins Round 2 tie-breaker when pressing 30ms earlier');
    await hostClient.emit('game:judge', { correct: true });
    assert.equal(room.participants.get(hpId).score, q1Price + q2Price + r2Price);
  }
});
