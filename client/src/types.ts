export interface Participant {
  id: string;
  name: string;
  role: 'host' | 'player' | 'spectator' | 'pending';
  score: number;
  connected: boolean;
  displayOnly: boolean;
  ready: boolean;
  isOwner: boolean;
  /** Live connection figures; null while offline or not yet measured. */
  pingMs: number | null;
  oneWayMs: number | null;
  jitterMs: number | null;
}

export interface ContentItem {
  type: 'text' | 'say' | 'image' | 'audio' | 'video' | 'html';
  value: string;
  url: string | null;
  missing?: boolean;
  placement?: 'screen' | 'replic' | 'background';
  duration?: number | null;
  waitForFinish?: boolean;
}

export interface RoomState {
  serverTime: number;
  you: (Pick<Participant, 'id' | 'name' | 'role'> & {
    isOwner: boolean;
    canModerate: boolean;
    canManage: boolean;
  }) | null;
  participants: Participant[];
  settings: {
    gameMode: string;
    falseStart: boolean;
    ignoreWrong: boolean;
    playAllQuestionsInFinalRound: boolean;
    useApellations: boolean;
    soundOnHostOnly: boolean;
    lockRoom: boolean;
    timeForBlockingButton: number;
    readingSpeed: number;
    partialText: boolean;
    oral: boolean;
    timeForThinkingOnQuestion: number;
    timeForPrintingAnswer: number;
    timeForMakingStake: number;
    timeForChoosingQuestion: number;
    timeForChoosingFinalTheme: number;
    timeForThinkingOnSpecial: number;
    timeForFinalThinking: number;
    timeForMediaDelay: number;
    timeForQuestionIntro: number;
    timeForQuestionReady: number;
    buzzSyncMode: 'server' | 'clientTimestamp';
    buzzSyncWindowMs: number;
    buzzOpenLeadMs: number;
    maxPlayers: number;
    [key: string]: string | number | boolean;
  };
  pack: {
    file: string;
    name: string;
    stats: { questions: number };
    rounds: { name: string }[];
  } | null;
  game: {
    phase: string;
    pausedPhase: string | null;
    roundIndex: number;
    round: { name: string; type: string } | null;
    chooserId: string | null;
    undoJudgment: { presentationId: string; judgmentId: number; playerId: string } | null;
    removedFinalThemes: number[];
    board: { name: string; questions: { price: number; available: boolean }[] }[];
    timer: { name: string; endsAt: number; durationMs: number } | null;
    current: {
      presentationId: string;
      themeIndex: number;
      questionIndex: number;
      themeName: string;
      price: number;
      type: string;
      assignedId: string | null;
      content: ContentItem[];
      priceRange: { minimum: number; maximum: number; step: number } | null;
      answerShown: boolean;
      right: string[] | null;
      answerContent: ContentItem[] | null;
      comments: string | null;
      sources: string[] | null;
      answerType: 'text' | 'select' | 'point';
      answerOptions: { label: string; content: ContentItem[] }[];
      answerDeviation: number | null;
      showmanComments: string | null;
      selectionMode: string | null;
      picks: { playerId: string; value: string; correct: boolean }[];
    } | null;
    buzzer: {
      winnerId: string | null;
      typedAnswer: { text: string | null; submitted: boolean; closed: boolean } | null;
      winnerInfo: { mode: 'server' | 'clientTimestamp' | 'random'; reactionMs: number; transitMs?: number; contenders?: number } | null;
      /** Server time the buttons turn green; it can be a little in the future. */
      openedAt: number | null;
      attempted: string[];
      blockedUntil: number | null;
      blockedPlayers: { id: string; until: number }[];
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
      wagers: Record<string, number> | null;
      judged: string[];
      eligibleIds: string[];
      answeredIds: string[];
      editingIds: string[];
      yourAnswer: string | null;
      answers: Record<string, string> | null;
    } | null;
    appeals: {
      judgments: { id: number; playerId: string; correct: boolean; delta: number; appealed: boolean; voided: boolean }[];
      active: {
        judgmentId: number;
        requesterId: string;
        targetId: string;
        kind: 'for' | 'against';
        votedIds: string[];
        eligibleVoterIds: string[];
      } | null;
    } | null;
  };
}

export interface PackListItem {
  file: string;
  name: string;
  rounds?: number | null;
  outline?: { name: string; themes: string[] }[];
  size: number;
  error?: string;
}

export interface Ack {
  ok: boolean;
  error?: string;
  packs?: PackListItem[];
}

export type JoinAck = { ok: true; token: string } | { ok: false; error: string };

export type NoPayloadCommand =
  | 'session:leave' | 'packs:list' | 'game:start' | 'game:stop' | 'game:pause' | 'game:resume'
  | 'game:openFinal' | 'game:closeFinal' | 'game:openBuzzer'
  | 'game:reveal' | 'game:next' | 'game:prevRound' | 'game:nextRound' | 'game:stakePass' | 'game:closeForAll'
  | 'game:appealClose' | 'game:passAnswer';

export interface CommandPayloads {
  'game:undoJudgment': { presentationId: string; judgmentId: number };
  'game:answer': { answer: string };
  'participant:kick': { targetId: string };
  'participant:rename': { targetId: string; name: string };
  'player:ready': { ready: boolean };
  'role:choose': { role: 'host' | 'player' };
  'role:set': { targetId: string; role: 'host' | 'player' | 'spectator' };
  'score:adjust': { targetId: string; delta: number };
  'packs:load': { file: string };
  'settings:update': Partial<RoomState['settings']>;
  'steam:download': { link: string };
  'game:select': { themeIndex: number; questionIndex: number };
  'game:removeFinalTheme': { themeIndex: number };
  'game:configureSpecial': { playerId: string; price: number };
  'game:finalWager': { amount: number };
  'game:finalAnswer': { answer: string };
  'game:draft': { text: string };
  'seat:give': { seatId: string; newcomerId: string };
  'game:judgeFinal': { playerId: string; correct: boolean };
  'game:judge': { correct: boolean; factor?: number };
  'game:stakeBid': { amount: number; allIn: boolean };
  'game:forAllAnswer': { answer: string };
  'game:judgeForAll': { playerId: string; correct: boolean };
  'game:appealRequest': { judgmentId: number };
  'game:appealVote': { support: boolean };
  'game:contentFinished': { presentationId: string; part?: 'answer' };
}

export type CommandEvent = NoPayloadCommand | keyof CommandPayloads;

// Player-specific fields mirror GameEngine.emitEvent payloads; the client uses them for podium replics.
export type GameEvent =
  | { type: 'answerJudged'; correct: boolean; playerId?: string | null; delta?: number }
  | { type: 'buzzAccepted'; playerId: string; assigned?: boolean }
  | { type: 'falseStart' | 'stakePass' | 'answerPassed'; playerId: string }
  | { type: 'stakeBid'; playerId: string; amount: number; allIn: boolean }
  | { type: 'stakeWon'; playerId: string; amount: number }
  | { type: 'giftAwarded'; playerId: string; price: number }
  | { type: 'buzzerOpen'; openedAt: number }
  | { type: 'specialSetup' | 'questionSelected' | 'roundEnd' };

export interface SteamProgress {
  stage: string;
  message: string;
  percent?: number;
}

export interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
  'game:event': (event: GameEvent) => void;
  'steam:progress': (progress: SteamProgress) => void;
  'packs:changed': (change: { packs: PackListItem[] }) => void;
  'session:kicked': () => void;
}

export type ClientToServerEvents = {
  [Event in NoPayloadCommand]: (payload: Record<string, never>, ack: (result: Ack) => void) => void;
} & {
  [Event in keyof CommandPayloads]: (payload: CommandPayloads[Event], ack: (result: Ack) => void) => void;
} & {
  'session:join': (payload: { nickname: string; asSpectator?: boolean }, ack: (result: JoinAck) => void) => void;
  'session:resume': (payload: { token: string }, ack: (result: { ok: boolean; resumed?: boolean }) => void) => void;
  'game:buzz': (payload: { clientAt: number }, ack: (result: Ack) => void) => void;
  'clock:ping': (payload: { rtt?: number }, ack: (result: { ok: boolean; serverTime: number }) => void) => void;
};
