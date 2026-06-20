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
import { classifyPlay, hostTeamSeats, legalCardsForSimplePlay } from './engine.js';
import {
  allOthersVoid,
  anyOpponentCanStillHoldDoor,
  buildTableMemory,
  doorCards,
  type Door,
  type TableMemory
} from './memory.js';
import { describeUpgradeObjective } from './strategy.js';
import {
  SEATS,
  type GameState,
  type PlayShape,
  type SeatIndex,
  type StrategyCandidate,
  type StrategyDecisionReport,
  type StrategyRisk,
  type UpgradeObjective
} from './types.js';

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
    const selected = chooseFollowWithPointSafety(state, seat, memory, fallback);
    return {
      cards: selected.cards,
      report: playReport(
        state,
        seat,
        selected.cards,
        describeUpgradeObjective(state, seat),
        selected.risks,
        [selected.summary],
        followCandidatesForReport(fallback, selected, memory)
      )
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
  const ownCalledAce = ownCalledAceLeadCandidate(state, seat, memory);
  if (ownCalledAce) return ownCalledAce;

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
      risks: [forcedTrumpRisk(trumpRisk)]
    };
  }

  const pointLeadRisk = unsafePointLeadRisk(state, seat, memory, fallback);
  if (pointLeadRisk) {
    const zeroPointLead = bestZeroPointLead(hand, memory, fallback);
    if (zeroPointLead) return zeroPointLead;
    return {
      cards: fallback,
      score: 15,
      summary: '首出单张分牌没有被记忆证明安全，也缺少后续控制结构；本手没有可替换的0分首出，只能保留并标记复盘。',
      risks: [pointLeadRisk]
    };
  }

  return {
    cards: fallback,
    score: 50,
    summary: '当前没有更高优先级的牌情策略，使用合法出牌基线。',
    risks: trumpRisk ? [trumpRisk] : []
  };
}

function chooseFollowWithPointSafety(state: GameState, seat: SeatIndex, memory: TableMemory, fallback: Card[]): ScoredCards {
  if (sumPoints(fallback) === 0) {
    return {
      cards: fallback,
      score: 70,
      summary: '跟牌候选不含5/10/K，优先满足牌型和同门约束。',
      risks: []
    };
  }

  const safety = pointFollowSafety(state, seat, memory, fallback);
  if (safety.safe) {
    return {
      cards: fallback,
      score: 90,
      summary: safety.summary,
      risks: []
    };
  }

  const lowPoint = lowPointFollowAlternative(state, seat, memory);
  if (lowPoint) {
    return {
      cards: lowPoint,
      score: 95,
      summary: `${safety.summary} 改垫0分低牌，避免把5/10/K送进不确定或敌方牌墩。`,
      risks: []
    };
  }

  return {
    cards: fallback,
    score: 20,
    summary: `${safety.summary} 没有合法0分替代牌，只能按合法基线出牌并标记复盘。`,
    risks: [{
      code: 'unsafe-point-play',
      severity: 'bad',
      message: '当前墩归属不安全时仍被迫打出5/10/K，后续需要复盘是否可通过前序控牌避免。',
      cardIds: fallback.map((card) => card.id)
    }]
  };
}

function pointFollowSafety(
  state: GameState,
  seat: SeatIndex,
  memory: TableMemory,
  fallback: Card[]
): { safe: boolean; summary: string } {
  const relation = currentWinnerRelation(state, seat);
  const selectedCanWin = beatsCurrentWinner(state, fallback);
  const followDoor = cardsDoor(fallback, memory.trumpSuit, memory.levelRank);
  const lowThreat = followDoor !== 'mixed' && laterThreatLow(state, seat, memory, followDoor);

  if (relation === 'teammate' && lowThreat) {
    return {
      safe: true,
      summary: '当前最大牌属于本方，且后手威胁低，可以把分送进本方牌墩。'
    };
  }

  if (relation === 'opponent' && selectedCanWin && lowThreat) {
    return {
      safe: true,
      summary: '当前最大牌属于敌方，但本手能接管且后手威胁低，可以上分争取收墩。'
    };
  }

  if (relation === 'opponent' && !selectedCanWin) {
    return {
      safe: false,
      summary: '当前最大牌属于敌方且本手不能赢，不主动上5/10/K。'
    };
  }

  if (relation === 'teammate') {
    return {
      safe: false,
      summary: '当前最大牌虽属本方，但后手仍可能截获，暂不上5/10/K。'
    };
  }

  return {
    safe: false,
    summary: '当前墩尚不能确认会归本方，不主动上5/10/K。'
  };
}

function ownCalledAceLeadCandidate(state: GameState, seat: SeatIndex, memory: TableMemory): ScoredCards | null {
  if (state.dealerSeat !== seat) return null;
  const candidates = state.friendCalls.flatMap((call): ScoredCards[] => {
    if (call.matchedBy !== null) return [];
    const ownAces = state.seats[seat].hand.filter((card) => {
      return card.suit === call.suit &&
        card.rank === 'A' &&
        effectiveSuit(card, memory.trumpSuit, memory.levelRank) !== 'trump';
    });
    if (ownAces.length === 0) return [];
    if (call.seen + ownAces.length >= call.nth) return [];
    const sorted = sortCards(ownAces, memory.trumpSuit, memory.levelRank);
    return [{
      cards: sorted,
      score: 1100 + sorted.length * 25,
      summary: `已叫${call.suit}第${call.nth}张A且自己持有${sorted.length}张，先主动打掉自有A，避免后续被迫跟牌叫回自己。`,
      risks: []
    }];
  });
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function currentWinnerRelation(state: GameState, seat: SeatIndex): 'teammate' | 'opponent' | 'uncertain' {
  const winner = state.currentTrick?.winner;
  if (winner === null || winner === undefined) return 'uncertain';
  if (isKnownTeammate(state, seat, winner)) return 'teammate';
  if (isKnownOpponent(state, seat, winner)) return 'opponent';
  return 'uncertain';
}

function isKnownTeammate(state: GameState, seat: SeatIndex, other: SeatIndex): boolean {
  if (seat === other) return true;
  const objective = describeUpgradeObjective(state, seat);
  const hosts = hostTeamSeats(state);
  if (objective.team === 'host') return hosts.includes(other);
  if (objective.team === 'attackers') return !hosts.includes(other);
  return false;
}

function isKnownOpponent(state: GameState, seat: SeatIndex, other: SeatIndex): boolean {
  const objective = describeUpgradeObjective(state, seat);
  const hosts = hostTeamSeats(state);
  if (objective.team === 'host') return !hosts.includes(other);
  if (objective.team === 'attackers') return hosts.includes(other);
  return false;
}

function laterThreatLow(state: GameState, seat: SeatIndex, memory: TableMemory, door: Door): boolean {
  const laterSeats = seatsStillToPlay(state, seat);
  if (laterSeats.length === 0) return true;
  return laterSeats.every((other) => isKnownTeammate(state, seat, other) || !!memory.players[other]?.voidDoors[door]);
}

function seatsStillToPlay(state: GameState, seat: SeatIndex): SeatIndex[] {
  const trick = state.currentTrick;
  if (!trick) return [];
  const played = new Set(trick.plays.map((play) => play.seat));
  const seats: SeatIndex[] = [];
  let next = nextSeat(seat);
  while (next !== trick.leader) {
    if (!played.has(next) && state.seats[next].hand.length > 0) seats.push(next);
    next = nextSeat(next);
  }
  return seats;
}

function nextSeat(seat: SeatIndex): SeatIndex {
  return ((seat + 1) % SEATS.length) as SeatIndex;
}

function beatsCurrentWinner(state: GameState, cards: Card[]): boolean {
  const trick = state.currentTrick;
  if (!trick?.leadShape || trick.winner === null) return false;
  const winningPlay = trick.plays.find((play) => play.seat === trick.winner);
  if (!winningPlay || !state.trumpSuit) return false;
  const candidate = classifyPlay(cards, state.trumpSuit, state.dealerLevel);
  const current = classifyPlay(winningPlay.cards, state.trumpSuit, state.dealerLevel);
  return beatsShape(candidate, current, trick.leadShape);
}

function beatsShape(candidate: PlayShape, current: PlayShape, lead: PlayShape): boolean {
  if (candidate.effectiveSuit === 'mixed') return false;
  if (current.effectiveSuit === 'mixed') return true;
  if (!canCompeteWithLeadShape(candidate, lead)) return false;
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

function canCompeteWithLeadShape(candidate: PlayShape, lead: PlayShape): boolean {
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
  return lead.components.every((component) => {
    const count = candidate.components
      .filter((item) => item.tupleSize >= component.tupleSize)
      .reduce((sum, item) => sum + item.tractorLength, 0);
    return count >= component.tractorLength;
  });
}

function lowPointFollowAlternative(state: GameState, seat: SeatIndex, memory: TableMemory): Card[] | null {
  const trick = state.currentTrick;
  if (!trick?.leadShape || trick.leadShape.count !== 1) return null;
  const hand = state.seats[seat].hand;
  const leadDoor = trick.leadShape.effectiveSuit;
  if (leadDoor !== 'mixed') {
    const matching = hand.filter((card) => effectiveSuit(card, memory.trumpSuit, memory.levelRank) === leadDoor);
    if (matching.length > 0) {
      const zeroPoint = lowestPointCards(matching.filter((card) => pointValue(card) === 0), memory);
      return zeroPoint.length > 0 ? [zeroPoint[0]] : null;
    }
  }

  const zeroPoint = hand.filter((card) => pointValue(card) === 0);
  const nonTrump = zeroPoint.filter((card) => effectiveSuit(card, memory.trumpSuit, memory.levelRank) !== 'trump');
  const pool = nonTrump.length > 0 ? nonTrump : zeroPoint;
  const lowest = lowestPointCards(pool, memory);
  return lowest.length > 0 ? [lowest[0]] : null;
}

function unsafePointLeadRisk(state: GameState, seat: SeatIndex, memory: TableMemory, fallback: Card[]): StrategyRisk | null {
  if (fallback.length !== 1) return null;
  const card = fallback[0];
  if (card.rank !== '10' && card.rank !== 'K') return null;
  const door = cardsDoor(fallback, memory.trumpSuit, memory.levelRank);
  if (door === 'mixed') return null;
  if (allOthersVoid(memory, seat, door)) return null;
  if (hasDoorControlSupport(state.seats[seat].hand, fallback, memory, door)) return null;
  return {
    code: 'unsafe-point-lead',
    severity: 'bad',
    message: '首出单张10/K未被记忆证明安全，也没有同门对子/结构兜底，容易把分主动送进不确定牌墩。',
    cardIds: fallback.map((item) => item.id)
  };
}

function hasDoorControlSupport(hand: Card[], selected: Card[], memory: TableMemory, door: Door): boolean {
  const remaining = doorCards(withoutCards(hand, selected), memory, door);
  if (remaining.length < 2) return false;
  return groupByLogicalCard(remaining, memory.trumpSuit, memory.levelRank).some((group) => group.length >= 2);
}

function bestZeroPointLead(hand: Card[], memory: TableMemory, fallback: Card[]): ScoredCards | null {
  const candidates: ScoredCards[] = [];
  const blocked = new Set(fallback.map((card) => card.id));
  for (const door of [...NORMAL_SUITS, 'trump'] as Door[]) {
    const cards = doorCards(hand, memory, door).filter((card) => pointValue(card) === 0 && !blocked.has(card.id));
    if (cards.length === 0) continue;
    candidates.push(...zeroPointLeadGroups(cards, memory.trumpSuit, memory.levelRank).map((group) => ({
      cards: group,
      score: (door === 'trump' ? 0 : 25) + leadScore(group, memory.trumpSuit, memory.levelRank),
      summary: `首出单张10/K不安全，改从${doorName(door)}出0分低风险牌，先不主动送分。`,
      risks: []
    })));
  }
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function zeroPointLeadGroups(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): Card[][] {
  const groups = groupByLogicalCard(cards, trumpSuit, levelRank);
  const structured = groups
    .filter((group) => group.length >= 2 && sumPoints(group) === 0)
    .sort((a, b) => b.length - a.length || effectiveRankValue(b[0], trumpSuit, levelRank) - effectiveRankValue(a[0], trumpSuit, levelRank));
  if (structured.length > 0) return structured;
  return lowestPointCards(cards, { trumpSuit, levelRank }).slice(0, 1).map((card) => [card]);
}

function lowestPointCards(cards: Card[], memory: Pick<TableMemory, 'trumpSuit' | 'levelRank'>): Card[] {
  return [...cards].sort((a, b) => {
    return pointValue(a) - pointValue(b) ||
      effectiveRankValue(a, memory.trumpSuit, memory.levelRank) - effectiveRankValue(b, memory.trumpSuit, memory.levelRank) ||
      a.id.localeCompare(b.id);
  });
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

function forcedTrumpRisk(risk: StrategyRisk): StrategyRisk {
  return {
    ...risk,
    severity: 'warn',
    message: '已知仍有人可能有主，但本手没有可用副牌首出，只能出主并等待复盘主牌控制权。'
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
  const ownCalledAce = ownCalledAceLeadCandidate(state, seat, memory);
  if (ownCalledAce) candidates.push(toCandidate('own-called-ace-lead', ownCalledAce));
  const safe = safeTossCandidate(hand, memory, seat);
  if (safe) candidates.push(toCandidate('safe-toss', safe));
  const nonTrump = bestNonTrumpLead(hand, memory);
  if (nonTrump) candidates.push(toCandidate('non-trump-lead', nonTrump));
  const zeroPointLead = bestZeroPointLead(hand, memory, fallback);
  if (zeroPointLead) candidates.push(toCandidate('point-safe-lead', zeroPointLead));
  candidates.push({
    id: 'legal-baseline',
    score: leadScore(fallback, memory.trumpSuit, memory.levelRank),
    summary: `合法出牌基线：${formatCards(fallback)}。`,
    cardIds: fallback.map((card) => card.id),
    risks: []
  });
  return candidates;
}

function followCandidatesForReport(fallback: Card[], selected: ScoredCards, memory: TableMemory): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  if (!sameCards(fallback, selected.cards)) {
    candidates.push(toCandidate('point-safe-follow', selected));
  }
  candidates.push({
    id: 'legal-baseline',
    score: leadScore(fallback, memory.trumpSuit, memory.levelRank),
    summary: `合法跟牌基线：${formatCards(fallback)}。`,
    cardIds: fallback.map((card) => card.id),
    risks: sumPoints(fallback) > 0 ? [{
      code: 'unsafe-point-play',
      severity: 'warn',
      message: '合法基线含5/10/K，需结合当前赢家归属和后手威胁判断是否采用。',
      cardIds: fallback.map((card) => card.id)
    }] : []
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

function doorName(door: Door): string {
  return door === 'trump' ? '主牌' : `${door}门`;
}

function withoutCards(cards: Card[], selected: Card[]): Card[] {
  const selectedIds = new Set(selected.map((card) => card.id));
  return cards.filter((card) => !selectedIds.has(card.id));
}

function sameCards(a: Card[], b: Card[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((card) => card.id));
  return b.every((card) => ids.has(card.id));
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
