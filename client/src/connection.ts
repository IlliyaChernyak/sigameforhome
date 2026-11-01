/**
 * Connection health beyond what socket.io reports on its own (audits CONN-3, CONN-5, CONN-6).
 *
 * - Wake probe: after a phone sleeps, a dead socket can still read `connected` until the ping
 *   timeout (about 18 s). The buzzer looks live and presses vanish. On return to the page we ask
 *   the server for a quick reply and close the transport if none comes, so the built-in
 *   reconnect starts at once. Closing the engine (not disconnect()+connect()) keeps the
 *   Manager's backoff and its automatic reconnect ("forced close" is not a deliberate disconnect).
 * - Another tab: the server disconnects a seat's older socket when the seat opens elsewhere.
 *   socket.io does not reconnect after a server-side disconnect, so the old tab must say why.
 * - Unreachable: repeated connect errors usually mean the phone is not on the host's Wi-Fi.
 *
 * The socket is injected so this module can be tested without a browser.
 */
import { t } from './i18n';

const WAKE_PROBE_MIN_HIDDEN_MS = 5000;
export const PROBE_TIMEOUT_MS = 2000;
const UNREACHABLE_AFTER_ERRORS = 3;

export type ConnectionNotice = 'none' | 'otherTab' | 'unreachable';

export interface MonitoredSocket {
  connected: boolean;
  io: { engine?: { close(): void } };
  timeout(ms: number): { emitWithAck(event: 'clock:ping', payload: Record<string, never>): Promise<unknown> };
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'disconnect', listener: (reason: string) => void): unknown;
  on(event: 'connect_error', listener: () => void): unknown;
  connect(): unknown;
}

export const noticeText: Record<Exclude<ConnectionNotice, 'none'>, string> = {
  otherTab: t('This seat is open on another tab or device.'),
  unreachable: t('Can’t reach the game server. Check you’re on the host’s Wi-Fi.'),
};

export function createConnectionMonitor(socket: MonitoredSocket, options: {
  onNotice: (notice: ConnectionNotice) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let hiddenAt: number | null = null;
  let probing = false;
  let connectErrors = 0;
  let notice: ConnectionNotice = 'none';
  const setNotice = (next: ConnectionNotice) => {
    if (next === notice) return;
    notice = next;
    options.onNotice(next);
  };

  socket.on('connect', () => { connectErrors = 0; setNotice('none'); });
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') setNotice('otherTab');
  });
  socket.on('connect_error', () => {
    if (++connectErrors >= UNREACHABLE_AFTER_ERRORS) setNotice('unreachable');
  });

  /** Asks the server for a reply; a silent socket is closed so socket.io reconnects now. */
  async function probe(): Promise<void> {
    // A disconnected socket is already reconnecting; probing it would only add noise.
    if (probing || !socket.connected) return;
    probing = true;
    try {
      await socket.timeout(PROBE_TIMEOUT_MS).emitWithAck('clock:ping', {});
    } catch {
      if (socket.connected) socket.io.engine?.close();
    } finally {
      probing = false;
    }
  }

  return {
    get notice() { return notice; },
    hidden() { hiddenAt = now(); },
    /** The page is visible again. Short glances at another app do not need a probe. */
    visible(): Promise<void> {
      const away = hiddenAt === null ? 0 : now() - hiddenAt;
      hiddenAt = null;
      return away >= WAKE_PROBE_MIN_HIDDEN_MS ? probe() : Promise.resolve();
    },
    /** A page restored from the back-forward cache may hold a socket from before the freeze. */
    restored(): Promise<void> { return probe(); },
    /** "Use here": take the seat back on this tab. */
    reclaim() { setNotice('none'); socket.connect(); },
  };
}
