export const NORMAL_SUITS = ['spades', 'hearts', 'clubs', 'diamonds'] as const;
export type NormalSuit = (typeof NORMAL_SUITS)[number];
export type TrumpSuit = NormalSuit | 'no-trump';
export type Suit = NormalSuit | 'joker';

export const SUIT_LABEL: Record<NormalSuit, string> = {
  spades: '黑',
  hearts: '红',
  clubs: '梅',
  diamonds: '方'
};

export const SUIT_SYMBOL: Record<Suit, string> = {
  spades: '♠',
  hearts: '♥',
  clubs: '♣',
  diamonds: '♦',
  joker: '☉'
};

export const COUNTER_SUIT_ORDER: NormalSuit[] = ['diamonds', 'clubs', 'hearts', 'spades'];

export const NORMAL_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export type NormalRank = (typeof NORMAL_RANKS)[number];
export type JokerRank = 'SJ' | 'BJ';
export type Rank = NormalRank | JokerRank;

export const LEVEL_ORDER: NormalRank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const NORMAL_RANK_VALUE = new Map<NormalRank, number>(
  NORMAL_RANKS.map((rank, index) => [rank, index + 2])
);

export type Card = {
  id: string;
  deck: number;
  suit: Suit;
  rank: Rank;
};

export type EffectiveSuit = NormalSuit | 'trump';

export function createDecks(deckCount = 6): Card[] {
  const cards: Card[] = [];
  for (let deck = 0; deck < deckCount; deck += 1) {
    for (const suit of NORMAL_SUITS) {
      for (const rank of NORMAL_RANKS) {
        cards.push({ id: `${deck}-${suit}-${rank}`, deck, suit, rank });
      }
    }
    cards.push({ id: `${deck}-joker-SJ`, deck, suit: 'joker', rank: 'SJ' });
    cards.push({ id: `${deck}-joker-BJ`, deck, suit: 'joker', rank: 'BJ' });
  }
  return cards;
}

export function isJoker(card: Card): boolean {
  return card.suit === 'joker';
}

export function isAce(card: Card): boolean {
  return card.suit !== 'joker' && card.rank === 'A';
}

export function isNormalSuit(suit: Suit): suit is NormalSuit {
  return suit !== 'joker';
}

export function pointValue(card: Card): number {
  if (card.rank === '5') return 5;
  if (card.rank === '10' || card.rank === 'K') return 10;
  return 0;
}

export function cardLabel(card: Card): string {
  if (card.rank === 'SJ') return `小王${card.deck + 1}`;
  if (card.rank === 'BJ') return `大王${card.deck + 1}`;
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}

export function baseCardKey(card: Card): string {
  return `${card.suit}:${card.rank}`;
}

export function effectiveSuit(card: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): EffectiveSuit {
  if (card.suit === 'joker') return 'trump';
  if (trumpSuit !== 'no-trump' && card.suit === trumpSuit) return 'trump';
  if (card.rank === levelRank) return 'trump';
  return card.suit;
}

export function effectiveRankValue(card: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): number {
  if (card.rank === 'BJ') return 220;
  if (card.rank === 'SJ') return 210;
  if (card.suit === 'joker') return 200;
  if (trumpSuit === 'no-trump' && card.rank === levelRank) return 180;
  if (card.rank === levelRank && card.suit === trumpSuit) return 190;
  if (card.rank === levelRank) return 180 + COUNTER_SUIT_ORDER.indexOf(card.suit);
  return NORMAL_RANK_VALUE.get(card.rank) ?? 0;
}

export function logicalRankValue(card: Card, levelRank: NormalRank): number {
  if (card.rank === 'BJ') return 220;
  if (card.rank === 'SJ') return 210;
  if (card.suit !== 'joker' && card.rank === levelRank) return 180;
  return NORMAL_RANK_VALUE.get(card.rank as NormalRank) ?? 0;
}

export function logicalCardKey(card: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): string {
  const door = effectiveSuit(card, trumpSuit, levelRank);
  if (door !== 'trump') return `${door}:${card.rank}`;
  if (card.suit === 'joker') return `trump:joker:${card.rank}`;
  if (card.rank === levelRank) {
    if (trumpSuit !== 'no-trump' && card.suit === trumpSuit) return `trump:main-level:${levelRank}`;
    return `trump:off-level:${levelRank}`;
  }
  return `trump:${card.suit}:${card.rank}`;
}

export function tractorRankValue(card: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): number {
  const normalRanks = NORMAL_RANKS.filter((rank) => rank !== levelRank);
  const normalRank = normalRanks.indexOf(card.rank as NormalRank);
  const normalTop = normalRanks.length;
  if (card.rank === 'SJ') return normalTop + (trumpSuit === 'no-trump' ? 2 : 3);
  if (card.rank === 'BJ') return normalTop + (trumpSuit === 'no-trump' ? 3 : 4);
  if (card.suit !== 'joker' && card.rank === levelRank) {
    if (trumpSuit !== 'no-trump' && card.suit === trumpSuit) return normalTop + 2;
    return normalTop + 1;
  }
  return normalRank >= 0 ? normalRank + 1 : 0;
}

export function compareLogicalCards(a: Card, b: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): number {
  const rank = tractorRankValue(a, trumpSuit, levelRank) - tractorRankValue(b, trumpSuit, levelRank);
  if (rank !== 0) return rank;
  const strength = effectiveRankValue(a, trumpSuit, levelRank) - effectiveRankValue(b, trumpSuit, levelRank);
  if (strength !== 0) return strength;
  return cardLabel(a).localeCompare(cardLabel(b));
}

export function sortCards(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): Card[] {
  return [...cards].sort((a, b) => {
    const suitA = effectiveSuit(a, trumpSuit, levelRank);
    const suitB = effectiveSuit(b, trumpSuit, levelRank);
    if (suitA !== suitB) return suitA.localeCompare(suitB);
    return effectiveRankValue(a, trumpSuit, levelRank) - effectiveRankValue(b, trumpSuit, levelRank);
  });
}

export function rankUpOne(rank: NormalRank): NormalRank {
  const index = LEVEL_ORDER.indexOf(rank);
  if (index < 0 || index === LEVEL_ORDER.length - 1) return rank;
  return LEVEL_ORDER[index + 1];
}

export function shuffle<T>(items: T[], seed = `${Date.now()}`): T[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  const random = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
