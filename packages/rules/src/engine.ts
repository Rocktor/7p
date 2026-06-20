import {
  COUNTER_SUIT_ORDER,
  type Card,
  type EffectiveSuit,
  type JokerRank,
  LEVEL_ORDER,
  type NormalRank,
  NORMAL_SUITS,
  type NormalSuit,
  type TrumpSuit,
  cardLabel,
  compareLogicalCards,
  createDecks,
  effectiveRankValue,
  effectiveSuit,
  isAce,
  isJoker,
  logicalCardKey,
  pointValue,
  rankUpOne,
  shuffle,
  sortCards,
  tractorRankValue
} from './cards.js';
import { analyzeBurySelection, strategyDecisionMessage, summarizeHandStructure } from './strategy.js';
import {
  type DispatchResult,
  type FriendCall,
  type GameEvent,
  type GameIntent,
  type GameState,
  type PlayShape,
  type PlayComponent,
  type PlayerState,
  type RoundResult,
  type SeatIndex,
  SEATS,
  type StrategyDecisionReport,
  type Trick,
  type TrumpBid
} from './types.js';

const PLAYER_COUNT = 7;
const DECK_COUNT = 6;
const HAND_SIZE = 45;
const KITTY_SIZE = 9;
const TUPLE_SIZES_DESC = [6, 5, 4, 3, 2] as const;
const TRUMP_SUIT_NAME: Record<TrumpSuit, string> = {
  spades: '黑桃',
  hearts: '红桃',
  clubs: '梅花',
  diamonds: '方片',
  'no-trump': '无主'
};

type CardGroupEntry = {
  group: Card[];
  remaining: Card[];
};

type FollowRequirement =
  | { kind: 'tractor'; tupleSize: number; tractorLength: number }
  | { kind: 'tuple'; tupleSize: number; groups: number };

export function createGame(id: string, name = '找朋友牌桌'): GameState {
  return {
    id,
    name,
    phase: 'lobby',
    seats: SEATS.map((seat) => emptyPlayer(seat)),
    dealerSeat: null,
    nextDealerSeat: null,
    dealerLevel: '7',
    trumpSuit: null,
    kitty: [],
    pickedKittyCardIds: [],
    bottomOwner: null,
    currentBid: null,
    bidPasses: [],
    counterPasses: [],
    counterEligibleSeats: [],
    friendCalls: [],
    aceSeen: { spades: 0, hearts: 0, clubs: 0, diamonds: 0 },
    activeSeat: null,
    currentTrick: null,
    completedTricks: [],
    round: 0,
    result: null,
    previousHostTeam: [],
    previousHostDown: false,
    events: []
  };
}

function emptyPlayer(seat: SeatIndex): PlayerState {
  return {
    seat,
    name: `座位${seat + 1}`,
    userId: null,
    isBot: false,
    level: '7',
    passedMandatory: { J: false, A: false },
    hand: [],
    personalPoints: 0
  };
}

function cloneState(state: GameState): GameState {
  return structuredClone(state) as GameState;
}

function addEvent(state: GameState, type: string, message: string, payload?: unknown): GameEvent {
  const event = { seq: state.events.length + 1, type, message, payload };
  state.events.push(event);
  return event;
}

export function dispatch(input: GameState, intent: GameIntent): DispatchResult {
  const state = cloneState(input);
  const before = state.events.length;
  const strategy = strategyReport(intent);
  if (strategy) addEvent(state, 'ai.decision', strategyDecisionMessage(strategy), strategy);

  switch (intent.type) {
    case 'sit':
      sit(state, intent.seat, intent.userId, intent.name);
      break;
    case 'leave-seat':
      leaveSeat(state, intent.seat, intent.userId);
      break;
    case 'toggle-bot':
      toggleBot(state, intent.seat, intent.enabled, intent.name);
      break;
    case 'start-game':
      startGame(state, intent.seed);
      break;
    case 'next-round':
      startNextRound(state, intent.seed);
      break;
    case 'bid':
      makeBid(state, intent.seat, intent.cardIds);
      break;
    case 'pass-counter':
      passCounter(state, intent.seat);
      break;
    case 'bury':
      buryKitty(state, intent.seat, intent.cardIds);
      break;
    case 'finish-counter':
      finishCounter(state, intent.seat);
      break;
    case 'call-friends':
      callFriends(state, intent.seat, intent.calls);
      break;
    case 'play':
      playCards(state, intent.seat, intent.cardIds);
      break;
    default:
      assertNever(intent);
  }

  return { state, events: state.events.slice(before) };
}

function strategyReport(intent: GameIntent): StrategyDecisionReport | undefined {
  return 'strategy' in intent ? intent.strategy : undefined;
}

function assertNever(value: never): never {
  throw new Error(`未知动作：${JSON.stringify(value)}`);
}

function assertPhase(state: GameState, phases: GameState['phase'][]) {
  if (!phases.includes(state.phase)) {
    throw new Error(`当前阶段 ${state.phase} 不能执行该动作`);
  }
}

function requireSeat(seat: SeatIndex): SeatIndex {
  if (!SEATS.includes(seat)) throw new Error('无效座位');
  return seat;
}

function player(state: GameState, seat: SeatIndex): PlayerState {
  return state.seats[requireSeat(seat)];
}

function seatForUser(state: GameState, userId: string): SeatIndex | null {
  const found = state.seats.find((p) => p.userId === userId);
  return found ? found.seat : null;
}

function sit(state: GameState, seat: SeatIndex, userId: string, name: string) {
  assertPhase(state, ['lobby', 'finished']);
  if (seatForUser(state, userId) !== null) throw new Error('已经入座，请先离席再坐到其他座位');
  const p = player(state, seat);
  if (p.userId && p.userId !== userId) throw new Error('座位已被占用');
  p.userId = userId;
  p.name = name.trim() || p.name;
  p.isBot = false;
  addEvent(state, 'seat.sit', `${p.name} 坐到 ${seat + 1} 号位`, { seat, userId });
}

function leaveSeat(state: GameState, seat: SeatIndex, userId: string) {
  const p = player(state, seat);
  if (p.userId !== userId) throw new Error('只能离开自己的座位');
  const name = p.name;
  p.userId = null;
  p.isBot = true;
  p.name = `AI-${seat + 1}`;
  addEvent(state, 'seat.leave', `${name} 离席，AI 接管 ${seat + 1} 号位`, { seat, userId });
}

function toggleBot(state: GameState, seat: SeatIndex, enabled: boolean, name?: string) {
  assertPhase(state, ['lobby', 'finished']);
  const p = player(state, seat);
  if (p.userId) throw new Error('真人座位请先离席再交给AI');
  if (enabled) {
    p.userId = null;
    p.isBot = true;
    p.name = name?.trim() || `AI-${seat + 1}`;
  } else {
    p.isBot = false;
    p.name = `空座${seat + 1}`;
    if (state.phase === 'lobby' || state.phase === 'finished') p.userId = null;
  }
  addEvent(state, 'seat.bot', `${seat + 1} 号位切换为${enabled ? 'AI' : '真人位'}`, { seat, enabled });
}

function startGame(state: GameState, seed = `${Date.now()}`) {
  assertPhase(state, ['lobby']);
  if (state.seats.some((p) => !p.userId && !p.isBot)) throw new Error('必须坐满7人或用AI补位');
  const dealer = randomDealer(seed);
  beginRound(state, dealer, seed);
}

function startNextRound(state: GameState, seed = `${Date.now()}`) {
  assertPhase(state, ['finished']);
  beginRound(state, state.nextDealerSeat ?? nextDealer(state), seed);
}

function randomDealer(seed: string): SeatIndex {
  const shuffled = shuffle(SEATS, seed);
  return shuffled[0];
}

function beginRound(state: GameState, dealerSeat: SeatIndex, seed: string) {
  const dealer = player(state, dealerSeat);
  const deck = shuffle(createDecks(DECK_COUNT), `${seed}:${state.round + 1}`);
  state.round += 1;
  state.phase = 'bidding';
  state.dealerSeat = dealerSeat;
  state.nextDealerSeat = null;
  state.dealerLevel = dealer.level;
  state.trumpSuit = null;
  state.kitty = deck.slice(0, KITTY_SIZE);
  state.pickedKittyCardIds = [];
  state.bottomOwner = null;
  state.currentBid = null;
  state.bidPasses = [];
  state.counterPasses = [];
  state.counterEligibleSeats = [...SEATS];
  state.friendCalls = [];
  state.aceSeen = { spades: 0, hearts: 0, clubs: 0, diamonds: 0 };
  state.activeSeat = dealerSeat;
  state.currentTrick = null;
  state.completedTricks = [];
  state.result = null;
  for (const p of state.seats) {
    p.hand = [];
    p.personalPoints = 0;
  }
  let cursor = KITTY_SIZE;
  for (let cardIndex = 0; cardIndex < HAND_SIZE; cardIndex += 1) {
    for (const seat of SEATS) {
      player(state, seat).hand.push(deck[cursor]);
      cursor += 1;
    }
  }
  for (const p of state.seats) {
    p.hand = sortCards(p.hand, 'spades', state.dealerLevel);
  }
  addEvent(state, 'round.start', `第 ${state.round} 局开始，${dealer.name} 坐庄打 ${state.dealerLevel}`, {
    dealerSeat,
    dealerLevel: state.dealerLevel
  });
}

function nextDealer(state: GameState): SeatIndex {
  const start = (((state.dealerSeat ?? 0) + 1) % PLAYER_COUNT) as SeatIndex;
  if (!state.previousHostDown) return start;
  for (let offset = 0; offset < PLAYER_COUNT; offset += 1) {
    const seat = ((start + offset) % PLAYER_COUNT) as SeatIndex;
    if (!state.previousHostTeam.includes(seat)) return seat;
  }
  return start;
}

function getCardsByIds(cards: Card[], cardIds: string[]): Card[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const selected = cardIds.map((id) => byId.get(id));
  if (selected.some((card) => !card)) throw new Error('选择的牌不在手牌中');
  if (new Set(cardIds).size !== cardIds.length) throw new Error('不能重复选择同一张牌');
  return selected as Card[];
}

function removeCards(cards: Card[], cardIds: string[]): Card[] {
  const remove = new Set(cardIds);
  return cards.filter((card) => !remove.has(card.id));
}

export function parseTrumpBid(
  cards: Card[],
  seat: SeatIndex,
  levelRank: NormalRank,
  source: TrumpBid['source'] = 'hand'
): TrumpBid {
  const jokerCards = cards.filter(isJoker);
  const jokerCount = jokerCards.length;
  if (jokerCount < 2) throw new Error('亮主/反底必须至少有任意两张王');
  const normalCards = cards.filter((card) => card.suit !== 'joker');
  const levelCards = cards.filter((card) => card.suit !== 'joker' && card.rank === levelRank);
  if (levelCards.length === 0) {
    if (normalCards.length > 0) throw new Error('亮主/反底只能使用王和级牌');
    return parseNoTrumpBid(cards, jokerCards, seat, levelRank, source);
  }
  if (normalCards.length !== levelCards.length) throw new Error('亮主/反底只能使用王和级牌');
  const suits = new Set(levelCards.map((card) => card.suit));
  if (suits.size !== 1) throw new Error('级牌必须同花色');
  const suit = levelCards[0].suit as NormalSuit;
  return {
    seat,
    suit,
    levelRank,
    levelCardCount: levelCards.length,
    jokerCount,
    cardIds: cards.map((card) => card.id),
    cards: [...cards],
    action: source === 'kitty' ? 'kitty' : 'bid',
    source
  };
}

function parseNoTrumpBid(
  cards: Card[],
  jokerCards: Card[],
  seat: SeatIndex,
  levelRank: NormalRank,
  source: TrumpBid['source']
): TrumpBid {
  const small = jokerCards.filter((card) => card.rank === 'SJ');
  const big = jokerCards.filter((card) => card.rank === 'BJ');
  if (small.length < 1 || big.length < 1) throw new Error('反无主必须有1张小王和1张大王作为2猫');
  const smallExtras = small.length - 1;
  const bigExtras = big.length - 1;
  if (smallExtras > 0 && bigExtras > 0) throw new Error('反无主额外王必须是同一种王');
  if (smallExtras === 0 && bigExtras === 0) throw new Error('反无主必须带同类小王或大王');
  const noTrumpRank = smallExtras > 0 ? 'SJ' : bigExtras > 0 ? 'BJ' : undefined;
  return {
    seat,
    suit: 'no-trump',
    levelRank,
    levelCardCount: Math.max(smallExtras, bigExtras),
    jokerCount: jokerCards.length,
    noTrumpRank,
    cardIds: cards.map((card) => card.id),
    cards: [...cards],
    action: source === 'kitty' ? 'kitty' : 'bid',
    source
  };
}

export function trumpBidStrength(bid: TrumpBid): number {
  return bid.levelCardCount * 10 + (bid.suit === 'no-trump' ? COUNTER_SUIT_ORDER.length : COUNTER_SUIT_ORDER.indexOf(bid.suit));
}

function beatsBid(next: TrumpBid, current: TrumpBid | null): boolean {
  if (!current) return true;
  return trumpBidStrength(next) > trumpBidStrength(current);
}

function makeBid(state: GameState, seat: SeatIndex, cardIds: string[]) {
  assertPhase(state, ['bidding', 'counter']);
  if (state.phase === 'bidding') {
    if (state.activeSeat !== seat) throw new Error('还没轮到这个座位亮主');
  } else {
    ensureCounterEligibleSeats(state);
    if (!state.counterEligibleSeats.includes(seat)) throw new Error('这个座位已经不在反底行列');
    if (state.activeSeat !== seat) throw new Error('还没轮到这个座位反底');
  }
  const p = player(state, seat);
  const cards = getCardsByIds(p.hand, cardIds);
  const isCounter = state.phase === 'counter';
  const bid = {
    ...parseTrumpBid(cards, seat, state.dealerLevel),
    action: isCounter ? 'counter' as const : 'bid' as const
  };
  if (!beatsBid(bid, state.currentBid)) throw new Error('这手亮主/反底压不过当前主');
  state.currentBid = bid;
  state.trumpSuit = bid.suit;
  state.counterPasses = [];
  if (isCounter) {
    state.pickedKittyCardIds = state.kitty.map((card) => card.id);
    p.hand.push(...state.kitty);
    p.hand = sortCards(p.hand, bid.suit, state.dealerLevel);
    state.kitty = [];
    state.bottomOwner = seat;
    state.phase = 'bury';
    state.activeSeat = seat;
    addEvent(state, 'trump.counter', `${p.name} 反底为 ${bidText(bid)}`, bid);
  } else {
    addEvent(state, 'trump.bid', `${p.name} 亮主为 ${bidText(bid)}`, bid);
    beginBury(state);
  }
}

function passCounter(state: GameState, seat: SeatIndex) {
  assertPhase(state, ['bidding', 'counter']);
  if (state.phase === 'bidding') {
    ensureCounterEligibleSeats(state);
    if (state.activeSeat !== seat) throw new Error('还没轮到这个座位亮主');
    removeCounterEligibility(state, seat);
  } else {
    ensureCounterEligibleSeats(state);
    if (!state.counterEligibleSeats.includes(seat)) throw new Error('这个座位已经不在反底行列');
    if (state.activeSeat !== seat) throw new Error('还没轮到这个座位反底');
  }
  const target = state.phase === 'bidding' ? state.bidPasses : state.counterPasses;
  if (!target.includes(seat)) target.push(seat);
  addEvent(state, 'player.pass', `${player(state, seat).name} 选择${state.phase === 'bidding' ? '不亮' : '不反'}`, { seat, phase: state.phase });
  if (state.phase === 'bidding') {
    const next = nextBiddingSeat(state, seat);
    if (next === null) beginBury(state);
    else state.activeSeat = next;
    return;
  }
  advanceCounterTurn(state, seat);
}

function ensureCounterEligibleSeats(state: GameState) {
  state.counterEligibleSeats ??= [...SEATS];
}

function removeCounterEligibility(state: GameState, seat: SeatIndex) {
  ensureCounterEligibleSeats(state);
  state.counterEligibleSeats = state.counterEligibleSeats.filter((item) => item !== seat);
}

function nextBiddingSeat(state: GameState, fromSeat: SeatIndex): SeatIndex | null {
  for (let offset = 1; offset <= PLAYER_COUNT; offset += 1) {
    const seat = ((fromSeat + offset) % PLAYER_COUNT) as SeatIndex;
    if (!state.bidPasses.includes(seat)) return seat;
  }
  return null;
}

function advanceCounterTurn(state: GameState, fromSeat: SeatIndex) {
  const next = nextCounterSeat(state, fromSeat);
  if (next === null) {
    enterFriendCall(state);
    return;
  }
  state.activeSeat = next;
}

function nextCounterSeat(state: GameState, fromSeat: SeatIndex): SeatIndex | null {
  ensureCounterEligibleSeats(state);
  for (let offset = 1; offset <= PLAYER_COUNT; offset += 1) {
    const seat = ((fromSeat + offset) % PLAYER_COUNT) as SeatIndex;
    if (seat === state.bottomOwner) continue;
    if (!state.counterEligibleSeats.includes(seat)) continue;
    if (state.counterPasses.includes(seat)) continue;
    return seat;
  }
  return null;
}

function beginBury(state: GameState) {
  const dealerSeat = state.dealerSeat;
  if (dealerSeat === null) throw new Error('庄家不存在');
  if (!state.currentBid) {
    const kittyBid = inferKittyBid(state);
    state.currentBid = kittyBid;
    state.trumpSuit = kittyBid.suit;
    addEvent(state, 'trump.kitty', `无人亮主，翻底定主为 ${TRUMP_SUIT_NAME[kittyBid.suit]} ${state.dealerLevel}`, kittyBid);
  }
  const dealer = player(state, dealerSeat);
  state.pickedKittyCardIds = state.kitty.map((card) => card.id);
  dealer.hand.push(...state.kitty);
  dealer.hand = sortCards(dealer.hand, state.currentBid.suit, state.dealerLevel);
  state.kitty = [];
  state.bottomOwner = dealerSeat;
  state.phase = 'bury';
  state.activeSeat = dealerSeat;
  addEvent(state, 'kitty.pickup', `${dealer.name} 拿起9张底牌`, { seat: dealerSeat });
}

function inferKittyBid(state: GameState): TrumpBid {
  const levelCards = state.kitty.filter((card) => card.suit !== 'joker' && card.rank === state.dealerLevel);
  const suit = (levelCards.at(-1)?.suit as NormalSuit | undefined) ?? 'spades';
  return {
    seat: state.dealerSeat ?? 0,
    suit,
    levelRank: state.dealerLevel,
    levelCardCount: Math.max(1, levelCards.filter((card) => card.suit === suit).length),
    jokerCount: state.kitty.filter(isJoker).length,
    cardIds: state.kitty.map((card) => card.id),
    cards: [...state.kitty],
    action: 'kitty',
    source: 'kitty'
  };
}

function bidText(bid: TrumpBid) {
  if (bid.suit === 'no-trump') {
    const extra = bid.levelCardCount > 0 ? ` + ${bid.levelCardCount} 张${jokerRankName(bid.noTrumpRank)}` : '';
    return `2猫${extra} · 无主`;
  }
  return `${bid.jokerCount} 张王 + ${bid.levelCardCount} 张${TRUMP_SUIT_NAME[bid.suit]} ${bid.levelRank}`;
}

function jokerRankName(rank: JokerRank | undefined) {
  if (rank === 'SJ') return '小王';
  if (rank === 'BJ') return '大王';
  return '同类王';
}

function buryKitty(state: GameState, seat: SeatIndex, cardIds: string[]) {
  assertPhase(state, ['bury']);
  if (state.bottomOwner !== seat) throw new Error('当前只有底牌持有人可以扣底');
  if (cardIds.length !== KITTY_SIZE) throw new Error('必须扣回9张底牌');
  const p = player(state, seat);
  const handBefore = [...p.hand];
  const cards = getCardsByIds(p.hand, cardIds);
  if (cards.some(isAce)) throw new Error('扣底不能扣任何A');
  const trumpSuit = state.trumpSuit ?? state.currentBid?.suit ?? 'spades';
  const aiSample = p.isBot ? analyzeBurySelection(state, seat, cards) : null;
  p.hand = removeCards(p.hand, cards.map((card) => card.id));
  state.kitty = cards;
  state.pickedKittyCardIds = [];
  state.phase = 'counter';
  state.counterPasses = [seat];
  state.activeSeat = seat;
  addEvent(state, 'kitty.bury', `${p.name} 扣回9张底牌，等待反底`, {
    seat,
    points: sumPoints(cards),
    cardIds: cards.map((card) => card.id),
    cards,
    ...(p.isBot ? {
      handBefore,
      handAfter: p.hand,
      structureBefore: summarizeHandStructure(handBefore, trumpSuit, state.dealerLevel),
      structureAfter: summarizeHandStructure(p.hand, trumpSuit, state.dealerLevel),
      analysis: aiSample
    } : {})
  });
  advanceCounterTurn(state, seat);
}

function finishCounter(state: GameState, seat: SeatIndex) {
  assertPhase(state, ['counter']);
  if (state.bottomOwner !== seat && state.dealerSeat !== seat) throw new Error('只有庄家或当前扣底者可以结束反底');
  enterFriendCall(state);
}

function enterFriendCall(state: GameState) {
  if (!state.currentBid) throw new Error('还没有定主');
  state.trumpSuit = state.currentBid.suit;
  for (const p of state.seats) {
    p.hand = sortCards(p.hand, state.currentBid.suit, state.dealerLevel);
  }
  state.phase = 'friend-call';
  state.activeSeat = state.dealerSeat;
  addEvent(state, 'friend.phase', '反底结束，庄家开始叫朋友', { dealerSeat: state.dealerSeat });
}

function callFriends(state: GameState, seat: SeatIndex, calls: { suit: NormalSuit; nth: number }[]) {
  assertPhase(state, ['friend-call']);
  if (seat !== state.dealerSeat) throw new Error('只有庄家可以叫朋友');
  if (calls.length !== 2) throw new Error('必须叫两张A');
  const seen = new Set<string>();
  state.friendCalls = calls.map((call, index) => {
    if (!NORMAL_SUITS.includes(call.suit)) throw new Error('叫A花色无效');
    if (state.trumpSuit !== 'no-trump' && call.suit === state.trumpSuit) throw new Error('不能叫主花色A');
    if (call.nth < 1 || call.nth > DECK_COUNT) throw new Error('第N张A必须在1到6之间');
    const key = `${call.suit}:${call.nth}`;
    if (seen.has(key)) throw new Error('不能重复叫完全相同的A');
    seen.add(key);
    return {
      id: `friend-${index + 1}`,
      suit: call.suit,
      nth: call.nth,
      seen: state.aceSeen[call.suit],
      matchedBy: null,
      matchedTrick: null,
      pointsAtReveal: null
    } satisfies FriendCall;
  });
  state.phase = 'playing';
  state.activeSeat = seat;
  state.currentTrick = newTrick(state.completedTricks.length + 1, seat);
  addEvent(
    state,
    'friend.call',
    `${player(state, seat).name} 叫朋友：${calls.map((call) => `${call.suit}第${call.nth}张A`).join('、')}`,
    state.friendCalls
  );
}

function newTrick(index: number, leader: SeatIndex): Trick {
  return {
    index,
    leader,
    plays: [],
    leadShape: null,
    winner: null,
    points: 0
  };
}

function playCards(state: GameState, seat: SeatIndex, cardIds: string[]) {
  assertPhase(state, ['playing']);
  if (state.activeSeat !== seat) throw new Error('还没轮到这个座位出牌');
  if (!state.currentTrick) throw new Error('当前没有牌墩');
  if (!state.trumpSuit) throw new Error('还没有定主');
  const p = player(state, seat);
  let cards = getCardsByIds(p.hand, cardIds);
  let shape = classifyPlay(cards, state.trumpSuit, state.dealerLevel);
  const trick = state.currentTrick;

  if (trick.plays.length === 0) {
    const resolved = resolveLeadPlay(state, seat, cards, shape);
    cards = resolved.cards;
    shape = resolved.shape;
    trick.leadShape = shape;
  } else {
    validateFollow(p.hand, cards, trick.leadShape!, state.trumpSuit, state.dealerLevel);
  }

  p.hand = removeCards(p.hand, cards.map((card) => card.id));
  trick.plays.push({ seat, cards });
  trick.points += sumPoints(cards);
  updateTrickWinner(state, trick);
  detectFriends(state, seat, cards);
  addEvent(state, 'play.cards', `${p.name} 打出 ${cards.map(cardLabel).join(' ')}`, { seat, cardIds: cards.map((card) => card.id), shape });

  if (trick.plays.length === PLAYER_COUNT) {
    completeTrick(state, trick);
  } else {
    state.activeSeat = nextSeat(seat);
  }
}

function resolveLeadPlay(state: GameState, seat: SeatIndex, cards: Card[], shape: PlayShape): { cards: Card[]; shape: PlayShape } {
  if (!state.trumpSuit) throw new Error('还没有定主');
  if (shape.kind !== 'combo') return { cards, shape };
  if (shape.effectiveSuit === 'mixed') throw new Error('不能混花色甩牌');
  const otherHands = state.seats
    .filter((p) => p.seat !== seat)
    .flatMap((p) => p.hand);
  for (const group of groupByLogicalCard(cards, state.trumpSuit, state.dealerLevel)) {
    const arity = group.length;
    const base = group[0];
    const canBeat = groupByLogicalCard(
      otherHands.filter((card) => effectiveSuit(card, state.trumpSuit!, state.dealerLevel) === shape.effectiveSuit),
      state.trumpSuit,
      state.dealerLevel
    ).some((otherGroup) => {
      return otherGroup.length >= arity &&
        effectiveRankValue(otherGroup[0], state.trumpSuit!, state.dealerLevel) > effectiveRankValue(base, state.trumpSuit!, state.dealerLevel);
    });
    if (canBeat) return forceSmallestTossComponent(state, cards);
  }
  return { cards, shape };
}

function forceSmallestTossComponent(state: GameState, cards: Card[]): { cards: Card[]; shape: PlayShape } {
  if (!state.trumpSuit) throw new Error('还没有定主');
  const smallest = groupByLogicalCard(cards, state.trumpSuit, state.dealerLevel)
    .sort((a, b) => {
      const strength = effectiveRankValue(a[0], state.trumpSuit!, state.dealerLevel) - effectiveRankValue(b[0], state.trumpSuit!, state.dealerLevel);
      if (strength !== 0) return strength;
      return a.length - b.length;
    })[0];
  const forcedShape = classifyPlay(smallest, state.trumpSuit, state.dealerLevel);
  addEvent(state, 'toss.fail', `甩牌失败，强制只出 ${smallest.map(cardLabel).join(' ')}`, {
    selected: cards.map((card) => card.id),
    forced: smallest.map((card) => card.id)
  });
  return { cards: smallest, shape: forcedShape };
}

export function classifyPlay(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): PlayShape {
  if (cards.length === 0) throw new Error('必须选择至少一张牌');
  const suits = new Set(cards.map((card) => effectiveSuit(card, trumpSuit, levelRank)));
  const playSuit = suits.size === 1 ? ([...suits][0] as EffectiveSuit) : 'mixed';
  const orderedGroups = groupByLogicalCard(cards, trumpSuit, levelRank);
  const groupSizes = new Set(orderedGroups.map((group) => group.length));
  const maxStrength = Math.max(...cards.map((card) => tractorRankValue(card, trumpSuit, levelRank)));
  const components = playSuit === 'mixed' ? [] : playComponents(orderedGroups, trumpSuit, levelRank);

  if (cards.length === 1) {
    return { kind: 'single', count: 1, effectiveSuit: playSuit, tupleSize: 1, tractorLength: 1, strength: maxStrength, label: '单张', components };
  }
  if (orderedGroups.length === 1) {
    const tupleSize = cards.length;
    return { kind: 'tuple', count: cards.length, effectiveSuit: playSuit, tupleSize, tractorLength: 1, strength: maxStrength, label: `${tupleSize}张`, components };
  }
  if (playSuit !== 'mixed' && groupSizes.size === 1) {
    const tupleSize = orderedGroups[0].length;
    if (tupleSize >= 2 && isConsecutiveGroups(orderedGroups, trumpSuit, levelRank)) {
      return {
        kind: 'tractor',
        count: cards.length,
        effectiveSuit: playSuit,
        tupleSize,
        tractorLength: orderedGroups.length,
        strength: maxStrength,
        label: `${orderedGroups.length}连${tupleSize}张`,
        components
      };
    }
  }
  return { kind: 'combo', count: cards.length, effectiveSuit: playSuit, tupleSize: 1, tractorLength: 1, strength: maxStrength, label: comboLabel(components), components };
}

function groupByLogicalCard(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): Card[][] {
  const groups = new Map<string, Card[]>();
  for (const card of cards) {
    const key = logicalCardKey(card, trumpSuit, levelRank);
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.values()].sort((a, b) => {
    return compareLogicalCards(a[0], b[0], trumpSuit, levelRank);
  });
}

function playComponents(groups: Card[][], trumpSuit: TrumpSuit, levelRank: NormalRank): PlayComponent[] {
  const pairOrBetter = groups.filter((group) => group.length >= 2);
  if (pairOrBetter.length === 0) return [];
  const sameSize = new Set(pairOrBetter.map((group) => group.length)).size === 1;
  if (sameSize && pairOrBetter.length >= 2 && isConsecutiveGroups(pairOrBetter, trumpSuit, levelRank)) {
    const tupleSize = pairOrBetter[0].length;
    return [{
      tupleSize,
      tractorLength: pairOrBetter.length,
      count: tupleSize * pairOrBetter.length,
      strength: Math.max(...pairOrBetter.map((group) => tractorRankValue(group[0], trumpSuit, levelRank))),
      label: `${pairOrBetter.length}连${tupleSize}张`
    }];
  }
  return pairOrBetter.map((group) => ({
    tupleSize: group.length,
    tractorLength: 1,
    count: group.length,
    strength: tractorRankValue(group[0], trumpSuit, levelRank),
    label: `${group.length}张`
  }));
}

function comboLabel(components: PlayComponent[]): string {
  if (components.length === 0) return '甩牌';
  const pairs = components.filter((component) => component.tupleSize === 2 && component.tractorLength === 1).length;
  if (pairs >= 2 && pairs === components.length) return `${pairs}对`;
  return `甩牌(${components.map((component) => component.label).join('+')})`;
}

function isConsecutiveGroups(groups: Card[][], trumpSuit: TrumpSuit, levelRank: NormalRank): boolean {
  for (let i = 1; i < groups.length; i += 1) {
    const prev = tractorRankValue(groups[i - 1][0], trumpSuit, levelRank);
    const current = tractorRankValue(groups[i][0], trumpSuit, levelRank);
    if (current !== prev + 1) return false;
  }
  return true;
}

function validateFollow(
  handBeforePlay: Card[],
  selected: Card[],
  leadShape: PlayShape,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank
) {
  if (selected.length !== leadShape.count) throw new Error(`必须跟 ${leadShape.count} 张牌`);
  if (leadShape.effectiveSuit === 'mixed') return;
  const matchingInHand = handBeforePlay.filter((card) => effectiveSuit(card, trumpSuit, levelRank) === leadShape.effectiveSuit);
  const matchingSelected = selected.filter((card) => effectiveSuit(card, trumpSuit, levelRank) === leadShape.effectiveSuit);
  if (matchingInHand.length >= leadShape.count && matchingSelected.length !== leadShape.count) {
    throw new Error('有同门花色时必须跟同门');
  }
  if (matchingInHand.length < leadShape.count && matchingSelected.length !== matchingInHand.length) {
    throw new Error('同门不够时必须把已有同门全部跟出');
  }
  if (matchingSelected.length === leadShape.count) {
    validateFollowStructure(matchingInHand, matchingSelected, leadShape, trumpSuit, levelRank);
  }
}

function validateFollowStructure(
  matchingInHand: Card[],
  matchingSelected: Card[],
  leadShape: PlayShape,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank
) {
  const requirements = followRequirements(matchingInHand, leadShape, trumpSuit, levelRank);
  const selectedGroups = availableGroupEntries(matchingSelected, trumpSuit, levelRank);
  for (const requirement of requirements) {
    if (requirement.kind === 'tractor') {
      const cards = consumeTractor(selectedGroups, requirement.tupleSize, requirement.tractorLength, trumpSuit, levelRank, false, true);
      if (!cards) throw new Error(`有${formatTractorName(requirement.tupleSize, requirement.tractorLength)}必须跟${formatTractorName(requirement.tupleSize, requirement.tractorLength)}`);
      continue;
    }
    const cards = consumeTupleGroups(selectedGroups, requirement.tupleSize, requirement.groups, trumpSuit, levelRank, false, true);
    if (cards.length !== requirement.tupleSize * requirement.groups) {
      if (requirement.tupleSize >= 3) throw new Error(`有${requirement.tupleSize}张必须跟${requirement.tupleSize}张`);
      throw new Error('有对必须跟对');
    }
  }
}

function followRequirements(
  cards: Card[],
  leadShape: PlayShape,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank
): FollowRequirement[] {
  const requirements: FollowRequirement[] = [];
  const groups = availableGroupEntries(cards, trumpSuit, levelRank);
  const components = [...leadShape.components].sort((a, b) => {
    if (b.tupleSize !== a.tupleSize) return b.tupleSize - a.tupleSize;
    return b.tractorLength - a.tractorLength;
  });

  for (const component of components) {
    if (component.tupleSize < 2) continue;
    let remainingCards = component.count;

    if (component.tractorLength >= 2) {
      const tractor = consumeTractor(groups, component.tupleSize, component.tractorLength, trumpSuit, levelRank, false, true);
      if (tractor) {
        requirements.push({
          kind: 'tractor',
          tupleSize: component.tupleSize,
          tractorLength: component.tractorLength
        });
        continue;
      }
    }

    for (let arity = component.tupleSize; arity >= 2; arity -= 1) {
      const groupsNeeded = Math.floor(remainingCards / arity);
      if (groupsNeeded <= 0) continue;
      const taken = consumeTupleGroups(groups, arity, groupsNeeded, trumpSuit, levelRank, false, true);
      const takenGroups = Math.floor(taken.length / arity);
      if (takenGroups <= 0) continue;
      requirements.push({ kind: 'tuple', tupleSize: arity, groups: takenGroups });
      remainingCards -= takenGroups * arity;
    }
  }

  return requirements;
}

function availableGroupEntries(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): CardGroupEntry[] {
  return groupByLogicalCard(cards, trumpSuit, levelRank).map((group) => ({
    group,
    remaining: [...group]
  }));
}

function consumeTractor(
  entries: CardGroupEntry[],
  tupleSize: number,
  tractorLength: number,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank,
  preferHigh: boolean,
  exactSize = false
): Card[] | null {
  const groups = entries.filter((entry) => exactSize ? entry.remaining.length === tupleSize : entry.remaining.length >= tupleSize);
  const runs: CardGroupEntry[][] = [];
  for (let start = 0; start <= groups.length - tractorLength; start += 1) {
    const run = groups.slice(start, start + tractorLength);
    if (isConsecutiveGroups(run.map((entry) => entry.group), trumpSuit, levelRank)) runs.push(run);
  }
  if (runs.length === 0) return null;
  runs.sort((a, b) => {
    const aStrength = tractorRankValue(a.at(-1)!.group[0], trumpSuit, levelRank);
    const bStrength = tractorRankValue(b.at(-1)!.group[0], trumpSuit, levelRank);
    return preferHigh ? bStrength - aStrength : aStrength - bStrength;
  });
  return runs[0].flatMap((entry) => entry.remaining.splice(0, tupleSize));
}

function consumeTupleGroups(
  entries: CardGroupEntry[],
  tupleSize: number,
  groupsNeeded: number,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank,
  preferHigh: boolean,
  exactSize = false
): Card[] {
  const groups = entries
    .filter((entry) => exactSize ? entry.remaining.length === tupleSize : entry.remaining.length >= tupleSize)
    .sort((a, b) => preferHigh
      ? compareLogicalCards(b.group[0], a.group[0], trumpSuit, levelRank)
      : compareLogicalCards(a.group[0], b.group[0], trumpSuit, levelRank)
    );
  const selected: Card[] = [];
  let remaining = groupsNeeded;
  for (const group of groups) {
    while (group.remaining.length >= tupleSize && remaining > 0) {
      selected.push(...group.remaining.splice(0, tupleSize));
      remaining -= 1;
    }
    if (remaining === 0) break;
  }
  return selected;
}

function selectRequiredFollowCards(
  pool: Card[],
  lead: PlayShape,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank,
  preferHigh: boolean
): Card[] {
  const selected: Card[] = [];
  const requirements = followRequirements(pool, lead, trumpSuit, levelRank);
  const groups = availableGroupEntries(pool, trumpSuit, levelRank);
  for (const requirement of requirements) {
    if (requirement.kind === 'tractor') {
      const tractor = consumeTractor(groups, requirement.tupleSize, requirement.tractorLength, trumpSuit, levelRank, preferHigh, true);
      if (tractor) selected.push(...tractor);
      continue;
    }
    selected.push(...consumeTupleGroups(groups, requirement.tupleSize, requirement.groups, trumpSuit, levelRank, preferHigh, true));
  }
  return selected;
}

function formatTractorName(tupleSize: number, tractorLength: number): string {
  if (tupleSize === 2) return `${tractorLength}连对`;
  return `${tractorLength}连${tupleSize}张`;
}

function completeTrick(state: GameState, trick: Trick) {
  const winner = updateTrickWinner(state, trick);
  player(state, winner).personalPoints += trick.points;
  state.completedTricks.push(trick);
  addEvent(state, 'trick.complete', `${player(state, winner).name} 收下第 ${trick.index} 墩，${trick.points} 分`, {
    winner,
    points: trick.points
  });

  if (state.seats.every((p) => p.hand.length === 0)) {
    finishRound(state);
    return;
  }
  state.currentTrick = newTrick(state.completedTricks.length + 1, winner);
  state.activeSeat = winner;
}

function updateTrickWinner(state: GameState, trick: Trick): SeatIndex {
  if (!state.trumpSuit || !trick.leadShape) throw new Error('牌墩状态错误');
  let winner = trick.plays[0].seat;
  let winningShape = classifyPlay(trick.plays[0].cards, state.trumpSuit, state.dealerLevel);
  for (const play of trick.plays.slice(1)) {
    const shape = classifyPlay(play.cards, state.trumpSuit, state.dealerLevel);
    if (beatsPlay(shape, winningShape, trick.leadShape)) {
      winner = play.seat;
      winningShape = shape;
    }
  }
  trick.winner = winner;
  return winner;
}

function beatsPlay(candidate: PlayShape, current: PlayShape, lead: PlayShape): boolean {
  if (candidate.effectiveSuit === 'mixed') return false;
  if (current.effectiveSuit === 'mixed') return true;
  if (!canCompeteWithLead(candidate, lead)) return false;
  if (candidate.effectiveSuit !== current.effectiveSuit) {
    return candidate.effectiveSuit === 'trump' && lead.effectiveSuit !== 'trump';
  }
  if (candidate.effectiveSuit !== lead.effectiveSuit && current.effectiveSuit === lead.effectiveSuit) return false;
  if (candidate.kind === current.kind &&
      candidate.tupleSize === current.tupleSize &&
      candidate.tractorLength === current.tractorLength) {
    return candidate.strength > current.strength;
  }
  return candidate.strength > current.strength && candidate.count === current.count;
}

function canCompeteWithLead(candidate: PlayShape, lead: PlayShape): boolean {
  if (candidate.count !== lead.count) return false;
  if (lead.kind === 'single') return candidate.kind === 'single';
  if (lead.kind === 'tuple') {
    return candidate.kind === 'tuple' && candidate.tupleSize === lead.tupleSize;
  }
  if (lead.kind === 'tractor') {
    return candidate.kind === 'tractor' &&
      candidate.tupleSize === lead.tupleSize &&
      candidate.tractorLength === lead.tractorLength;
  }
  return coversComponents(candidate.components, lead.components);
}

function coversComponents(candidate: PlayComponent[], lead: PlayComponent[]): boolean {
  for (const component of lead) {
    const count = candidate
      .filter((item) => item.tupleSize >= component.tupleSize)
      .reduce((sum, item) => sum + item.tractorLength, 0);
    if (count < component.tractorLength) return false;
  }
  return true;
}

function detectFriends(state: GameState, seat: SeatIndex, cards: Card[]) {
  for (const card of cards) {
    if (card.suit === 'joker' || card.rank !== 'A') continue;
    state.aceSeen[card.suit] += 1;
    for (const call of state.friendCalls) {
      if (call.matchedBy !== null || call.suit !== card.suit) continue;
      call.seen = state.aceSeen[card.suit];
      if (call.seen >= call.nth) {
        call.matchedBy = seat;
        call.matchedTrick = state.currentTrick?.index ?? null;
        call.pointsAtReveal = player(state, seat).personalPoints;
        addEvent(state, 'friend.reveal', `${player(state, seat).name} 打出第 ${call.nth} 张${call.suit}A，身份暴露`, {
          call,
          temporaryPoints: call.pointsAtReveal
        });
      }
    }
  }
}

function finishRound(state: GameState) {
  const hostTeam = hostTeamSeats(state);
  const attackerTeam = SEATS.filter((seat) => !hostTeam.includes(seat));
  const rawAttackerPoints = attackerTeam.reduce<number>((sum, seat) => sum + player(state, seat).personalPoints, 0);
  const lastTrick = state.completedTricks.at(-1);
  const bottomSaved = !!lastTrick && hostTeam.includes(lastTrick.winner!);
  const kittyPoints = bottomSaved ? 0 : sumPoints(state.kitty);
  const lastTrickCardsPerSeat = lastTrick?.plays[0]?.cards.length ?? 0;
  const kittyMultiplier = bottomSaved || !lastTrick ? 1 : 2 ** lastTrickCardsPerSeat;
  const attackerPoints = rawAttackerPoints + kittyPoints * kittyMultiplier;
  const { outcome, levelDelta, winner } = scoreOutcome(attackerPoints);

  if (winner === 'host') {
    for (const seat of hostTeam) rankUpPlayer(player(state, seat), levelDelta, state.dealerLevel, true);
  } else if (levelDelta > 0) {
    for (const seat of attackerTeam) rankUpPlayer(player(state, seat), levelDelta, state.dealerLevel, false);
  }
  const mandatoryBottomPenalty = applyMandatoryBottomPenalty(state, attackerPoints, bottomSaved, lastTrick);

  const hostDown = attackerPoints >= 240;
  state.previousHostTeam = hostTeam;
  state.previousHostDown = hostDown;
  state.nextDealerSeat = nextDealer(state);
  state.result = {
    attackerPoints,
    rawAttackerPoints,
    kittyPoints,
    kittyMultiplier,
    hostTeam,
    attackerTeam,
    outcome,
    levelDelta,
    nextDealer: state.nextDealerSeat,
    bottomSaved,
    mandatoryBottomPenalty
  };
  state.phase = 'finished';
  state.activeSeat = null;
  state.currentTrick = null;
  addEvent(state, 'round.finish', resultMessage(state), state.result);
}

export function scoreOutcome(attackerPoints: number): { outcome: RoundResult['outcome']; levelDelta: number; winner: 'host' | 'attackers' } {
  if (attackerPoints === 0) return { outcome: 'host-big-shutout', levelDelta: 3, winner: 'host' };
  if (attackerPoints < 120) return { outcome: 'host-small-shutout', levelDelta: 2, winner: 'host' };
  if (attackerPoints < 240) return { outcome: 'host-level-up', levelDelta: 1, winner: 'host' };
  const levelDelta = Math.floor((attackerPoints - 240) / 120);
  if (levelDelta <= 0) return { outcome: 'attackers-down', levelDelta: 0, winner: 'attackers' };
  return { outcome: 'attackers-level-up', levelDelta, winner: 'attackers' };
}

function applyMandatoryBottomPenalty(
  state: GameState,
  attackerPoints: number,
  bottomSaved: boolean,
  lastTrick: Trick | undefined
): RoundResult['mandatoryBottomPenalty'] {
  if (attackerPoints < 240 || bottomSaved || !lastTrick || state.dealerSeat === null || !state.trumpSuit) return null;
  if (state.dealerLevel !== 'J' && state.dealerLevel !== 'A') return null;

  const rank = state.dealerLevel;
  const trickCards = lastTrick.plays.flatMap((play) => play.cards);
  const mainHits = state.trumpSuit === 'no-trump' ? [] : trickCards.filter((card) => card.suit === state.trumpSuit && card.rank === rank);
  const offHits = trickCards.filter((card) => card.suit !== 'joker' && card.suit !== state.trumpSuit && card.rank === rank);
  const kind = mainHits.length > 0 ? 'main' : offHits.length > 0 ? 'off' : null;
  if (!kind) return null;

  const target = fixedMandatoryPenaltyTarget(rank, kind);
  const affected = hostTeamSeats(state).flatMap((seat) => {
    const teammate = player(state, seat);
    const from = teammate.level;
    const to = mandatoryPenaltyTargetForPlayer(rank, kind, from);
    if (!shouldDropToTarget(from, to)) return [];
    teammate.level = to;
    resetMandatoryFlagsAfterDrop(teammate, to);
    return [{ seat, from, to }];
  });

  return {
    rank,
    kind,
    target,
    affected,
    cardIds: (kind === 'main' ? mainHits : offHits).map((card) => card.id)
  };
}

function fixedMandatoryPenaltyTarget(rank: 'J' | 'A', kind: 'main' | 'off'): NormalRank | null {
  if (rank === 'J') return kind === 'main' ? '7' : null;
  return kind === 'main' ? 'J' : 'K';
}

function mandatoryPenaltyTargetForPlayer(rank: 'J' | 'A', kind: 'main' | 'off', from: NormalRank): NormalRank {
  if (rank === 'J' && kind === 'off') return offJPenaltyTarget(from);
  const target = fixedMandatoryPenaltyTarget(rank, kind);
  if (!target) return from;
  return target;
}

function offJPenaltyTarget(from: NormalRank): NormalRank {
  const targets: Record<NormalRank, NormalRank> = {
    '2': '2',
    '3': '3',
    '4': '4',
    '5': '5',
    '6': '6',
    '7': '7',
    '8': '7',
    '9': '7',
    '10': '8',
    J: '9',
    Q: '9',
    K: '10',
    A: 'J'
  };
  return targets[from];
}

function shouldDropToTarget(from: NormalRank, target: NormalRank): boolean {
  return LEVEL_ORDER.indexOf(from) > LEVEL_ORDER.indexOf(target);
}

function resetMandatoryFlagsAfterDrop(p: PlayerState, level: NormalRank) {
  const targetIndex = LEVEL_ORDER.indexOf(level);
  if (targetIndex <= LEVEL_ORDER.indexOf('J')) p.passedMandatory.J = false;
  if (targetIndex <= LEVEL_ORDER.indexOf('A')) p.passedMandatory.A = false;
}

function rankUpPlayer(p: PlayerState, delta: number, tableLevel: NormalRank, wonAsHostTeam: boolean) {
  if ((tableLevel === 'J' || tableLevel === 'A') && p.level === tableLevel && wonAsHostTeam) {
    p.passedMandatory[tableLevel] = true;
  }
  for (let i = 0; i < delta; i += 1) {
    if ((p.level === 'J' || p.level === 'A') && !p.passedMandatory[p.level]) return;
    const next = rankUpOne(p.level);
    p.level = next;
    if ((next === 'J' || next === 'A') && !p.passedMandatory[next]) return;
  }
}

function resultMessage(state: GameState): string {
  const result = state.result;
  if (!result) return '本局结束';
  const prefix = `闲家共 ${result.attackerPoints} 分`;
  const penalty = result.mandatoryBottomPenalty ? `，${mandatoryPenaltyMessage(state, result.mandatoryBottomPenalty)}` : '';
  if (result.outcome === 'host-big-shutout') return `${prefix}，大光，庄家队升3级${penalty}`;
  if (result.outcome === 'host-small-shutout') return `${prefix}，小光，庄家队升2级${penalty}`;
  if (result.outcome === 'host-level-up') return `${prefix}，庄家队升1级${penalty}`;
  if (result.outcome === 'attackers-down') return `${prefix}，闲家下台不升级${penalty}`;
  return `${prefix}，闲家升 ${result.levelDelta} 级${penalty}`;
}

function mandatoryPenaltyMessage(state: GameState, penalty: NonNullable<RoundResult['mandatoryBottomPenalty']>) {
  const affected = penalty.affected.map((item) => `${player(state, item.seat).name}${item.from}->${item.to}`).join('、');
  const target = penalty.target ? `打回 ${penalty.target}` : '按个人级数打回';
  return `${penalty.kind === 'main' ? '主' : '副'}${penalty.rank}抠底，庄家队${target}${affected ? `（${affected}）` : ''}`;
}

export function hostTeamSeats(state: GameState): SeatIndex[] {
  const seats = new Set<SeatIndex>();
  if (state.dealerSeat !== null) seats.add(state.dealerSeat);
  for (const call of state.friendCalls) {
    if (call.matchedBy !== null) seats.add(call.matchedBy);
  }
  return [...seats].sort((a, b) => a - b) as SeatIndex[];
}

export function sumPoints(cards: Card[]): number {
  return cards.reduce((sum, card) => sum + pointValue(card), 0);
}

function nextSeat(seat: SeatIndex): SeatIndex {
  return ((seat + 1) % PLAYER_COUNT) as SeatIndex;
}

export function legalCardsForSimplePlay(state: GameState, seat: SeatIndex): Card[] {
  const p = player(state, seat);
  if (state.phase !== 'playing' || state.activeSeat !== seat || !state.currentTrick || !state.trumpSuit) return [];
  if (state.currentTrick.plays.length === 0) return chooseLeadCards(p.hand, state.trumpSuit, state.dealerLevel);
  const lead = state.currentTrick.leadShape!;
  const matching = p.hand.filter((card) => lead.effectiveSuit !== 'mixed' && effectiveSuit(card, state.trumpSuit!, state.dealerLevel) === lead.effectiveSuit);
  if (matching.length >= lead.count) {
    return chooseCardsForLeadShape(matching, lead, state.trumpSuit, state.dealerLevel, state.currentTrick.points > 0);
  }
  if (matching.length > 0) {
    const rest = lowestCards(withoutIds(p.hand, matching.map((card) => card.id)), lead.count - matching.length, state.trumpSuit, state.dealerLevel);
    return [...matching, ...rest];
  }
  const trumps = p.hand.filter((card) => effectiveSuit(card, state.trumpSuit!, state.dealerLevel) === 'trump');
  if (trumps.length >= lead.count && state.currentTrick.points > 0) {
    const kill = chooseCardsForLeadShape(trumps, lead, state.trumpSuit, state.dealerLevel, true);
    const killShape = classifyPlay(kill, state.trumpSuit, state.dealerLevel);
    if (canCompeteWithLead(killShape, lead)) return kill;
  }
  return lowestCards(p.hand, lead.count, state.trumpSuit, state.dealerLevel);
}

function chooseLeadCards(hand: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): Card[] {
  const candidates: Card[][] = [];
  for (const suit of ['trump', ...NORMAL_SUITS] as EffectiveSuit[]) {
    const pool = hand.filter((card) => effectiveSuit(card, trumpSuit, levelRank) === suit);
    if (pool.length === 0) continue;
    for (const tupleSize of TUPLE_SIZES_DESC) {
      for (let tractorLength = Math.floor(pool.length / tupleSize); tractorLength >= 2; tractorLength -= 1) {
        const tractor = findTractorSelection(pool, trumpSuit, levelRank, tupleSize, tractorLength, true);
        if (tractor) candidates.push(tractor);
      }
      const tuple = selectTupleGroups(pool, trumpSuit, levelRank, tupleSize, 1, true);
      if (tuple.length === tupleSize) candidates.push(tuple);
    }
  }
  candidates.push(...hand.map((card) => [card]));
  return candidates
    .map((cards) => ({ cards, score: leadCandidateScore(cards, trumpSuit, levelRank) }))
    .sort((a, b) => b.score - a.score)[0]?.cards ?? [sortCards(hand, trumpSuit, levelRank)[0]];
}

function leadCandidateScore(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): number {
  const shape = classifyPlay(cards, trumpSuit, levelRank);
  const structure = shape.kind === 'tractor' ? 90 : shape.kind === 'tuple' ? 40 : 0;
  return sumPoints(cards) * 15 + structure + shape.count * 3 + shape.strength / 100;
}

function chooseCardsForLeadShape(
  pool: Card[],
  lead: PlayShape,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank,
  preferHigh: boolean
): Card[] {
  const selected = selectRequiredFollowCards(pool, lead, trumpSuit, levelRank, preferHigh);
  if (selected.length < lead.count) {
    const rest = fillCardsForLeadShape(
      withoutIds(pool, selected.map((card) => card.id)),
      lead,
      lead.count - selected.length,
      trumpSuit,
      levelRank,
      preferHigh
    );
    selected.push(...rest);
  }
  return selected.slice(0, lead.count);
}

function fillCardsForLeadShape(
  pool: Card[],
  lead: PlayShape,
  count: number,
  trumpSuit: TrumpSuit,
  levelRank: NormalRank,
  preferHigh: boolean
): Card[] {
  const maxRequiredTuple = Math.max(lead.tupleSize, ...lead.components.map((component) => component.tupleSize));
  const unprotected = groupByLogicalCard(pool, trumpSuit, levelRank)
    .filter((group) => group.length <= maxRequiredTuple)
    .flat();
  const fillPool = unprotected.length >= count ? unprotected : pool;
  return preferHigh
    ? highestCards(fillPool, count, trumpSuit, levelRank)
    : lowestCards(fillPool, count, trumpSuit, levelRank);
}

function selectTupleGroups(
  pool: Card[],
  trumpSuit: TrumpSuit,
  levelRank: NormalRank,
  tupleSize: number,
  groupsNeeded: number,
  preferHigh: boolean
): Card[] {
  const groups = groupByLogicalCard(pool, trumpSuit, levelRank)
    .filter((group) => group.length >= tupleSize)
    .sort((a, b) => preferHigh
      ? compareLogicalCards(b[0], a[0], trumpSuit, levelRank)
      : compareLogicalCards(a[0], b[0], trumpSuit, levelRank)
    );
  const selected: Card[] = [];
  let remaining = groupsNeeded;
  for (const group of groups) {
    const chunks = Math.floor(group.length / tupleSize);
    for (let i = 0; i < chunks && remaining > 0; i += 1) {
      selected.push(...group.slice(i * tupleSize, i * tupleSize + tupleSize));
      remaining -= 1;
    }
    if (remaining === 0) break;
  }
  return selected;
}

function findTractorSelection(
  pool: Card[],
  trumpSuit: TrumpSuit,
  levelRank: NormalRank,
  tupleSize: number,
  tractorLength: number,
  preferHigh: boolean
): Card[] | null {
  const groups = groupByLogicalCard(pool, trumpSuit, levelRank).filter((group) => group.length >= tupleSize);
  const runs: Card[][][] = [];
  for (let start = 0; start <= groups.length - tractorLength; start += 1) {
    const run = groups.slice(start, start + tractorLength);
    if (isConsecutiveGroups(run, trumpSuit, levelRank)) runs.push(run);
  }
  if (runs.length === 0) return null;
  runs.sort((a, b) => {
    const aStrength = tractorRankValue(a.at(-1)![0], trumpSuit, levelRank);
    const bStrength = tractorRankValue(b.at(-1)![0], trumpSuit, levelRank);
    return preferHigh ? bStrength - aStrength : aStrength - bStrength;
  });
  return runs[0].flatMap((group) => group.slice(0, tupleSize));
}

function lowestCards(cards: Card[], count: number, trumpSuit: TrumpSuit, levelRank: NormalRank): Card[] {
  return sortCards(cards, trumpSuit, levelRank).slice(0, count);
}

function highestCards(cards: Card[], count: number, trumpSuit: TrumpSuit, levelRank: NormalRank): Card[] {
  return sortCards(cards, trumpSuit, levelRank).slice(-count);
}

function withoutIds(cards: Card[], ids: string[]): Card[] {
  const removed = new Set(ids);
  return cards.filter((card) => !removed.has(card.id));
}

export function cardsByIds(state: GameState, seat: SeatIndex, ids: string[]): Card[] {
  return getCardsByIds(player(state, seat).hand, ids);
}

export function mustCallBeforePlay(state: GameState): boolean {
  return state.phase === 'friend-call';
}

export function isMandatoryRank(rank: NormalRank): rank is 'J' | 'A' {
  return rank === 'J' || rank === 'A';
}

export function levelOrder(): NormalRank[] {
  return [...LEVEL_ORDER];
}
