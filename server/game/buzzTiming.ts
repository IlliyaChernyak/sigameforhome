/**
 * Buzzer timing that fits the slowest seated player's connection.
 *
 * The host's open lead and comparison window are floors. A LAN room keeps them; a room with one
 * player on poor mobile data gets a longer lead, so that player's screen still turns green on
 * time, and a longer window, so their press still arrives before the winner is picked. With
 * fixed values a player past about 250 ms round trip saw green late or pressed too late to count.
 * The figures behind it are kept in latencyBoard.ts.
 */

export const MAX_OPEN_LEAD_MS = 1000;
/** Matches the window setting's own maximum and the server's 500 ms trust in player clocks. */
export const MAX_SYNC_WINDOW_MS = 500;
// The signal travels one way (about half a round trip). Jitter is planned for on its own (see
// LatencyBoard.pace), so these margins only cover the frame a slow phone needs before it can paint
// green and a room update being larger than a probe. They were 120 and 80 ms while they also had
// to absorb jitter, which made a steady slow link wait as long as a shaky one.
const LEAD_MARGIN_MS = 80;
const WINDOW_MARGIN_MS = 50;
/** Room left after a measured delivery for timer slop and the frame that paints green. */
const DELIVERY_SPARE_MS = 30;
/**
 * The most a late green can earn. An old 60 Hz phone busy with a picture paints one to three
 * frames late; more than this is a stalled tab, or a client claiming time it did not lose.
 */
export const MAX_PAINT_CREDIT_MS = 80;

const fit = (floorMs: number, worstRttMs: number | null, marginMs: number, maxMs: number): number =>
  worstRttMs == null ? floorMs : Math.max(floorMs, Math.min(maxMs, Math.round(worstRttMs / 2 + marginMs)));

/**
 * How far ahead the open signal is scheduled. A measured delivery (from the green-signal reports)
 * beats the round-trip estimate when it is longer: it is what the slowest screen really needed.
 */
export const openLeadMs = (floorMs: number, worstRttMs: number | null, worstDeliveryMs: number | null = null): number =>
  Math.max(fit(floorMs, worstRttMs, LEAD_MARGIN_MS, MAX_OPEN_LEAD_MS),
    worstDeliveryMs == null ? 0 : Math.min(MAX_OPEN_LEAD_MS, Math.round(worstDeliveryMs + DELIVERY_SPARE_MS)));

/** How long presses are collected after the first one arrives. */
export const syncWindowMs = (floorMs: number, worstRttMs: number | null): number =>
  fit(floorMs, worstRttMs, WINDOW_MARGIN_MS, MAX_SYNC_WINDOW_MS);

/**
 * How long after a press its packet may still be on the way from a link with this planned round
 * trip; null when the link is unmeasured. It never exceeds the comparison window's cap: a press
 * older than that is clamped by the server's trust in player clocks and cannot lead anyway.
 */
export const pressInFlightMs = (paceRttMs: number | null): number | null =>
  paceRttMs == null ? null : Math.min(MAX_SYNC_WINDOW_MS, Math.round(paceRttMs / 2 + WINDOW_MARGIN_MS));

/**
 * Time taken off a press because its screen turned green `rawPaintMs` after the open moment: the
 * player saw the signal that much later, so a press is ranked from their own green. A press
 * before that green was a guess, not a reaction, and earns nothing; so does a junk report.
 */
export const paintCreditMs = (pressedAt: number, openedAt: number, rawPaintMs: unknown): number => {
  const paintMs = Number(rawPaintMs);
  if (!Number.isFinite(paintMs) || paintMs <= 0 || pressedAt < openedAt + paintMs) return 0;
  return Math.min(MAX_PAINT_CREDIT_MS, Math.round(paintMs));
};
