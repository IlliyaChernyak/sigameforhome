/** Persist the live room so a server restart keeps seats, scores, and the board. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.ts';
import { loadPack } from '../packs/packManager.ts';
import { PHASES, type Phase } from './constants.ts';
import { restoreSettings, type GameSettings } from './settings.ts';
import { armGrace, graceModeForSavedPhase } from './seatGrace.ts';
import { startHandover } from './moderationHandover.ts';
import type { CurrentQuestionState, Judgment } from './GameEngine.ts';
import type { Participant, Room } from './Room.ts';

interface SavedGame {
  phase: Phase;
  roundIndex: number;
  played: string[];
  paused?: { phase: Phase } | null;
  removedFinalThemes?: number[];
  chooserId: string | null;
  current?: Pick<CurrentQuestionState, 'themeIndex' | 'questionIndex' | 'chooserBeforeQuestion'> & {
    judgments: Judgment[];
  } | null;
}

interface SavedRoom {
  version: number;
  settings: Partial<GameSettings>;
  ownerId: string | null;
  packFile: string | null;
  participants: Array<Omit<Participant, 'connected' | 'socketId'>>;
  game: SavedGame | null;
}

const file = config.roomStateFile;

export async function restoreRoom(room: Room, stateFile = file): Promise<void> {
  let saved: SavedRoom;
  try { saved = JSON.parse(await fsp.readFile(stateFile, 'utf8')) as SavedRoom; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[room] State not restored: ${(err as Error).message}`);
    return;
  }
  if (saved.version !== 1) return;
  try {
    if (saved.packFile) {
      try { room.loadedPack = await loadPack(saved.packFile); }
      catch (err) {
        // A removed or broken pack should not erase independently recoverable seats and scores.
        console.warn(`[room] Pack not restored: ${(err as Error).message}`);
      }
    }
    room.settings = restoreSettings(saved.settings);
    for (const entry of saved.participants) {
      const participant: Participant = { ...entry,
        mediaTicket: entry.mediaTicket || crypto.randomBytes(24).toString('base64url'),
        connected: false, socketId: null };
      room.participants.set(participant.id, participant);
      room.tokens.set(participant.token, participant.id);
    }
    room.ownerId = saved.ownerId;
    const game = saved.game;
    if (room.loadedPack && game && game.phase !== PHASES.LOBBY) {
      room.engine.roundIndex = game.roundIndex;
      room.engine.played = new Set(game.played);
      room.engine.removedFinalThemes = new Set(game.removedFinalThemes ?? []);
      room.engine.chooserId = game.chooserId;
      const restoredPhase: Phase = game.phase === PHASES.PAUSED ? game.paused?.phase ?? PHASES.BOARD : game.phase;
      // Replay an interrupted question from the board; scores and prior questions remain.
      if (([PHASES.SPECIAL_SETUP, PHASES.STAKE_AUCTION, PHASES.FOR_ALL_ANSWERING, PHASES.FOR_ALL_JUDGE,
        PHASES.APPEAL_VOTE, PHASES.INTRO, PHASES.READY,
        PHASES.READING, PHASES.BUZZER_OPEN, PHASES.ANSWERING,
        PHASES.FINAL_WAGER, PHASES.FINAL_QUESTION, PHASES.FINAL_JUDGE] as Phase[]).includes(restoredPhase) && game.current) {
        room.engine.played.delete(`${game.roundIndex}:${game.current.themeIndex}:${game.current.questionIndex}`);
        // Replaying a partially scored question must not charge players twice.
        for (const judgment of game.current.judgments ?? []) {
          if (judgment.voided) continue;
          const player = room.participants.get(judgment.playerId);
          if (player) player.score -= judgment.delta;
        }
        room.engine.chooserId = game.current.chooserBeforeQuestion ?? game.chooserId;
      }
      if (restoredPhase === PHASES.REVEAL) {
        if (room.engine.round?.type === 'final') {
          // A completed final answer may lead to another theme when the full-final rule is enabled.
          room.engine.removedFinalThemes.clear();
          const remaining = room.engine.finalThemeIndices().length;
          room.engine.phase = !room.settings.playAllQuestionsInFinalRound || !remaining
            ? PHASES.GAME_OVER : remaining > 1 ? PHASES.FINAL_THEMES : PHASES.BOARD;
        } else {
          room.engine.phase = room.engine.roundHasQuestionsLeft() ? PHASES.BOARD : PHASES.ROUND_END;
        }
      } else {
        room.engine.phase = ([PHASES.GAME_OVER, PHASES.ROUND_END, PHASES.FINAL_THEMES] as Phase[]).includes(restoredPhase)
          ? restoredPhase : PHASES.BOARD;
      }
      if (game.phase === PHASES.PAUSED) {
        // Replayed questions return to the board, but an explicit pause stays paused.
        room.engine.paused = { phase: room.engine.phase, timerName: null, timerMs: null };
        room.engine.phase = PHASES.PAUSED;
      }
    }
    // Everyone restored is offline, so give each the normal reconnect window (audit CONN-4).
    const mode = graceModeForSavedPhase(game?.phase);
    for (const pid of room.participants.keys()) armGrace(room, pid, mode);
    // The restored host is offline too, so the owner waits the same handover time (audit UX-7).
    const host = room.host();
    if (host) startHandover(room, host.id);
  } catch (err) {
    console.warn(`[room] State not restored: ${(err as Error).message}`);
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
    room.removalTimers.clear();
    room.participants.clear(); room.tokens.clear(); room.ownerId = null; room.loadedPack = null;
    room.engine.reset();
  }
}

export function persistRoom(room: Room, stateFile = file): () => Promise<void> {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  const save = () => {
    if (pending) clearTimeout(pending);
    pending = null;
    const game = room.engine;
    const state = {
      version: 1,
      settings: room.settings,
      ownerId: room.ownerId,
      packFile: room.loadedPack?.file ?? null,
      participants: [...room.participants.values()].map(({ socketId, connected, ...p }) => p),
      game: { phase: game.phase, roundIndex: game.roundIndex, played: [...game.played],
        paused: game.paused,
        removedFinalThemes: [...game.removedFinalThemes],
        chooserId: game.chooserId,
        current: game.current && { themeIndex: game.current.themeIndex, questionIndex: game.current.questionIndex,
          chooserBeforeQuestion: game.current.chooserBeforeQuestion,
          judgments: game.current.judgments } },
    };
    // Serialize writes so a slower earlier save cannot replace newer state.
    writeQueue = writeQueue.then(async () => {
      const temp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsp.mkdir(path.dirname(stateFile), { recursive: true });
        await fsp.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
        await fsp.rename(temp, stateFile);
      } catch (err) { console.warn(`[room] Save failed: ${(err as Error).message}`); }
    });
    return writeQueue;
  };

  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(save, 250);
  };
  room.on('change', schedule);

  // Shutdown calls this even if the debounce event has not fired yet.
  return () => {
    room.off('change', schedule);
    return save();
  };
}
