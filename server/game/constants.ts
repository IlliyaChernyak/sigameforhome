/** Shared enums & union types. */

export const ROLES = Object.freeze({
  /** First connection hasn't picked yet. */
  PENDING: 'pending',
  /** Game master ("Showman" in SIGame). */
  HOST: 'host',
  PLAYER: 'player',
  SPECTATOR: 'spectator',
} as const);

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  /** Round board shown, chooser picks a question. */
  BOARD: 'board',
  SPECIAL_SETUP: 'specialSetup',
  STAKE_AUCTION: 'stakeAuction',
  FOR_ALL_ANSWERING: 'forAllAnswering',
  FOR_ALL_JUDGE: 'forAllJudge',
  FINAL_WAGER: 'finalWager',
  FINAL_THEMES: 'finalThemes',
  FINAL_QUESTION: 'finalQuestion',
  FINAL_JUDGE: 'finalJudge',
  PAUSED: 'paused',
  /**
   * The chosen cell is lit on the board before the question starts. A phase of its own (not a timer
   * inside READING) so every action that accepts READING refuses it by default and no content leaks.
   */
  INTRO: 'intro',
  /**
   * The question is on screen with a get-ready countdown before reading starts. Presses are ignored,
   * not punished, so players can read ahead and settle on their buttons.
   */
  READY: 'ready',
  /** Question content is being shown/read. Pressing now = false start. */
  READING: 'reading',
  /** Buzzers are live. */
  BUZZER_OPEN: 'buzzerOpen',
  /** A player buzzed and is answering; host judges. */
  ANSWERING: 'answering',
  /** Correct answer displayed. */
  REVEAL: 'reveal',
  /** Players vote on a disputed verdict after the answer is revealed. */
  APPEAL_VOTE: 'appealVote',
  ROUND_END: 'roundEnd',
  GAME_OVER: 'gameOver',
} as const);

export type Phase = (typeof PHASES)[keyof typeof PHASES];
