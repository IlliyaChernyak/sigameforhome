/** Advances pack content in order while leaving DOM and media controls to the caller. */
export interface PresentedContent {
  type: string;
  value?: string;
  missing?: boolean;
  duration?: number | null;
  waitForFinish?: boolean;
}

export type RenderContent<T extends PresentedContent> = (
  item: T, index: number, active: boolean, replay: boolean, done: () => void,
) => void | ((visibleText: string) => void);

export class ContentPresenter<T extends PresentedContent> {
  private index = 0;
  private shown = false;
  private finished = false;
  private paused = false;
  private disposed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerCallback: (() => void) | null = null;
  /*
   * The script runs on one timeline. `origin` is the local time it starts (a pause moves it later)
   * and `position` the planned moment of the next step. Steps are due at origin + position, so
   * chained timers never drift, and a screen that starts late catches up to the others.
   */
  private origin = 0;
  private position = 0;
  private pausedAt = 0;
  private readonly starts: number[] = [];
  private pending: (() => void) | null = null;
  private visibleCharacters = 0;
  private textCharacters: string[] = [];
  private updateText: ((visibleText: string) => void) | null = null;

  constructor(
    private readonly items: T[],
    private readonly render: RenderContent<T>,
    private readonly onFinish: () => void,
    private readonly mediaDelayMs = 0,
    private readonly textCharsPerSecond = 0,
  ) {}

  get isFinished(): boolean {
    return this.finished;
  }

  /** `origin` is the local time the script starts on every screen; it may lie ahead or behind. */
  start(origin = Date.now()): void {
    this.origin = origin;
    this.next();
  }

  /** Local time item `index` started (or was due to) on the shared timeline; null before it shows. */
  startOf(index: number): number | null {
    return this.starts[index] == null ? null : this.origin + this.starts[index];
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused || this.disposed) return;
    this.paused = paused;
    if (paused) {
      this.pausedAt = Date.now();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    this.origin += Date.now() - this.pausedAt;
    if (this.pending) {
      const advance = this.pending;
      this.pending = null;
      advance();
    } else this.arm();
  }

  /** Re-render after a media ticket rotates, keeping the current step and timer. */
  refresh(): void {
    if (this.disposed) return;
    this.generation++;
    const last = this.finished ? this.items.length : this.index;
    for (let i = 0; i < last; i++) this.render(this.items[i], i, false, true, () => {});
    if (this.shown && !this.finished) this.show(true);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerCallback = null;
    this.pending = null;
  }

  private schedule(ms: number, callback: () => void): void {
    this.position += Math.max(0, ms);
    this.timerCallback = callback;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.arm();
  }

  private arm(): void {
    if (this.paused || this.disposed || this.timer || !this.timerCallback) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const callback = this.timerCallback;
      this.timerCallback = null;
      callback?.();
    }, Math.max(0, this.origin + this.position - Date.now()));
  }

  private next(): void {
    if (this.disposed || this.finished) return;
    if (this.index >= this.items.length) {
      this.finished = true;
      this.onFinish();
      return;
    }
    this.shown = false;
    const item = this.items[this.index];
    const media = item.type === 'audio' || item.type === 'video';
    if (media && this.mediaDelayMs > 0) this.schedule(this.mediaDelayMs, () => this.show());
    else this.show();
  }

  private show(replay = false): void {
    if (this.disposed || this.finished) return;
    this.shown = true;
    const item = this.items[this.index];
    if (!replay) this.starts[this.index] = this.position;
    const generation = ++this.generation;
    const playsToEnd = (item.type === 'audio' || item.type === 'video') && item.waitForFinish;
    const done = () => {
      if (this.disposed || generation !== this.generation) return;
      // A clip that plays to its end took real time; the timeline moves on from that moment.
      if (playsToEnd) this.position = Math.max(this.position, (this.paused ? this.pausedAt : Date.now()) - this.origin);
      if (this.paused) this.pending = () => this.complete();
      else this.complete();
    };
    const updateText = this.render(item, this.index, true, replay, done);
    if (this.textCharsPerSecond > 0 && !item.missing &&
        (item.type === 'text' || item.type === 'say') && item.value &&
        typeof updateText === 'function') {
      this.textCharacters = Array.from(item.value);
      this.updateText = updateText;
      if (!replay) this.visibleCharacters = 0;
      this.updateText(this.textCharacters.slice(0, this.visibleCharacters).join(''));
      if (!replay) this.schedule(1000 / this.textCharsPerSecond, () => this.advanceText());
      return;
    }
    if (playsToEnd) return;
    const durationMs = Math.max(0, (item.duration ?? 0) * 1000);
    if (durationMs) {
      if (!replay) this.schedule(durationMs, () => this.complete());
    }
    else queueMicrotask(done);
  }

  private advanceText(): void {
    if (this.disposed || this.finished) return;
    this.visibleCharacters++;
    this.updateText?.(this.textCharacters.slice(0, this.visibleCharacters).join(''));
    if (this.visibleCharacters >= this.textCharacters.length) this.complete();
    else this.schedule(1000 / this.textCharsPerSecond, () => this.advanceText());
  }

  private complete(): void {
    if (this.disposed || this.finished) return;
    this.generation++;
    this.index++;
    this.next();
  }
}
