/**
 * Buzzer timing that fits the slowest seated player's connection.
 *
 * The host's open lead and comparison window are floors. A LAN room keeps them; a room with one
 * player on poor mobile data gets a longer lead, so that player's screen still turns green on
 * time, and a longer window, so their press still arrives before the winner is picked. With
 * fixed values a player past about 250 ms round trip saw green late or pressed too late to count.
 */

/** Reports beyond this are a broken link or a forged value; they must not stall every question. */
const MAX_REPORTED_RTT_MS = 2000;
export const MAX_OPEN_LEAD_MS = 1000;
/** Matches the window setting's own maximum and the server's 500 ms trust in player clocks. */
export const MAX_SYNC_WINDOW_MS = 500;
// The signal travels one way (about half a round trip). The margins cover jitter on top of the
// smoothed round trip, plus the frame a slow phone needs before it can paint green.
const LEAD_MARGIN_MS = 120;
const WINDOW_MARGIN_MS = 80;
/** Recent reports kept per player for the jitter shown next to their ping. */
const JITTER_SAMPLES = 8;
/** Smaller moves are Wi-Fi noise; re-broadcasting the room for each would only cost renders. */
const PING_CHANGE_MS = 10;

/** What the podium shows about a player's connection. */
export interface PingStats {
  pingMs: number;
  oneWayMs: number;
  jitterMs: number;
}

/** Each client's smoothed round trip, as it reports it with its clock probes. */
export class LatencyBoard {
  private readonly rtts = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();

  /** Returns true when the shown ping moved enough to be worth a room update. */
  report(pid: string, raw: unknown): boolean {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return false;
    const rtt = Math.min(MAX_REPORTED_RTT_MS, Math.round(value));
    const previous = this.rtts.get(pid);
    this.rtts.set(pid, rtt);
    this.samples.set(pid, [...(this.samples.get(pid) ?? []), rtt].slice(-JITTER_SAMPLES));
    return previous == null || Math.abs(previous - rtt) >= PING_CHANGE_MS;
  }

  /** A new connection may be on another network, so the old figure no longer applies. */
  forget(pid: string): void {
    this.rtts.delete(pid);
    this.samples.delete(pid);
  }

  /** The latest round trip with its spread over recent reports; null before the first report. */
  stats(pid: string): PingStats | null {
    const rtt = this.rtts.get(pid);
    if (rtt == null) return null;
    const recent = this.samples.get(pid) ?? [rtt];
    const mean = recent.reduce((sum, v) => sum + v, 0) / recent.length;
    const jitterMs = Math.round(recent.reduce((sum, v) => sum + Math.abs(v - mean), 0) / recent.length);
    return { pingMs: rtt, oneWayMs: Math.round(rtt / 2), jitterMs };
  }

  /** The slowest round trip among these participants; null when none has reported yet. */
  worst(pids: Iterable<string>): number | null {
    let worst: number | null = null;
    for (const pid of pids) {
      const rtt = this.rtts.get(pid);
      if (rtt != null && (worst == null || rtt > worst)) worst = rtt;
    }
    return worst;
  }
}

const fit = (floorMs: number, worstRttMs: number | null, marginMs: number, maxMs: number): number =>
  worstRttMs == null ? floorMs : Math.max(floorMs, Math.min(maxMs, Math.round(worstRttMs / 2 + marginMs)));

/** How far ahead the open signal is scheduled. */
export const openLeadMs = (floorMs: number, worstRttMs: number | null): number =>
  fit(floorMs, worstRttMs, LEAD_MARGIN_MS, MAX_OPEN_LEAD_MS);

/** How long presses are collected after the first one arrives. */
export const syncWindowMs = (floorMs: number, worstRttMs: number | null): number =>
  fit(floorMs, worstRttMs, WINDOW_MARGIN_MS, MAX_SYNC_WINDOW_MS);
