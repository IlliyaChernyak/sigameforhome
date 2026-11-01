/**
 * What the server knows about each player's link: the round trips their client reports with its
 * clock probes, and how their screen met recent green signals. buzzTiming.ts turns these figures
 * into the open lead and the comparison window.
 */

/** Reports beyond this are a broken link or a forged value; they must not stall every question. */
export const MAX_REPORTED_RTT_MS = 2000;
/** Recent reports kept per player for the jitter shown next to their ping. */
const JITTER_SAMPLES = 8;
/** Smaller moves are Wi-Fi noise; re-broadcasting the room for each would only cost renders. */
const PING_CHANGE_MS = 10;
/** A link is planned for this many jitters above its high recent round trip. */
const JITTER_SPREAD = 2;
/** The share of recent reports the planned round trip must cover (nearest rank). */
const PACE_PERCENTILE = 0.9;
/**
 * The share of recent deliveries the open lead must cover. With eight kept, the slowest two are
 * left out: one hiccup on an old phone should not stretch the next eight questions, and the paint
 * credit (buzzTiming.ts) makes up for a single late green.
 */
const DELIVERY_PERCENTILE = 0.75;
/** A link counts as lagging only past this planned round trip and this many times the room's. */
const LAG_FLOOR_MS = 400;
const LAG_FACTOR = 3;
/** Reports beyond this are a stalled tab or a forged value, not a timing figure. */
const MAX_SIGNAL_MS = 5000;

/** What the podium shows about a player's connection. */
export interface PingStats {
  pingMs: number;
  oneWayMs: number;
  jitterMs: number;
}

/**
 * How one screen met the scheduled green signal, as the client measured it. It tells apart an
 * update that arrived after the open moment (raise the lead) from a screen that painted late.
 */
export interface SignalStats {
  /** How far ahead of the open moment the room update arrived; negative means it came late. */
  leadMs: number;
  /** The smallest lead among recent questions. */
  worstLeadMs: number;
  /** How long after the open moment the screen turned green, by its own clock estimate. */
  paintMs: number;
  /** Half the client's best probe round trip: how far its clock estimate can be off. */
  clockErrMs: number;
}

export interface SignalReport {
  leadMs?: unknown;
  paintMs?: unknown;
  clockErrMs?: unknown;
  /** How long the screen took to apply the update after it arrived; older clients omit it. */
  readyMs?: unknown;
}

const signalFigure = (raw: unknown, min: number): number | null => {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(MAX_SIGNAL_MS, Math.round(value))) : null;
};

/** Nearest-rank percentile of a non-empty list. */
const percentile = (values: readonly number[], share: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * share) - 1];
};

/** The largest figure, skipping players with none; null when nobody has one. */
const largest = (figures: Iterable<number | null>): number | null => {
  let max: number | null = null;
  for (const value of figures) if (value != null && (max == null || value > max)) max = value;
  return max;
};

/** Each client's smoothed round trip, as it reports it with its clock probes. */
export class LatencyBoard {
  private readonly rtts = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();
  private readonly signals = new Map<string,
    { leads: number[]; deliveries: number[]; paintMs: number; clockErrMs: number; openAt: number | null }>();

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
    this.signals.delete(pid);
  }

  /**
   * Records one green signal's timing; malformed reports are dropped. `open` is the current open
   * moment and how far ahead the server scheduled it (null when the report is for another open).
   * Less the lead the update arrived with, plus the time the screen took to apply it, that is how
   * long this device really needs between the server opening the buttons and being ready to show
   * green. Round trips only estimate it; an old phone rendering a picture can need far more.
   */
  reportSignal(pid: string, raw: SignalReport, open: { at: number; scheduledLeadMs: number } | null = null): void {
    const leadMs = signalFigure(raw.leadMs, -MAX_SIGNAL_MS);
    const paintMs = signalFigure(raw.paintMs, 0);
    const clockErrMs = signalFigure(raw.clockErrMs, 0);
    const readyMs = raw.readyMs == null ? 0 : signalFigure(raw.readyMs, 0);
    if (leadMs == null || paintMs == null || clockErrMs == null || readyMs == null) return;
    const previous = this.signals.get(pid);
    const leads = [...(previous?.leads ?? []), leadMs].slice(-JITTER_SAMPLES);
    let deliveries = previous?.deliveries ?? [];
    if (open) {
      const deliveryMs = Math.max(0, Math.min(MAX_SIGNAL_MS, open.scheduledLeadMs - leadMs + readyMs));
      deliveries = [...deliveries, deliveryMs].slice(-JITTER_SAMPLES);
    }
    this.signals.set(pid, { leads, deliveries, paintMs, clockErrMs, openAt: open?.at ?? null });
  }

  /** How late this screen turned green for the open moment `at`; null before its report for that open. */
  paintFor(pid: string, at: number): number | null {
    const s = this.signals.get(pid);
    return s && s.openAt === at ? s.paintMs : null;
  }

  /** The latest green signal's timing with the worst recent lead; null before the first report. */
  signal(pid: string): SignalStats | null {
    const s = this.signals.get(pid);
    if (!s) return null;
    return { leadMs: s.leads[s.leads.length - 1], worstLeadMs: Math.min(...s.leads), paintMs: s.paintMs, clockErrMs: s.clockErrMs };
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

  /**
   * The round trip buzzer timing plans for: high in the recent reports plus twice their jitter.
   * The client already smooths what it reports, so the latest figure lags a sudden spike; one quiet
   * report on a shaky link must not shorten every wait. With the eight reports kept, the 90th
   * percentile is the highest of them. Null before the first report.
   */
  pace(pid: string): number | null {
    const stats = this.stats(pid);
    if (!stats) return null;
    const high = percentile(this.samples.get(pid) ?? [stats.pingMs], PACE_PERCENTILE);
    return Math.min(MAX_REPORTED_RTT_MS, high + JITTER_SPREAD * stats.jitterMs);
  }

  /** The slowest planned round trip among these participants; null when none has reported yet. */
  worst(pids: Iterable<string>): number | null {
    return largest([...pids].map((pid) => this.pace(pid)));
  }

  /** How long this device needs from a scheduled open to an applied update; null before it is measured. */
  delivery(pid: string): number | null {
    const deliveries = this.signals.get(pid)?.deliveries;
    return deliveries?.length ? percentile(deliveries, DELIVERY_PERCENTILE) : null;
  }

  /** The slowest measured delivery among these participants; null when none is measured yet. */
  worstDelivery(pids: Iterable<string>): number | null {
    return largest([...pids].map((pid) => this.delivery(pid)));
  }

  /**
   * Links far slower than the rest: past LAG_FLOOR_MS and LAG_FACTOR times the median of the
   * other measured links. Two phones on Wi-Fi and one on a weak cell signal: the third.
   */
  lagging(pids: Iterable<string>): Set<string> {
    const paces = [...pids].flatMap((pid) => {
      const pace = this.pace(pid);
      return pace == null ? [] : [{ pid, pace }];
    });
    const out = new Set<string>();
    for (const { pid, pace } of paces) {
      const others = paces.filter((p) => p.pid !== pid).map((p) => p.pace).sort((a, b) => a - b);
      if (!others.length) continue;
      const mid = (others.length - 1) / 2;
      const median = (others[Math.floor(mid)] + others[Math.ceil(mid)]) / 2;
      if (pace > Math.max(LAG_FLOOR_MS, LAG_FACTOR * median)) out.add(pid);
    }
    return out;
  }
}
