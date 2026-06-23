export type Suit = 'spades' | 'hearts' | 'clubs' | 'diamonds' | 'joker';
export type NormalSuit = Exclude<Suit, 'joker'>;
export type TrumpSuit = NormalSuit | 'no-trump';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A' | 'SJ' | 'BJ';

export type Card = {
  id: string;
  deck: number;
  suit: Suit;
  rank: Rank;
};

export type PlayerState = {
  seat: number;
  name: string;
  userId: string | null;
  isBot: boolean;
  level: string;
  hand: Card[];
  handCount: number;
  personalPoints: number;
};

export type TrickState = {
  index: number;
  leader: number;
  plays: { seat: number; cards: Card[] }[];
  leadShape?: unknown;
  winner?: number | null;
  points: number;
};

export type GameState = {
  id: string;
  name: string;
  phase: string;
  seats: PlayerState[];
  dealerSeat: number | null;
  nextDealerSeat: number | null;
  dealerLevel: string;
  trumpSuit: TrumpSuit | null;
  kitty: Card[];
  pickedKittyCardIds: string[];
  bottomOwner: number | null;
  currentBid: null | {
    seat: number;
    suit: TrumpSuit;
    levelRank: string;
    levelCardCount: number;
    jokerCount: number;
    noTrumpRank?: 'SJ' | 'BJ';
    cardIds: string[];
    cards: Card[];
    action: 'bid' | 'counter' | 'kitty';
    source: 'hand' | 'kitty';
  };
  bidPasses: number[];
  counterPasses: number[];
  counterEligibleSeats: number[];
  friendCalls: { id: string; suit: NormalSuit; rank?: 'A' | 'K'; nth: number; seen: number; matchedBy: number | null; matchedTrick: number | null }[];
  aceSeen: Record<NormalSuit, number>;
  activeSeat: number | null;
  currentTrick: TrickState | null;
  completedTricks: TrickState[];
  round: number;
  result: null | {
    attackerPoints: number;
    rawAttackerPoints: number;
    kittyPoints: number;
    kittyMultiplier: number;
    hostTeam: number[];
    attackerTeam: number[];
    outcome: string;
    levelDelta: number;
    nextDealer: number;
    bottomSaved: boolean;
    mandatoryBottomPenalty?: null | {
      rank: 'J' | 'A';
      kind: 'main' | 'off';
      target: string | null;
      affected: {
        seat: number;
        from: string;
        to: string;
      }[];
      cardIds: string[];
    };
  };
  events: { seq: number; type: string; message: string; payload?: unknown }[];
};

export type User = {
  id: string;
  name: string;
  token: string;
};

export type ReplayAnalysis = {
  title: string;
  summary: string;
  friendTimeline: string[];
  scoringTimeline: string[];
  keyMoments: string[];
  aiDecisionTimeline: string[];
  badDecisionTimeline: string[];
  learningSummary: string;
};
