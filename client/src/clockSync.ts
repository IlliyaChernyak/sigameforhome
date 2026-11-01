/**
 * This device's estimate of the server clock, behind device-time buzzes, timers and shared starts.
 *
 * - Local time is monotonic. Date.now() jumps when the phone corrects its clock, and every
 *   estimate built on it stayed off by that jump until the next reconnect.
 * - The lowest round trip gives the most exact offset; near-best samples refine it.
 * - The best round trip ages a little with each sample. Phone and server clocks drift apart (tens
 *   of ms per hour), and once the network got slower no sample came near the old best again, so
 *   the estimate froze while the drift grew.
 * - A sample that contradicts the estimate beyond both their error bounds proves it wrong (a
 *   clock that jumped, a monotonic clock paused through sleep, drift) and replaces it at once.
 *
 * It only reads the clock through `localNow`, so tests drive it with their own timestamps.
 */

/** Local time that never jumps. It may pause while the device sleeps; the contradiction check repairs that. */
export const localNow = (): number => performance.timeOrigin + performance.now();

/**
 * Each sample lets the best round trip grow by this share, so newer samples can take over. At one
 * probe per 8 s a best 8× below the current round trip is outgrown in about 3 minutes.
 */
const BEST_RTT_AGING = 1.1;
/** Samples up to this round trip refine the offset; slower ones are too uncertain to blend in. */
const nearBestRtt = (bestRttMs: number) => bestRttMs * 1.5 + 10;

export class ClockSync {
  /** Server time minus local time. */
  offsetMs = 0;
  /** The lowest recent round trip; Infinity until the first sample. */
  bestRttMs = Infinity;
  /**
   * Typical round trip, sent with each probe so the server can fit the buzzer open lead and
   * comparison window to the slowest phone (server/game/buzzTiming.ts).
   */
  smoothRttMs: number | null = null;

  get calibrated(): boolean {
    return Number.isFinite(this.bestRttMs);
  }

  /** Server time now, by this device's estimate. */
  serverNow(local = localNow()): number {
    return local + this.offsetMs;
  }

  /** Before the first probe returns, a room update's server time is a rough first estimate. */
  seed(serverTime: number, local = localNow()): void {
    if (!this.calibrated) this.offsetMs = serverTime - local;
  }

  /** A reconnect may be on another network; measure the round trip afresh. */
  reset(): void {
    this.bestRttMs = Infinity;
    this.smoothRttMs = null;
  }

  /** One probe: sent and received on the local clock, stamped by the server in between. */
  add(sentAt: number, receivedAt: number, serverTime: number): void {
    const rtt = receivedAt - sentAt;
    if (!(rtt >= 0) || !Number.isFinite(serverTime)) return;
    this.smoothRttMs = this.smoothRttMs == null ? rtt : this.smoothRttMs * 0.7 + rtt * 0.3;
    const sampleOffset = serverTime + rtt / 2 - receivedAt;
    this.bestRttMs *= BEST_RTT_AGING;
    // The true offset lies within half a round trip of each sample's offset, and the estimate is
    // built from samples no slower than nearBestRtt. Past both bounds (+1 ms for the server's whole
    // millisecond stamp) the estimate cannot be right.
    const contradicts = this.calibrated &&
      Math.abs(sampleOffset - this.offsetMs) > (rtt + nearBestRtt(this.bestRttMs)) / 2 + 1;
    if (rtt <= this.bestRttMs || contradicts) {
      this.bestRttMs = rtt;
      this.offsetMs = sampleOffset;
    } else if (rtt <= nearBestRtt(this.bestRttMs)) {
      // A slow sample's offset can be wrong by half its extra delay (uneven up/down links), so
      // only near-best samples refine the estimate; blending every sample let jitter creep in.
      this.offsetMs = this.offsetMs * 0.8 + sampleOffset * 0.2;
    }
  }
}
