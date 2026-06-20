import {
  NORMAL_SUITS,
  type Card,
  type EffectiveSuit,
  type NormalRank,
  type TrumpSuit,
  cardLabel,
  compareLogicalCards,
  effectiveRankValue,
  effectiveSuit,
  logicalCardKey,
  pointValue,
  sortCards
} from './cards.js';
import { classifyPlay, legalCardsForSimplePlay } from './engine.js';
import {
  allOthersVoid,
  anyOpponentCanStillHoldDoor,
  buildTableMemory,
  doorCards,
  type Door,
  type TableMemory
} from './memory.js';
import { describeUpgradeObjective } from './strategy.js';
import type { GameState, SeatIndex, StrategyCandidate, StrategyDecisionReport, StrategyRisk, UpgradeObjective } from './types.js';

type ScoredCards = {
  cards: Card[];
  score: number;
  summary: string;
  risks: StrategyRisk[];
};

export function chooseUpgradePlay(state: GameState, seat: SeatIndex): { cards: Card[]; report: StrategyDecisionReport } | null {
  if (state.phase !== 'playing' || state.activeSeat !== seat || !state.currentTrick || !state.trumpSuit) return null;
  const fallback = legalCardsForSimplePlay(state, seat);
  if (fallback.length === 0) return null;
  const memory = buildTableMemory(state);
  if (!memory) return {
    cards: fallback,
    report: playReport(state, seat, fallback, describeUpgradeObjective(state, seat), [], ['未能建立牌情记忆，回退到合法出牌。'])
  };

  if (state.currentTrick.plays.length > 0) {
    return {
      cards: fallback,
      report: playReport(state, seat, fallback, describeUpgradeObjective(state, seat), [], ['跟牌阶段先满足牌型和同门约束，后续再做控分策略。'])
    };
  }

  const selected = chooseLeadWithMemory(state, seat, memory, fallback);
  return {
    cards: selected.cards,
    report: playReport(
      state,
      seat,
      selected.cards,
      describeUpgradeObjective(state, seat),
      selected.risks,
      [selected.summary],
      leadCandidatesForReport(state, seat, memory, fallback)
    )
  };
}

function chooseLeadWithMemory(state: GameState, seat: SeatIndex, memory: TableMemory, fallback: Card[]): ScoredCards {
  const hand = state.seats[seat].hand;
  const objective = describeUpgradeObjective(state, seat);
  const safeToss = safeTossCandidate(hand, memory, seat);
  if (safeToss) return safeToss;

  const fallbackDoor = cardsDoor(fallback, memory.trumpSuit, memory.levelRank);
  const trumpRisk = leadTrumpRisk(memory, seat, objective, fallbackDoor);
  if (fallbackDoor === 'trump' && trumpRisk) {
    const nonTrump = bestNonTrumpLead(hand, memory);
    if (nonTrump) return nonTrump;
    return {
      cards: fallback,
      score: 10,
      summary: '没有可用副牌首出，只能出主；该动作需要复盘主牌控制权。',
      risks: [trumpRisk]
    };
  }

  return {
    cards: fallback,
    score: 50,
    summary: '当前没有更高优先级的牌情策略，使用合法出牌基线。',
    risks: trumpRisk ? [trumpRisk] : []
  };
}

function safeTossCandidate(hand: Card[], memory: TableMemory, seat: SeatIndex): ScoredCards | null {
  const doors: Door[] = ['trump', ...NORMAL_SUITS];
  const candidates = doors.flatMap((door): ScoredCards[] => {
    if (!allOthersVoid(memory, seat, door)) return [];
    const cards = doorCards(hand, memory, door);
    if (cards.length < 2) return [];
    const sorted = sortCards(cards, memory.trumpSuit, memory.levelRank);
    const shape = classifyPlay(sorted, memory.trumpSuit, memory.levelRank);
    if (shape.effectiveSuit !== door) return [];
    const doorName = door === 'trump' ? '主牌' : `${door}门`;
    return [{
      cards: sorted,
      score: 1000 + sorted.length * 20 + sumPoints(sorted) * 10,
      summary: `牌情显示其他玩家已断${doorName}，主动甩${doorName}兑现独占控制。`,
      risks: []
    }];
  });
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function bestNonTrumpLead(hand: Card[], memory: TableMemory): ScoredCards | null {
  const candidates: ScoredCards[] = [];
  for (const door of NORMAL_SUITS) {
    const cards = doorCards(hand, memory, door);
    if (cards.length === 0) continue;
    candidates.push(...leadGroups(cards, memory.trumpSuit, memory.levelRank).map((group) => ({
      cards: group,
      score: leadScore(group, memory.trumpSuit, memory.levelRank),
      summary: `避免无谓调主，改从${door}门出牌，先保留主牌控制和末墩空间。`,
      risks: []
    })));
  }
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function leadGroups(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): Card[][] {
  const groups = groupByLogicalCard(cards, trumpSuit, levelRank);
  const structured = groups
    .filter((group) => group.length >= 2)
    .sort((a, b) => b.length - a.length || effectiveRankValue(b[0], trumpSuit, levelRank) - effectiveRankValue(a[0], trumpSuit, levelRank));
  if (structured.length > 0) return structured;
  return sortCards(cards, trumpSuit, levelRank).slice(-1).map((card) => [card]);
}

function leadScore(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): number {
  const shape = classifyPlay(cards, trumpSuit, levelRank);
  const structure = shape.kind === 'tractor' ? 80 : shape.kind === 'tuple' ? 45 : 0;
  return sumPoints(cards) * 12 + structure + shape.count * 5 + shape.strength / 100;
}

function leadTrumpRisk(
  memory: TableMemory,
  seat: SeatIndex,
  objective: UpgradeObjective,
  door: EffectiveSuit | 'mixed'
): StrategyRisk | null {
  if (door !== 'trump') return null;
  if (!anyOpponentCanStillHoldDoor(memory, seat, 'trump')) return null;
  if (objective.team === 'attackers') return null;
  return {
    code: 'lead-trump-risk',
    severity: 'bad',
    message: '已知仍有人可能有主，庄家队/暗友阶段继续调主可能把控制权交给闲家。'
  };
}

function playReport(
  state: GameState,
  seat: SeatIndex,
  cards: Card[],
  objective: UpgradeObjective,
  risks: StrategyRisk[],
  reasons: string[],
  candidates?: StrategyCandidate[]
): StrategyDecisionReport {
  return {
    seat,
    phase: state.phase,
    action: 'play',
    objective,
    score: 100 - riskPenalty(risks) + cards.length,
    selectedCardIds: cards.map((card) => card.id),
    reasons: [objective.summary, ...reasons, `实际出牌：${formatCards(cards)}。`],
    risks,
    candidates
  };
}

function leadCandidatesForReport(
  state: GameState,
  seat: SeatIndex,
  memory: TableMemory,
  fallback: Card[]
): StrategyCandidate[] {
  const hand = state.seats[seat].hand;
  const candidates: StrategyCandidate[] = [];
  const safe = safeTossCandidate(hand, memory, seat);
  if (safe) candidates.push(toCandidate('safe-toss', safe));
  const nonTrump = bestNonTrumpLead(hand, memory);
  if (nonTrump) candidates.push(toCandidate('non-trump-lead', nonTrump));
  candidates.push({
    id: 'legal-baseline',
    score: leadScore(fallback, memory.trumpSuit, memory.levelRank),
    summary: `合法出牌基线：${formatCards(fallback)}。`,
    cardIds: fallback.map((card) => card.id),
    risks: []
  });
  return candidates;
}

function toCandidate(id: string, scored: ScoredCards): StrategyCandidate {
  return {
    id,
    score: scored.score,
    summary: `${scored.summary} ${formatCards(scored.cards)}。`,
    cardIds: scored.cards.map((card) => card.id),
    risks: scored.risks
  };
}

function cardsDoor(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): EffectiveSuit | 'mixed' {
  const doors = new Set(cards.map((card) => effectiveSuit(card, trumpSuit, levelRank)));
  return doors.size === 1 ? [...doors][0] : 'mixed';
}

function groupByLogicalCard(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): Card[][] {
  const grouped = new Map<string, Card[]>();
  for (const card of cards) {
    const key = logicalCardKey(card, trumpSuit, levelRank);
    grouped.set(key, [...(grouped.get(key) ?? []), card]);
  }
  return [...grouped.values()].sort((a, b) => compareLogicalCards(a[0], b[0], trumpSuit, levelRank));
}

function sumPoints(cards: Card[]): number {
  return cards.reduce((sum, card) => sum + pointValue(card), 0);
}

function riskPenalty(risks: StrategyRisk[]): number {
  return risks.reduce((sum, risk) => {
    if (risk.severity === 'bad') return sum + 35;
    if (risk.severity === 'warn') return sum + 15;
    return sum + 3;
  }, 0);
}

function formatCards(cards: Card[]): string {
  return cards.length ? cards.map(cardLabel).join(' ') : '[]';
}
