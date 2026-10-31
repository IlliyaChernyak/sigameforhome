/**
 * Game settings mirroring SIGame's AppSettings / TimeSettings
 * (see SI repo: src/SIGame/.../AppSettingsCore.cs & TimeSettings.cs).
 */

export type BuzzSyncMode = 'server' | 'clientTimestamp';
export type ButtonPressMode = 'firstWins' | 'randomWithinInterval';
export type GameMode = 'classic' | 'simple';

export interface GameSettings {
  maxPlayers: number;
  falseStart: boolean;
  oral: boolean;
  ignoreWrong: boolean;
  readingSpeed: number;
  partialText: boolean;
  buzzSyncMode: BuzzSyncMode;
  buzzSyncWindowMs: number;
  buzzOpenLeadMs: number;
  buttonPressMode: ButtonPressMode;
  buttonPressIntervalMs: number;
  playAllQuestionsInFinalRound: boolean;
  displaySources: boolean;
  useApellations: boolean;
  gameMode: GameMode;
  soundOnHostOnly: boolean;
  lockRoom: boolean;
  timeForChoosingQuestion: number;
  timeForThinkingOnQuestion: number;
  timeForPrintingAnswer: number;
  timeForGivingACat: number;
  timeForMakingStake: number;
  timeForThinkingOnSpecial: number;
  timeForChoosingFinalTheme: number;
  timeForFinalThinking: number;
  timeForShowmanDecisions: number;
  timeForBlockingButton: number;
  timeForMediaDelay: number;
  timeForQuestionIntro: number;
  timeForQuestionReady: number;
}

export interface BooleanSettingSchema {
  type: 'boolean';
  default: boolean;
  label: string;
}

export interface IntegerSettingSchema {
  type: 'integer';
  default: number;
  min: number;
  max: number;
  label: string;
}

export interface EnumSettingSchema<T extends string = string> {
  type: 'enum';
  default: T;
  values: readonly T[];
  label: string;
}

export type SettingSchemaEntry = BooleanSettingSchema | IntegerSettingSchema | EnumSettingSchema;

const bool = (def: boolean, label: string): BooleanSettingSchema => ({ type: 'boolean', default: def, label });
const int = (def: number, min: number, max: number, label: string): IntegerSettingSchema => ({
  type: 'integer',
  default: def,
  min,
  max,
  label,
});
const oneOf = <T extends string>(def: T, values: readonly T[], label: string): EnumSettingSchema<T> => ({
  type: 'enum',
  default: def,
  values,
  label,
});

export const SETTINGS_SCHEMA: Record<keyof GameSettings, SettingSchemaEntry> = Object.freeze({
  /* ---- Table ---- */
  maxPlayers: int(6, 2, 12, 'Player slots'),

  /* ---- Rules (AppSettings) ---- */
  falseStart: bool(true, 'False starts: pressing before the question is read blocks the button'),
  oral: bool(true, 'Oral game (answers spoken, host judges)'),
  ignoreWrong: bool(false, 'Do not subtract points for wrong answers'),
  readingSpeed: int(20, 5, 60, 'Reading speed (characters/second)'),
  partialText: bool(false, 'Show question text gradually'),
  // Device time is the default: arrival order let the fastest laptop win ~90 % of equal-speed
  // presses against old phones and weak Wi-Fi (buzzer fairness simulation, 2026-10-31).
  buzzSyncMode: oneOf<BuzzSyncMode>(
    'clientTimestamp',
    ['server', 'clientTimestamp'],
    'Who-clicked-first sync mode (server arrival vs client request time; client time trusts player clocks)',
  ),
  // 200 ms covers the upload gap between a laptop and a phone on weak Wi-Fi (about 80 ms plus spikes).
  // It is a floor: a slower player's reported round trip lengthens it (buzzTiming.ts).
  buzzSyncWindowMs: int(200, 20, 500, 'Client timestamp sync collection window, minimum (ms)'),
  // The open signal is scheduled this far ahead so every screen turns green at the same moment,
  // however slow its network or its rendering. Presses stamped before it are false starts.
  // Also a floor: a player past about 360 ms round trip gets a longer lead (buzzTiming.ts).
  buzzOpenLeadMs: int(300, 0, 1000, 'Open signal lead: all screens turn green together, minimum (ms)'),
  buttonPressMode: oneOf<ButtonPressMode>('firstWins', ['firstWins', 'randomWithinInterval'], 'Button press resolution'),
  buttonPressIntervalMs: int(100, 0, 1000, 'Random window for simultaneous presses (ms)'),
  playAllQuestionsInFinalRound: bool(false, 'Play all questions in the final round'),
  displaySources: bool(false, 'Show question sources'),
  useApellations: bool(true, 'Allow appeals'),
  gameMode: oneOf<GameMode>('classic', ['classic', 'simple'], 'Game mode'),
  // Phones in one room play clips out of sync; the host or TV screen can be the only speaker.
  soundOnHostOnly: bool(false, 'Play question sound only on the host and TV screens'),
  // Newcomers join as spectators and wait for the host to seat them.
  lockRoom: bool(false, 'Lock the room: new arrivals watch until the host seats them'),

  /* ---- Timers in seconds (TimeSettings) ---- */
  // Tuned for an in-room party game, not SIGame's online defaults (2026-10-31): taps get short
  // clocks, typing gets enough for a phone, and minimums stop values nobody can play with.
  timeForChoosingQuestion: int(30, 5, 120, 'Time to choose a question'),
  // 5 s felt short in playtests; past 30 s the table waits on nobody.
  timeForThinkingOnQuestion: int(7, 3, 30, 'Time to press the button after reading'),
  timeForPrintingAnswer: int(20, 5, 120, 'Time to give an answer'),
  timeForGivingACat: int(20, 5, 60, 'Time to give the secret question away'),
  // Per bidder turn: 30 s across six players stalled an auction for minutes.
  timeForMakingStake: int(15, 5, 60, 'Time to make a stake'),
  // Everyone types at once on a for-all question.
  timeForThinkingOnSpecial: int(30, 10, 120, 'Time to think on a special question'),
  timeForChoosingFinalTheme: int(20, 5, 120, 'Time to remove a final theme'),
  timeForFinalThinking: int(45, 15, 180, 'Final round thinking time'),
  timeForShowmanDecisions: int(30, 10, 120, 'Host decision time'),
  // 3 s ate most of the buzz window, so one early press cost the whole question.
  timeForBlockingButton: int(1, 0, 10, 'Button block after false start'),
  timeForMediaDelay: int(0, 0, 15, 'Delay before media playback'),
  timeForQuestionIntro: int(2, 0, 10, 'Pick reveal: seconds the chosen cell stays lit before the question'),
  timeForQuestionReady: int(3, 0, 15, 'Get ready: seconds the question is shown with a countdown before reading'),
});

export function defaultSettings(): GameSettings {
  return Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([k, s]) => [k, s.default]),
  ) as unknown as GameSettings;
}

/**
 * Settings from a saved room, fitted to today's schema. Limits change between versions, so an
 * old save may hold values a host could no longer pick: integers are clamped into range, values
 * of the wrong type fall back to the default, and retired keys (e.g. timeOfRound) are dropped.
 */
export function restoreSettings(saved: Partial<Record<string, unknown>> | undefined): GameSettings {
  const next: Record<string, unknown> = { ...defaultSettings() };
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    const value = saved?.[key];
    if (schema.type === 'boolean' && typeof value === 'boolean') next[key] = value;
    else if (schema.type === 'integer' && typeof value === 'number' && Number.isFinite(value)) {
      next[key] = Math.min(schema.max, Math.max(schema.min, Math.round(value)));
    } else if (schema.type === 'enum' && typeof value === 'string' && schema.values.includes(value)) next[key] = value;
  }
  return next as unknown as GameSettings;
}

export function applySettingsPatch(current: GameSettings, patch: Partial<Record<string, unknown>>): GameSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const schema = SETTINGS_SCHEMA[key as keyof GameSettings];
    if (!schema) continue;
    switch (schema.type) {
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error(`${key} must be true/false`);
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < schema.min || value > schema.max) {
          throw new Error(`${key} must be an integer between ${schema.min} and ${schema.max}`);
        }
        break;
      case 'enum':
        if (typeof value !== 'string' || !schema.values.includes(value)) {
          throw new Error(`${key} must be one of ${schema.values.join(', ')}`);
        }
        break;
    }
    next[key] = value;
  }
  return next as unknown as GameSettings;
}
