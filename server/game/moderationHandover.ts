/**
 * When the room owner may stand in for an absent host (audit UX-7).
 *
 * The owner used to get host controls the instant the host's socket dropped, so every short
 * Wi-Fi blip flashed moderation onto a player's phone. Now the owner waits HANDOVER_MS.
 *
 * The wait is a flag set by a timer, not a clock comparison. canModerate is only evaluated when
 * a snapshot is built, so the timer must also trigger a re-broadcast; and a timer can fire a
 * millisecond before Date.now() reaches the deadline, which would strand a clock check forever.
 *
 * The state is tied to one host id. A timer left over from an earlier host does nothing once a
 * different participant holds the host seat.
 */
import type { Room } from './Room.ts';
import { safeTimeout, type TimerHandle } from '../utils/safeTimer.ts';

export const HANDOVER_MS = 10_000;

interface Handover {
  hostId: string;
  ready: boolean;
  timer: TimerHandle;
}

// Beside the room, not in it: this is transient connection state, never persisted or sent.
const handovers = new WeakMap<Room, Handover>();

/** The host's socket dropped (live, or offline after a restore): start the wait. */
export function startHandover(room: Room, hostId: string): void {
  clearHandover(room, hostId);
  const timer = safeTimeout('moderation handover', () => markHandoverReady(room, hostId),
    HANDOVER_MS, () => room.changed());
  handovers.set(room, { hostId, ready: false, timer });
}

/** The wait for `hostId` is over. Exported so tests can end it without a fake clock. */
export function markHandoverReady(room: Room, hostId: string): void {
  const handover = handovers.get(room);
  if (handover?.hostId !== hostId) return;
  handover.ready = true;
  // The first joiner usually picks Host, so the absent host is often the owner too. The owner
  // stands in for the host, so keeping ownership with them for the whole reconnect grace left
  // nobody able to moderate or reassign the host seat. A returning host keeps host rights anyway.
  if (room.ownerId === hostId) room.reassignOwner();
  room.changed();
}

/** The host came back, left the seat, or left the room. Ignores other participants. */
export function clearHandover(room: Room, pid: string): void {
  const handover = handovers.get(room);
  if (handover?.hostId !== pid) return;
  clearTimeout(handover.timer);
  handovers.delete(room);
}

export function handoverReady(room: Room, hostId: string): boolean {
  const handover = handovers.get(room);
  return handover?.hostId === hostId && handover.ready;
}
