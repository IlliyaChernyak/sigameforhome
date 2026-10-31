/** Buzzer labels, offline state and press confirmation (audits UX-3, CONN-2), plus the host banner (UX-4). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACK_TIMEOUT_MS, buzzerView, createPressTracker, phaseLabel } from '../client/src/buzzerFeedback.ts';
import { hostBannerText } from '../client/src/hostBanner.ts';

const settings = { falseStart: true, timeForBlockingButton: 3 };
function input(phase, buzzer = {}, extra = {}) {
  return {
    game: { phase, current: { answerType: 'text' }, buzzer: { winnerId: null, attempted: [], blockedUntil: null, ...buzzer } },
    youId: 'me', settings, now: 1000, touchOnly: true, nameOf: () => 'Ann', ...extra,
  };
}

test('each phase has its label', () => {
  assert.deepEqual(phaseLabel(input('intro')), { tone: 'buzz-reading', main: 'Wait', sub: 'An early press blocks you for 3 s.' });
  assert.equal(phaseLabel(input('reading')).main, 'Wait for green');
  assert.equal(phaseLabel(input('reading', {}, { settings: { ...settings, falseStart: false } })).tone, 'buzz-open');
  assert.deepEqual(phaseLabel(input('buzzerOpen')), { tone: 'buzz-open', main: 'Buzz', sub: 'Tap here.' });
  assert.equal(phaseLabel(input('buzzerOpen', {}, { touchOnly: false })).sub, 'Tap here or press Space.');
  assert.equal(phaseLabel(input('answering', { winnerId: 'me' })).tone, 'buzz-you-answering');
  assert.equal(phaseLabel(input('answering', { winnerId: 'ann' })).main, 'Ann answers');
  assert.equal(phaseLabel(input('buzzerOpen', { attempted: ['me'] })).main, 'You already answered');
  assert.equal(phaseLabel(input('buzzerOpen', { blockedUntil: 2500 })).main, 'Blocked 1.5 s');
  assert.equal(phaseLabel(input('board')).tone, 'buzz-idle');
});

test('open buttons wait for the scheduled green signal on the synced clock', () => {
  // now is 1000 in input(): the signal at 1300 has not come yet, the one at 900 has.
  assert.equal(phaseLabel(input('buzzerOpen', { openedAt: 1300 })).main, 'Wait for green');
  assert.equal(phaseLabel(input('buzzerOpen', { openedAt: 900 })).tone, 'buzz-open');
});

test('offline disables a visible buzzer', () => {
  const view = buzzerView(phaseLabel(input('buzzerOpen')), false, 'idle');
  assert.equal(view.main, 'Offline');
  assert.equal(view.disabled, true);
  assert.deepEqual(view.flags, ['offline']);
  // An idle (hidden) buzzer stays idle; the connection bar already explains.
  assert.equal(buzzerView(phaseLabel(input('board')), false, 'idle').tone, 'buzz-idle');
});

test('sent and not-sent states', () => {
  const open = phaseLabel(input('buzzerOpen'));
  assert.deepEqual(buzzerView(open, true, 'sent').flags, ['sent']);
  const failed = buzzerView(open, true, 'failed');
  assert.equal(failed.main, 'Not sent');
  assert.deepEqual(failed.flags, ['not-sent']);
  assert.equal(failed.disabled, false);
});

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimeout(handle) { pending.delete(handle); },
    fireAll() { for (const [handle, { fn }] of [...pending]) { pending.delete(handle); fn(); } },
    pending,
  };
}

test('a press is sent at once, confirmed by ok, and fails on ok:false or no reply in 2 s', () => {
  const timers = fakeTimers();
  let changes = 0;
  const tracker = createPressTracker(() => { changes++; }, timers);
  const ack = tracker.press();
  assert.equal(tracker.state, 'sent');
  assert.equal([...timers.pending.values()][0].ms, ACK_TIMEOUT_MS);
  ack({ ok: true });
  assert.equal(tracker.state, 'sent');
  assert.equal(timers.pending.size, 0);

  tracker.press()({ ok: false });
  assert.equal(tracker.state, 'failed');

  const late = tracker.press();
  timers.fireAll();
  assert.equal(tracker.state, 'failed');
  late({ ok: true }); // a reply after the timeout changes nothing
  assert.equal(tracker.state, 'failed');

  const before = changes;
  tracker.follow('q1:buzzerOpen');
  assert.equal(tracker.state, 'idle');
  assert.equal(changes, before, 'resetting during a render does not ask for another render');
  tracker.press();
  tracker.follow('q1:buzzerOpen'); // same question and phase: keep the press state
  assert.equal(tracker.state, 'sent');
  tracker.follow('q1:answering');
  assert.equal(tracker.state, 'idle');
  assert.equal(timers.pending.size, 0);
});

test('host banner: waiting for everyone, a stand-in line for the moderator, nothing when fine', () => {
  const base = (you, hostConnected, phase = 'reading') => ({
    you: { id: you.id, name: 'x', role: you.role, isOwner: false, canModerate: !!you.canModerate, canManage: false },
    participants: [{ id: 'h', role: 'host', connected: hostConnected }],
    game: { phase },
  });
  assert.equal(hostBannerText(base({ id: 'p', role: 'player' }, false)), 'Host reconnecting — the game waits.');
  assert.match(hostBannerText(base({ id: 'p', role: 'player', canModerate: true }, false)), /You can run the game/);
  assert.equal(hostBannerText(base({ id: 'p', role: 'player' }, true)), null);
  assert.equal(hostBannerText(base({ id: 'p', role: 'player' }, false, 'lobby')), null);
});
