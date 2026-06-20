import { NORMAL_SUITS, type Card } from './cards.js';
import { parseTrumpBid, trumpBidStrength } from './engine.js';
import { chooseUpgradePlay } from './play-policy.js';
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
    const play = chooseUpgradePlay(state, seat);
    if (play) {
      return { type: 'play', seat, cardIds: play.cards.map((card) => card.id), strategy: play.report };
    }
  }

  return null;
}

function findBid(state: GameState, seat: SeatIndex): string[] | null {
  const hand = state.seats[seat].hand;
  const jokers = hand.filter((card) => card.suit === 'joker').slice(0, 2);
  if (jokers.length < 2) return null;
  const candidates: Card[][] = [];
  for (const suit of NORMAL_SUITS) {
    const levelCards = hand.filter((card) => card.suit === suit && card.rank === state.dealerLevel);
    if (levelCards.length > 0) candidates.push([...jokers, ...levelCards]);
  }

  const small = hand.filter((card) => card.rank === 'SJ');
  const big = hand.filter((card) => card.rank === 'BJ');
  if (small.length >= 1 && big.length >= 2) candidates.push([small[0], big[0], ...big.slice(1)]);
  if (small.length >= 2 && big.length >= 1) candidates.push([small[0], big[0], ...small.slice(1)]);

  const currentStrength = state.currentBid ? trumpBidStrength(state.currentBid) : -1;
  return candidates
    .flatMap((cards) => {
      try {
        const parsed = parseTrumpBid(cards, seat, state.dealerLevel);
        return trumpBidStrength(parsed) > currentStrength ? [{ cards, strength: trumpBidStrength(parsed) }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.strength - a.strength)[0]?.cards.map((card) => card.id) ?? null;
}

export function replayScoreSnapshot(state: GameState) {
  return state.seats.map((seat) => ({
    seat: seat.seat,
    name: seat.name,
    points: seat.personalPoints,
    level: seat.level
  }));
}
