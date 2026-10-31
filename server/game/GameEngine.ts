/**
 * Game engine: the round/board/question/buzzer state machine.
 *
 * Supported flows:
 *   ✔ rounds & board, question selection by chooser or host
 *   ✔ reading phase with SIGame-style false starts
 *   ✔ buzzer (first-wins or random-within-interval), answer judging, scoring
 *   ✔ round timer, server-side countdowns (clients only render `endsAt`)
 *   ✔ guided secrets, stake auctions, no-risk scoring, and final wagers/judging
 *   ✔ guided for-all private answers and individual judging
 *
 * The engine never talks to sockets. It mutates state and calls room.changed()
 * / room.emitEvent(); the transport layer decides who receives what.
 */
import { randomUUID } from 'node:crypto';
import type { AnswerOption, AnswerType, ContentItem, Package, Question, QuestionType, Round } from '../packs/siqParser.ts';
import { PHASES, type Phase, ROLES } from './constants.ts';
import type { Participant, Room } from './Room.ts';
import type { GameSettings } from './settings.ts';
import { openLeadMs, syncWindowMs } from './buzzTiming.ts';
import { safeTimeout } from '../utils/safeTimer.ts';

const CLIENT_CLOCK_TRUST_MS = 500;

/** Host verdict multipliers for a correct answer: half credit, full, or double. */
const REWARD_FACTORS = [0.5, 1, 2];
const QUESTION_PHASES = new Set<Phase>([PHASES.READING, PHASES.BUZZER_OPEN, PHASES.ANSWERING, PHASES.FOR_ALL_ANSWERING, PHASES.FOR_ALL_JUDGE, PHASES.REVEAL]);
/**
 * The longest the server waits for the host's device to report that a clip ended. A host who
 * drops, locks their phone, or whose browser blocks playback never reports it, and the room
 * would sit on the question until someone pressed a button. Pack-given durations close sooner.
 */
const CLIP_REPORT_LIMIT_SECONDS = 180;
/** Slack past a pack-given duration: media delay, buffering, and a slow host device. */
const CLIP_REPORT_MARGIN_SECONDS = 10;
const isClip = (item: ContentItem): boolean => item.type === 'audio' || item.type === 'video';

/** How long a dropped bidder keeps their auction turn (device playtest F16). */
const AUCTION_RECONNECT_GRACE_MS = 10_000;
export interface ActiveTimer {
  name: string;
  durationMs: number;
  endsAt: number;
  handle: ReturnType<typeof setTimeout>;
}

export interface WinnerInfo {
  mode: 'server' | 'clientTimestamp' | 'random';
  reactionMs: number;
  transitMs?: number;
  contenders?: number;
}

export interface PendingBuzz {
  playerId: string;
  mode: 'random' | 'clientTimestamp';
  serverAt: number;
  effectiveAt: number;
  transitMs?: number;
}

export interface BuzzerState {
  winnerId: string | null;
  winnerInfo: WinnerInfo | null;
  openedAt: number | null;
  attempted: Set<string>;
  blockedUntil: Map<string, number>;
  pending: PendingBuzz[];
  remainingMs: number | null;
  typedAnswer: string | null;
  typedAnswerClosed: boolean;
}

export interface CurrentQuestionState {
  presentationId: string;
  themeIndex: number;
  questionIndex: number;
  themeName: string;
  price: number;
  type: QuestionType;
  question: Question;
  answerShown: boolean;
  assignedId: string | null;
  chooserBeforeQuestion: string | null;
  judgments: Judgment[];
  /** Option letters and picture clicks, kept so the reveal can show every attempt. */
  picks: AnswerPick[];
}

export interface AnswerPick {
  playerId: string;
  value: string;
  correct: boolean;
}

export interface Judgment {
  id: number;
  playerId: string;
  correct: boolean;
  delta: number;
  rightDelta: number;
  wrongDelta: number;
  kind: string;
  appealed: boolean;
  voided: boolean;
}

interface StakeAuction {
  order: string[];
  turnIndex: number;
  leaderId: string | null;
  amount: number;
  allIn: boolean;
  passed: Set<string>;
  minimum: number;
}

interface ForAllState {
  eligibleIds: string[];
  answers: Map<string, string>;
  judged: Set<string>;
}

interface AppealState {
  judgmentId: number;
  requesterId: string;
  targetId: string;
  kind: 'for' | 'against';
  eligibleVoterIds: string[];
  votes: Map<string, boolean>;
}

interface JudgmentUndo {
  presentationId: string;
  judgmentId: number;
  phase: Phase;
  chooserId: string | null;
  buzzer: BuzzerState;
  answerShown: boolean;
  timerName: string | null;
  timerMs: number | null;
  forAllJudged: Set<string> | null;
  finalJudged: Set<string>;
}

interface PausedState {
  phase: Phase;
  timerName: string | null;
  timerMs: number | null;
  buzzWindowMs?: number | null;
}

export type BuzzResult = 'accepted' | 'falseStart' | 'queued' | 'ignored';

export interface GameView {
  phase: Phase;
  pausedPhase: Phase | null;
  roundIndex: number;
  round: { name: string; type: Round['type'] } | null;
  board: Array<{
    name: string;
    questions: Array<{ price: number; available: boolean }>;
  }>;
  chooserId: string | null;
  removedFinalThemes: number[];
  timer: { name: string; endsAt: number; durationMs: number } | null;
  current: {
    presentationId: string;
    themeIndex: number;
    questionIndex: number;
    themeName: string;
    price: number;
    type: QuestionType;
    content: ContentItem[];
    answerShown: boolean;
    assignedId: string | null;
    priceRange: unknown;
    right: string[] | null;
    wrong: string[] | null;
    answerContent: ContentItem[] | null;
    comments: string | null;
    sources: string[] | null;
    answerType: AnswerType;
    answerOptions: AnswerOption[];
    answerDeviation: number | null;
    /** Host-only notes from the pack. */
    showmanComments: string | null;
    selectionMode: string | null;
    picks: AnswerPick[];
  } | null;
  undoJudgment: { presentationId: string; judgmentId: number; playerId: string } | null;
  buzzer: {
    winnerId: string | null;
    winnerInfo: WinnerInfo | null;
    openedAt: number | null;
    attempted: string[];
    blockedUntil: number | null;
    blockedPlayers: Array<{ id: string; until: number }>;
    typedAnswer: { text: string | null; submitted: boolean; closed: boolean } | null;
  };
  auction: {
    turnId: string | null;
    leaderId: string | null;
    amount: number;
    allIn: boolean;
    passedIds: string[];
    minimum: number;
    minimumNextBid: number;
  } | null;
  forAll: {
    eligibleIds: string[];
    submittedIds: string[];
    yourAnswer: string | null;
    answers: Record<string, string> | null;
    judgedIds: string[];
  } | null;
  final: {
    wagered: string[];
    yourWager: number | null;
    wagers: Record<string, number | undefined> | null;
    judged: string[];
    eligibleIds: string[];
    answeredIds: string[];
    editingIds: string[];
    yourAnswer: string | null;
    answers: Record<string, string> | null;
  } | null;
  appeals: {
    judgments: Array<Pick<Judgment, 'id' | 'playerId' | 'correct' | 'delta' | 'appealed' | 'voided'>>;
    active: {
      judgmentId: number;
      requesterId: string;
      targetId: string;
      kind: 'for' | 'against';
      eligibleVoterIds: string[];
      votedIds: string[];
    } | null;
  } | null;
}

export class GameEngine {
  readonly room: Room;
  phase!: Phase;
  roundIndex!: number;
  played!: Set<string>;
  chooserId!: string | null;
  current!: CurrentQuestionState | null;
  timer: ActiveTimer | null = null;
  /** Hidden from players' clocks: it is not a deadline, only the latest the server will wait. */
  clipReportHandle?: ReturnType<typeof setTimeout>;
  buzzWindowHandle?: ReturnType<typeof setTimeout>;
  buzzWindowEndsAt: number | null = null;
  buzzer!: BuzzerState;
  finalWagers!: Map<string, number>;
  finalJudged!: Set<string>;
  finalAnswers!: Map<string, string>;
  /**
   * Unsent text from the final and for-all answer boxes (device playtest F4). Used only when answer
   * time closes, so a host who ends it early, a timer, or a dropped phone never loses a typed answer.
   * Never part of view(): nobody else sees what a player has not sent.
   */
  drafts!: Map<string, string>;
  removedFinalThemes!: Set<number>;
  paused!: PausedState | null;
  auction!: StakeAuction | null;
  forAll!: ForAllState | null;
  appeal!: AppealState | null;
  judgmentUndo: JudgmentUndo[] = [];
  judgmentSequence = 1;

  constructor(room: Room) {
    this.room = room;
    this.reset();
  }

  reset(): void {
    this.clearTimer();
    this.phase = PHASES.LOBBY;
    this.roundIndex = -1;
    this.played = new Set<string>();
    this.chooserId = null;
    this.current = null;
    this.finalWagers = new Map();
    this.finalJudged = new Set();
    this.finalAnswers = new Map();
    this.drafts = new Map();
    this.removedFinalThemes = new Set();
    this.paused = null;
    this.auction = null;
    this.forAll = null;
    this.appeal = null;
    this.judgmentUndo = [];
    this.judgmentSequence = 1;
    this.resetBuzzer();
  }

  resetBuzzer(): void {
    clearTimeout(this.buzzWindowHandle);
    this.buzzWindowEndsAt = null;
    this.buzzer = {
      winnerId: null,
      winnerInfo: null,
      openedAt: null,
      attempted: new Set<string>(),
      blockedUntil: new Map<string, number>(),
      pending: [],
      remainingMs: null,
      typedAnswer: null,
      typedAnswerClosed: false,
    };
  }

  /* ----------------------------------------------------------------- helpers */

  get settings(): GameSettings {
    return this.room.settings;
  }

  get pack(): Package | null {
    return this.room.loadedPack?.pack ?? null;
  }

  get round(): Round | null {
    return this.pack?.rounds[this.roundIndex] ?? null;
  }

  activePlayers(): Participant[] {
    return this.room.players().filter((p) => p.connected);
  }

  /** A departed answerer must not leave the next selection assigned to an empty seat. */
  ensureConnectedChooser(): void {
    const chooser = this.chooserId ? this.room.participants.get(this.chooserId) : null;
    if (chooser?.role === ROLES.PLAYER && chooser.connected) return;
    this.chooserId = [...this.activePlayers()]
      .sort((a, b) => a.score - b.score || a.joinedAt - b.joinedAt)[0]?.id ?? null;
  }

  /** A removed or reseated player no longer has an answer to judge. */
  forAllEligibleIds(): string[] {
    return this.forAll?.eligibleIds.filter((id) => this.room.participants.get(id)?.role === ROLES.PLAYER) ?? [];
  }

  /** Final theme removal always plays the first question of each unplayed theme. */
  finalThemeIndices(): number[] {
    if (this.round?.type !== 'final') return [];
    return this.round.themes.flatMap((theme, index) =>
      theme.questions[0]?.price >= 0 && !this.played.has(`${this.roundIndex}:${index}:0`) ? [index] : []);
  }

  /** Only players with a positive score play the final, as in the show. */
  finalists(): Participant[] {
    return this.activePlayers().filter((p) => p.score > 0)
      .sort((a, b) => a.score - b.score || a.joinedAt - b.joinedAt);
  }

  /** Answer types other than text are answered by tapping, even when answers are spoken. */
  answerType(): AnswerType {
    return this.current?.question.answerType ?? 'text';
  }

  usesAnswerInput(): boolean {
    return !this.settings.oral || this.answerType() !== 'text';
  }

  finalEligibleIds(): string[] {
    return [...this.finalWagers.keys()].filter((id) =>
      this.room.participants.get(id)?.role === ROLES.PLAYER);
  }

  isAvailable(t: number, q: number): boolean {
    const question = this.round?.themes[t]?.questions[q];
    return !!question && (this.round.type !== 'final' || q === 0) &&
      !this.removedFinalThemes.has(t) && question.price >= 0 &&
      !this.played.has(`${this.roundIndex}:${t}:${q}`);
  }

  roundHasQuestionsLeft(): boolean {
    return !!this.round?.themes.some((theme, t) => theme.questions.some((_, q) => this.isAvailable(t, q)));
  }

  assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  /** Keep actual deltas so appeals and recovery use the rules in force when judging. */
  recordJudgment(playerId: string, correct: boolean, delta: number, rightDelta: number,
    wrongDelta: number, kind = 'normal'): Judgment {
    this.assert(this.current, 'No active question');
    const judgment = {
      id: this.judgmentSequence++,
      playerId, correct, delta, rightDelta, wrongDelta, kind,
      appealed: false, voided: false,
    };
    this.current.judgments.push(judgment);
    return judgment;
  }

  captureJudgmentUndo(): void {
    this.assert(this.current, 'No active question');
    this.judgmentUndo.push({
      presentationId: this.current.presentationId,
      judgmentId: this.judgmentSequence,
      phase: this.phase,
      chooserId: this.chooserId,
      buzzer: structuredClone(this.buzzer),
      answerShown: this.current.answerShown,
      timerName: this.timer?.name ?? null,
      timerMs: this.timer ? Math.max(0, this.timer.endsAt - Date.now()) : null,
      forAllJudged: this.forAll ? new Set(this.forAll.judged) : null,
      finalJudged: new Set(this.finalJudged),
    });
  }

  canUndoJudgment(): boolean {
    const current = this.current;
    const latest = current?.judgments.at(-1);
    const saved = this.judgmentUndo.at(-1);
    return !!(current && latest && saved && !this.appeal &&
      !current.judgments.some((item) => item.appealed) &&
      this.room.participants.has(latest.playerId) &&
      saved.presentationId === current.presentationId && saved.judgmentId === latest.id &&
      !this.buzzer.pending.length &&
      ([PHASES.BUZZER_OPEN, PHASES.REVEAL, PHASES.FOR_ALL_JUDGE, PHASES.FINAL_JUDGE] as Phase[]).includes(this.phase));
  }

  undoJudgment(presentationId: string, judgmentId: number): { playerId: string; delta: number } {
    this.assert(this.canUndoJudgment(), 'There is no verdict to undo');
    const current = this.current!;
    const judgment = current.judgments.at(-1)!;
    const saved = this.judgmentUndo.at(-1)!;
    this.assert(presentationId === current.presentationId && judgmentId === judgment.id,
      'The verdict has changed');
    const player = this.room.participants.get(judgment.playerId)!;
    player.score -= judgment.delta;
    current.judgments.pop();
    this.judgmentUndo.pop();
    if (current.picks.at(-1)?.playerId === judgment.playerId) current.picks.pop();
    this.clearTimer();
    clearTimeout(this.buzzWindowHandle);
    this.buzzWindowHandle = undefined;
    this.buzzWindowEndsAt = null;
    this.phase = saved.phase;
    this.chooserId = saved.chooserId;
    this.buzzer = saved.buzzer;
    current.answerShown = saved.answerShown;
    if (this.forAll && saved.forAllJudged) this.forAll.judged = saved.forAllJudged;
    this.finalJudged = saved.finalJudged;
    if (saved.timerName && saved.timerMs !== null) {
      this.startTimer(saved.timerName, Math.max(0.001, saved.timerMs / 1000),
        saved.timerName === 'answering' ? () => this.expireAnswering() : undefined);
    }
    return { playerId: player.id, delta: -judgment.delta };
  }

  /** Recovery replays an interrupted question, so remove every score it already awarded. */
  rollbackCurrentScores(): void {
    for (const judgment of this.current?.judgments ?? []) {
      if (judgment.voided) continue;
      const player = this.room.participants.get(judgment.playerId);
      if (player) player.score -= judgment.delta;
      judgment.voided = true;
    }
    if (this.current) this.chooserId = this.current.chooserBeforeQuestion;
  }

  /* ------------------------------------------------------------------ timers */

  startTimer(name: string, seconds: number, onExpire?: () => void): void {
    this.clearTimer();
    if (!seconds || seconds <= 0) return;
    const durationMs = seconds * 1000;
    this.timer = {
      name,
      durationMs,
      endsAt: Date.now() + durationMs,
      handle: setTimeout(() => {
        this.timer = null;
        try {
          onExpire?.();
        } catch (err) {
          console.warn(`[engine] timer "${name}" expiry ignored: ${(err as Error).message}`);
        }
        this.room.changed();
      }, durationMs),
    };
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer.handle);
    this.timer = null;
    // Every step that clears the clock leaves the clip wait too (or re-arms it, see resume).
    clearTimeout(this.clipReportHandle);
    this.clipReportHandle = undefined;
  }

  /**
   * Safety net for the waits only the host's device can end: question clips (contentFinished)
   * and answer clips (answerFinished). If no report arrives, the server acts as if it had.
   */
  private armClipReportGuard(): void {
    clearTimeout(this.clipReportHandle);
    this.clipReportHandle = undefined;
    const current = this.current;
    if (!current) return;
    const { question, presentationId } = current;
    const reading = this.phase === PHASES.READING && this.readingEndsOnSignal(question);
    const revealing = this.phase === PHASES.REVEAL && this.round?.type !== 'final' && this.hasAnswerClip(question);
    if (!reading && !revealing) return;
    const items = reading ? question.content : question.answerContent;
    // A clip without a pack-given duration could be a whole song, so only the cap is safe.
    const seconds = items.filter(isClip).every((item) => item.duration)
      ? (reading ? this.estimateReadingSeconds(question) : this.estimateRevealSeconds(question)) +
        CLIP_REPORT_MARGIN_SECONDS
      : CLIP_REPORT_LIMIT_SECONDS;
    this.clipReportHandle = safeTimeout('clip report', () => {
      this.clipReportHandle = undefined;
      // The same checks as a real report, so a stale guard changes nothing.
      const { advanced } = reading ? this.contentFinished(presentationId) : this.answerFinished(presentationId);
      if (advanced) this.room.changed();
    }, seconds * 1000, () => this.room.changed());
  }

  pause(): void {
    this.assert(this.phase !== PHASES.LOBBY && this.phase !== PHASES.GAME_OVER &&
      this.phase !== PHASES.PAUSED, 'Game cannot be paused now');
    this.paused = {
      phase: this.phase,
      timerName: this.timer?.name ?? null,
      timerMs: this.timer ? Math.max(0, this.timer.endsAt - Date.now()) : null,
      buzzWindowMs: this.buzzer.pending.length && this.buzzWindowEndsAt != null
        ? Math.max(0, this.buzzWindowEndsAt - Date.now()) : null,
    };
    this.clearTimer();
    clearTimeout(this.buzzWindowHandle);
    this.buzzWindowEndsAt = null;
    this.phase = PHASES.PAUSED;
  }

  resume(): void {
    this.assert(this.phase === PHASES.PAUSED && this.paused, 'Game is not paused');
    const saved = this.paused;
    this.paused = null;
    this.phase = saved.phase;
    // Players learn of the resume at different times, so the open signal is scheduled again.
    const rearmMs = this.phase === PHASES.BUZZER_OPEN && !this.buzzer.pending.length && saved.timerName === 'buzzer'
      ? this.openLeadMs() : 0;
    if (saved.timerName && saved.timerMs != null) {
      const onExpire = saved.timerName === 'intro' ? () => this.beginQuestion()
        : saved.timerName === 'ready' ? () => this.startQuestionReading()
        : saved.timerName === 'reading' ? () =>
        this.current?.type === 'forAll' ? this.openForAllAnswers() : this.openBuzzer()
        : saved.timerName === 'stake' ? () => this.passStake(this.auctionTurnId())
        : saved.timerName === 'forAll' ? () => this.closeForAllAnswers()
        : saved.timerName === 'buzzer' ? () => this.expireBuzzer()
          : saved.timerName === 'answering' ? () => this.expireAnswering()
          : saved.timerName === 'final' ? () => this.closeFinal()
            : saved.timerName === 'appeal' ? () => this.resolveAppeal()
              : saved.timerName === 'reveal' ? () => this.next() : undefined;
      this.startTimer(saved.timerName, Math.max(0.001, (saved.timerMs + rearmMs) / 1000), onExpire);
    } else {
      // Pause cleared a clip wait; a report sent while paused was dropped, so wait afresh.
      this.armClipReportGuard();
    }
    if (rearmMs) {
      this.buzzer.openedAt = Date.now() + rearmMs;
      this.room.emitEvent({ type: 'buzzerOpen', openedAt: this.buzzer.openedAt });
    }
    if (this.phase === PHASES.STAKE_AUCTION) {
      const bidder = this.room.participants.get(this.auctionTurnId() ?? '');
      if (bidder?.role !== ROLES.PLAYER || !bidder.connected) this.advanceStakeAuction();
    }
    if (this.phase === PHASES.BUZZER_OPEN && this.buzzer.pending.length) {
      if (saved.buzzWindowMs != null) this.scheduleBuzzWindow(saved.buzzWindowMs);
      else {
        const pool = this.buzzer.pending;
        this.buzzer.pending = [];
        this.grantPendingBuzz(pool);
      }
    }
    // Roster changes while paused may have satisfied the for-all completion rule.
    this.advanceForAllAfterRosterChange();
    // A finalist may have dropped an edit while paused, releasing a held final.
    this.closeFinalWhenAllSent();
  }

  /* ---------------------------------------------------------------- flow */

  start(): void {
    this.assert(this.phase === PHASES.LOBBY || this.phase === PHASES.GAME_OVER, 'Stop the current game before starting again');
    this.room.releaseExpiredSeats();
    this.assert(this.pack, 'Load a pack first');
    this.assert(this.pack.rounds.length > 0, 'This pack has no rounds');
    this.assert(this.activePlayers().length > 0, 'At least one connected player is required');
    this.assert(this.room.host()?.connected, 'A connected host is required before starting');
    if (this.settings.gameMode === 'classic') {
      this.assert(!this.pack.rounds.some((round) =>
        round.themes.some((theme) => theme.questions.some((q) => !['simple', 'noRisk', 'stake', 'secret', 'secretPublicPrice', 'secretNoQuestion', 'forAll'].includes(q.type)))),
      'This pack contains special or final questions; choose Simple game mode');
    }
    this.reset();
    // Readiness is for this start only; back in the lobby everyone confirms again.
    for (const p of this.room.participants.values()) delete p.ready;
    for (const p of this.room.players()) p.score = 0;
    this.enterRound(0);
  }

  stop(): void {
    this.reset();
    this.room.releaseExpiredSeats();
  }

  enterRound(index: number): void {
    this.clearTimer();
    this.roundIndex = index;
    this.current = null;
    this.judgmentUndo = [];
    this.auction = null;
    this.forAll = null;
    this.appeal = null;
    this.resetBuzzer();
    this.removedFinalThemes = new Set();
    const finalThemes = this.finalThemeIndices().length;
    this.phase = this.round?.type === 'final' && finalThemes > 1 ? PHASES.FINAL_THEMES : PHASES.BOARD;

    const players = this.room.players();
    if (this.round?.type === 'final') {
      // The lowest-scoring finalist removes first; without finalists the host removes themes.
      this.chooserId = this.finalists()[0]?.id ?? null;
    } else if (index === 0 || !players.length) {
      this.chooserId = players.length ? players[Math.floor(Math.random() * players.length)].id : null;
    } else {
      this.chooserId = [...players].sort((a, b) => a.score - b.score)[0].id;
    }
    if (this.round?.type === 'final' && finalThemes === 1) {
      // A single final theme needs no pick; go straight to wagers.
      this.selectQuestion(this.chooserId, true, this.finalThemeIndices()[0], 0);
    } else if (this.phase === PHASES.BOARD) this.startChoosingTimer();
    else this.startFinalThemeTimer();
  }

  startFinalThemeTimer(): void {
    // As with question choice, the host may still act after this countdown expires.
    this.startTimer('choosingFinalTheme', this.settings.timeForChoosingFinalTheme);
  }

  removeFinalTheme(actorId: string | null, actorIsModerator: boolean, themeIndex: number): void {
    this.assert(this.phase === PHASES.FINAL_THEMES, 'Final themes are not being eliminated');
    this.assert(actorIsModerator || actorId === this.chooserId, 'It is not your turn to choose');
    this.assert(Number.isInteger(themeIndex) && this.finalThemeIndices().includes(themeIndex) &&
      !this.removedFinalThemes.has(themeIndex), 'That theme is not available');
    const remaining = this.finalThemeIndices().filter((i) => !this.removedFinalThemes.has(i)).length;
    this.assert(remaining > 1, 'The final theme is already selected');
    this.removedFinalThemes.add(themeIndex);
    if (remaining === 2) {
      // The last theme left is the final question; a one-cell board would only add a click.
      const last = this.finalThemeIndices().find((i) => !this.removedFinalThemes.has(i));
      this.assert(last !== undefined, 'No final theme is left');
      this.phase = PHASES.BOARD;
      this.selectQuestion(this.chooserId, true, last, 0);
      return;
    }
    // Finalists take turns removing themes.
    const finalists = this.finalists();
    if (finalists.length) {
      const at = finalists.findIndex((p) => p.id === this.chooserId);
      this.chooserId = finalists[(at + 1) % finalists.length].id;
    }
    this.startFinalThemeTimer();
  }

  startChoosingTimer(): void {
    // Informational only: a human host can always pick on behalf of the chooser.
    this.ensureConnectedChooser();
    this.startTimer('choosing', this.settings.timeForChoosingQuestion);
  }

  nextRound(): void {
    this.assert(this.phase !== PHASES.LOBBY && this.phase !== PHASES.GAME_OVER, 'Start the game first');
    this.assert(this.pack, 'No pack loaded');
    const next = this.pack.rounds[this.roundIndex + 1];
    if (next) this.enterRound(this.roundIndex + 1);
    else this.finish();
  }

  prevRound(): void {
    this.assert(this.phase !== PHASES.LOBBY, 'Start the game first');
    this.assert(this.pack, 'No pack loaded');
    const targetIndex = this.phase === PHASES.GAME_OVER
      ? Math.max(0, this.pack.rounds.length - 1)
      : this.roundIndex - 1;
    this.assert(targetIndex >= 0 && this.pack.rounds[targetIndex], 'Already at the first round');
    this.enterRound(targetIndex);
  }

  finish(): void {
    this.clearTimer();
    this.current = null;
    this.judgmentUndo = [];
    this.auction = null;
    this.forAll = null;
    this.appeal = null;
    this.phase = PHASES.GAME_OVER;
  }

  selectQuestion(actorId: string | null, actorIsModerator: boolean, themeIndex: number, questionIndex: number): void {
    this.assert(this.phase === PHASES.BOARD, 'You cannot choose a question right now');
    this.assert(actorIsModerator || actorId === this.chooserId, 'It is not your turn to choose');
    this.assert(this.isAvailable(themeIndex, questionIndex), 'This question is not available');
    const round = this.round;
    this.assert(round, 'No active round');
    if (round.type === 'final') this.assert(questionIndex === 0, 'Only the first question of a final theme is played');

    const theme = round.themes[themeIndex];
    const question = theme.questions[questionIndex];
    // Special and final questions need their own turn and scoring rules.
    this.assert(round.type === 'final' || this.settings.gameMode === 'simple' ||
      ['simple', 'noRisk', 'stake', 'secret', 'secretPublicPrice', 'secretNoQuestion', 'forAll'].includes(question.type),
      'This question type is not supported yet; use Simple game mode');
    // An auction with no bidder must leave the board untouched for reconnecting players.
    if (round.type !== 'final' && this.settings.gameMode !== 'simple' && question.type === 'stake') {
      this.assert(this.activePlayers().length > 0, 'No connected players can bid');
    }
    this.clearTimer();
    this.played.add(`${this.roundIndex}:${themeIndex}:${questionIndex}`);
    this.judgmentUndo = [];
    this.judgmentSequence = 1;
    this.resetBuzzer();

    this.current = {
      presentationId: randomUUID(),
      themeIndex,
      questionIndex,
      themeName: theme.name,
      price: question.price,
      type: this.settings.gameMode === 'simple' ? 'simple' : question.type,
      question,
      answerShown: false,
      assignedId: null,
      chooserBeforeQuestion: this.chooserId,
      judgments: [],
      picks: [],
    };
    if (round.type === 'final') {
      this.finalWagers = new Map();
      this.finalJudged = new Set();
      this.finalAnswers = new Map();
      this.drafts = new Map();
      this.phase = PHASES.FINAL_WAGER;
      return;
    }
    this.room.emitEvent({ type: 'questionSelected', themeIndex, questionIndex, price: question.price });
    // Like the show, the chosen cell is lit on every screen before the question (or its twist) starts.
    // The intro is its own phase, so commands that accept READING refuse it without extra guards.
    if (this.settings.timeForQuestionIntro > 0) {
      this.phase = PHASES.INTRO;
      this.startTimer('intro', this.settings.timeForQuestionIntro, () => this.beginQuestion());
    } else this.beginQuestion();
  }

  /** Ends the intro: starts the auction, the special setup, or reading for the chosen question. */
  beginQuestion(): void {
    if (!this.current || (this.phase !== PHASES.INTRO && this.phase !== PHASES.BOARD)) return;
    // A host skip arrives while the intro timer is still set; the next step starts its own timers.
    this.clearTimer();
    const { themeIndex, questionIndex } = this.current;
    if (this.current.type === 'stake') {
      // Everyone may have left during the intro. Put the cell back instead of auctioning to nobody.
      if (!this.activePlayers().length) {
        this.played.delete(`${this.roundIndex}:${themeIndex}:${questionIndex}`);
        this.returnToBoard();
        return;
      }
      this.startStakeAuction();
      return;
    }
    if (this.current.type === 'forAll') {
      // Every player connected when the question starts gets a private answer slot.
      this.forAll = { eligibleIds: this.activePlayers().map((p) => p.id), answers: new Map(), judged: new Set() };
      this.drafts = new Map();
      this.presentQuestion();
      return;
    }
    if (this.isAssignedQuestion()) {
      this.phase = PHASES.SPECIAL_SETUP;
      this.startTimer('givingCat', this.settings.timeForGivingACat);
      this.room.emitEvent({ type: 'specialSetup', themeIndex, questionIndex });
      return;
    }
    this.presentQuestion();
  }

  /**
   * Shows the question with a get-ready countdown so players can read ahead and settle on their
   * buttons. Every question type comes here once its twist (auction, secret, gift) is settled.
   */
  presentQuestion(): void {
    if (this.settings.timeForQuestionReady > 0) {
      this.phase = PHASES.READY;
      this.startTimer('ready', this.settings.timeForQuestionReady, () => this.startQuestionReading());
    } else this.startQuestionReading();
  }

  /** Ends the countdown: reading starts, or buttons open at once when false starts are off. */
  startQuestionReading(): void {
    if (!this.current) return;
    // A host skip arrives while the ready timer is still set; the next step starts its own timers.
    this.clearTimer();
    const { question } = this.current;
    this.phase = PHASES.READING;
    // Only buzzer questions may skip reading; for-all and assigned questions always read first.
    if (this.current.type !== 'forAll' && !this.isAssignedQuestion() &&
        !this.settings.falseStart && !this.readingEndsOnSignal(question)) {
      const totalSeconds = this.estimateReadingSeconds(question) + this.settings.timeForThinkingOnQuestion;
      this.openBuzzer(totalSeconds);
    } else {
      this.startReading(question);
    }
  }

  isAssignedQuestion(): boolean {
    return ['stake', 'secret', 'secretPublicPrice', 'secretNoQuestion'].includes(this.current?.type ?? '');
  }

  /** The chooser bids first, then players follow ascending-score order. */
  startStakeAuction(): void {
    this.assert(this.current, 'No active question');
    // Parsed stake questions have no hidden-stake subtype, so all connected players may bid.
    const players = [...this.activePlayers()].sort((a, b) => a.score - b.score || a.joinedAt - b.joinedAt);
    this.assert(players.length > 0, 'No connected players can bid');
    const chooserIndex = Math.max(0, players.findIndex((p) => p.id === this.chooserId));
    const order = [...players.slice(chooserIndex), ...players.slice(0, chooserIndex)].map((p) => p.id);
    this.auction = {
      order, turnIndex: -1, leaderId: null, amount: 0, allIn: false,
      passed: new Set(), minimum: this.current.question.price,
    };
    this.phase = PHASES.STAKE_AUCTION;
    this.advanceStakeAuction();
  }

  auctionTurnId(): string | null {
    return this.auction?.order[this.auction.turnIndex] ?? null;
  }

  /**
   * The bidder's phone dropped (a refresh, an app switch). Skipping them at once burned the whole
   * question when everyone else had passed (device playtest F16), so the turn waits a short grace,
   * never longer than the bid clock had left. Still offline then: the turn moves on as before.
   */
  holdAuctionTurn(playerId: string): void {
    if (this.phase !== PHASES.STAKE_AUCTION || this.auctionTurnId() !== playerId) return;
    const leftMs = this.timer ? this.timer.endsAt - Date.now() : AUCTION_RECONNECT_GRACE_MS;
    this.startTimer('stake', Math.max(0.001, Math.min(leftMs, AUCTION_RECONNECT_GRACE_MS) / 1000), () => {
      if (this.auctionTurnId() !== playerId) return;
      if (this.room.participants.get(playerId)?.connected) this.passStake(playerId);
      else this.advanceStakeAuction();
    });
  }

  /** The bidder is back within the grace: their turn gets a fresh bid clock. */
  resumeAuctionTurn(playerId: string): void {
    if (this.phase !== PHASES.STAKE_AUCTION || this.auctionTurnId() !== playerId) return;
    this.startTimer('stake', this.settings.timeForMakingStake, () => this.passStake(playerId));
  }

  /** Skips passed/disconnected players and the current leader; their prior bid still stands. */
  advanceStakeAuction(): void {
    const auction = this.auction;
    this.assert(auction && this.phase === PHASES.STAKE_AUCTION, 'No stake auction is active');
    for (let offset = 1; offset <= auction.order.length; offset++) {
      const index = (auction.turnIndex + offset) % auction.order.length;
      const id = auction.order[index];
      const player = this.room.participants.get(id);
      if (id === auction.leaderId || auction.passed.has(id) ||
          player?.role !== ROLES.PLAYER || !player.connected) continue;
      auction.turnIndex = index;
      this.startTimer('stake', this.settings.timeForMakingStake, () => this.passStake(id));
      return;
    }
    this.finishStakeAuction();
  }

  bidStake(playerId: string, amount: number, allIn = false): void {
    const auction = this.auction;
    this.assert(this.phase === PHASES.STAKE_AUCTION && auction, 'No stake auction is active');
    this.assert(playerId === this.auctionTurnId(), 'It is not your turn to bid');
    const player = this.room.participants.get(playerId);
    this.assert(player?.role === ROLES.PLAYER && player.connected, 'Only a connected player may bid');
    this.assert(typeof allIn === 'boolean' && Number.isInteger(amount), 'Bid must be a whole number');
    this.assert(amount >= auction.minimum && amount > auction.amount, `Bid must exceed ${auction.amount} and reach ${auction.minimum}`);
    if (allIn) {
      this.assert(amount === player.score, 'All-in bid must equal your score');
    } else {
      this.assert(!auction.allIn, 'Only a higher all-in bid can beat an all-in');
      this.assert(amount <= Math.max(auction.minimum, player.score), 'Bid exceeds your available stake');
    }
    auction.leaderId = playerId;
    auction.amount = amount;
    auction.allIn = allIn;
    this.room.emitEvent({ type: 'stakeBid', playerId, amount, allIn });
    this.advanceStakeAuction();
  }

  passStake(playerId: string | null): void {
    const auction = this.auction;
    this.assert(this.phase === PHASES.STAKE_AUCTION && auction, 'No stake auction is active');
    this.assert(playerId && playerId === this.auctionTurnId(), 'It is not your turn to bid');
    auction.passed.add(playerId);
    this.room.emitEvent({ type: 'stakePass', playerId });
    this.advanceStakeAuction();
  }

  finishStakeAuction(): void {
    const auction = this.auction;
    this.assert(auction, 'No stake auction is active');
    this.clearTimer();
    this.auction = null;
    this.assert(this.current, 'No active question');
    const winner = auction.leaderId ? this.room.participants.get(auction.leaderId) : null;
    if (winner?.role !== ROLES.PLAYER || !winner.connected) {
      // Everyone passed or the high bidder left: never assign an offline answerer.
      this.phase = PHASES.REVEAL;
      this.current.answerShown = true;
      this.scheduleRevealClose();
      return;
    }
    this.current.price = auction.amount;
    this.current.assignedId = auction.leaderId;
    this.room.emitEvent({ type: 'stakeWon', playerId: auction.leaderId, amount: auction.amount });
    this.presentQuestion();
  }

  openForAllAnswers(): void {
    this.assert(this.phase === PHASES.READING && this.current?.type === 'forAll' && this.forAll,
      'No for-all question is being read');
    this.phase = PHASES.FOR_ALL_ANSWERING;
    this.startTimer('forAll', this.settings.timeForThinkingOnSpecial, () => this.closeForAllAnswers());
    this.advanceForAllAfterRosterChange();
  }

  submitForAllAnswer(playerId: string, answer: string): void {
    this.assert(this.phase === PHASES.FOR_ALL_ANSWERING && this.forAll, 'Answers are closed');
    const forAll = this.forAll;
    this.assert(this.forAllEligibleIds().includes(playerId) &&
      this.room.participants.get(playerId)?.connected, 'You cannot answer this question');
    this.assert(!forAll.answers.has(playerId), 'Answer already submitted');
    this.assert(typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 350,
      'Answer must be 1–350 characters');
    forAll.answers.set(playerId, answer.trim());
    this.advanceForAllAfterRosterChange();
  }

  advanceForAllAfterRosterChange(): void {
    if (!this.forAll) return;
    // Offline players keep a judging slot, but cannot hold the answer timer open.
    if (this.phase === PHASES.FOR_ALL_ANSWERING && this.forAllEligibleIds().every((id) =>
      !this.room.participants.get(id)?.connected || this.forAll?.answers.has(id))) {
      this.closeForAllAnswers();
    } else if (this.phase === PHASES.FOR_ALL_JUDGE && this.forAllEligibleIds().every((id) =>
      this.forAll?.judged.has(id))) {
      this.revealAnswer();
    }
  }

  closeForAllAnswers(): void {
    this.assert(this.phase === PHASES.FOR_ALL_ANSWERING && this.forAll, 'Answers are closed');
    this.clearTimer();
    // A sent for-all answer is final (no resubmit), so a draft only fills an empty slot.
    for (const id of this.forAllEligibleIds()) {
      const draft = this.drafts.get(id);
      if (draft && !this.forAll.answers.has(id)) this.forAll.answers.set(id, draft);
    }
    this.drafts.clear();
    this.phase = PHASES.FOR_ALL_JUDGE;
    if (!this.forAllEligibleIds().length) this.revealAnswer();
  }

  judgeForAll(playerId: string, correct: boolean): void {
    this.assert(this.phase === PHASES.FOR_ALL_JUDGE && this.forAll, 'For-all answers are not being judged');
    this.assert(this.current, 'No active question');
    const forAll = this.forAll;
    const current = this.current;
    this.assert(typeof correct === 'boolean', 'Verdict must be true or false');
    this.assert(this.forAllEligibleIds().includes(playerId) && !forAll.judged.has(playerId),
      'Player already judged or not in this question');
    const player = this.room.participants.get(playerId);
    this.assert(player, 'Unknown player');
    const hasAnswer = forAll.answers.has(playerId);
    const accepted = correct && hasAnswer;
    const delta = accepted ? current.price : this.settings.ignoreWrong ? 0 : -current.price;
    this.captureJudgmentUndo();
    player.score += delta;
    this.recordJudgment(playerId, accepted, delta, current.price,
      this.settings.ignoreWrong ? 0 : -current.price, 'forAll');
    forAll.judged.add(playerId);
    this.room.emitEvent({ type: 'answerJudged', playerId, correct: accepted, delta });
    if (this.forAllEligibleIds().every((id) => forAll.judged.has(id))) this.revealAnswer();
  }

  configureSpecial(playerId: string, price: number): void {
    this.assert(this.phase === PHASES.SPECIAL_SETUP, 'No special question is awaiting setup');
    this.assert(this.current, 'No active question');
    const current = this.current;
    const player = this.room.participants.get(playerId);
    this.assert(player?.role === ROLES.PLAYER && player.connected, 'Choose a connected player');
    const { type, question } = current;
    const range = question.typeParams?.price;
    // A secret without a question is a gift of the pack's fixed value.
    const gift = type === 'secretNoQuestion';
    const minimum = gift ? question.price : range?.minimum ?? question.price;
    const maximum = gift ? question.price : range?.maximum ?? Math.max(question.price, player.score);
    const step = range?.step || 1;
    this.assert(Number.isSafeInteger(price) && price >= minimum && price <= maximum &&
      (price - minimum) % step === 0, `Value must be ${minimum}–${maximum} in steps of ${step}`);
    // A chosen stake may use a player's score instead of the pack's bounded price range.
    this.assert(Number.isSafeInteger(player.score + price) &&
      (gift || Number.isSafeInteger(player.score - price)), 'Value would exceed a safe score');
    if (type.startsWith('secret') && question.typeParams?.selectionMode === 'exceptCurrent') {
      this.assert(playerId !== this.chooserId, 'Choose another player for this secret question');
    }
    current.price = price;
    current.assignedId = playerId;
    if (gift) {
      this.clearTimer();
      player.score += price;
      this.recordJudgment(playerId, true, price, price, 0, 'gift');
      current.answerShown = true;
      this.phase = PHASES.REVEAL;
      this.scheduleRevealClose();
      this.room.emitEvent({ type: 'giftAwarded', playerId, price });
      return;
    }
    this.presentQuestion();
  }

  setFinalWager(playerId: string, amount: number): void {
    this.assert(this.phase === PHASES.FINAL_WAGER, 'Final wagers are closed');
    const player = this.room.participants.get(playerId);
    this.assert(player?.role === ROLES.PLAYER, 'Only players may wager');
    this.assert(player.score > 0, 'Only players with a positive score play the final');
    this.assert(Number.isInteger(amount) && amount >= 0 && amount <= player.score,
      'Wager must be between zero and your current score');
    this.finalWagers.set(playerId, amount);
  }

  openFinal(): void {
    this.assert(this.phase === PHASES.FINAL_WAGER, 'Final question is not ready');
    this.assert(this.finalists().every((p) => this.finalWagers.has(p.id)), 'Wait for every finalist to wager');
    // A disconnected finalist cannot block the final; their wager defaults to zero.
    for (const player of this.room.players()) {
      if (player.score > 0 && !this.finalWagers.has(player.id)) {
        this.finalWagers.set(player.id, 0);
        this.finalJudged.add(player.id);
      }
    }
    this.phase = PHASES.FINAL_QUESTION;
    this.startTimer('final', this.settings.timeForFinalThinking, () => this.closeFinal());
  }

  /**
   * Saves what a player has typed but not sent. Accepted while the answer box is open, also during a
   * pause. A draft never counts as an answer. Returns true when others must hear about it: a
   * finalist started or stopped changing a sent answer (the host sees who holds the close), or
   * dropping such a change let a held final close.
   */
  saveDraft(playerId: string, text: unknown): boolean {
    this.assert(typeof text === 'string' && text.length <= 350, 'Answer must be at most 350 characters');
    const phase = this.phase === PHASES.PAUSED ? this.paused?.phase : this.phase;
    if (phase === PHASES.FINAL_QUESTION) {
      this.assert(this.finalEligibleIds().includes(playerId) && !this.finalJudged.has(playerId),
        'You are not playing this final');
    } else {
      this.assert(phase === PHASES.FOR_ALL_ANSWERING && this.forAll, 'Answers are closed');
      this.assert(this.forAllEligibleIds().includes(playerId) && !this.forAll.answers.has(playerId),
        'You cannot answer this question');
    }
    const editing = () => this.finalAnswers.has(playerId) && this.drafts.has(playerId);
    const wasEditing = editing();
    const draft = text.trim();
    // A draft equal to the sent final answer is no edit at all.
    if (draft && draft !== this.finalAnswers.get(playerId)) this.drafts.set(playerId, draft);
    else this.drafts.delete(playerId);
    return this.closeFinalWhenAllSent() || editing() !== wasEditing;
  }

  /** Finalists write a private answer so the host can judge what they actually said. */
  submitFinalAnswer(playerId: string, answer: unknown): void {
    this.assert(this.phase === PHASES.FINAL_QUESTION, 'Final answers are closed');
    this.assert(this.finalEligibleIds().includes(playerId) && !this.finalJudged.has(playerId),
      'You are not playing this final');
    this.assert(typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 350,
      'Answer must be 1–350 characters');
    this.finalAnswers.set(playerId, answer.trim());
    // The sent text replaces any draft; a later edit saves a new draft that wins at close.
    this.drafts.delete(playerId);
    this.closeFinalWhenAllSent();
  }

  /**
   * Everyone online has sent an answer and nobody is changing one: waiting out the clock would only
   * stall the room. An edit typed after sending holds the close, so another player's last answer can
   * never lock in someone's half-typed change; the timer or the host still ends it.
   */
  closeFinalWhenAllSent(): boolean {
    if (this.phase !== PHASES.FINAL_QUESTION) return false;
    const waiting = this.finalEligibleIds().filter((id) => !this.finalJudged.has(id) &&
      this.room.participants.get(id)?.connected && (!this.finalAnswers.has(id) || this.drafts.has(id)));
    if (waiting.length) return false;
    this.closeFinal();
    return true;
  }

  closeFinal(): void {
    this.assert(this.phase === PHASES.FINAL_QUESTION, 'Final question is not open');
    this.clearTimer();
    // Sending clears a draft, so any draft left here was typed after the last send: it is the newest text.
    for (const [id, draft] of this.drafts) {
      if (this.finalEligibleIds().includes(id) && !this.finalJudged.has(id)) this.finalAnswers.set(id, draft);
    }
    this.drafts.clear();
    this.phase = PHASES.FINAL_JUDGE;
    if (this.finalEligibleIds().every((id) => this.finalJudged.has(id))) this.revealAnswer();
  }

  judgeFinal(playerId: string, correct: boolean): void {
    this.assert(this.phase === PHASES.FINAL_JUDGE, 'Final answers are not being judged');
    this.assert(typeof correct === 'boolean', 'Verdict must be true or false');
    this.assert(this.finalEligibleIds().includes(playerId) && !this.finalJudged.has(playerId),
      'Player already judged or not in final');
    const player = this.room.participants.get(playerId);
    this.assert(player, 'Unknown player');
    const amount = this.finalWagers.get(playerId);
    this.assert(amount !== undefined, 'Player has no final wager');
    const delta = correct ? amount : -amount;
    this.captureJudgmentUndo();
    player.score += delta;
    this.recordJudgment(playerId, correct, delta, amount, -amount, 'final');
    this.finalJudged.add(playerId);
    if (this.finalEligibleIds().every((id) => this.finalJudged.has(id))) this.revealAnswer();
  }

  /** Estimates how long the question takes to present, using SIGame's ReadingSpeed. */
  estimateReadingSeconds(question: Question): number {
    let seconds = 0;
    for (const item of question.content) {
      if (item.type === 'audio' || item.type === 'video') seconds += this.settings.timeForMediaDelay;
      if (item.type === 'text' || item.type === 'say') seconds += item.value.length / this.settings.readingSpeed;
      else if (item.duration) seconds += item.duration;
      else if (item.type === 'image') seconds += 2;
      else if (item.type === 'audio' || item.type === 'video') seconds += 10;
    }
    return Math.max(1, Math.ceil(seconds));
  }

  hasWaitForFinishMedia(question: Question): boolean {
    return question.content.some((item) =>
      (item.type === 'audio' || item.type === 'video') && item.waitForFinish);
  }

  /**
   * Reading that the host's device ends (contentFinished), not an estimate: a waitForFinish script,
   * and a select question with a clip, whose options appear one by one only after the clip ends.
   */
  readingEndsOnSignal(question: Question): boolean {
    return this.hasWaitForFinishMedia(question) || (question.answerType === 'select' &&
      question.content.some((item) => item.type === 'audio' || item.type === 'video'));
  }

  startReading(question: Question): void {
    // A media completion signal, not an estimated duration, ends a waitForFinish script.
    if (this.readingEndsOnSignal(question)) {
      this.clearTimer();
      this.armClipReportGuard();
      return;
    }
    this.startTimer('reading', this.estimateReadingSeconds(question), () =>
      this.current?.type === 'forAll' ? this.openForAllAnswers() : this.openBuzzer());
  }

  /** The host's device reports that the question's media ended; buzzers open then instead of on an estimate. */
  contentFinished(presentationId: string): { advanced: boolean } {
    if (this.phase !== PHASES.READING || !this.current ||
        this.current.presentationId !== presentationId ||
        !this.current.question.content.some((item) => item.type === 'audio' || item.type === 'video')) return { advanced: false };
    if (this.current.type === 'forAll') this.openForAllAnswers();
    else this.openBuzzer();
    return { advanced: true };
  }

  /** Resolve queued presses using the mode active when they were collected. */
  grantPendingBuzz(pool: PendingBuzz[]): boolean {
    clearTimeout(this.buzzWindowHandle);
    this.buzzWindowHandle = undefined;
    this.buzzWindowEndsAt = null;
    // A player who disconnected or left their seat cannot win a delayed buzz.
    const eligible = pool.filter(({ playerId }) => {
      const player = this.room.participants.get(playerId);
      return player?.role === ROLES.PLAYER && player.connected;
    });
    if (!eligible.length) return false;
    if (eligible[0].mode === 'random') {
      const chosen = eligible[Math.floor(Math.random() * eligible.length)];
      this.grantAnswer(chosen.playerId, {
        mode: 'random',
        reactionMs: Math.max(0, chosen.serverAt - (this.buzzer.openedAt ?? chosen.serverAt)),
      });
      return true;
    }
    eligible.sort((a, b) => a.effectiveAt - b.effectiveAt || a.serverAt - b.serverAt);
    const chosen = eligible[0];
    this.grantAnswer(chosen.playerId, {
      mode: 'clientTimestamp',
      reactionMs: Math.max(0, Math.round(chosen.effectiveAt - (this.buzzer.openedAt ?? chosen.effectiveAt))),
      transitMs: chosen.transitMs,
      contenders: eligible.length,
    });
    return true;
  }

  scheduleBuzzWindow(delayMs: number): void {
    this.buzzWindowEndsAt = Date.now() + delayMs;
    this.buzzWindowHandle = safeTimeout('buzz window', () => {
      this.buzzWindowEndsAt = null;
      const pool = this.buzzer.pending;
      this.buzzer.pending = [];
      if (this.phase === PHASES.BUZZER_OPEN && pool.length) {
        this.grantPendingBuzz(pool);
        this.room.changed();
      }
    }, delayMs, () => this.room.changed());
  }

  expireBuzzer(): void {
    // A press before the countdown deadline counts even if its collection window is still open.
    // Time is up with no answerer: end the question and show what the answer was.
    if (!this.buzzer.pending.length) return this.revealAnswer();
    const pool = this.buzzer.pending;
    this.buzzer.pending = [];
    if (this.grantPendingBuzz(pool)) this.buzzer.remainingMs = 1000;
    else this.revealAnswer();
  }

  /**
   * Opens the buttons. The open moment is scheduled `leadMs` ahead so every screen turns green
   * together on the synced clock: a slow phone or weak Wi-Fi no longer sees the signal late.
   * Without the lead the fastest device won ~90 % of equal-speed presses (fairness simulation).
   */
  openBuzzer(overrideSeconds?: number, leadMs = this.openLeadMs()): void {
    this.assert(this.phase === PHASES.READING || this.phase === PHASES.ANSWERING, 'Buttons cannot be opened now');
    this.assert(this.current?.type !== 'forAll', 'For-all questions do not use buttons');
    if (this.isAssignedQuestion()) {
      this.assert(this.current?.assignedId, 'No player is assigned');
      this.grantAnswer(this.current.assignedId);
      return;
    }
    clearTimeout(this.buzzWindowHandle);
    this.buzzWindowEndsAt = null;
    this.phase = PHASES.BUZZER_OPEN;
    this.buzzer.winnerId = null;
    this.buzzer.winnerInfo = null;
    this.buzzer.typedAnswer = null;
    this.buzzer.typedAnswerClosed = false;
    this.buzzer.pending = [];
    this.buzzer.openedAt = Date.now() + leadMs;
    const seconds =
      overrideSeconds != null
        ? overrideSeconds
        : this.buzzer.remainingMs != null
          ? this.buzzer.remainingMs / 1000
          : this.settings.timeForThinkingOnQuestion;
    // The lead is waiting, not thinking time, so the countdown gets it on top.
    this.startTimer('buzzer', seconds + leadMs / 1000, () => this.expireBuzzer());
    this.room.emitEvent({ type: 'buzzerOpen', openedAt: this.buzzer.openedAt });
  }

  /** The open lead for the players seated now: the host's setting, longer for a slow connection. */
  openLeadMs(): number {
    return openLeadMs(this.settings.buzzOpenLeadMs, this.room.worstPlayerRttMs());
  }

  /** The comparison window for the players seated now: the host's setting, longer for a slow upload. */
  syncWindowMs(): number {
    return syncWindowMs(this.settings.buzzSyncWindowMs, this.room.worstPlayerRttMs());
  }

  /** When the player pressed, on the server clock, from their calibrated device time. */
  clientPressTime(serverNow: number, rawClientAt?: unknown): number {
    const num = Number(rawClientAt);
    if (!Number.isFinite(num)) return serverNow;
    // A player's clock is trusted only a little way back, so a skewed or forged clientAt cannot
    // jump the queue by seconds (audit SEC-4).
    return Math.min(serverNow + 20, Math.max(serverNow - CLIENT_CLOCK_TRUST_MS, num));
  }

  resolvePressTimestamp(serverNow: number, rawClientAt?: unknown): number {
    // An early press allowed by the rules (false starts off) counts as pressed at the signal.
    return Math.max(this.buzzer.openedAt ?? serverNow, this.clientPressTime(serverNow, rawClientAt));
  }

  blockFalseStart(playerId: string, now: number): { result: BuzzResult } {
    this.buzzer.blockedUntil.set(playerId, now + this.settings.timeForBlockingButton * 1000);
    this.room.emitEvent({ type: 'falseStart', playerId });
    this.room.changed();
    return { result: 'falseStart' };
  }

  buzz(playerId: string, meta: { clientAt?: number } = {}): { result: BuzzResult } {
    const now = Date.now();
    const player = this.room.participants.get(playerId);
    if (!player || player.role !== ROLES.PLAYER) return { result: 'ignored' };

    if (this.phase === PHASES.READING) {
      if (this.isAssignedQuestion()) return { result: 'ignored' };
      if (!this.settings.falseStart) {
        // Someone already pressed, so there is nothing to wait for: open at once.
        this.openBuzzer(undefined, 0);
        return this.buzz(playerId, meta);
      }
      return this.blockFalseStart(playerId, now);
    }

    if (this.phase !== PHASES.BUZZER_OPEN) return { result: 'ignored' };
    if (this.buzzer.attempted.has(playerId)) return { result: 'ignored' };
    if ((this.buzzer.blockedUntil.get(playerId) ?? 0) > now) return { result: 'ignored' };
    // Pressed before the scheduled signal. With device time this also catches a laggy press made
    // before green that arrives after it; arrival order cannot tell those apart.
    const pressedAt = this.settings.buzzSyncMode === 'clientTimestamp' ? this.clientPressTime(now, meta?.clientAt) : now;
    if (this.settings.falseStart && pressedAt < (this.buzzer.openedAt ?? now)) return this.blockFalseStart(playerId, now);

    if (this.buzzer.pending[0]?.mode === 'random' ||
        (!this.buzzer.pending.length && this.settings.buttonPressMode === 'randomWithinInterval' && this.settings.buttonPressIntervalMs > 0)) {
      const firstPress = this.buzzer.pending.length === 0;
      if (!this.buzzer.pending.some((p) => p.playerId === playerId)) {
        this.buzzer.pending.push({ playerId, mode: 'random', serverAt: now, effectiveAt: now });
      }
      if (firstPress) {
        this.scheduleBuzzWindow(this.settings.buttonPressIntervalMs);
      }
      return { result: 'queued' };
    }

    if (this.buzzer.pending[0]?.mode === 'clientTimestamp' ||
        (!this.buzzer.pending.length && this.settings.buzzSyncMode === 'clientTimestamp' && this.settings.buzzSyncWindowMs > 0)) {
      const effectiveAt = this.resolvePressTimestamp(now, meta?.clientAt);
      const firstPress = this.buzzer.pending.length === 0;
      if (!this.buzzer.pending.some((p) => p.playerId === playerId)) {
        this.buzzer.pending.push({
          playerId,
          mode: 'clientTimestamp',
          serverAt: now,
          effectiveAt,
          transitMs: Math.max(0, Math.round(now - effectiveAt)),
        });
      }
      if (firstPress) {
        this.scheduleBuzzWindow(this.syncWindowMs());
      }
      return { result: 'queued' };
    }

    this.grantAnswer(playerId, {
      mode: 'server',
      reactionMs: Math.max(0, Math.round(now - (this.buzzer.openedAt ?? now))),
    });
    this.room.changed();
    return { result: 'accepted' };
  }

  grantAnswer(playerId: string, winnerInfo: WinnerInfo | null = null): void {
    this.buzzer.remainingMs = this.timer ? Math.max(1000, this.timer.endsAt - Date.now()) : null;
    this.buzzer.winnerId = playerId;
    this.buzzer.winnerInfo = winnerInfo;
    this.buzzer.typedAnswer = null;
    this.buzzer.typedAnswerClosed = false;
    this.phase = PHASES.ANSWERING;
    // The host must make the verdict; an elapsed countdown must not silently decide it.
    // Tapped answers (options, picture clicks) are auto-judged, so their timeout counts as wrong.
    this.startTimer('answering', this.current?.question.answerDuration ?? this.settings.timeForPrintingAnswer,
      () => this.expireAnswering());
    this.room.emitEvent({ type: 'buzzAccepted', playerId, winnerInfo, assigned: this.isAssignedQuestion() });
  }

  expireAnswering(): void {
    if (this.phase !== PHASES.ANSWERING) return;
    if (this.answerType() !== 'text' && this.buzzer.typedAnswer === null) {
      this.buzzer.typedAnswerClosed = true;
      this.judge(false);
    } else if (!this.settings.oral) this.buzzer.typedAnswerClosed = true;
  }

  submitAnswer(playerId: string, answer: unknown): void {
    this.assert(this.phase === PHASES.ANSWERING && this.buzzer.winnerId === playerId,
      'Only the current answerer can submit');
    this.assert(this.usesAnswerInput(), 'Written answers are disabled');
    this.assert(this.buzzer.typedAnswer === null, 'Answer already submitted');
    this.assert(!this.buzzer.typedAnswerClosed && this.timer?.name === 'answering' &&
      Date.now() < this.timer.endsAt, 'Answer time has ended');
    this.assert(typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 350,
      'Answer must be 1–350 characters');
    const type = this.answerType();
    if (type === 'text') {
      this.buzzer.typedAnswer = answer.trim();
      this.buzzer.typedAnswerClosed = true;
      return;
    }
    const value = answer.trim();
    const correct = type === 'select' ? this.isRightOption(value) : this.isRightPoint(value);
    this.buzzer.typedAnswer = value;
    this.buzzer.typedAnswerClosed = true;
    this.current!.picks.push({ playerId, value, correct });
    this.judge(correct);
  }

  isRightOption(label: string): boolean {
    const question = this.current!.question;
    this.assert(question.answerOptions.some((option) => option.label === label), 'Choose one of the options');
    return question.right.some((right) => right.trim().toUpperCase() === label.toUpperCase());
  }

  /**
   * Pack answers read "x,y,aspect" with x and y as fractions of the picture and aspect as its
   * width/height ratio. As in SIGame's AnswerChecker, x is scaled by the aspect so distance and
   * deviation are measured in picture heights and the hit area stays round.
   */
  isRightPoint(value: string): boolean {
    const click = parsePoint(value);
    this.assert(click, 'Click on the picture');
    const question = this.current!.question;
    const deviation = question.answerDeviation ?? 0.05;
    return question.right.some((right) => {
      const target = parsePoint(right);
      if (!target) return false;
      const aspect = target.aspect ?? 1;
      return Math.hypot((click.x - target.x) * aspect, click.y - target.y) <= deviation;
    });
  }

  /** `factor` lets the host award half (a partly right answer) or double the question value. */
  judge(correct: boolean, factor = 1): void {
    this.assert(this.phase === PHASES.ANSWERING && this.buzzer.winnerId, 'Nobody is answering');
    this.assert(REWARD_FACTORS.includes(factor), 'Reward must be half, full or double');
    this.assert(this.current, 'No active question');
    this.assert(!this.usesAnswerInput() || this.buzzer.typedAnswer !== null || this.buzzer.typedAnswerClosed,
      'Wait for the written answer or its deadline');
    const player = this.room.participants.get(this.buzzer.winnerId);
    const price = this.current.price;
    this.captureJudgmentUndo();

    if (correct) {
      const reward = Math.round(price * factor);
      if (player) player.score += reward;
      this.recordJudgment(this.buzzer.winnerId, true, reward, reward,
        this.settings.ignoreWrong || this.current.type === 'noRisk' ? 0 : -price);
      this.chooserId = this.buzzer.winnerId;
      this.room.emitEvent({ type: 'answerJudged', playerId: this.buzzer.winnerId, correct: true, delta: reward });
      this.revealAnswer();
      return;
    }

    // Sponsored/no-risk questions do not penalize a wrong answer.
    const delta = this.settings.ignoreWrong || this.current.type === 'noRisk' ? 0 : -price;
    if (player) player.score += delta;
    this.recordJudgment(this.buzzer.winnerId, false, delta, price, delta);
    this.buzzer.attempted.add(this.buzzer.winnerId);
    this.room.emitEvent({ type: 'answerJudged', playerId: this.buzzer.winnerId, correct: false, delta });
    this.continueAfterMiss();
  }

  /**
   * The answerer gives up: no points lost, but they are out for this question and the others may
   * still buzz. An assigned question (cat, auction) must be answered, or a bidder could take a
   * stake and walk away from it for free. Only the host passes, for the answerer, e.g. when they
   * say "pass" out loud; players no longer have a Pass button of their own.
   */
  passAnswer(): void {
    const playerId = this.buzzer.winnerId;
    this.assert(this.phase === PHASES.ANSWERING && playerId, 'Nobody is answering');
    this.assert(!this.isAssignedQuestion(), 'This question must be answered');
    this.assert(this.buzzer.typedAnswer === null, 'Answer already submitted');
    // A missed written deadline waits for the host's verdict; passing then would dodge the penalty.
    this.assert(!this.buzzer.typedAnswerClosed, 'Answer time has ended');
    this.buzzer.attempted.add(playerId);
    this.room.emitEvent({ type: 'answerPassed', playerId });
    this.continueAfterMiss();
  }

  /** After a wrong answer or a pass: reopen the buttons, or end the question when nobody is left. */
  continueAfterMiss(): void {
    const someoneLeft = this.activePlayers().some((p) => !this.buzzer.attempted.has(p.id));
    if (someoneLeft && !this.isAssignedQuestion()) this.openBuzzer();
    // Nobody can still answer: end the question and show what the answer was.
    else this.revealAnswer();
  }

  estimateRevealSeconds(question: Question): number {
    // A picture answer needs a moment to be found and understood; text alone reads faster.
    let seconds = question.answerContent.some((item) => item.type === 'image') ||
      question.answerType === 'point' ? 6 : 4;
    for (const item of question.answerContent) {
      if (item.duration) seconds = Math.max(seconds, Math.ceil(item.duration));
      else if (item.type === 'audio' || item.type === 'video') seconds = Math.max(seconds, 5);
    }
    return seconds;
  }

  revealAnswer(): void {
    this.assert((QUESTION_PHASES.has(this.phase) && this.round?.type !== 'final') ||
      (this.phase === PHASES.FINAL_JUDGE && this.finalEligibleIds().every((id) => this.finalJudged.has(id))),
      'Judge every final answer before revealing');
    this.assert(this.current?.type !== 'forAll' ||
      (this.phase === PHASES.FOR_ALL_JUDGE && this.forAllEligibleIds().every((id) => this.forAll?.judged.has(id))),
    'Judge every for-all answer before revealing');
    this.assert(this.current, 'No active question');
    this.clearTimer();
    clearTimeout(this.buzzWindowHandle);
    this.buzzWindowEndsAt = null;
    this.phase = PHASES.REVEAL;
    this.current.answerShown = true;
    this.scheduleRevealClose();
  }

  /** Answer clips the host's device plays in full; a point answer shows on the picture, not its clips. */
  hasAnswerClip(question: Question): boolean {
    return question.answerType !== 'point' &&
      question.answerContent.some((item) => item.type === 'audio' || item.type === 'video');
  }

  /**
   * Every answer leaves the screen on its own, so the host never has to close a question by hand.
   * An answer clip (the song behind a music question) plays to its end: the host's device reports
   * that through answerFinished. Anything else stays up long enough to read it and to challenge
   * the verdict. The final waits for the host, because moving on from it ends the game.
   * A hidden guard (armClipReportGuard) closes a clip answer whose end report never arrives.
   */
  private scheduleRevealClose(waitForClip = true): void {
    if (!this.current || this.round?.type === 'final') return;
    if (waitForClip && this.hasAnswerClip(this.current.question)) return this.armClipReportGuard();
    this.startTimer('reveal', this.estimateRevealSeconds(this.current.question), () => this.next());
  }

  /** The host's device reports that the answer's clips played out; the question closes then. */
  answerFinished(presentationId: string): { advanced: boolean } {
    if (this.phase !== PHASES.REVEAL || !this.current || this.round?.type === 'final' ||
        this.current.presentationId !== presentationId ||
        !this.hasAnswerClip(this.current.question)) return { advanced: false };
    this.next();
    return { advanced: true };
  }

  /** An answerer may challenge a rejection; another player may challenge an acceptance. */
  requestAppeal(requesterId: string, judgmentId: number): void {
    this.assert(this.phase === PHASES.REVEAL && this.current, 'Appeals open after the answer is revealed');
    this.assert(this.settings.useApellations, 'Appeals are disabled');
    const requester = this.room.participants.get(requesterId);
    this.assert(requester?.role === ROLES.PLAYER && requester.connected, 'Only connected players may appeal');
    const judgment = this.current.judgments.find((item) => item.id === judgmentId);
    this.assert(judgment && !judgment.appealed && !judgment.voided && judgment.kind !== 'gift',
      'That verdict cannot be appealed');
    this.assert(this.room.participants.get(judgment.playerId)?.role === ROLES.PLAYER,
      'The answerer is no longer a player');
    const kind = judgment.correct ? 'against' : 'for';
    if (kind === 'for') {
      this.assert(requesterId === judgment.playerId, 'Only the answerer may appeal a rejection');
      this.assert(judgment.kind !== 'forAll' || this.forAll?.answers.has(requesterId),
        'A blank answer cannot be appealed');
    } else {
      this.assert(requesterId !== judgment.playerId, 'Another player must challenge an acceptance');
      this.assert(this.activePlayers().length > 3, 'At least four connected players are required');
    }

    const eligibleVoterIds = this.activePlayers().map((p) => p.id)
      .filter((id) => id !== judgment.playerId && (kind === 'for' || id !== requesterId));
    // Once an answer was contested, reverting a prior verdict would invalidate the vote.
    this.judgmentUndo = [];
    this.appeal = { judgmentId, requesterId, targetId: judgment.playerId, kind,
      eligibleVoterIds, votes: new Map() };
    this.phase = PHASES.APPEAL_VOTE;
    this.room.emitEvent({ type: 'appealStarted', judgmentId, requesterId,
      targetId: judgment.playerId, kind });
    if (eligibleVoterIds.length) {
      this.startTimer('appeal', this.settings.timeForShowmanDecisions, () => this.resolveAppeal());
    } else {
      this.resolveAppeal();
    }
  }

  voteAppeal(playerId: string, support: boolean): void {
    this.assert(this.phase === PHASES.APPEAL_VOTE && this.appeal, 'No appeal vote is open');
    const appeal = this.appeal;
    this.assert(typeof support === 'boolean', 'Vote must be true or false');
    this.assert(appeal.eligibleVoterIds.includes(playerId) &&
      this.room.participants.get(playerId)?.connected, 'You cannot vote on this appeal');
    this.assert(!appeal.votes.has(playerId), 'You already voted');
    appeal.votes.set(playerId, support);
    if (appeal.eligibleVoterIds.every((id) => appeal.votes.has(id) ||
      !this.room.participants.get(id)?.connected)) this.resolveAppeal();
  }

  resolveAppeal(): void {
    this.assert(this.phase === PHASES.APPEAL_VOTE && this.appeal, 'No appeal vote is open');
    this.assert(this.current, 'No active question');
    this.clearTimer();
    const appeal = this.appeal;
    const current = this.current;
    const judgment = current.judgments.find((item) => item.id === appeal.judgmentId);
    this.assert(judgment, 'Appealed verdict is missing');
    // The answerer supports their verdict; the host supports the original verdict.
    // A challenger of an accepted answer contributes one fixed vote against it.
    let support = 1;
    let oppose = appeal.kind === 'against' ? 2 : 1;
    for (const vote of appeal.votes.values()) {
      if (vote) support += 1;
      else oppose += 1;
    }
    const accepted = support > oppose;
    judgment.appealed = true;
    if (accepted) {
      const correctedDelta = judgment.correct ? judgment.wrongDelta : judgment.rightDelta;
      const target = this.room.participants.get(judgment.playerId);
      if (target) target.score += correctedDelta - judgment.delta;
      judgment.correct = !judgment.correct;
      judgment.delta = correctedDelta;
      if (judgment.kind === 'normal') {
        if (appeal.kind === 'for') {
          // A newly accepted early answer invalidates all later attempts on this question.
          for (const later of current.judgments.filter((item) => item.id > judgment.id && !item.voided)) {
            const player = this.room.participants.get(later.playerId);
            if (player) player.score -= later.delta;
            later.voided = true;
          }
          this.chooserId = judgment.playerId;
        } else {
          this.chooserId = current.chooserBeforeQuestion;
        }
        this.ensureConnectedChooser();
      }
    }
    this.appeal = null;
    this.phase = PHASES.REVEAL;
    // The answer clip may have ended during the vote, so the question closes on the estimate now.
    this.scheduleRevealClose(false);
    this.room.emitEvent({ type: 'appealResolved', judgmentId: judgment.id,
      targetId: judgment.playerId, kind: appeal.kind, accepted, support, oppose });
  }

  /** Leaves the current question (or skips it) and returns to the board / ends the round. */
  next(): void {
    if (this.phase === PHASES.ROUND_END) return this.nextRound();
    if (this.round?.type === 'final' && this.phase === PHASES.REVEAL) {
      this.judgmentUndo = [];
      const remaining = this.finalThemeIndices();
      if (!this.settings.playAllQuestionsInFinalRound || !remaining.length) return this.finish();
      // Each final theme contributes its first question; earlier eliminations reset.
      this.current = null;
      this.appeal = null;
      this.removedFinalThemes.clear();
      if (remaining.length > 1) {
        this.phase = PHASES.FINAL_THEMES;
        this.startFinalThemeTimer();
      } else {
        this.phase = PHASES.BOARD;
        this.selectQuestion(this.chooserId, true, remaining[0], 0);
      }
      return;
    }
    // During the intro, Next is the host's "skip the pause", not "skip the question".
    if (this.phase === PHASES.INTRO) return this.beginQuestion();
    // During the countdown, Next starts reading now instead of dropping a question already on screen.
    if (this.phase === PHASES.READY) return this.startQuestionReading();
    this.assert(QUESTION_PHASES.has(this.phase) || this.phase === PHASES.SPECIAL_SETUP ||
      this.phase === PHASES.STAKE_AUCTION, 'Nothing to continue');
    this.returnToBoard();
  }

  /** Clears the finished question and returns to the board, or ends the round when nothing is left. */
  returnToBoard(): void {
    this.judgmentUndo = [];
    this.clearTimer();
    this.current = null;
    this.appeal = null;
    this.auction = null;
    this.forAll = null;
    this.resetBuzzer();

    // Rounds have no clock: a round ends only when its board is empty or the host moves on.
    if (!this.roundHasQuestionsLeft()) {
      this.phase = PHASES.ROUND_END;
      this.room.emitEvent({ type: 'roundEnd', roundIndex: this.roundIndex });
    } else {
      this.phase = PHASES.BOARD;
      this.startChoosingTimer();
    }
  }

  /* ------------------------------------------------------------------ views */

  /**
   * True while nobody may see the question yet: the intro, special setup, an auction or a final wager
   * (also while paused in one of them), and always for a gift. The view and media access share it.
   */
  contentHidden(): boolean {
    if (!this.current || this.current.type === 'secretNoQuestion') return true;
    const phase = this.phase === PHASES.PAUSED ? this.paused?.phase : this.phase;
    return ([PHASES.INTRO, PHASES.SPECIAL_SETUP, PHASES.STAKE_AUCTION, PHASES.FINAL_WAGER] as Phase[])
      .includes(phase ?? PHASES.PAUSED);
  }

  getView(viewer: Participant | null, canModerate: boolean): GameView {
    const round = this.round;
    const c = this.current;
    const forAll = this.forAll;
    // A player who owns the room may moderate, but must never receive an early answer.
    const showAnswer = viewer?.role === ROLES.HOST || (c?.answerShown ?? false);
    // Final answers and wagers stay private until the host has judged them all; then the room sees the payoff.
    const shownPhase = this.phase === PHASES.PAUSED ? this.paused?.phase : this.phase;
    const finalShown = (canModerate && this.phase === PHASES.FINAL_JUDGE) ||
      (round?.type === 'final' && (shownPhase === PHASES.REVEAL || shownPhase === PHASES.APPEAL_VOTE));

    return {
      phase: this.phase,
      pausedPhase: this.paused?.phase ?? null,
      roundIndex: this.roundIndex,
      round: round ? { name: round.name, type: round.type } : null,
      board:
        round?.themes.map((theme, t) => ({
          name: theme.name,
          questions: theme.questions.map((q, i) => ({ price: q.price, available: this.isAvailable(t, i) })),
        })) ?? [],
      removedFinalThemes: [...this.removedFinalThemes],
      chooserId: this.chooserId,
      timer: this.timer && { name: this.timer.name, endsAt: this.timer.endsAt, durationMs: this.timer.durationMs },
      current: c && {
        presentationId: c.presentationId,
        themeIndex: c.themeIndex,
        questionIndex: c.questionIndex,
        themeName: c.type === 'secretNoQuestion' ? 'Gift' : c.themeName,
        price: c.price,
        type: c.type,
        content: this.contentHidden() ? [] : c.question.content,
        assignedId: c.assignedId,
        priceRange: this.phase === PHASES.SPECIAL_SETUP ? c.question.typeParams?.price ?? null : null,
        answerShown: c.answerShown,
        right: showAnswer && c.type !== 'secretNoQuestion' ? c.question.right : null,
        wrong: viewer?.role === ROLES.HOST ? c.question.wrong : null,
        answerContent: showAnswer && c.type !== 'secretNoQuestion' ? c.question.answerContent : null,
        comments: showAnswer && c.type !== 'secretNoQuestion' ? c.question.info.comments : null,
        sources: showAnswer && c.type !== 'secretNoQuestion' && this.settings.displaySources ? c.question.info.sources : null,
        answerType: c.type === 'secretNoQuestion' ? 'text' : c.question.answerType,
        // Options carry text and media, so they follow the same gate as the question itself.
        answerOptions: this.contentHidden() ? [] : c.question.answerOptions,
        answerDeviation: c.question.answerDeviation,
        showmanComments: viewer?.role === ROLES.HOST ? c.question.info.showmanComments || null : null,
        selectionMode: c.question.typeParams?.selectionMode ?? null,
        picks: c.answerShown ? c.picks : [],
      },
      undoJudgment: canModerate && this.canUndoJudgment() && c ? {
        presentationId: c.presentationId,
        judgmentId: c.judgments.at(-1)!.id,
        playerId: c.judgments.at(-1)!.playerId,
      } : null,
      buzzer: {
        winnerId: this.buzzer.winnerId,
        winnerInfo: this.buzzer.winnerInfo,
        // Clients keep the button at "wait" until this moment on the synced clock.
        openedAt: this.buzzer.openedAt,
        attempted: [...this.buzzer.attempted],
        blockedUntil: viewer ? (this.buzzer.blockedUntil.get(viewer.id) ?? null) : null,
        blockedPlayers: [...this.buzzer.blockedUntil.entries()]
          .filter(([, until]) => until > Date.now())
          .map(([id, until]) => ({ id, until })),
        typedAnswer: this.usesAnswerInput() &&
          (this.phase === PHASES.ANSWERING ||
            (this.phase === PHASES.PAUSED && this.paused?.phase === PHASES.ANSWERING))
          ? {
              text: canModerate || viewer?.id === this.buzzer.winnerId ? this.buzzer.typedAnswer : null,
              submitted: this.buzzer.typedAnswer !== null,
              closed: this.buzzer.typedAnswerClosed,
            } : null,
      },
      auction: this.auction ? {
        turnId: this.auctionTurnId(),
        leaderId: this.auction.leaderId,
        amount: this.auction.amount,
        allIn: this.auction.allIn,
        passedIds: [...this.auction.passed],
        minimum: this.auction.minimum,
        minimumNextBid: Math.max(this.auction.minimum, this.auction.amount + 1),
      } : null,
      forAll: forAll ? {
        eligibleIds: this.forAllEligibleIds(),
        submittedIds: [...forAll.answers.keys()],
        yourAnswer: viewer ? forAll.answers.get(viewer.id) ?? null : null,
        // A recovered player moderator needs submitted answers to judge, but never the key.
        answers: canModerate && this.phase === PHASES.FOR_ALL_JUDGE
          ? Object.fromEntries(this.forAllEligibleIds().map((id) => [id, forAll.answers.get(id) ?? ''])) : null,
        judgedIds: [...forAll.judged],
      } : null,
      final: this.round?.type === 'final' ? {
        wagered: [...this.finalWagers.keys()],
        yourWager: viewer ? this.finalWagers.get(viewer.id) ?? null : null,
        wagers: finalShown
          ? Object.fromEntries(this.finalEligibleIds().map((id) => [id, this.finalWagers.get(id)])) : null,
        judged: [...this.finalJudged],
        // Before wagers close, finalists are everyone with a positive score.
        eligibleIds: this.phase === PHASES.FINAL_WAGER || this.phase === PHASES.FINAL_THEMES ||
          this.phase === PHASES.BOARD ? this.finalists().map((p) => p.id) : this.finalEligibleIds(),
        answeredIds: [...this.finalAnswers.keys()],
        // Who holds the close by changing a sent answer; the host only, and never the text itself.
        editingIds: canModerate ? [...this.drafts.keys()].filter((id) => this.finalAnswers.has(id)) : [],
        yourAnswer: viewer ? this.finalAnswers.get(viewer.id) ?? null : null,
        answers: finalShown
          ? Object.fromEntries(this.finalEligibleIds().map((id) => [id, this.finalAnswers.get(id) ?? ''])) : null,
      } : null,
      // Verdicts are public once the question reaches reveal; votes stay private until resolution.
      appeals: c && (
        this.phase === PHASES.REVEAL ||
        this.phase === PHASES.APPEAL_VOTE ||
        (this.phase === PHASES.PAUSED && (this.paused?.phase === PHASES.REVEAL || this.paused?.phase === PHASES.APPEAL_VOTE))
      ) ? {
        judgments: c.judgments.filter((item) => item.kind !== 'gift').map((item) => ({
          id: item.id, playerId: item.playerId, correct: item.correct, delta: item.delta,
          appealed: item.appealed, voided: item.voided,
        })),
        active: this.appeal && {
          judgmentId: this.appeal.judgmentId,
          requesterId: this.appeal.requesterId,
          targetId: this.appeal.targetId,
          kind: this.appeal.kind,
          eligibleVoterIds: this.appeal.eligibleVoterIds,
          votedIds: [...this.appeal.votes.keys()],
        },
      } : null,
    };
  }
}

/** Parses "x,y" or "x,y,aspect"; x and y must lie on the picture. */
function parsePoint(value: string): { x: number; y: number; aspect: number | null } | null {
  const [x, y, aspect] = value.split(',').map((part) => Number(part.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y, aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : null };
}
