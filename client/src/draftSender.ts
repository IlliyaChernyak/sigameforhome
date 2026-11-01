/**
 * Sends unsent answer text to the server while a player types (device playtest F4).
 *
 * The server keeps it as a draft and uses it only when answer time closes, so a host who ends the
 * time early, or a phone that drops, does not lose a typed answer. Drafts are quiet: a failed send
 * shows nothing, and the next keystroke, blur or reconnect tries again.
 */

export interface DraftSender {
  /** Text changed in the box for this question (`key` changes per question, so equal text is resent). */
  update(key: string, text: string): void;
  /** Sends a waiting change now (blur, page hidden, reconnect). */
  flush(): void;
  /** The text was submitted as the answer: the server dropped its draft, so start from that text. */
  submitted(key: string, text: string): void;
}

/** `send` returns false when the text could not go out (offline), so it is retried later. */
export function createDraftSender(send: (text: string) => boolean, delayMs = 500): DraftSender {
  let key = '';
  let lastSent = '';
  let waiting: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const switchTo = (next: string) => {
    if (next === key) return;
    key = next;
    lastSent = '';
    waiting = null;
  };
  const flush = () => {
    clearTimeout(timer);
    const text = waiting;
    if (text === null) return;
    if (text.trim() === lastSent) { waiting = null; return; }
    if (!send(text.trim())) return; // keep waiting; a later flush retries
    lastSent = text.trim();
    waiting = null;
  };

  return {
    update(nextKey, text) {
      switchTo(nextKey);
      waiting = text;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    submitted(nextKey, text) {
      switchTo(nextKey);
      clearTimeout(timer);
      waiting = null;
      lastSent = text.trim();
    },
  };
}
