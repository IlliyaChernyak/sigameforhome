/**
 * The client's server clock estimate (client/src/clockSync.ts): best round trips win, the best
 * ages so drift is tracked, and a contradicting sample replaces a stale estimate at once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClockSync, localNow } from '../client/src/clockSync.ts';

/** One probe on a link with these one-way delays, against a server `trueOffset` ms ahead. */
const probe = (clock, { at, up, down, trueOffset }) => clock.add(at, at + up + down, at + up + trueOffset);

test('local time is monotonic and close to wall time', () => {
  const a = localNow();
  const b = localNow();
  assert.ok(b >= a);
  assert.ok(Math.abs(a - Date.now()) < 1000);
});

test('the lowest round trip sets the offset; slow samples barely move it', () => {
  const clock = new ClockSync();
  assert.equal(clock.calibrated, false);
  probe(clock, { at: 0, up: 5, down: 5, trueOffset: 1000 });
  assert.equal(clock.calibrated, true);
  assert.equal(clock.offsetMs, 1000);
  assert.equal(clock.bestRttMs, 10);
  // A 100 ms sample on an uneven link would be 40 ms off; it is too slow to blend in.
  probe(clock, { at: 1000, up: 90, down: 10, trueOffset: 1000 });
  assert.equal(clock.offsetMs, 1000);
  assert.equal(clock.serverNow(5000), 6000);
});

test('the best round trip ages, so a slower network can refine the offset again', () => {
  const clock = new ClockSync();
  probe(clock, { at: 0, up: 5, down: 5, trueOffset: 0 });
  // The network is now 40 ms each way and the clocks drift 2 ms per sample.
  let accepted = false;
  for (let i = 1; i <= 30 && !accepted; i++) {
    probe(clock, { at: i * 8000, up: 40, down: 40, trueOffset: 2 * i });
    accepted = clock.bestRttMs === 80;
  }
  assert.ok(accepted, 'an 80 ms sample becomes the best once the old 10 ms best has aged');
});

test('a sample outside both error bounds replaces the estimate at once', () => {
  const clock = new ClockSync();
  probe(clock, { at: 0, up: 5, down: 5, trueOffset: 0 });
  // The local clock paused 3 s through sleep: the server now reads 3 s further ahead.
  probe(clock, { at: 8000, up: 60, down: 60, trueOffset: 3000 });
  assert.equal(clock.offsetMs, 3000);
  assert.equal(clock.bestRttMs, 120);
  // A slow uneven sample (80 ms off) inside the bounds neither resets nor moves it.
  probe(clock, { at: 16000, up: 200, down: 40, trueOffset: 3000 });
  assert.equal(clock.offsetMs, 3000);
});

test('a room update seeds the estimate only before the first probe', () => {
  const clock = new ClockSync();
  clock.seed(5000, 1000);
  assert.equal(clock.offsetMs, 4000);
  probe(clock, { at: 0, up: 5, down: 5, trueOffset: 4100 });
  clock.seed(9999, 0);
  assert.equal(clock.offsetMs, 4100);
});

test('reset measures the round trip afresh but keeps the offset until a new sample', () => {
  const clock = new ClockSync();
  probe(clock, { at: 0, up: 50, down: 50, trueOffset: 200 });
  assert.equal(clock.smoothRttMs, 100);
  clock.reset();
  assert.equal(clock.calibrated, false);
  assert.equal(clock.smoothRttMs, null);
  assert.equal(clock.offsetMs, 200);
});

test('junk samples are ignored', () => {
  const clock = new ClockSync();
  clock.add(100, 50, 0); // received before sent
  clock.add(0, 10, Number.NaN);
  assert.equal(clock.calibrated, false);
  assert.equal(clock.smoothRttMs, null);
});
