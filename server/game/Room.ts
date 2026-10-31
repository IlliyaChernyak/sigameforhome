/**
 * Room: the single game table hosted by this server.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import type { LoadedPack } from '../packs/packManager.ts';
import { canonicalMediaPath } from '../packs/htmlAssets.ts';
import type { ContentItem, PackageStats, RoundType } from '../packs/siqParser.ts';
import { PHASES, ROLES, type Role } from './constants.ts';
import { GameEngine, type GameView } from './GameEngine.ts';
import { applySettingsPatch, defaultSettings, type GameSettings } from './settings.ts';
import { takeGraceMode } from './seatGrace.ts';
import { clearHandover, handoverReady, startHandover } from './moderationHandover.ts';
import { assertNicknameFree, normalizeNickname } from './nickname.ts';
import { LatencyBoard } from './buzzTiming.ts';
import { safeTimeout } from '../utils/safeTimer.ts';

/** Moments with no live answer, wager or bid, where seats may change hands. */
const CALM_PHASES = new Set<string>([PHASES.LOBBY, PHASES.BOARD, PHASES.ROUND_END, PHASES.FINAL_THEMES, PHASES.GAME_OVER]);

const MAX_MANUAL_SCORE = 1_000_000_000_000;
export const MAX_ROOM_PARTICIPANTS = 64;

export interface Participant {
  id: string;
  token: string;
  mediaTicket: string;
  name: string;
  role: Role;
  score: number;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
  autoSpectator?: boolean;
  displayOnly?: boolean;
  /** Lobby only: the player said they are ready to start. Cleared by a role change or a game start. */
  ready?: boolean;
}

export interface RoomSnapshot {
  serverTime: number;
  you: {
    id: string;
    name: string;
    role: Role;
    isOwner: boolean;
    canModerate: boolean;
    canManage: boolean;
  } | null;
  participants: Array<{
    id: string;
    name: string;
    role: Role;
    score: number;
    connected: boolean;
    isOwner: boolean;
    displayOnly: boolean;
    ready: boolean;
    /** Live connection figures from clock probes; null while offline or not yet measured. */
    pingMs: number | null;
    oneWayMs: number | null;
    jitterMs: number | null;
  }>;
  settings: GameSettings;
  pack: {
    file: string;
    packId: string;
    name: string;
    logo: string | null;
    difficulty: number;
    authors: string[];
    stats: PackageStats;
    rounds: Array<{ name: string; type: RoundType; themes: number }>;
  } | null;
  game: GameView;
}

export class Room extends EventEmitter {
  participants = new Map<string, Participant>();
  tokens = new Map<string, string>();
  ownerId: string | null = null;
  settings: GameSettings = defaultSettings();
  loadedPack: LoadedPack | null = null;
  engine: GameEngine;
  /** Not persisted: round trips belong to live connections. */
  latency = new LatencyBoard();
  removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  changeScheduled = false;

  constructor() {
    super();
    this.engine = new GameEngine(this);
  }

  /* ------------------------------------------------------------- queries */

  players(): Participant[] {
    return [...this.participants.values()].filter((p) => p.role === ROLES.PLAYER);
  }

  /** The slowest round trip among seated, connected players; their screens set the buzzer pace. */
  worstPlayerRttMs(): number | null {
    return this.latency.worst(this.players().filter((p) => p.connected).map((p) => p.id));
  }

  /** Records a probe's round trip; the shown ping re-broadcasts only when it moves noticeably. */
  recordPing(pid: string, rtt: unknown): void {
    if (this.latency.report(pid, rtt)) this.changed();
  }

  host(): Participant | null {
    return [...this.participants.values()].find((p) => p.role === ROLES.HOST) ?? null;
  }

  /** No live answer, wager or bid: also true for a pause taken at such a moment. */
  betweenQuestions(): boolean {
    const phase = this.engine.phase === PHASES.PAUSED ? this.engine.paused?.phase : this.engine.phase;
    return !!phase && CALM_PHASES.has(phase);
  }

  hasFreePlayerSlot(): boolean {
    return this.players().length < this.settings.maxPlayers;
  }

  canModerate(pid: string | null | undefined): boolean {
    if (!pid) return false;
    const p = this.participants.get(pid);
    if (!p || p.displayOnly) return false;
    if (p.role === ROLES.HOST) return true;
    const host = this.host();
    // With no host the owner runs the game; an absent host is covered only after the handover wait.
    return pid === this.ownerId && (!host || (!host.connected && handoverReady(this, host.id)));
  }

  /**
   * Pack/settings management (the admin panel). Host only: an owner who sits as a player no longer
   * gets it. The owner still manages while standing in for a missing host, because canModerate covers that.
   */
  canManage(pid: string | null | undefined): boolean {
    return this.canModerate(pid);
  }

  /**
   * A player standing in for an absent host must not rule on their own answer or score: they
   * could mark themselves correct, pass, or end the question to dodge a miss. The host never
   * answers, so this only ever stops a stand-in. Someone else (the returning host) rules instead.
   */
  assertNotOwnRuling(actorId: string, targetId: string | null | undefined): void {
    if (targetId && targetId === actorId) throw new Error('Someone else must rule on your own answer');
  }

  /** Whoever is on the spot right now: the buzzed-in answerer, while they answer. */
  currentAnswererId(): string | null {
    return this.engine.phase === PHASES.ANSWERING ? this.engine.buzzer.winnerId : null;
  }

  /* ------------------------------------------------------------ sessions */

  /**
   * Creates a new participant and applies the role-assignment rules.
   * @returns {{ participant: Participant, token: string }}
   */
  join(rawNickname: unknown, asSpectator = false): { participant: Participant; token: string } {
    // Spectators also consume a session, snapshot fan-out, and persisted state.
    if (this.participants.size >= MAX_ROOM_PARTICIPANTS) throw new Error('The room is full');
    const name = normalizeNickname(rawNickname);
    assertNicknameFree(this, name);

    const isFirst = this.ownerId === null;
    if (isFirst && asSpectator) throw new Error('A host or player must join before opening the TV view');
    let role: Role;
    if (isFirst) role = ROLES.PENDING;
    else if (asSpectator) role = ROLES.SPECTATOR;
    // A locked room seats newcomers as spectators; only the host can seat them (audit QOL-3).
    else role = this.hasFreePlayerSlot() && !this.settings.lockRoom ? ROLES.PLAYER : ROLES.SPECTATOR;

    const participant: Participant = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      mediaTicket: crypto.randomBytes(24).toString('base64url'),
      name,
      role,
      score: 0,
      connected: false,
      socketId: null,
      joinedAt: Date.now(),
      // Auto-assigned spectators are promoted automatically when a player slot frees up.
      // A display-only TV never inherits a player seat when one opens.
      autoSpectator: role === ROLES.SPECTATOR && !asSpectator && !this.settings.lockRoom,
      displayOnly: asSpectator,
    };
    this.participants.set(participant.id, participant);
    this.tokens.set(participant.token, participant.id);
    if (isFirst) this.ownerId = participant.id;

    this.changed();
    return { participant, token: participant.token };
  }

  resume(token: unknown): Participant | null {
    const pid = this.tokens.get(String(token ?? ''));
    return pid ? (this.participants.get(pid) ?? null) : null;
  }

  attach(pid: string, socketId: string): string | null {
    const p = this.participants.get(pid);
    if (!p) return null;
    // A new socket must not revive media URLs captured from an earlier connection.
    p.mediaTicket = crypto.randomBytes(24).toString('base64url');
    this.latency.forget(pid);
    const previous = p.socketId && p.socketId !== socketId ? p.socketId : null;
    p.socketId = socketId;
    p.connected = true;
    this.promoteSpectators();
    if (this.ownerId && !this.participants.get(this.ownerId)?.connected &&
        !this.removalTimers.has(this.ownerId)) this.reassignOwner();
    clearTimeout(this.removalTimers.get(pid));
    this.removalTimers.delete(pid);
    takeGraceMode(this, pid); // a reconnect ends any restore grace; later drops follow live rules
    clearHandover(this, pid);
    this.engine.resumeAuctionTurn(pid);
    this.changed();
    return previous;
  }

  detach(pid: string, socketId: string): void {
    const p = this.participants.get(pid);
    if (!p || p.socketId !== socketId) return;
    const wasAuctionTurn = this.engine.phase === PHASES.STAKE_AUCTION &&
      this.engine.auctionTurnId() === pid;
    p.connected = false;
    p.socketId = null;
    if (p.role === ROLES.HOST) startHandover(this, pid);
    this.removalTimers.set(
      pid,
      safeTimeout(`reconnect grace ${pid}`, () => this.expire(pid), config.reconnectGraceMs, () => this.changed()),
    );
    // A refresh or app switch must not cost the turn: the engine holds it briefly, then moves on.
    if (wasAuctionTurn) this.engine.holdAuctionTurn(pid);
    this.engine.advanceForAllAfterRosterChange();
    this.changed();
  }

  expire(pid: string): void {
    const p = this.participants.get(pid);
    this.removalTimers.delete(pid);
    // A restored 'keep' seat survives a lobby fallback (e.g. its saved pack failed to load).
    const keepRestored = takeGraceMode(this, pid) === 'keep';
    if (!p || p.connected) return;
    const inGame = this.engine.phase !== PHASES.LOBBY || keepRestored;
    if (inGame && (p.role === ROLES.PLAYER || p.role === ROLES.HOST)) {
      // Keep scores/seats for reconnects, but let a connected participant recover moderation.
      if (this.ownerId === pid) {
        this.reassignOwner();
        this.changed();
      }
      return;
    }
    this.remove(pid);
  }

  /** Once play ends, departed seats with no reconnect grace left should free lobby slots. */
  releaseExpiredSeats(): void {
    for (const p of [...this.participants.values()]) {
      if (!p.connected && !this.removalTimers.has(p.id)) this.remove(p.id);
    }
  }

  remove(pid: string): void {
    const p = this.participants.get(pid);
    if (!p) return;
    const wasAuctionTurn = this.engine.phase === PHASES.STAKE_AUCTION &&
      this.engine.auctionTurnId() === pid;
    clearTimeout(this.removalTimers.get(pid));
    this.removalTimers.delete(pid);
    takeGraceMode(this, pid);
    clearHandover(this, pid);
    this.participants.delete(pid);
    this.tokens.delete(p.token);
    if (this.engine.chooserId === pid) this.engine.chooserId = this.players()[0]?.id ?? null;
    if (this.ownerId === pid) this.reassignOwner();
    this.promoteSpectators();
    if (wasAuctionTurn) this.engine.advanceStakeAuction();
    this.engine.advanceForAllAfterRosterChange();
    this.changed();
  }

  reassignOwner(): void {
    const candidates = [...this.participants.values()].filter((p) => !p.displayOnly).sort(
      (a, b) => Number(b.connected) - Number(a.connected) ||
        Number(b.role === ROLES.PLAYER || b.role === ROLES.HOST) -
        Number(a.role === ROLES.PLAYER || a.role === ROLES.HOST) || a.joinedAt - b.joinedAt,
    );
    this.ownerId = candidates.find((p) => p.connected)?.id ?? candidates[0]?.id ?? null;
    // If the new owner never chose a role (impossible today, but keep invariants) nothing else to do.
    // If everyone left, the next joiner becomes the new "first" and gets the Host/Player choice.
  }

  promoteSpectators(): void {
    if (this.engine.phase !== PHASES.LOBBY && this.engine.phase !== PHASES.GAME_OVER) return;
    const waiting = [...this.participants.values()]
      // A locked room freezes seating, also for people who were waiting before the lock (QOL-3).
      .filter((p) => !this.settings.lockRoom && p.connected && p.role === ROLES.SPECTATOR && p.autoSpectator && !p.displayOnly)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    for (const s of waiting) {
      if (!this.hasFreePlayerSlot()) break;
      s.role = ROLES.PLAYER;
      delete s.autoSpectator;
    }
  }

  /* --------------------------------------------------------------- roles */

  chooseInitialRole(pid: string, role: Role): void {
    const p = this.participants.get(pid);
    if (!p || p.role !== ROLES.PENDING) throw new Error('You have already chosen a role');
    if (role === ROLES.HOST) {
      if (this.host()) throw new Error('A host is already assigned');
      p.role = ROLES.HOST;
    } else if (role === ROLES.PLAYER) {
      p.role = this.hasFreePlayerSlot() ? ROLES.PLAYER : ROLES.SPECTATOR;
    } else {
      throw new Error('Choose either host or player');
    }
    this.changed();
  }

  setRole(actorId: string, targetId: string, role: Role): void {
    const target = this.participants.get(targetId);
    if (!target) throw new Error('Unknown participant');
    if (target.displayOnly && role !== ROLES.SPECTATOR) throw new Error('TV views remain spectators');
    if (role !== ROLES.HOST && role !== ROLES.PLAYER && role !== ROLES.SPECTATOR) {
      throw new Error('Invalid role');
    }
    if (target.role === role) return;
    // A player leaving their seat mid-question would cut into a live answer, wager or bid.
    if (role === ROLES.HOST && target.role === ROLES.PLAYER && !this.betweenQuestions()) {
      throw new Error('Wait until the question is over');
    }

    const self = actorId === targetId;
    const moderator = this.canModerate(actorId);

    if (role === ROLES.HOST) {
      const host = this.host();
      if (host && host.id !== targetId) throw new Error('The host seat is taken');
      // An empty host seat is open to anyone. Only the owner could claim it before, so a host who
      // pressed Leave came back as a plain player and could not get the seat back.
      if (!moderator && !self) throw new Error('Only the host can appoint a host');
    } else {
      if (!self && !moderator) throw new Error('You cannot change other participants');
      if (role === ROLES.PLAYER && !moderator && this.settings.lockRoom) throw new Error('The room is locked');
      if (role === ROLES.PLAYER && !this.hasFreePlayerSlot()) throw new Error('All player slots are taken');
    }

    const wasAuctionTurn = this.engine.phase === PHASES.STAKE_AUCTION &&
      this.engine.auctionTurnId() === targetId;
    target.role = role;
    delete target.autoSpectator;
    delete target.ready;
    // A released host seat ends that host's wait; an offline new host starts one, or the owner could
    // never moderate (the seat is kept for the whole game and only a moderator can release it).
    if (role === ROLES.HOST && !target.connected) startHandover(this, targetId);
    else clearHandover(this, targetId);
    this.promoteSpectators();
    // A player who took the host seat mid-game may have held the next pick.
    if (this.engine.phase !== PHASES.LOBBY) this.engine.ensureConnectedChooser();
    // A reseated bidder cannot act, so let the next eligible player bid immediately.
    if (wasAuctionTurn && role !== ROLES.PLAYER) this.engine.advanceStakeAuction();
    this.engine.advanceForAllAfterRosterChange();
    this.changed();
  }

  /** A player marks themselves ready (or not) in the lobby; the host sees it before starting. */
  setReady(pid: string, ready: boolean): void {
    const p = this.participants.get(pid);
    if (p?.role !== ROLES.PLAYER) throw new Error('Only players can mark themselves ready');
    if (this.engine.phase !== PHASES.LOBBY) throw new Error('The game has already started');
    p.ready = ready;
    this.changed();
  }

  /**
   * A player lost their device (dead phone, another browser) and rejoined under a new name. The host
   * gives them their old offline seat back (device playtest F7): the newcomer's session moves into
   * it, so the seat keeps its id, score and history, and the temporary seat disappears. The lost
   * device's old token stops working. Between questions only, so no live answer, wager or bid
   * changes hands. Returns the newcomer's socket id so the caller can rebind it.
   */
  giveSeat(actorId: string, seatId: string, newcomerId: string): string {
    if (!this.canModerate(actorId)) throw new Error('Only the host can give a seat back');
    const seat = this.participants.get(seatId);
    const newcomer = this.participants.get(newcomerId);
    if (!seat || !newcomer || seatId === newcomerId) throw new Error('Unknown participant');
    if (seat.role !== ROLES.PLAYER) throw new Error('Only a player seat can be given back');
    if (seat.connected) throw new Error('That seat is still connected');
    if (newcomer.role === ROLES.HOST || newcomerId === actorId) throw new Error('The host cannot take a player seat');
    if (!newcomer.connected || !newcomer.socketId) throw new Error('The new device is not connected');
    if (!this.betweenQuestions()) throw new Error('Wait until the question is over');
    const engine = this.engine;

    const socketId = newcomer.socketId;
    clearTimeout(this.removalTimers.get(newcomerId));
    this.removalTimers.delete(newcomerId);
    takeGraceMode(this, newcomerId);
    this.participants.delete(newcomerId);
    this.tokens.delete(seat.token);
    seat.token = newcomer.token;
    this.tokens.set(seat.token, seatId);
    if (engine.chooserId === newcomerId) engine.chooserId = seatId;
    if (this.ownerId === newcomerId) this.ownerId = seatId;
    this.attach(seatId, socketId);
    return socketId;
  }

  kick(actorId: string, targetId: string): void {
    if (!this.canModerate(actorId)) throw new Error('Only the host can remove participants');
    if (actorId === targetId) throw new Error('You cannot remove yourself');
    const target = this.participants.get(targetId);
    if (!target) return;
    this.remove(targetId);
    this.emit('kicked', target);
  }

  /* ---------------------------------------------------- settings & packs */

  updateSettings(actorId: string, patch: Partial<Record<string, unknown>>): void {
    if (!this.canManage(actorId)) throw new Error('Only the host can change settings');
    const next = applySettingsPatch(this.settings, patch);
    // Switching answer input while a question is live would strand the current answerer.
    if (next.oral !== this.settings.oral &&
      this.engine.phase !== PHASES.LOBBY && this.engine.phase !== PHASES.GAME_OVER) {
      throw new Error('Change oral answer mode before starting a game');
    }
    if (next.maxPlayers < this.players().length) throw new Error('More players are seated than the new limit');
    this.settings = next;
    this.promoteSpectators();
    this.changed();
  }

  setPack(loaded: LoadedPack): void {
    if (this.engine.phase !== PHASES.LOBBY) throw new Error('Stop the current game before changing the pack');
    this.loadedPack = loaded;
    this.changed();
  }

  adjustScore(actorId: string, targetId: string, delta: number): void {
    if (!this.canModerate(actorId)) throw new Error('Only the host can change scores');
    this.assertNotOwnRuling(actorId, targetId);
    const p = this.participants.get(targetId);
    if (!p) throw new Error('Unknown participant');
    // Leave room for the bounded pack's remaining question values to change the score.
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(p.score + delta) ||
        Math.abs(p.score + delta) > MAX_MANUAL_SCORE) {
      throw new Error('Score change must keep a safe whole-number score within ±1 trillion');
    }
    p.score += delta;
    this.changed();
  }

  /* ------------------------------------------------------------- output */

  changed(): void {
    if (this.changeScheduled) return;
    this.changeScheduled = true;
    setImmediate(() => {
      this.changeScheduled = false;
      this.emit('change');
    });
  }

  emitEvent(evt: Record<string, unknown>): void {
    this.emit('event', { ...evt, at: Date.now() });
  }

  /** Media tickets identify a viewer without exposing their session token in URLs. */
  mediaUrl(url: string | null | undefined, viewer: Participant | null, type?: ContentItem['type']): string | null {
    if (!url?.startsWith('/media/') || !viewer) return url ?? null;
    // A path ticket also reaches relative resources loaded inside sandboxed HTML.
    return type === 'html' ? url.replace('/media/', `/media-html/${viewer.mediaTicket}/`)
      : `${url}?ticket=${viewer.mediaTicket}`;
  }

  canAccessMedia(ticket: unknown, requestPath: string): boolean {
    if (typeof ticket !== 'string' || !ticket) return false;
    const viewer = [...this.participants.values()].find((p) => p.mediaTicket === ticket);
    const current = this.engine.current;
    if (!viewer?.connected || !this.loadedPack) return false;
    const canonical = canonicalMediaPath;
    let requested;
    try {
      requested = requestPath.split('/').map(decodeURIComponent).join('/');
    } catch { return false; }
    const allowed = (item: ContentItem | null | undefined): boolean => {
      const source = canonical(item?.url);
      if (!source) return false;
      if (source === requested) return true;
      if (item?.type === 'html') {
        const assets = this.loadedPack?.htmlAssets?.get(source);
        if (assets?.has(requested)) return true;
        if (assets?.size) for (const asset of assets) {
          const parts = asset.split('/');
          const derived = `/media/${parts[2]}/_derived/${parts.slice(3).join('/')}.ios.`;
          if (requested === `${derived}mp4` || requested === `${derived}mp3`) return true;
        }
      }
      // Derivatives live outside archive media folders, so a pack-authored file
      // with an .ios suffix cannot inherit access to a visible source clip.
      const parts = source.split('/');
      const generated = (ext: string) => `/media/${parts[2]}/_derived/${parts.slice(3).join('/')}.ios.${ext}`;
      return (item?.type === 'video' && requested === generated('mp4')) ||
        (item?.type === 'audio' && requested === generated('mp3'));
    };
    if (allowed(this.loadedPack.pack.logo)) return true;
    if (!current || current.type === 'secretNoQuestion') return false;
    // Same gate as the state view, so a file never loads before its question is on screen.
    const visible = !this.engine.contentHidden();
    if (visible && current.question.content.some(allowed)) return true;
    if (visible && (current.question.answerOptions ?? []).some((option) => option.content.some(allowed))) return true;
    const canSeeAnswer = viewer.role === ROLES.HOST || current.answerShown;
    return canSeeAnswer && current.question.answerContent.some(allowed);
  }

  /** Personalised state for one participant. */
  snapshotFor(pid: string): RoomSnapshot {
    const viewer = this.participants.get(pid) ?? null;
    const canModerate = this.canModerate(pid);
    const loadedPack = this.loadedPack;
    const pack = loadedPack?.pack;
    const game = this.engine.getView(viewer, canModerate);
    if (game.current) {
      game.current.content = game.current.content.map((item) => ({ ...item, url: this.mediaUrl(item.url, viewer, item.type) }));
      game.current.answerOptions = (game.current.answerOptions ?? []).map((option) => ({ ...option,
        content: option.content.map((item) => ({ ...item, url: this.mediaUrl(item.url, viewer, item.type) })) }));
      if (game.current.answerContent) {
        game.current.answerContent = game.current.answerContent.map((item) =>
          ({ ...item, url: this.mediaUrl(item.url, viewer, item.type) }));
      }
    }

    return {
      serverTime: Date.now(),
      you: viewer
        ? {
            id: viewer.id,
            name: viewer.name,
            role: viewer.role,
            isOwner: viewer.id === this.ownerId,
            canModerate,
            canManage: this.canManage(pid),
          }
        : null,
      participants: [...this.participants.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => {
          const ping = p.connected ? this.latency.stats(p.id) : null;
          return {
            id: p.id,
            name: p.name,
            role: p.role,
            score: p.score,
            connected: p.connected,
            isOwner: p.id === this.ownerId,
            displayOnly: !!p.displayOnly,
            ready: !!p.ready,
            pingMs: ping?.pingMs ?? null,
            oneWayMs: ping?.oneWayMs ?? null,
            jitterMs: ping?.jitterMs ?? null,
          };
        }),
      settings: this.settings,
      pack: pack && loadedPack ? {
        file: loadedPack.file,
        packId: loadedPack.packId,
        name: pack.name,
        logo: this.mediaUrl(pack.logo?.url ?? null, viewer),
        difficulty: pack.difficulty,
        authors: pack.info.authors,
        stats: pack.stats,
        rounds: pack.rounds.map((r) => ({ name: r.name, type: r.type, themes: r.themes.length })),
      } : null,
      game,
    };
  }
}
