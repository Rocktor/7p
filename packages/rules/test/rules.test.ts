import { describe, expect, it } from 'vitest';
import {
  type Card,
  type FriendCall,
  type GameState,
  type NormalRank,
  type SeatIndex,
  badDecisionLines,
  classifyPlay,
  createGame,
  decideBotIntent,
  dispatch,
  effectiveRankValue,
  effectiveSuit,
  hostTeamSeats,
  legalCardsForSimplePlay,
  parseTrumpBid,
  scoreOutcome,
  sumPoints,
  trumpBidStrength
} from '../src/index.js';

function fillBots(state: GameState): GameState {
  let next = state;
  for (let seat = 0; seat < 7; seat += 1) {
    next = dispatch(next, { type: 'toggle-bot', seat: seat as never, enabled: true }).state;
  }
  return next;
}

function startSeeded(seed = 'test'): GameState {
  let state = fillBots(createGame('test'));
  state = dispatch(state, { type: 'start-game', seed }).state;
  return state;
}

function forceBidCards(state: GameState, seat: number): Card[] {
  return [
    { id: 'manual-joker-1', deck: 0, suit: 'joker', rank: 'SJ' },
    { id: 'manual-joker-2', deck: 1, suit: 'joker', rank: 'BJ' },
    { id: 'manual-level-1', deck: 0, suit: 'hearts', rank: state.dealerLevel }
  ] as Card[];
}

function manualBidCards(prefix: string, suit: Card['suit'], levelRank: Card['rank'], levelCount = 1): Card[] {
  return [
    { id: `${prefix}-joker-1`, deck: 0, suit: 'joker', rank: 'SJ' },
    { id: `${prefix}-joker-2`, deck: 1, suit: 'joker', rank: 'BJ' },
    ...Array.from({ length: levelCount }, (_, index) => ({
      id: `${prefix}-level-${index + 1}`,
      deck: index,
      suit,
      rank: levelRank
    }))
  ] as Card[];
}

function noTrumpBidCards(prefix: string, extraRank: 'SJ' | 'BJ', extraCount: number): Card[] {
  return [
    { id: `${prefix}-cat-sj`, deck: 0, suit: 'joker', rank: 'SJ' },
    { id: `${prefix}-cat-bj`, deck: 0, suit: 'joker', rank: 'BJ' },
    ...Array.from({ length: extraCount }, (_, index) => ({
      id: `${prefix}-extra-${extraRank}-${index + 1}`,
      deck: index + 1,
      suit: 'joker',
      rank: extraRank
    }))
  ] as Card[];
}

function pair(prefix: string, suit: Card['suit'], rank: Card['rank']): Card[] {
  return [0, 1].map((deck) => ({ id: `${prefix}-${deck}`, deck, suit, rank })) as Card[];
}

function stateBeforeMandatoryBottomPenalty(rank: 'J' | 'A', finalCard: Card): GameState {
  const state = createGame(`mandatory-bottom-${rank}-${finalCard.suit}`);
  state.phase = 'playing';
  state.dealerSeat = 0;
  state.trumpSuit = 'spades';
  state.dealerLevel = rank;
  state.kitty = [];
  state.seats[0].level = rank;
  state.seats[2].level = rank;
  state.friendCalls = [{
    id: 'matched-friend',
    suit: 'clubs',
    nth: 1,
    seen: 1,
    matchedBy: 2,
    matchedTrick: 1,
    pointsAtReveal: 0
  } satisfies FriendCall];
  state.seats[1].personalPoints = 240;
  for (let seat = 0; seat < 7; seat += 1) state.seats[seat].hand = [];

  const lead = { id: `lead-${rank}`, deck: 0, suit: 'clubs', rank: '2' } as Card;
  state.currentTrick = {
    index: 45,
    leader: 2,
    plays: [
      { seat: 2, cards: [lead] },
      { seat: 3, cards: [{ id: `m-${rank}-3`, deck: 0, suit: 'clubs', rank: '3' } as Card] },
      { seat: 4, cards: [{ id: `m-${rank}-4`, deck: 0, suit: 'clubs', rank: '4' } as Card] },
      { seat: 5, cards: [{ id: `m-${rank}-5`, deck: 0, suit: 'clubs', rank: '6' } as Card] },
      { seat: 6, cards: [{ id: `m-${rank}-6`, deck: 0, suit: 'clubs', rank: '8' } as Card] },
      { seat: 0, cards: [{ id: `m-${rank}-0`, deck: 0, suit: 'clubs', rank: '9' } as Card] }
    ],
    leadShape: classifyPlay([lead], 'spades', rank),
    winner: null,
    points: 0
  };
  state.activeSeat = 1;
  state.seats[1].hand = [finalCard];
  return state;
}

describe('7人6副牌找朋友规则', () => {
  it('玩家必须先离席才能换座，离席后由AI接管', () => {
    let state = createGame('seat-flow');
    state = dispatch(state, { type: 'sit', seat: 0, userId: 'u1', name: '玩家A' }).state;

    expect(() => dispatch(state, { type: 'sit', seat: 1, userId: 'u1', name: '玩家A' })).toThrow(/先离席/);
    expect(() => dispatch(state, { type: 'toggle-bot', seat: 0, enabled: true })).toThrow(/先离席/);

    state = dispatch(state, { type: 'leave-seat', seat: 0, userId: 'u1' }).state;
    expect(state.seats[0]).toMatchObject({ userId: null, isBot: true, name: 'AI-1' });

    state = dispatch(state, { type: 'sit', seat: 1, userId: 'u1', name: '玩家A' }).state;
    expect(state.seats[1]).toMatchObject({ userId: 'u1', isBot: false, name: '玩家A' });
  });

  it('牌局中离席会保留手牌并交给AI继续接管', () => {
    const state = createGame('leave-during-play');
    const hand = [{ id: 'held-card', deck: 0, suit: 'spades', rank: '7' } as Card];
    state.phase = 'playing';
    state.activeSeat = 0;
    state.seats[0].userId = 'u1';
    state.seats[0].name = '玩家A';
    state.seats[0].hand = hand;

    const result = dispatch(state, { type: 'leave-seat', seat: 0, userId: 'u1' }).state;

    expect(result.seats[0]).toMatchObject({ userId: null, isBot: true, name: 'AI-1' });
    expect(result.seats[0].hand).toEqual(hand);
    expect(result.activeSeat).toBe(0);
  });

  it('发7人各45张，底牌9张，首轮随机庄家打自己的级', () => {
    const state = startSeeded('deal');
    expect(state.phase).toBe('bidding');
    expect(state.kitty).toHaveLength(9);
    expect(state.seats.every((seat) => seat.hand.length === 45)).toBe(true);
    expect(state.dealerSeat).not.toBeNull();
    expect(state.dealerLevel).toBe('7');
  });

  it('亮主必须两王带同花级牌，且同张数按黑红梅方反', () => {
    const state = startSeeded('bid');
    const bid = parseTrumpBid(forceBidCards(state, 0), 0, state.dealerLevel);
    expect(bid.suit).toBe('hearts');
    expect(bid.levelCardCount).toBe(1);
    expect(bid.jokerCount).toBe(2);
    expect(bid.cards.map((card) => card.id)).toEqual(bid.cardIds);

    const weaker = [
      { id: 'w1', deck: 0, suit: 'joker', rank: 'SJ' },
      { id: 'w2', deck: 1, suit: 'joker', rank: 'BJ' },
      { id: 'w3', deck: 0, suit: 'diamonds', rank: state.dealerLevel }
    ] as Card[];
    expect(parseTrumpBid(weaker, 1, state.dealerLevel).suit).toBe('diamonds');
  });

  it('无主用2猫加同类王反同张数级牌，少一张压不过', () => {
    const state = startSeeded('no-trump-bid');
    const suited = parseTrumpBid(manualBidCards('suited', 'spades', state.dealerLevel, 3), 0, state.dealerLevel);
    const noTrump = parseTrumpBid(noTrumpBidCards('nt', 'SJ', 3), 1, state.dealerLevel);
    const weakNoTrump = parseTrumpBid(noTrumpBidCards('weak-nt', 'BJ', 2), 2, state.dealerLevel);

    expect(noTrump.suit).toBe('no-trump');
    expect(noTrump.levelCardCount).toBe(3);
    expect(noTrump.noTrumpRank).toBe('SJ');
    expect(trumpBidStrength(noTrump)).toBeGreaterThan(trumpBidStrength(suited));
    expect(trumpBidStrength(weakNoTrump)).toBeLessThan(trumpBidStrength(suited));
    expect(() => parseTrumpBid(noTrumpBidCards('bare-nt', 'SJ', 0), 3, state.dealerLevel)).toThrow(/同类小王或大王/);
    expect(() => parseTrumpBid([
      { id: 'mix-sj-1', deck: 0, suit: 'joker', rank: 'SJ' },
      { id: 'mix-bj-1', deck: 0, suit: 'joker', rank: 'BJ' },
      { id: 'mix-sj-2', deck: 1, suit: 'joker', rank: 'SJ' },
      { id: 'mix-bj-2', deck: 1, suit: 'joker', rank: 'BJ' }
    ] as Card[], 4, state.dealerLevel)).toThrow(/同一种王/);
  });

  it('无主时级牌仍是常主，但不存在主花色级牌加成', () => {
    const spadeNine = { id: 's9', deck: 0, suit: 'spades', rank: '9' } as Card;
    const heartNine = { id: 'h9', deck: 0, suit: 'hearts', rank: '9' } as Card;

    expect(effectiveSuit(spadeNine, 'spades', '9')).toBe('trump');
    expect(effectiveRankValue(spadeNine, 'spades', '9')).toBeGreaterThan(effectiveRankValue(heartNine, 'spades', '9'));
    expect(effectiveSuit(spadeNine, 'no-trump', '9')).toBe('trump');
    expect(effectiveSuit(heartNine, 'no-trump', '9')).toBe('trump');
    expect(effectiveRankValue(spadeNine, 'no-trump', '9')).toBe(effectiveRankValue(heartNine, 'no-trump', '9'));
  });

  it('一墩未结束时实时记录当前最大出牌座位', () => {
    let state = createGame('current-trick-winner');
    state.phase = 'playing';
    state.dealerSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '9';
    state.activeSeat = 0;
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [],
      leadShape: null,
      winner: null,
      points: 0
    };
    state.seats[0].hand = [
      { id: 'lead-7-1', deck: 0, suit: 'clubs', rank: '7' },
      { id: 'lead-7-2', deck: 1, suit: 'clubs', rank: '7' }
    ] as Card[];
    state.seats[1].hand = [
      { id: 'follow-j-1', deck: 0, suit: 'clubs', rank: 'J' },
      { id: 'follow-j-2', deck: 1, suit: 'clubs', rank: 'J' }
    ] as Card[];

    state = dispatch(state, { type: 'play', seat: 0, cardIds: state.seats[0].hand.map((card) => card.id) }).state;
    expect(state.currentTrick?.winner).toBe(0);

    state = dispatch(state, { type: 'play', seat: 1, cardIds: state.seats[1].hand.map((card) => card.id) }).state;
    expect(state.currentTrick?.winner).toBe(1);
  });

  it('亮主后庄家立即拿底，不存在亮主后的继续等待阶段', () => {
    let state = startSeeded('bid-immediate-bury');
    const dealer = state.dealerSeat!;
    const originalKittyIds = state.kitty.map((card) => card.id);
    const bidCards = forceBidCards(state, dealer);
    state.seats[dealer].hand.push(...bidCards);
    state = dispatch(state, { type: 'bid', seat: dealer, cardIds: bidCards.map((card) => card.id) }).state;
    expect(state.phase).toBe('bury');
    expect(state.bottomOwner).toBe(dealer);
    expect(state.kitty).toHaveLength(0);
    expect(state.pickedKittyCardIds).toEqual(originalKittyIds);
    expect(originalKittyIds.every((id) => state.seats[dealer].hand.some((card) => card.id === id))).toBe(true);
    expect(state.seats[dealer].hand).toHaveLength(57);
    expect(state.currentBid?.cards.map((card) => card.id)).toEqual(bidCards.map((card) => card.id));
    expect(state.events.at(-2)?.message).toContain('亮主为');
    expect(state.events.at(-2)?.message).toContain('张王');
    expect(state.events.at(-1)?.message).toContain('拿起9张底牌');
  });

  it('亮主从庄家开始顺序推进，不亮者退出后续反底行列', () => {
    let state = startSeeded('bid-order-eligibility');
    const dealer = state.dealerSeat!;
    const next = ((dealer + 1) % 7) as SeatIndex;
    const nextBid = forceBidCards(state, next);
    state.seats[next].hand.push(...nextBid);

    expect(() => dispatch(state, { type: 'bid', seat: next, cardIds: nextBid.map((card) => card.id) })).toThrow(/还没轮到.*亮主/);

    state = dispatch(state, { type: 'pass-counter', seat: dealer }).state;
    expect(state.activeSeat).toBe(next);
    expect(state.bidPasses).toContain(dealer);
    expect(state.counterEligibleSeats).not.toContain(dealer);

    state = dispatch(state, { type: 'bid', seat: next, cardIds: nextBid.map((card) => card.id) }).state;
    const dealerBury = state.seats[dealer].hand.filter((card) => card.rank !== 'A').slice(0, 9);
    state = dispatch(state, { type: 'bury', seat: dealer, cardIds: dealerBury.map((card) => card.id) }).state;

    expect(state.phase).toBe('counter');
    expect(state.counterEligibleSeats).not.toContain(dealer);
    expect(() => dispatch(state, { type: 'bid', seat: dealer, cardIds: [] })).toThrow(/不在反底行列/);
  });

  it('每次反底都必须拿当前9张底牌并扣回9张，之后才能继续反底', () => {
    let state = startSeeded('counter-chain');
    const dealer = state.dealerSeat!;
    const firstBid = manualBidCards('first', 'hearts', state.dealerLevel, 1);
    state.seats[dealer].hand.push(...firstBid);
    state = dispatch(state, { type: 'bid', seat: dealer, cardIds: firstBid.map((card) => card.id) }).state;

    const dealerBury = state.seats[dealer].hand.filter((card) => card.rank !== 'A').slice(0, 9);
    state = dispatch(state, { type: 'bury', seat: dealer, cardIds: dealerBury.map((card) => card.id) }).state;
    expect(state.phase).toBe('counter');
    expect(state.kitty).toHaveLength(9);
    expect(state.pickedKittyCardIds).toEqual([]);

    const counterSeatOne = state.activeSeat!;
    const secondBid = manualBidCards('second', 'spades', state.dealerLevel, 1);
    state.seats[counterSeatOne].hand.push(...secondBid);
    const seatOneHandBefore = state.seats[counterSeatOne].hand.length;
    const counterOneKittyIds = state.kitty.map((card) => card.id);
    state = dispatch(state, { type: 'bid', seat: counterSeatOne, cardIds: secondBid.map((card) => card.id) }).state;
    expect(state.phase).toBe('bury');
    expect(state.bottomOwner).toBe(counterSeatOne);
    expect(state.kitty).toHaveLength(0);
    expect(state.pickedKittyCardIds).toEqual(counterOneKittyIds);
    expect(state.seats[counterSeatOne].hand).toHaveLength(seatOneHandBefore + 9);
    expect(state.events.at(-1)?.message).toContain('反底为');

    const seatOneBury = state.seats[counterSeatOne].hand.filter((card) => card.rank !== 'A').slice(0, 9);
    state = dispatch(state, { type: 'bury', seat: counterSeatOne, cardIds: seatOneBury.map((card) => card.id) }).state;
    expect(state.phase).toBe('counter');
    expect(state.kitty).toHaveLength(9);
    expect(state.pickedKittyCardIds).toEqual([]);

    const counterSeatTwo = state.activeSeat!;
    const thirdBid = manualBidCards('third', 'diamonds', state.dealerLevel, 2);
    state.seats[counterSeatTwo].hand.push(...thirdBid);
    const seatTwoHandBefore = state.seats[counterSeatTwo].hand.length;
    const counterTwoKittyIds = state.kitty.map((card) => card.id);
    state = dispatch(state, { type: 'bid', seat: counterSeatTwo, cardIds: thirdBid.map((card) => card.id) }).state;
    expect(state.phase).toBe('bury');
    expect(state.bottomOwner).toBe(counterSeatTwo);
    expect(state.kitty).toHaveLength(0);
    expect(state.pickedKittyCardIds).toEqual(counterTwoKittyIds);
    expect(state.seats[counterSeatTwo].hand).toHaveLength(seatTwoHandBefore + 9);
  });

  it('扣底阶段禁止扣任何A', () => {
    let state = startSeeded('bury-a');
    const dealer = state.dealerSeat!;
    state.seats[dealer].hand.push(...forceBidCards(state, dealer));
    state = dispatch(state, { type: 'bid', seat: dealer, cardIds: forceBidCards(state, dealer).map((card) => card.id) }).state;
    const hand = state.seats[dealer].hand;
    const ace = hand.find((card) => card.rank === 'A')!;
    const nonA = hand.filter((card) => card.rank !== 'A').slice(0, 8);
    expect(() => dispatch(state, { type: 'bury', seat: dealer, cardIds: [ace, ...nonA].map((card) => card.id) })).toThrow(/A/);
  });

  it('支持叫某花色第N张A，打出对应A后朋友暴露并追溯暂存分', () => {
    let state = startSeeded('friend');
    const dealer = state.dealerSeat!;
    state.trumpSuit = 'spades';
    state.phase = 'friend-call';
    state.activeSeat = dealer;
    state = dispatch(state, {
      type: 'call-friends',
      seat: dealer,
      calls: [
        { suit: 'hearts', nth: 1 },
        { suit: 'clubs', nth: 2 }
      ]
    }).state;
    const friendSeat = ((dealer + 1) % 7) as never;
    const ace = state.seats[friendSeat].hand.find((card) => card.suit === 'hearts' && card.rank === 'A');
    if (!ace) return;
    state.activeSeat = friendSeat;
    state.currentTrick = {
      index: 1,
      leader: friendSeat,
      plays: [],
      leadShape: null,
      winner: null,
      points: 0
    };
    state.seats[friendSeat].personalPoints = 25;
    state = dispatch(state, { type: 'play', seat: friendSeat, cardIds: [ace.id] }).state;
    expect(state.friendCalls[0].matchedBy).toBe(friendSeat);
    expect(state.friendCalls[0].pointsAtReveal).toBe(25);
    expect(hostTeamSeats(state)).toContain(friendSeat);
  });

  it('叫朋友不能叫主花色A', () => {
    const state = startSeeded('friend-no-trump-ace');
    const dealer = state.dealerSeat!;
    state.trumpSuit = 'spades';
    state.phase = 'friend-call';
    state.activeSeat = dealer;
    expect(() => dispatch(state, {
      type: 'call-friends',
      seat: dealer,
      calls: [
        { suit: 'spades', nth: 1 },
        { suit: 'hearts', nth: 2 }
      ]
    })).toThrow(/主花色A/);
  });

  it('三连对和四张会被识别成结构化牌型', () => {
    const pairTractor = [
      { id: 'a', deck: 0, suit: 'clubs', rank: '3' },
      { id: 'b', deck: 1, suit: 'clubs', rank: '3' },
      { id: 'c', deck: 0, suit: 'clubs', rank: '4' },
      { id: 'd', deck: 1, suit: 'clubs', rank: '4' },
      { id: 'e', deck: 0, suit: 'clubs', rank: '5' },
      { id: 'f', deck: 1, suit: 'clubs', rank: '5' }
    ] as Card[];
    expect(classifyPlay(pairTractor, 'spades', '7').kind).toBe('tractor');

    const quad = [
      { id: 'q1', deck: 0, suit: 'hearts', rank: '9' },
      { id: 'q2', deck: 1, suit: 'hearts', rank: '9' },
      { id: 'q3', deck: 2, suit: 'hearts', rank: '9' },
      { id: 'q4', deck: 3, suit: 'hearts', rank: '9' }
    ] as Card[];
    const shape = classifyPlay(quad, 'spades', '7');
    expect(shape.kind).toBe('tuple');
    expect(shape.tupleSize).toBe(4);
  });

  it('打J黑桃主时，主牌拖拉机跳过J并连接副J、主J和大小猫', () => {
    const cards = [
      ...pair('s10', 'spades', '10'),
      ...pair('sq', 'spades', 'Q'),
      ...pair('sk', 'spades', 'K'),
      ...pair('sa', 'spades', 'A'),
      { id: 'off-j-heart', deck: 0, suit: 'hearts', rank: 'J' },
      { id: 'off-j-club', deck: 0, suit: 'clubs', rank: 'J' },
      ...pair('main-j', 'spades', 'J'),
      ...pair('small-joker', 'joker', 'SJ'),
      ...pair('big-joker', 'joker', 'BJ')
    ] as Card[];

    const shape = classifyPlay(cards, 'spades', 'J');

    expect(shape.kind).toBe('tractor');
    expect(shape.effectiveSuit).toBe('trump');
    expect(shape.tupleSize).toBe(2);
    expect(shape.tractorLength).toBe(8);
  });

  it('打J时副牌拖拉机也会跳过J连接10、Q、K、A', () => {
    const cards = [
      ...pair('h10', 'hearts', '10'),
      ...pair('hq', 'hearts', 'Q'),
      ...pair('hk', 'hearts', 'K'),
      ...pair('ha', 'hearts', 'A')
    ] as Card[];

    const shape = classifyPlay(cards, 'spades', 'J');

    expect(shape.kind).toBe('tractor');
    expect(shape.effectiveSuit).toBe('hearts');
    expect(shape.tupleSize).toBe(2);
    expect(shape.tractorLength).toBe(4);
  });

  it('AI首出能按当前打J识别并打出跳J副牌拖拉机', () => {
    const state = createGame('ai-j-tractor-lead');
    state.phase = 'playing';
    state.dealerSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = 'J';
    state.activeSeat = 0;
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [],
      leadShape: null,
      winner: null,
      points: 0
    };
    const tractor = [
      ...pair('h10-ai', 'hearts', '10'),
      ...pair('hq-ai', 'hearts', 'Q'),
      ...pair('hk-ai', 'hearts', 'K'),
      ...pair('ha-ai', 'hearts', 'A')
    ] as Card[];
    state.seats[0].isBot = true;
    state.seats[0].hand = [
      ...tractor,
      { id: 'c2-ai', deck: 0, suit: 'clubs', rank: '2' },
      { id: 'd3-ai', deck: 0, suit: 'diamonds', rank: '3' }
    ] as Card[];
    for (let seat = 1; seat < 7; seat += 1) {
      state.seats[seat].hand = [{ id: `other-c2-${seat}`, deck: seat, suit: 'clubs', rank: '2' } as Card];
    }

    const intent = decideBotIntent(state, 0);

    expect(intent?.type).toBe('play');
    if (intent?.type !== 'play') return;
    const selected = state.seats[0].hand.filter((card) => intent.cardIds.includes(card.id));
    const shape = classifyPlay(selected, 'spades', 'J');
    expect(new Set(intent.cardIds)).toEqual(new Set(tractor.map((card) => card.id)));
    expect(shape.kind).toBe('tractor');
    expect(shape.effectiveSuit).toBe('hearts');
    expect(shape.tractorLength).toBe(4);
  });

  it('抠底按末墩每家出牌张数算2的N次方倍数，双抠是4倍', () => {
    const kitty = [
      { id: 'k1', deck: 0, suit: 'clubs', rank: '5' },
      { id: 'k2', deck: 1, suit: 'clubs', rank: '10' }
    ] as Card[];
    expect(sumPoints(kitty) * 2 ** 2).toBe(60);
  });

  it('计分分档按0分大光、1到119小光、120到239庄家升1级、240下台不升级', () => {
    expect(scoreOutcome(0)).toEqual({ outcome: 'host-big-shutout', levelDelta: 3, winner: 'host' });
    expect(scoreOutcome(1)).toEqual({ outcome: 'host-small-shutout', levelDelta: 2, winner: 'host' });
    expect(scoreOutcome(59)).toEqual({ outcome: 'host-small-shutout', levelDelta: 2, winner: 'host' });
    expect(scoreOutcome(119)).toEqual({ outcome: 'host-small-shutout', levelDelta: 2, winner: 'host' });
    expect(scoreOutcome(120)).toEqual({ outcome: 'host-level-up', levelDelta: 1, winner: 'host' });
    expect(scoreOutcome(239)).toEqual({ outcome: 'host-level-up', levelDelta: 1, winner: 'host' });
    expect(scoreOutcome(240)).toEqual({ outcome: 'attackers-down', levelDelta: 0, winner: 'attackers' });
    expect(scoreOutcome(359)).toEqual({ outcome: 'attackers-down', levelDelta: 0, winner: 'attackers' });
    expect(scoreOutcome(360)).toEqual({ outcome: 'attackers-level-up', levelDelta: 1, winner: 'attackers' });
    expect(scoreOutcome(480)).toEqual({ outcome: 'attackers-level-up', levelDelta: 2, winner: 'attackers' });
  });

  it('同门不够时必须全跟并补足张数，避免2♦3♦4♦5♦后卡住', () => {
    const state = createGame('follow-fill');
    state.phase = 'playing';
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 1;
    const lead = [
      { id: 'l1', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'l2', deck: 0, suit: 'diamonds', rank: '3' },
      { id: 'l3', deck: 0, suit: 'diamonds', rank: '4' },
      { id: 'l4', deck: 0, suit: 'diamonds', rank: '5' }
    ] as Card[];
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [{ seat: 0, cards: lead }],
      leadShape: classifyPlay(lead, 'spades', '7'),
      winner: null,
      points: 5
    };
    state.seats[1].hand = [
      { id: 'h1', deck: 0, suit: 'diamonds', rank: '8' },
      { id: 'h2', deck: 0, suit: 'diamonds', rank: '9' },
      { id: 'h3', deck: 0, suit: 'clubs', rank: '2' },
      { id: 'h4', deck: 0, suit: 'hearts', rank: '3' },
      { id: 'h5', deck: 0, suit: 'clubs', rank: 'K' }
    ] as Card[];
    const chosen = legalCardsForSimplePlay(state, 1);
    expect(chosen).toHaveLength(4);
    expect(chosen.filter((card) => card.suit === 'diamonds')).toHaveLength(2);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: chosen.map((card) => card.id) })).not.toThrow();
  });

  it('2♦3♦4♦5♦不能当顺子/拖拉机，甩牌失败时强制只出最小一手', () => {
    const state = createGame('bad-toss');
    state.phase = 'playing';
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 0;
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [],
      leadShape: null,
      winner: null,
      points: 0
    };
    state.seats[0].hand = [
      { id: 'd2', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'd3', deck: 0, suit: 'diamonds', rank: '3' },
      { id: 'd4', deck: 0, suit: 'diamonds', rank: '4' },
      { id: 'd5', deck: 0, suit: 'diamonds', rank: '5' }
    ] as Card[];
    state.seats[1].hand = [
      { id: 'd6', deck: 0, suit: 'diamonds', rank: '6' }
    ] as Card[];
    const result = dispatch(state, { type: 'play', seat: 0, cardIds: ['d2', 'd3', 'd4', 'd5'] }).state;
    expect(result.currentTrick?.plays[0].cards.map((card) => card.id)).toEqual(['d2']);
    expect(result.seats[0].hand.map((card) => card.id)).toEqual(['d3', 'd4', 'd5']);
    expect(result.events.some((event) => event.type === 'toss.fail')).toBe(true);
  });

  it('有对必须跟对，但手里多出的3对/4对不强迫全部打出', () => {
    const state = createGame('pair-follow');
    state.phase = 'playing';
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 1;
    const lead = [
      { id: 'p1', deck: 0, suit: 'hearts', rank: '4' },
      { id: 'p2', deck: 1, suit: 'hearts', rank: '4' },
      { id: 'p3', deck: 0, suit: 'hearts', rank: '5' },
      { id: 'p4', deck: 1, suit: 'hearts', rank: '5' }
    ] as Card[];
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [{ seat: 0, cards: lead }],
      leadShape: classifyPlay(lead, 'spades', '7'),
      winner: null,
      points: 10
    };
    state.seats[1].hand = [
      { id: 'a1', deck: 0, suit: 'hearts', rank: '8' },
      { id: 'a2', deck: 1, suit: 'hearts', rank: '8' },
      { id: 'b1', deck: 0, suit: 'hearts', rank: '9' },
      { id: 'b2', deck: 1, suit: 'hearts', rank: '9' },
      { id: 'c1', deck: 0, suit: 'hearts', rank: '10' },
      { id: 'c2', deck: 1, suit: 'hearts', rank: '10' }
    ] as Card[];
    const chosen = legalCardsForSimplePlay(state, 1);
    expect(chosen).toHaveLength(4);
    expect(classifyPlay(chosen, 'spades', '7').components.reduce((sum, component) => sum + component.tractorLength, 0)).toBeGreaterThanOrEqual(2);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: chosen.map((card) => card.id) })).not.toThrow();
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: ['a1', 'b1', 'c1', 'a2'] })).toThrow(/对|拖拉机/);
  });

  it('领对子时，手里有5张A不强制拆出A对', () => {
    const state = createGame('five-aces-on-pair');
    state.phase = 'playing';
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 1;
    const lead = [
      { id: 'hk1', deck: 0, suit: 'hearts', rank: 'K' },
      { id: 'hk2', deck: 1, suit: 'hearts', rank: 'K' }
    ] as Card[];
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [{ seat: 0, cards: lead }],
      leadShape: classifyPlay(lead, 'spades', '7'),
      winner: null,
      points: 20
    };
    state.seats[1].hand = [
      { id: 'ha1', deck: 0, suit: 'hearts', rank: 'A' },
      { id: 'ha2', deck: 1, suit: 'hearts', rank: 'A' },
      { id: 'ha3', deck: 2, suit: 'hearts', rank: 'A' },
      { id: 'ha4', deck: 3, suit: 'hearts', rank: 'A' },
      { id: 'ha5', deck: 4, suit: 'hearts', rank: 'A' },
      { id: 'h2', deck: 0, suit: 'hearts', rank: '2' },
      { id: 'h3', deck: 0, suit: 'hearts', rank: '3' }
    ] as Card[];
    const chosen = legalCardsForSimplePlay(state, 1);
    expect(chosen).toHaveLength(2);
    expect(chosen.filter((card) => card.suit === 'hearts' && card.rank === 'A')).toHaveLength(0);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: ['h2', 'h3'] })).not.toThrow();
  });

  it('跟两对拖拉机时，没有拖但有一对也必须先跟一对再补牌', () => {
    const state = createGame('tractor-fallback-pair');
    state.phase = 'playing';
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 1;
    const lead = [
      { id: 'q1', deck: 0, suit: 'diamonds', rank: 'Q' },
      { id: 'q2', deck: 1, suit: 'diamonds', rank: 'Q' },
      { id: 'k1', deck: 0, suit: 'diamonds', rank: 'K' },
      { id: 'k2', deck: 1, suit: 'diamonds', rank: 'K' }
    ] as Card[];
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [{ seat: 0, cards: lead }],
      leadShape: classifyPlay(lead, 'spades', '7'),
      winner: null,
      points: 20
    };
    state.seats[1].hand = [
      { id: 'd21', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'd22', deck: 1, suit: 'diamonds', rank: '2' },
      { id: 'd3', deck: 0, suit: 'diamonds', rank: '3' },
      { id: 'd4', deck: 0, suit: 'diamonds', rank: '4' },
      { id: 'd5', deck: 0, suit: 'diamonds', rank: '5' }
    ] as Card[];
    const chosen = legalCardsForSimplePlay(state, 1);
    expect(chosen.filter((card) => card.rank === '2')).toHaveLength(2);
    expect(chosen).toHaveLength(4);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: chosen.map((card) => card.id) })).not.toThrow();
  });

  it('跟三连对时，三张A不强制拆成A对，但已有的正对子仍必须跟', () => {
    const state = createGame('pair-tractor-no-break-triple');
    state.phase = 'playing';
    state.trumpSuit = 'clubs';
    state.dealerLevel = '7';
    state.activeSeat = 1;
    const lead = [
      { id: 'q1', deck: 0, suit: 'diamonds', rank: 'Q' },
      { id: 'q2', deck: 1, suit: 'diamonds', rank: 'Q' },
      { id: 'k1', deck: 0, suit: 'diamonds', rank: 'K' },
      { id: 'k2', deck: 1, suit: 'diamonds', rank: 'K' },
      { id: 'a1', deck: 0, suit: 'diamonds', rank: 'A' },
      { id: 'a2', deck: 1, suit: 'diamonds', rank: 'A' }
    ] as Card[];
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [{ seat: 0, cards: lead }],
      leadShape: classifyPlay(lead, 'clubs', '7'),
      winner: null,
      points: 20
    };
    state.seats[1].hand = [
      { id: 'd21', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'd22', deck: 1, suit: 'diamonds', rank: '2' },
      { id: 'da1', deck: 0, suit: 'diamonds', rank: 'A' },
      { id: 'da2', deck: 1, suit: 'diamonds', rank: 'A' },
      { id: 'da3', deck: 2, suit: 'diamonds', rank: 'A' },
      { id: 'd5', deck: 0, suit: 'diamonds', rank: '5' },
      { id: 'd8', deck: 0, suit: 'diamonds', rank: '8' },
      { id: 'd9', deck: 0, suit: 'diamonds', rank: '9' },
      { id: 'd3', deck: 0, suit: 'diamonds', rank: '3' }
    ] as Card[];
    const chosen = legalCardsForSimplePlay(state, 1);
    expect(chosen).toHaveLength(6);
    expect(chosen.filter((card) => card.rank === '2')).toHaveLength(2);
    expect(chosen.filter((card) => card.rank === 'A')).toHaveLength(0);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: ['d21', 'd22', 'd5', 'd8', 'd9', 'da1'] })).not.toThrow();
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: ['d21', 'd5', 'd8', 'd9', 'da1', 'd3'] })).toThrow(/对/);
  });

  it('领四张时没有四张但有三张，必须先跟三张再补牌', () => {
    const state = createGame('quad-fallback-triple');
    state.phase = 'playing';
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 1;
    const lead = [0, 1, 2, 3].map((deck) => ({ id: `d10-${deck}`, deck, suit: 'diamonds', rank: '10' })) as Card[];
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [{ seat: 0, cards: lead }],
      leadShape: classifyPlay(lead, 'spades', '7'),
      winner: null,
      points: 40
    };
    state.seats[1].hand = [
      { id: 'd91', deck: 0, suit: 'diamonds', rank: '9' },
      { id: 'd92', deck: 1, suit: 'diamonds', rank: '9' },
      { id: 'd93', deck: 2, suit: 'diamonds', rank: '9' },
      { id: 'd2', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'd3', deck: 0, suit: 'diamonds', rank: '3' },
      { id: 'c2', deck: 0, suit: 'clubs', rank: '2' }
    ] as Card[];
    const chosen = legalCardsForSimplePlay(state, 1);
    expect(chosen).toHaveLength(4);
    expect(chosen.filter((card) => card.suit === 'diamonds' && card.rank === '9')).toHaveLength(3);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: ['d91', 'd92', 'd2', 'd3'] })).toThrow(/3张/);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: chosen.map((card) => card.id) })).not.toThrow();
  });

  it('领六张时没有六张但有五张，必须先跟五张再补牌', () => {
    const state = createGame('six-fallback-five');
    state.phase = 'playing';
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 1;
    const lead = [0, 1, 2, 3, 4, 5].map((deck) => ({ id: `d10-${deck}`, deck, suit: 'diamonds', rank: '10' })) as Card[];
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [{ seat: 0, cards: lead }],
      leadShape: classifyPlay(lead, 'spades', '7'),
      winner: null,
      points: 60
    };
    state.seats[1].hand = [
      { id: 'd91', deck: 0, suit: 'diamonds', rank: '9' },
      { id: 'd92', deck: 1, suit: 'diamonds', rank: '9' },
      { id: 'd93', deck: 2, suit: 'diamonds', rank: '9' },
      { id: 'd94', deck: 3, suit: 'diamonds', rank: '9' },
      { id: 'd95', deck: 4, suit: 'diamonds', rank: '9' },
      { id: 'd2', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'd3', deck: 0, suit: 'diamonds', rank: '3' }
    ] as Card[];
    const chosen = legalCardsForSimplePlay(state, 1);
    expect(chosen).toHaveLength(6);
    expect(chosen.filter((card) => card.suit === 'diamonds' && card.rank === '9')).toHaveLength(5);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: ['d91', 'd92', 'd2', 'd3', 'd94', 'd95'] })).toThrow(/5张/);
    expect(() => dispatch(state, { type: 'play', seat: 1, cardIds: chosen.map((card) => card.id) })).not.toThrow();
  });

  it('G1 闲家末墩抠底加分算进决定升降级的闲家总抓分', () => {
    const state = createGame('kitty-score');
    state.phase = 'playing';
    state.dealerSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.kitty = [
      { id: 'k5', deck: 0, suit: 'clubs', rank: '5' },
      { id: 'k10', deck: 0, suit: 'clubs', rank: '10' }
    ] as Card[];
    for (let seat = 0; seat < 7; seat += 1) state.seats[seat].hand = [];
    state.seats[1].personalPoints = 230;
    const lead = { id: 'l1', deck: 0, suit: 'clubs', rank: '2' } as Card;
    state.currentTrick = {
      index: 45,
      leader: 2,
      plays: [
        { seat: 2, cards: [lead] },
        { seat: 3, cards: [{ id: 'l2', deck: 0, suit: 'clubs', rank: '3' } as Card] },
        { seat: 4, cards: [{ id: 'l3', deck: 0, suit: 'clubs', rank: '4' } as Card] },
        { seat: 5, cards: [{ id: 'l4', deck: 0, suit: 'clubs', rank: '6' } as Card] },
        { seat: 6, cards: [{ id: 'l5', deck: 0, suit: 'clubs', rank: '8' } as Card] },
        { seat: 0, cards: [{ id: 'l6', deck: 0, suit: 'clubs', rank: '9' } as Card] }
      ],
      leadShape: classifyPlay([lead], 'spades', '7'),
      winner: null,
      points: 0
    };
    state.activeSeat = 1;
    state.seats[1].hand = [{ id: 'win', deck: 0, suit: 'clubs', rank: 'A' } as Card];
    const result = dispatch(state, { type: 'play', seat: 1, cardIds: ['win'] }).state;
    expect(result.result?.rawAttackerPoints).toBe(230);
    expect(result.result?.kittyPoints).toBe(15);
    expect(result.result?.kittyMultiplier).toBe(2);
    expect(result.result?.attackerPoints).toBe((result.result?.rawAttackerPoints ?? 0) + (result.result?.kittyPoints ?? 0) * (result.result?.kittyMultiplier ?? 0));
    expect(result.result?.attackerPoints).toBe(260);
  });

  it.each([
    ['主J抠底，庄家打回7', 'J', { id: 'main-j', deck: 0, suit: 'spades', rank: 'J' }, 'main', '7', '7'],
    ['副J抠底，庄家队按个人级数打回', 'J', { id: 'off-j', deck: 0, suit: 'hearts', rank: 'J' }, 'off', null, '9'],
    ['主A抠底，庄家打回J', 'A', { id: 'main-a', deck: 0, suit: 'spades', rank: 'A' }, 'main', 'J', 'J'],
    ['副A抠底，庄家打回K', 'A', { id: 'off-a', deck: 0, suit: 'hearts', rank: 'A' }, 'off', 'K', 'K']
  ] as const)('%s', (_name, rank, finalCard, kind, resultTarget, playerTarget) => {
    const state = stateBeforeMandatoryBottomPenalty(rank, finalCard as Card);
    const result = dispatch(state, { type: 'play', seat: 1, cardIds: [finalCard.id] }).state;
    expect(result.seats[0].level).toBe(playerTarget as NormalRank);
    expect(result.seats[2].level).toBe(playerTarget as NormalRank);
    expect(result.result?.mandatoryBottomPenalty).toMatchObject({
      rank,
      kind,
      target: resultTarget,
      affected: [
        { seat: 0, from: rank, to: playerTarget },
        { seat: 2, from: rank, to: playerTarget }
      ]
    });
    expect(result.events.at(-1)?.message).toContain(`${kind === 'main' ? '主' : '副'}${rank}抠底`);
  });

  it.each([
    ['7', '7', false],
    ['8', '7', true],
    ['9', '7', true],
    ['10', '8', true],
    ['J', '9', true],
    ['Q', '9', true],
    ['K', '10', true],
    ['A', 'J', true]
  ] as const)('副J抠底时朋友%s按距离底一半且至少2级打回%s', (from, target, affected) => {
    const finalCard = { id: `off-j-${from}`, deck: 0, suit: 'hearts', rank: 'J' } as Card;
    const state = stateBeforeMandatoryBottomPenalty('J', finalCard);
    state.seats[2].level = from as NormalRank;
    const result = dispatch(state, { type: 'play', seat: 1, cardIds: [finalCard.id] }).state;

    expect(result.seats[2].level).toBe(target);
    const friendPenalty = result.result?.mandatoryBottomPenalty?.affected.find((item) => item.seat === 2);
    if (affected) {
      expect(friendPenalty).toMatchObject({ seat: 2, from, to: target });
    } else {
      expect(friendPenalty).toBeUndefined();
    }
    expect(result.result?.mandatoryBottomPenalty?.target).toBeNull();
  });

  it('下一局会清空上一局结算态', () => {
    const state = fillBots(createGame('next-round-clean'));
    state.phase = 'finished';
    state.round = 1;
    state.dealerSeat = 0;
    state.nextDealerSeat = 3;
    state.dealerLevel = '7';
    state.trumpSuit = 'spades';
    state.kitty = [{ id: 'k5', deck: 0, suit: 'clubs', rank: '5' }] as Card[];
    state.completedTricks = [{
      index: 21,
      leader: 0,
      plays: [],
      leadShape: null,
      winner: 1,
      points: 0
    }];
    state.result = {
      attackerPoints: 260,
      rawAttackerPoints: 230,
      kittyPoints: 15,
      kittyMultiplier: 2,
      hostTeam: [0, 2],
      attackerTeam: [1, 3, 4, 5, 6],
      outcome: 'attackers-down',
      levelDelta: 0,
      nextDealer: 3,
      bottomSaved: false,
      mandatoryBottomPenalty: null
    };

    const next = dispatch(state, { type: 'next-round', seed: 'next-round-clean' }).state;

    expect(next.phase).toBe('bidding');
    expect(next.round).toBe(2);
    expect(next.dealerSeat).toBe(3);
    expect(next.nextDealerSeat).toBeNull();
    expect(next.result).toBeNull();
    expect(next.completedTricks).toHaveLength(0);
    expect(next.currentTrick).toBeNull();
    expect(next.activeSeat).toBe(3);
    expect(next.seats.every((seat) => seat.personalPoints === 0)).toBe(true);
  });

  it('G2 扣回的9张可含原底牌，但A不可扣', () => {
    const state = createGame('bury-original-kitty');
    state.phase = 'bury';
    state.dealerSeat = 0;
    state.bottomOwner = 0;
    state.trumpSuit = 'spades';
    state.currentBid = {
      seat: 0,
      suit: 'spades',
      levelRank: '7',
      levelCardCount: 1,
      jokerCount: 2,
      cardIds: [],
      cards: [],
      action: 'bid',
      source: 'hand'
    };
    const originalKitty = Array.from({ length: 9 }, (_, index) => ({
      id: `ok${index}`,
      deck: index % 6,
      suit: 'clubs',
      rank: index === 0 ? '5' : '6'
    })) as Card[];
    state.seats[0].hand = [
      ...originalKitty,
      { id: 'ace', deck: 0, suit: 'hearts', rank: 'A' } as Card
    ];
    const result = dispatch(state, { type: 'bury', seat: 0, cardIds: originalKitty.map((card) => card.id) }).state;
    expect(result.kitty.map((card) => card.id)).toEqual(originalKitty.map((card) => card.id));
    expect(() => dispatch(state, { type: 'bury', seat: 0, cardIds: ['ace', ...originalKitty.slice(1).map((card) => card.id)] })).toThrow(/A/);
  });

  it('升级导向扣底不会只因0分就优先扣掉四张J结构', () => {
    const state = createGame('upgrade-bury-structure');
    state.phase = 'bury';
    state.dealerSeat = 0;
    state.bottomOwner = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.currentBid = {
      seat: 0,
      suit: 'spades',
      levelRank: '7',
      levelCardCount: 1,
      jokerCount: 2,
      cardIds: [],
      cards: [],
      action: 'bid',
      source: 'hand'
    };
    state.seats[0].isBot = true;
    state.seats[0].hand = [
      { id: 'cj1', deck: 0, suit: 'clubs', rank: 'J' },
      { id: 'cj2', deck: 1, suit: 'clubs', rank: 'J' },
      { id: 'cj3', deck: 2, suit: 'clubs', rank: 'J' },
      { id: 'cj4', deck: 3, suit: 'clubs', rank: 'J' },
      { id: 'c2', deck: 0, suit: 'clubs', rank: '2' },
      { id: 'c3', deck: 0, suit: 'clubs', rank: '3' },
      { id: 'c4', deck: 0, suit: 'clubs', rank: '4' },
      { id: 'c6', deck: 0, suit: 'clubs', rank: '6' },
      { id: 'd2', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'd3', deck: 0, suit: 'diamonds', rank: '3' },
      { id: 'h2', deck: 0, suit: 'hearts', rank: '2' },
      { id: 'h3', deck: 0, suit: 'hearts', rank: '3' },
      { id: 'h4', deck: 0, suit: 'hearts', rank: '4' }
    ] as Card[];

    const intent = decideBotIntent(state, 0);

    expect(intent?.type).toBe('bury');
    if (intent?.type !== 'bury') return;
    expect(intent.cardIds.filter((id) => id.startsWith('cj'))).toHaveLength(0);
    expect(intent.strategy?.candidates?.find((candidate) => candidate.id === 'point-only-baseline')?.risks?.some((risk) => risk.code === 'bury-structure')).toBe(true);

    const result = dispatch(state, intent);
    expect(result.events[0].type).toBe('ai.decision');
    expect(result.events[1].type).toBe('kitty.bury');
    expect(badDecisionLines(result.state)).toHaveLength(0);
    expect((result.events[1].payload as { analysis?: unknown }).analysis).toBeTruthy();
  });

  it('找朋友默认避开自己已经持有的A，避免普通牌力下少找朋友', () => {
    const state = createGame('friend-call-avoid-self');
    state.phase = 'friend-call';
    state.dealerSeat = 0;
    state.activeSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.seats[0].isBot = true;
    state.seats[0].hand = [
      { id: 'ha1', deck: 0, suit: 'hearts', rank: 'A' },
      { id: 'ha2', deck: 1, suit: 'hearts', rank: 'A' },
      { id: 'ca1', deck: 0, suit: 'clubs', rank: 'A' },
      { id: 'c2', deck: 0, suit: 'clubs', rank: '2' },
      { id: 'd2', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'h2', deck: 0, suit: 'hearts', rank: '2' }
    ] as Card[];

    const intent = decideBotIntent(state, 0);

    expect(intent?.type).toBe('call-friends');
    if (intent?.type !== 'call-friends') return;
    for (const call of intent.calls) {
      const ownAces = state.seats[0].hand.filter((card) => card.suit === call.suit && card.rank === 'A').length;
      expect(call.nth).toBeGreaterThan(ownAces);
    }
    expect(intent.strategy?.risks.some((risk) => risk.code === 'self-friend')).toBe(false);
  });

  it('庄家队不能在对手仍可能有主时只按牌面继续调主', () => {
    const state = createGame('avoid-bad-trump-lead');
    state.phase = 'playing';
    state.dealerSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 0;
    state.currentTrick = {
      index: 1,
      leader: 0,
      plays: [],
      leadShape: null,
      winner: null,
      points: 0
    };
    state.seats[0].isBot = true;
    state.seats[0].hand = [
      { id: 's10-1', deck: 0, suit: 'spades', rank: '10' },
      { id: 's10-2', deck: 1, suit: 'spades', rank: '10' },
      { id: 'h2-1', deck: 0, suit: 'hearts', rank: '2' },
      { id: 'h2-2', deck: 1, suit: 'hearts', rank: '2' }
    ] as Card[];
    for (let seat = 1; seat < 7; seat += 1) {
      state.seats[seat].hand = [{ id: `unknown-c3-${seat}`, deck: seat, suit: 'clubs', rank: '3' } as Card];
    }

    const intent = decideBotIntent(state, 0);

    expect(intent?.type).toBe('play');
    if (intent?.type !== 'play') return;
    expect(intent.cardIds).toEqual(['h2-1', 'h2-2']);
    expect(intent.strategy?.candidates?.some((candidate) => candidate.id === 'non-trump-lead')).toBe(true);
  });

  it('全场只剩AI有主时，AI会主动甩主兑现独占控制', () => {
    const state = createGame('safe-trump-toss');
    state.phase = 'playing';
    state.dealerSeat = 6;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 6;
    const leadTrump = { id: 'old-s2', deck: 0, suit: 'spades', rank: '2' } as Card;
    state.completedTricks = [{
      index: 1,
      leader: 6,
      plays: [
        { seat: 6, cards: [leadTrump] },
        { seat: 0, cards: [{ id: 'old-c2-0', deck: 0, suit: 'clubs', rank: '2' } as Card] },
        { seat: 1, cards: [{ id: 'old-c2-1', deck: 1, suit: 'clubs', rank: '2' } as Card] },
        { seat: 2, cards: [{ id: 'old-c2-2', deck: 2, suit: 'clubs', rank: '2' } as Card] },
        { seat: 3, cards: [{ id: 'old-c2-3', deck: 3, suit: 'clubs', rank: '2' } as Card] },
        { seat: 4, cards: [{ id: 'old-c2-4', deck: 4, suit: 'clubs', rank: '2' } as Card] },
        { seat: 5, cards: [{ id: 'old-c2-5', deck: 5, suit: 'clubs', rank: '2' } as Card] }
      ],
      leadShape: classifyPlay([leadTrump], 'spades', '7'),
      winner: 6,
      points: 0
    }];
    state.currentTrick = {
      index: 2,
      leader: 6,
      plays: [],
      leadShape: null,
      winner: null,
      points: 0
    };
    for (let seat = 0; seat < 6; seat += 1) {
      state.seats[seat].hand = [{ id: `left-c3-${seat}`, deck: seat, suit: 'clubs', rank: '3' } as Card];
    }
    state.seats[6].isBot = true;
    state.seats[6].hand = [
      { id: 's10', deck: 0, suit: 'spades', rank: '10' },
      { id: 'sk', deck: 0, suit: 'spades', rank: 'K' },
      { id: 'h7', deck: 0, suit: 'hearts', rank: '7' }
    ] as Card[];

    const intent = decideBotIntent(state, 6);

    expect(intent?.type).toBe('play');
    if (intent?.type !== 'play') return;
    expect(intent.cardIds).toEqual(['s10', 'sk', 'h7']);
    expect(intent.strategy?.candidates?.some((candidate) => candidate.id === 'safe-toss')).toBe(true);
    const result = dispatch(state, intent).state;
    expect(result.events.some((event) => event.type === 'toss.fail')).toBe(false);
    expect(result.currentTrick?.plays[0].cards.map((card) => card.id)).toEqual(['s10', 'sk', 'h7']);
  });

  it('当前最大牌是敌方且自己不能赢时，AI优先垫0分低牌', () => {
    const state = createGame('avoid-feeding-points-to-enemy');
    state.phase = 'playing';
    state.dealerSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 6;
    state.friendCalls = [{
      id: 'friend-ai7',
      suit: 'clubs',
      nth: 1,
      seen: 1,
      matchedBy: 6,
      matchedTrick: 1,
      pointsAtReveal: 0
    } satisfies FriendCall];
    const lead = { id: 'enemy-dk', deck: 0, suit: 'diamonds', rank: 'K' } as Card;
    state.currentTrick = {
      index: 3,
      leader: 5,
      plays: [{ seat: 5, cards: [lead] }],
      leadShape: classifyPlay([lead], 'spades', '7'),
      winner: 5,
      points: 10
    };
    state.seats[6].isBot = true;
    state.seats[6].hand = [
      { id: 'ai7-d10', deck: 0, suit: 'diamonds', rank: '10' },
      { id: 'ai7-d2', deck: 0, suit: 'diamonds', rank: '2' },
      { id: 'ai7-c3', deck: 0, suit: 'clubs', rank: '3' }
    ] as Card[];

    const intent = decideBotIntent(state, 6);

    expect(intent?.type).toBe('play');
    if (intent?.type !== 'play') return;
    expect(intent.cardIds).toEqual(['ai7-d2']);
    expect(intent.strategy?.candidates?.some((candidate) => candidate.id === 'point-safe-follow')).toBe(true);
  });

  it('当前最大牌是本方且后手无威胁时，AI允许把10分送进本方墩', () => {
    const state = createGame('allow-safe-team-points');
    state.phase = 'playing';
    state.dealerSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 6;
    state.friendCalls = [{
      id: 'friend-ai7-safe',
      suit: 'clubs',
      nth: 1,
      seen: 1,
      matchedBy: 6,
      matchedTrick: 1,
      pointsAtReveal: 0
    } satisfies FriendCall];
    const lead = { id: 'host-dk', deck: 0, suit: 'diamonds', rank: 'K' } as Card;
    state.currentTrick = {
      index: 4,
      leader: 0,
      plays: [
        { seat: 0, cards: [lead] },
        { seat: 1, cards: [{ id: 'safe-d3-1', deck: 0, suit: 'diamonds', rank: '3' } as Card] },
        { seat: 2, cards: [{ id: 'safe-d4-2', deck: 0, suit: 'diamonds', rank: '4' } as Card] },
        { seat: 3, cards: [{ id: 'safe-d6-3', deck: 0, suit: 'diamonds', rank: '6' } as Card] },
        { seat: 4, cards: [{ id: 'safe-d8-4', deck: 0, suit: 'diamonds', rank: '8' } as Card] },
        { seat: 5, cards: [{ id: 'safe-d9-5', deck: 0, suit: 'diamonds', rank: '9' } as Card] }
      ],
      leadShape: classifyPlay([lead], 'spades', '7'),
      winner: 0,
      points: 10
    };
    state.seats[6].isBot = true;
    state.seats[6].hand = [
      { id: 'safe-d10', deck: 0, suit: 'diamonds', rank: '10' },
      { id: 'safe-d2', deck: 0, suit: 'diamonds', rank: '2' }
    ] as Card[];

    const intent = decideBotIntent(state, 6);

    expect(intent?.type).toBe('play');
    if (intent?.type !== 'play') return;
    expect(intent.cardIds).toEqual(['safe-d10']);
  });

  it('首出单张10/K未被记忆证明安全时，AI改出0分低风险牌', () => {
    const state = createGame('avoid-unsafe-point-lead');
    state.phase = 'playing';
    state.dealerSeat = 0;
    state.trumpSuit = 'spades';
    state.dealerLevel = '7';
    state.activeSeat = 6;
    state.friendCalls = [{
      id: 'friend-ai7-lead',
      suit: 'clubs',
      nth: 1,
      seen: 1,
      matchedBy: 6,
      matchedTrick: 1,
      pointsAtReveal: 0
    } satisfies FriendCall];
    state.currentTrick = {
      index: 5,
      leader: 6,
      plays: [],
      leadShape: null,
      winner: null,
      points: 0
    };
    state.seats[6].isBot = true;
    state.seats[6].hand = [
      { id: 'unsafe-d10', deck: 0, suit: 'diamonds', rank: '10' },
      { id: 'unsafe-c2', deck: 0, suit: 'clubs', rank: '2' },
      { id: 'unsafe-h3', deck: 0, suit: 'hearts', rank: '3' }
    ] as Card[];

    const intent = decideBotIntent(state, 6);

    expect(intent?.type).toBe('play');
    if (intent?.type !== 'play') return;
    expect(intent.cardIds).not.toEqual(['unsafe-d10']);
    const selected = state.seats[6].hand.filter((card) => intent.cardIds.includes(card.id));
    expect(sumPoints(selected)).toBe(0);
    expect(intent.strategy?.candidates?.some((candidate) => candidate.id === 'point-safe-lead')).toBe(true);
  });
});
