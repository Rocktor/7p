import { NORMAL_SUITS, type NormalSuit, pointValue, sortCards } from './cards.js';
import { decideBotIntent } from './ai.js';
import { createGame, dispatch, legalCardsForSimplePlay, parseTrumpBid, trumpBidStrength } from './engine.js';
import type { GameIntent, GameState, RoundResult, SeatIndex, StrategyDecisionReport, StrategyRisk } from './types.js';

export type BotStrategyName = 'upgrade' | 'point-only-baseline';

export type SimulationOptions = {
  seeds: string[];
  strategy: BotStrategyName;
  maxSteps?: number;
};

export type SimulatedGame = {
  seed: string;
  strategy: BotStrategyName;
  finished: boolean;
  steps: number;
  result: RoundResult | null;
  riskCount: number;
  badRiskCount: number;
  buryRiskCount: number;
  decisionCount: number;
};

export type StrategyEvaluation = {
  strategy: BotStrategyName;
  games: number;
  finished: number;
  hostWinRate: number;
  attackerWinRate: number;
  averageAttackerPoints: number;
  averageRawAttackerPoints: number;
  bottomDugRate: number;
  totalRiskCount: number;
  totalBadRiskCount: number;
  totalBuryRiskCount: number;
  outcomeCounts: Record<RoundResult['outcome'], number>;
  gamesDetail: SimulatedGame[];
};

export type EvaluationReport = {
  seeds: string[];
  strategies: StrategyEvaluation[];
  comparison: {
    baseline: BotStrategyName;
    challenger: BotStrategyName;
    attackerPointsDelta: number;
    badRiskDelta: number;
    buryRiskDelta: number;
    hostWinRateDelta: number;
  } | null;
};

const PLAYER_COUNT = 7;
const DEFAULT_MAX_STEPS = 3000;

export function evaluateStrategies(seeds: string[]): EvaluationReport {
  const strategies: BotStrategyName[] = ['point-only-baseline', 'upgrade'];
  const results = strategies.map((strategy) => evaluateStrategy({ seeds, strategy }));
  const baseline = results.find((result) => result.strategy === 'point-only-baseline');
  const challenger = results.find((result) => result.strategy === 'upgrade');
  return {
    seeds,
    strategies: results,
    comparison: baseline && challenger
      ? {
          baseline: baseline.strategy,
          challenger: challenger.strategy,
          attackerPointsDelta: round2(challenger.averageAttackerPoints - baseline.averageAttackerPoints),
          badRiskDelta: challenger.totalBadRiskCount - baseline.totalBadRiskCount,
          buryRiskDelta: challenger.totalBuryRiskCount - baseline.totalBuryRiskCount,
          hostWinRateDelta: round2(challenger.hostWinRate - baseline.hostWinRate)
        }
      : null
  };
}

export function evaluateStrategy(options: SimulationOptions): StrategyEvaluation {
  const gamesDetail = options.seeds.map((seed) => simulateGame(seed, options.strategy, options.maxSteps));
  const finishedGames = gamesDetail.filter((game) => game.finished && game.result);
  const outcomeCounts = emptyOutcomeCounts();
  for (const game of finishedGames) {
    outcomeCounts[game.result!.outcome] += 1;
  }
  const hostWins = finishedGames.filter((game) => game.result!.outcome !== 'attackers-level-up').length;
  const attackerWins = finishedGames.length - hostWins;
  const totalAttackerPoints = sum(finishedGames.map((game) => game.result!.attackerPoints));
  const totalRawAttackerPoints = sum(finishedGames.map((game) => game.result!.rawAttackerPoints));
  const bottomDug = finishedGames.filter((game) => !game.result!.bottomSaved).length;
  return {
    strategy: options.strategy,
    games: gamesDetail.length,
    finished: finishedGames.length,
    hostWinRate: ratio(hostWins, finishedGames.length),
    attackerWinRate: ratio(attackerWins, finishedGames.length),
    averageAttackerPoints: round2(ratio(totalAttackerPoints, finishedGames.length)),
    averageRawAttackerPoints: round2(ratio(totalRawAttackerPoints, finishedGames.length)),
    bottomDugRate: ratio(bottomDug, finishedGames.length),
    totalRiskCount: sum(gamesDetail.map((game) => game.riskCount)),
    totalBadRiskCount: sum(gamesDetail.map((game) => game.badRiskCount)),
    totalBuryRiskCount: sum(gamesDetail.map((game) => game.buryRiskCount)),
    outcomeCounts,
    gamesDetail
  };
}

export function simulateGame(seed: string, strategy: BotStrategyName, maxSteps = DEFAULT_MAX_STEPS): SimulatedGame {
  let state = createGame(`sim-${strategy}-${seed}`, `AI评测 ${strategy} ${seed}`);
  for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
    state = dispatch(state, { type: 'toggle-bot', seat: seat as SeatIndex, enabled: true }).state;
  }
  state = dispatch(state, { type: 'start-game', seed }).state;

  let steps = 0;
  while (state.phase !== 'finished' && steps < maxSteps) {
    const intent = nextSimulationIntent(state, strategy);
    if (!intent) break;
    state = dispatch(state, intent).state;
    steps += 1;
  }

  const risks = collectRisks(state);
  return {
    seed,
    strategy,
    finished: state.phase === 'finished',
    steps,
    result: state.result,
    riskCount: risks.length,
    badRiskCount: risks.filter((risk) => risk.severity === 'bad').length,
    buryRiskCount: collectBuryRisks(state).length,
    decisionCount: state.events.filter((event) => event.type === 'ai.decision').length
  };
}

function nextSimulationIntent(state: GameState, strategy: BotStrategyName): GameIntent | null {
  if (state.phase === 'bidding' || state.phase === 'counter') {
    const passes = state.phase === 'bidding' ? state.bidPasses : state.counterPasses;
    for (const seat of state.seats) {
      if (!seat.isBot) continue;
      const intent = strategyIntent(state, seat.seat, strategy);
      if (intent && !(intent.type === 'pass-counter' && passes.includes(seat.seat))) return intent;
    }
  }
  if (state.phase === 'bury' && state.bottomOwner !== null) return strategyIntent(state, state.bottomOwner, strategy);
  if (state.phase === 'friend-call' && state.dealerSeat !== null) return strategyIntent(state, state.dealerSeat, strategy);
  if (state.phase === 'playing' && state.activeSeat !== null) return strategyIntent(state, state.activeSeat, strategy);
  return null;
}

function strategyIntent(state: GameState, seat: SeatIndex, strategy: BotStrategyName): GameIntent | null {
  if (strategy === 'upgrade') return decideBotIntent(state, seat);
  return baselineBotIntent(state, seat);
}

function baselineBotIntent(state: GameState, seat: SeatIndex): GameIntent | null {
  const player = state.seats[seat];
  if (!player.isBot) return null;

  if (state.phase === 'bidding' || state.phase === 'counter') {
    const bid = findBaselineBid(state, seat);
    if (bid) return { type: 'bid', seat, cardIds: bid };
    return { type: 'pass-counter', seat };
  }

  if (state.phase === 'bury' && state.bottomOwner === seat) {
    const cards = sortCards(player.hand.filter((card) => card.rank !== 'A'), state.trumpSuit ?? 'spades', state.dealerLevel)
      .sort((a, b) => pointValue(a) - pointValue(b))
      .slice(0, 9);
    return { type: 'bury', seat, cardIds: cards.map((card) => card.id) };
  }

  if (state.phase === 'friend-call' && state.dealerSeat === seat) {
    return { type: 'call-friends', seat, calls: baselineFriendCalls(state) };
  }

  if (state.phase === 'playing' && state.activeSeat === seat) {
    const cards = legalCardsForSimplePlay(state, seat);
    if (cards.length > 0) return { type: 'play', seat, cardIds: cards.map((card) => card.id) };
  }

  return null;
}

function findBaselineBid(state: GameState, seat: SeatIndex): string[] | null {
  const hand = state.seats[seat].hand;
  const jokers = hand.filter((card) => card.suit === 'joker').slice(0, 2);
  if (jokers.length < 2) return null;
  for (const suit of NORMAL_SUITS) {
    const levelCards = hand.filter((card) => card.suit === suit && card.rank === state.dealerLevel);
    if (levelCards.length === 0) continue;
    const cards = [...jokers, levelCards[0]];
    try {
      const parsed = parseTrumpBid(cards, seat, state.dealerLevel);
      const current = state.currentBid;
      const currentStrength = current ? trumpBidStrength(current) : -1;
      if (trumpBidStrength(parsed) > currentStrength) return cards.map((card) => card.id);
    } catch {
      return null;
    }
  }
  return null;
}

function baselineFriendCalls(state: GameState): { suit: NormalSuit; nth: number }[] {
  const dealer = state.dealerSeat === null ? null : state.seats[state.dealerSeat];
  const visibleAces = new Set(
    (dealer?.hand ?? [])
      .filter((card) => card.rank === 'A' && card.suit !== 'joker')
      .map((card) => `${card.suit}:${card.deck}`)
  );
  const calls: { suit: NormalSuit; nth: number }[] = [];
  const availableSuits = NORMAL_SUITS.filter((suit) => suit !== state.trumpSuit);
  for (const suit of availableSuits) {
    const ownCount = [...visibleAces].filter((key) => key.startsWith(`${suit}:`)).length;
    calls.push({ suit, nth: Math.min(6, Math.max(1, ownCount + 1)) });
    if (calls.length === 2) return calls;
  }
  return availableSuits.slice(0, 2).map((suit, index) => ({ suit, nth: index + 2 }));
}

function collectRisks(state: GameState): StrategyRisk[] {
  return [
    ...state.events
      .filter((event) => event.type === 'ai.decision')
      .flatMap((event) => ((event.payload as StrategyDecisionReport | undefined)?.risks ?? [])),
    ...collectBuryRisks(state)
  ];
}

function collectBuryRisks(state: GameState): StrategyRisk[] {
  return state.events
    .filter((event) => event.type === 'kitty.bury')
    .flatMap((event) => {
      const payload = event.payload as { analysis?: StrategyDecisionReport } | undefined;
      return payload?.analysis?.risks ?? [];
    });
}

function emptyOutcomeCounts(): Record<RoundResult['outcome'], number> {
  return {
    'host-big-shutout': 0,
    'host-small-shutout': 0,
    'host-level-up': 0,
    'attackers-level-up': 0
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
