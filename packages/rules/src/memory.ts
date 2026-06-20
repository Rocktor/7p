import {
  NORMAL_SUITS,
  type Card,
  type EffectiveSuit,
  type NormalRank,
  type NormalSuit,
  type TrumpSuit,
  effectiveSuit,
  pointValue
} from './cards.js';
import type { GameState, PlayedCards, PlayShape, SeatIndex, Trick } from './types.js';

export type Door = EffectiveSuit;

export type PlayerMemory = {
  seat: SeatIndex;
  remainingCount: number;
  playedCards: Card[];
  capturedPoints: number;
  voidDoors: Record<Door, boolean>;
};

export type TableMemory = {
  trumpSuit: TrumpSuit;
  levelRank: NormalRank;
  playedCards: Card[];
  pointsPlayed: number;
  trumpPlayed: Card[];
  acesSeen: Record<NormalSuit, number>;
  players: PlayerMemory[];
};

const DOORS: Door[] = ['trump', ...NORMAL_SUITS];

export function buildTableMemory(state: GameState): TableMemory | null {
  if (!state.trumpSuit) return null;
  const players = state.seats.map((seat): PlayerMemory => ({
    seat: seat.seat,
    remainingCount: seat.hand.length,
    playedCards: [],
    capturedPoints: seat.personalPoints,
    voidDoors: emptyVoidDoors()
  }));
  const allPlays: PlayedCards[] = [];
  for (const trick of state.completedTricks) {
    applyTrickMemory(players, trick, state.trumpSuit, state.dealerLevel);
    allPlays.push(...trick.plays);
  }
  if (state.currentTrick) {
    applyTrickMemory(players, state.currentTrick, state.trumpSuit, state.dealerLevel);
    allPlays.push(...state.currentTrick.plays);
  }
  const playedCards = allPlays.flatMap((play) => play.cards);
  return {
    trumpSuit: state.trumpSuit,
    levelRank: state.dealerLevel,
    playedCards,
    pointsPlayed: sumPoints(playedCards),
    trumpPlayed: playedCards.filter((card) => effectiveSuit(card, state.trumpSuit!, state.dealerLevel) === 'trump'),
    acesSeen: {
      spades: state.aceSeen.spades,
      hearts: state.aceSeen.hearts,
      clubs: state.aceSeen.clubs,
      diamonds: state.aceSeen.diamonds
    },
    players
  };
}

export function playerMemory(memory: TableMemory, seat: SeatIndex): PlayerMemory {
  return memory.players[seat];
}

export function isVoid(memory: TableMemory, seat: SeatIndex, door: Door): boolean {
  return !!memory.players[seat]?.voidDoors[door];
}

export function allOthersVoid(memory: TableMemory, seat: SeatIndex, door: Door): boolean {
  const activeOthers = memory.players.filter((player) => player.seat !== seat && player.remainingCount > 0);
  return activeOthers.length > 0 && activeOthers.every((player) => player.voidDoors[door]);
}

export function anyOpponentCanStillHoldDoor(memory: TableMemory, seat: SeatIndex, door: Door): boolean {
  return memory.players
    .filter((player) => player.seat !== seat && player.remainingCount > 0)
    .some((player) => !player.voidDoors[door]);
}

export function doorCards(cards: Card[], memory: TableMemory, door: Door): Card[] {
  return cards.filter((card) => effectiveSuit(card, memory.trumpSuit, memory.levelRank) === door);
}

function applyTrickMemory(players: PlayerMemory[], trick: Trick, trumpSuit: TrumpSuit, levelRank: NormalRank) {
  for (const play of trick.plays) {
    const memory = players[play.seat];
    memory.playedCards.push(...play.cards);
  }
  if (!trick.leadShape || trick.leadShape.effectiveSuit === 'mixed') return;
  for (const play of trick.plays.slice(1)) {
    markVoidsFromFollow(players[play.seat], play, trick.leadShape, trumpSuit, levelRank);
  }
}

function markVoidsFromFollow(
  memory: PlayerMemory,
  play: PlayedCards,
  leadShape: PlayShape,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank
) {
  const leadDoor = leadShape.effectiveSuit;
  if (leadDoor === 'mixed') return;
  const followedCount = play.cards.filter((card) => effectiveSuit(card, trumpSuit, levelRank) === leadDoor).length;
  if (followedCount < leadShape.count) {
    memory.voidDoors[leadDoor] = true;
  }
}

function emptyVoidDoors(): Record<Door, boolean> {
  return {
    trump: false,
    spades: false,
    hearts: false,
    clubs: false,
    diamonds: false
  };
}

function sumPoints(cards: Card[]): number {
  return cards.reduce((sum, card) => sum + pointValue(card), 0);
}
