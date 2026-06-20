import { NORMAL_SUITS, type NormalSuit } from './cards.js';
import { legalCardsForSimplePlay, parseTrumpBid } from './engine.js';
import { chooseFriendCallsForUpgrade, chooseUpgradeBury, reportSimpleDecision } from './strategy.js';
import type { GameIntent, GameState, SeatIndex } from './types.js';

export function decideBotIntent(state: GameState, seat: SeatIndex): GameIntent | null {
  const player = state.seats[seat];
  if (!player.isBot) return null;

  if (state.phase === 'bidding') {
    const bid = findBid(state, seat);
    if (bid) {
      return {
        type: 'bid',
        seat,
        cardIds: bid,
        strategy: reportSimpleDecision(state, seat, 'bid', bid, ['能定主时优先建立本局主牌结构，服务后续升级目标。'])
      };
    }
    return {
      type: 'pass-counter',
      seat,
      strategy: reportSimpleDecision(state, seat, 'pass-counter', [], ['没有满足两王带同花级牌的亮主条件，不盲目定弱主。'])
    };
  }

  if (state.phase === 'counter') {
    const bid = findBid(state, seat);
    if (bid) {
      return {
        type: 'bid',
        seat,
        cardIds: bid,
        strategy: reportSimpleDecision(state, seat, 'bid', bid, ['反底必须压过当前主，只有能改善主牌控制时才出手。'])
      };
    }
    return {
      type: 'pass-counter',
      seat,
      strategy: reportSimpleDecision(state, seat, 'pass-counter', [], ['反底不足以改善升级目标，选择保留手牌结构。'])
    };
  }

  if (state.phase === 'bury' && state.bottomOwner === seat) {
    const { cards, report } = chooseUpgradeBury(state, seat);
    return { type: 'bury', seat, cardIds: cards.map((card) => card.id), strategy: report };
  }

  if (state.phase === 'friend-call' && state.dealerSeat === seat) {
    const { calls, report } = chooseFriendCallsForUpgrade(state, seat);
    return { type: 'call-friends', seat, calls, strategy: report };
  }

  if (state.phase === 'playing' && state.activeSeat === seat) {
    const cards = legalCardsForSimplePlay(state, seat);
    if (cards.length > 0) {
      const cardIds = cards.map((card) => card.id);
      return {
        type: 'play',
        seat,
        cardIds,
        strategy: reportSimpleDecision(state, seat, 'play', cardIds, ['按当前牌型约束选择合法牌，再交给复盘判断是否服务升级分档。'])
      };
    }
  }

  return null;
}

function findBid(state: GameState, seat: SeatIndex): string[] | null {
  const hand = state.seats[seat].hand;
  const jokers = hand.filter((card) => card.suit === 'joker').slice(0, 2);
  if (jokers.length < 2) return null;
  for (const suit of NORMAL_SUITS) {
    const levelCards = hand.filter((card) => card.suit === suit && card.rank === state.dealerLevel);
    if (levelCards.length > 0) {
      const cards = [...jokers, levelCards[0]];
      try {
        const parsed = parseTrumpBid(cards, seat, state.dealerLevel);
        const current = state.currentBid;
        const strength = parsed.levelCardCount * 10 + suitStrength(parsed.suit);
        const currentStrength = current ? current.levelCardCount * 10 + suitStrength(current.suit) : -1;
        if (strength > currentStrength) return cards.map((card) => card.id);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function suitStrength(suit: NormalSuit): number {
  return { diamonds: 0, clubs: 1, hearts: 2, spades: 3 }[suit];
}

export function replayScoreSnapshot(state: GameState) {
  return state.seats.map((seat) => ({
    seat: seat.seat,
    name: seat.name,
    points: seat.personalPoints,
    level: seat.level
  }));
}
