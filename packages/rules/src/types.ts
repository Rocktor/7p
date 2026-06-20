import type { Card, JokerRank, NormalRank, NormalSuit, TrumpSuit } from './cards.js';

export type SeatIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const SEATS: SeatIndex[] = [0, 1, 2, 3, 4, 5, 6];

export type GamePhase = 'lobby' | 'bidding' | 'bury' | 'counter' | 'friend-call' | 'playing' | 'finished';

export type PlayerState = {
  seat: SeatIndex;
  name: string;
  userId: string | null;
  isBot: boolean;
  level: NormalRank;
  passedMandatory: {
    J: boolean;
    A: boolean;
  };
  hand: Card[];
  personalPoints: number;
};

export type TrumpBid = {
  seat: SeatIndex;
  suit: TrumpSuit;
  levelRank: NormalRank;
  levelCardCount: number;
  jokerCount: number;
  noTrumpRank?: JokerRank;
  cardIds: string[];
  cards: Card[];
  action: 'bid' | 'counter' | 'kitty';
  source: 'hand' | 'kitty';
};

export type FriendCall = {
  id: string;
  suit: NormalSuit;
  nth: number;
  seen: number;
  matchedBy: SeatIndex | null;
  matchedTrick: number | null;
  pointsAtReveal: number | null;
};

export type PlayedCards = {
  seat: SeatIndex;
  cards: Card[];
};

export type PlayKind = 'single' | 'tuple' | 'tractor' | 'combo';

export type PlayComponent = {
  tupleSize: number;
  tractorLength: number;
  count: number;
  strength: number;
  label: string;
};

export type PlayShape = {
  kind: PlayKind;
  count: number;
  effectiveSuit: NormalSuit | 'trump' | 'mixed';
  tupleSize: number;
  tractorLength: number;
  strength: number;
  label: string;
  components: PlayComponent[];
};

export type Trick = {
  index: number;
  leader: SeatIndex;
  plays: PlayedCards[];
  leadShape: PlayShape | null;
  winner: SeatIndex | null;
  points: number;
};

export type RoundResult = {
  attackerPoints: number;
  rawAttackerPoints: number;
  kittyPoints: number;
  kittyMultiplier: number;
  hostTeam: SeatIndex[];
  attackerTeam: SeatIndex[];
  outcome: 'host-big-shutout' | 'host-small-shutout' | 'host-level-up' | 'attackers-down' | 'attackers-level-up';
  levelDelta: number;
  nextDealer: SeatIndex;
  bottomSaved: boolean;
  mandatoryBottomPenalty: {
    rank: 'J' | 'A';
    kind: 'main' | 'off';
    target: NormalRank | null;
    affected: {
      seat: SeatIndex;
      from: NormalRank;
      to: NormalRank;
    }[];
    cardIds: string[];
  } | null;
};

export type GameEvent = {
  seq: number;
  type: string;
  message: string;
  payload?: unknown;
};

export type UpgradeObjective = {
  team: 'host' | 'attackers' | 'hidden' | 'unknown';
  target: 'host-big-shutout' | 'host-small-shutout' | 'host-level-up' | 'attackers-down' | 'attackers-level-up' | 'survive-hidden';
  scoreLine: string;
  summary: string;
};

export type StrategyRisk = {
  code:
    | 'bury-bottom-points'
    | 'bury-control-card'
    | 'bury-structure'
    | 'break-structure'
    | 'lead-trump-risk'
    | 'unsafe-point-lead'
    | 'unsafe-point-play'
    | 'single-card-thinking'
    | 'self-friend'
    | 'unknown-team';
  severity: 'info' | 'warn' | 'bad';
  message: string;
  cardIds?: string[];
};

export type StrategyCandidate = {
  id: string;
  score: number;
  summary: string;
  cardIds?: string[];
  calls?: { suit: NormalSuit; nth: number }[];
  risks?: StrategyRisk[];
};

export type StrategyDecisionReport = {
  seat: SeatIndex;
  phase: GamePhase;
  action: 'bid' | 'pass-counter' | 'bury' | 'call-friends' | 'play';
  objective: UpgradeObjective;
  score: number;
  selectedCardIds?: string[];
  selectedCalls?: { suit: NormalSuit; nth: number }[];
  reasons: string[];
  risks: StrategyRisk[];
  candidates?: StrategyCandidate[];
  handBefore?: unknown;
  handAfter?: unknown;
};

export type GameState = {
  id: string;
  name: string;
  phase: GamePhase;
  seats: PlayerState[];
  dealerSeat: SeatIndex | null;
  nextDealerSeat: SeatIndex | null;
  dealerLevel: NormalRank;
  trumpSuit: TrumpSuit | null;
  kitty: Card[];
  pickedKittyCardIds: string[];
  bottomOwner: SeatIndex | null;
  currentBid: TrumpBid | null;
  bidPasses: SeatIndex[];
  counterPasses: SeatIndex[];
  counterEligibleSeats: SeatIndex[];
  friendCalls: FriendCall[];
  aceSeen: Record<NormalSuit, number>;
  activeSeat: SeatIndex | null;
  currentTrick: Trick | null;
  completedTricks: Trick[];
  round: number;
  result: RoundResult | null;
  previousHostTeam: SeatIndex[];
  previousHostDown: boolean;
  events: GameEvent[];
};

export type GameIntent =
  | { type: 'sit'; seat: SeatIndex; userId: string; name: string }
  | { type: 'leave-seat'; seat: SeatIndex; userId: string }
  | { type: 'toggle-bot'; seat: SeatIndex; enabled: boolean; name?: string }
  | { type: 'start-game'; seed?: string }
  | { type: 'bid'; seat: SeatIndex; cardIds: string[]; strategy?: StrategyDecisionReport }
  | { type: 'pass-counter'; seat: SeatIndex; strategy?: StrategyDecisionReport }
  | { type: 'bury'; seat: SeatIndex; cardIds: string[]; strategy?: StrategyDecisionReport }
  | { type: 'finish-counter'; seat: SeatIndex }
  | { type: 'call-friends'; seat: SeatIndex; calls: { suit: NormalSuit; nth: number }[]; strategy?: StrategyDecisionReport }
  | { type: 'play'; seat: SeatIndex; cardIds: string[]; strategy?: StrategyDecisionReport }
  | { type: 'next-round'; seed?: string };

export type DispatchResult = {
  state: GameState;
  events: GameEvent[];
};
