import {
  NORMAL_SUITS,
  type Card,
  type EffectiveSuit,
  type NormalRank,
  type NormalSuit,
  type TrumpSuit,
  cardLabel,
  effectiveRankValue,
  effectiveSuit,
  pointValue,
  sortCards
} from './cards.js';
import type {
  GameIntent,
  GameState,
  SeatIndex,
  StrategyCandidate,
  StrategyDecisionReport,
  StrategyRisk,
  UpgradeObjective
} from './types.js';

const TARGET_LINES = {
  host: '闲家 <240 保升，1-119 小光升2级，0分大光升3级',
  attackers: '闲家 >=240 下台并升级，末墩抠底会放大底分',
  hidden: '身份未明时先保留控牌和结构，等朋友暴露后再服务明确队伍'
} as const;

type GroupInfo = {
  key: string;
  label: string;
  door: EffectiveSuit;
  cards: Card[];
};

export function describeUpgradeObjective(state: GameState, seat: SeatIndex): UpgradeObjective {
  const matchedHost = new Set<SeatIndex>();
  if (state.dealerSeat !== null) matchedHost.add(state.dealerSeat);
  for (const call of state.friendCalls) {
    if (call.matchedBy !== null) matchedHost.add(call.matchedBy);
  }

  if (state.dealerSeat === null) {
    return {
      team: 'unknown',
      target: 'survive-hidden',
      scoreLine: TARGET_LINES.hidden,
      summary: '庄家未定，先以保留控牌结构为目标。'
    };
  }

  if (matchedHost.has(seat)) {
    return {
      team: 'host',
      target: 'host-level-up',
      scoreLine: TARGET_LINES.host,
      summary: '本方按庄家队处理，所有动作优先服务守底和压低闲家分。'
    };
  }

  const hasHiddenFriend = state.friendCalls.some((call) => call.matchedBy === null);
  if (hasHiddenFriend || state.phase === 'bury' || state.phase === 'friend-call') {
    return {
      team: 'hidden',
      target: 'survive-hidden',
      scoreLine: TARGET_LINES.hidden,
      summary: '朋友身份尚未完全明朗，先避免破坏升级所需的控牌结构。'
    };
  }

  return {
    team: 'attackers',
    target: 'attackers-level-up',
    scoreLine: TARGET_LINES.attackers,
    summary: '本方按闲家队处理，目标是突破240分并争末墩抠底。'
  };
}

export function chooseUpgradeBury(state: GameState, seat: SeatIndex): { cards: Card[]; report: StrategyDecisionReport } {
  const player = state.seats[seat];
  const trumpSuit = requireTrumpSuit(state);
  const pool = player.hand.filter((card) => card.rank !== 'A');
  const selected = scoreBuryCards(pool, trumpSuit, state.dealerLevel)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 9)
    .map((entry) => entry.card);
  return { cards: selected, report: analyzeBurySelection(state, seat, selected) };
}

export function analyzeBurySelection(state: GameState, seat: SeatIndex, selected: Card[]): StrategyDecisionReport {
  const trumpSuit = requireTrumpSuit(state);
  const handBefore = state.seats[seat].hand;
  const selectedIds = new Set(selected.map((card) => card.id));
  const handAfter = handBefore.filter((card) => !selectedIds.has(card.id));
  const risks = detectBuryRisks(handBefore, selected, trumpSuit, state.dealerLevel);
  const selectedPoints = sumCardPoints(selected);
  const reasons = [
    describeUpgradeObjective(state, seat).summary,
    `扣底分 ${selectedPoints}，目标是降低被末墩抠底后的放大损失。`,
    ...structureReasons(handBefore, handAfter, trumpSuit, state.dealerLevel)
  ];
  if (risks.length === 0) {
    reasons.push('未发现扣主控、扣强结构或只看0分单牌的明显问题。');
  }

  const pointOnly = pointOnlyBury(handBefore, trumpSuit, state.dealerLevel);
  const pointOnlyRisks = detectBuryRisks(handBefore, pointOnly, trumpSuit, state.dealerLevel);
  const score = 100 - riskPenalty(risks) - selectedPoints;

  return {
    seat,
    phase: state.phase,
    action: 'bury',
    objective: describeUpgradeObjective(state, seat),
    score,
    selectedCardIds: selected.map((card) => card.id),
    reasons,
    risks,
    candidates: [
      {
        id: 'upgrade-oriented',
        score,
        summary: `升级导向扣底：${formatCards(selected)}。`,
        cardIds: selected.map((card) => card.id),
        risks
      },
      {
        id: 'point-only-baseline',
        score: 100 - riskPenalty(pointOnlyRisks) - sumCardPoints(pointOnly),
        summary: `只按分值扣底基线：${formatCards(pointOnly)}。`,
        cardIds: pointOnly.map((card) => card.id),
        risks: pointOnlyRisks
      }
    ],
    handBefore: summarizeHandStructure(handBefore, trumpSuit, state.dealerLevel),
    handAfter: summarizeHandStructure(handAfter, trumpSuit, state.dealerLevel)
  };
}

export function chooseFriendCallsForUpgrade(
  state: GameState,
  seat: SeatIndex
): { calls: { suit: NormalSuit; nth: number }[]; report: StrategyDecisionReport } {
  const trumpSuit = state.trumpSuit;
  const availableSuits = NORMAL_SUITS.filter((suit) => suit !== trumpSuit);
  const ownAces = new Map<NormalSuit, number>();
  for (const suit of NORMAL_SUITS) ownAces.set(suit, 0);
  for (const card of state.seats[seat].hand) {
    if (card.suit !== 'joker' && card.rank === 'A') ownAces.set(card.suit, (ownAces.get(card.suit) ?? 0) + 1);
  }
  const power = estimateHostPower(state, seat);
  const candidates: StrategyCandidate[] = [];

  for (const suit of availableSuits) {
    const ownCount = ownAces.get(suit) ?? 0;
    for (let nth = 1; nth <= 6; nth += 1) {
      const selfHit = nth <= ownCount;
      const risks: StrategyRisk[] = selfHit
        ? [{
            code: 'self-friend',
            severity: power >= 85 ? 'warn' : 'bad',
            message: `${suit}第${nth}张A大概率叫到自己；牌力不明朗时等于少找朋友。`
          }]
        : [];
      const distanceFromNextExternal = Math.abs(nth - Math.min(6, ownCount + 1));
      const score = 70 - distanceFromNextExternal * 6 - (selfHit ? (power >= 85 ? 18 : 70) : 0);
      candidates.push({
        id: `${suit}:${nth}`,
        score,
        summary: `${suit}第${nth}张A${selfHit ? '（自找风险）' : '（优先找外部朋友）'}`,
        calls: [{ suit, nth }],
        risks
      });
    }
  }

  const selected: { suit: NormalSuit; nth: number }[] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const call = candidate.calls?.[0];
    if (!call) continue;
    if (selected.some((item) => item.suit === call.suit && item.nth === call.nth)) continue;
    selected.push(call);
    if (selected.length === 2) break;
  }

  const selectedRisks = selected.flatMap((call) => {
    const ownCount = ownAces.get(call.suit) ?? 0;
    if (call.nth > ownCount) return [];
    return [{
      code: 'self-friend',
      severity: power >= 85 ? 'warn' : 'bad',
      message: `${call.suit}第${call.nth}张A会先命中自己，只有强牌独打才应接受。`
    } satisfies StrategyRisk];
  });

  return {
    calls: selected,
    report: {
      seat,
      phase: state.phase,
      action: 'call-friends',
      objective: describeUpgradeObjective(state, seat),
      score: 100 - riskPenalty(selectedRisks),
      selectedCalls: selected,
      reasons: [
        describeUpgradeObjective(state, seat).summary,
        `庄家牌力估计 ${power}，普通牌力优先找外部朋友，强牌才允许自找。`
      ],
      risks: selectedRisks,
      candidates: candidates.slice(0, 8)
    }
  };
}

export function reportSimpleDecision(
  state: GameState,
  seat: SeatIndex,
  action: StrategyDecisionReport['action'],
  selectedCardIds: string[],
  reasons: string[]
): StrategyDecisionReport {
  const selected = state.seats[seat].hand.filter((card) => selectedCardIds.includes(card.id));
  const risks: StrategyRisk[] = [];
  const selectedPoints = sumCardPoints(selected);
  if (action === 'play' && selectedPoints >= 30) {
    risks.push({
      code: 'single-card-thinking',
      severity: 'info',
      message: `本手打出 ${selectedPoints} 分，需要结合控分和当前墩归属复盘。`,
      cardIds: selected.map((card) => card.id)
    });
  }
  return {
    seat,
    phase: state.phase,
    action,
    objective: describeUpgradeObjective(state, seat),
    score: 100 - riskPenalty(risks),
    selectedCardIds,
    reasons: [describeUpgradeObjective(state, seat).summary, ...reasons],
    risks
  };
}

export function strategyDecisionMessage(report: StrategyDecisionReport): string {
  const riskText = report.risks.filter((risk) => risk.severity !== 'info').length;
  const suffix = riskText > 0 ? `，发现${riskText}个风险` : '，未发现明显坏决策';
  return `AI-${report.seat + 1} ${actionLabel(report.action)}：${report.objective.scoreLine}${suffix}`;
}

export function summarizeHandStructure(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank) {
  const groups = groupCards(cards, trumpSuit, levelRank);
  const doors = new Map<EffectiveSuit, { count: number; points: number; controls: number; tupleGroups: number }>();
  for (const card of cards) {
    const door = effectiveSuit(card, trumpSuit, levelRank);
    const current = doors.get(door) ?? { count: 0, points: 0, controls: 0, tupleGroups: 0 };
    current.count += 1;
    current.points += pointValue(card);
    if (isControlCard(card, trumpSuit, levelRank)) current.controls += 1;
    doors.set(door, current);
  }
  for (const group of groups) {
    if (group.cards.length >= 2) {
      const current = doors.get(group.door);
      if (current) current.tupleGroups += 1;
    }
  }
  return {
    total: cards.length,
    points: sumCardPoints(cards),
    trumpCount: doors.get('trump')?.count ?? 0,
    doors: [...doors.entries()].map(([door, value]) => ({ door, ...value })),
    strongGroups: groups
      .filter((group) => group.cards.length >= 2)
      .map((group) => ({
        key: group.key,
        label: group.label,
        door: group.door,
        count: group.cards.length,
        points: sumCardPoints(group.cards),
        cardIds: group.cards.map((card) => card.id)
      }))
  };
}

export function badDecisionLines(state: GameState): string[] {
  return state.events
    .filter((event) => event.type === 'ai.decision')
    .flatMap((event) => {
      const report = event.payload as StrategyDecisionReport | undefined;
      if (!report?.risks) return [];
      return report.risks
        .filter((risk) => risk.severity !== 'info')
        .map((risk) => `#${event.seq} ${state.seats[report.seat]?.name ?? `AI-${report.seat + 1}`}：${risk.message}`);
    });
}

export function learningSummary(state: GameState): string {
  const reports = state.events
    .filter((event) => event.type === 'ai.decision')
    .map((event) => event.payload as StrategyDecisionReport)
    .filter((report) => report?.action);
  if (reports.length === 0) return '本局还没有可学习的 AI 决策快照。';
  const risky = reports.filter((report) => report.risks.some((risk) => risk.severity !== 'info'));
  const buryReports = reports.filter((report) => report.action === 'bury');
  return `本局记录 ${reports.length} 个 AI 决策快照，其中 ${risky.length} 个带风险；扣底样本 ${buryReports.length} 个。`;
}

function scoreBuryCards(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank) {
  const groups = groupCards(cards, trumpSuit, levelRank);
  const groupSize = new Map(groups.map((group) => [group.key, group.cards.length]));
  const suitSize = new Map<NormalSuit, number>();
  for (const suit of NORMAL_SUITS) {
    suitSize.set(suit, cards.filter((card) => card.suit === suit && effectiveSuit(card, trumpSuit, levelRank) !== 'trump').length);
  }
  return cards.map((card) => {
    let cost = pointValue(card) * 9 + rankKeepValue(card, trumpSuit, levelRank);
    const door = effectiveSuit(card, trumpSuit, levelRank);
    if (door === 'trump') cost += 85;
    if (card.suit !== 'joker' && card.rank === levelRank) cost += 90;
    if (card.suit === 'joker') cost += 140;
    const count = groupSize.get(groupKey(card, trumpSuit, levelRank)) ?? 1;
    if (count >= 4) cost += 55;
    else if (count === 3) cost += 28;
    else if (count === 2) cost += 12;
    if (card.suit !== 'joker' && door !== 'trump') {
      const size = suitSize.get(card.suit) ?? 0;
      if (size <= 2) cost -= 25;
      else if (size <= 4) cost -= 8;
    }
    return { card, cost };
  });
}

function detectBuryRisks(
  handBefore: Card[],
  selected: Card[],
  trumpSuit: TrumpSuit,
  levelRank: NormalRank
): StrategyRisk[] {
  const risks: StrategyRisk[] = [];
  const selectedIds = new Set(selected.map((card) => card.id));
  const selectedPoints = sumCardPoints(selected);
  if (selectedPoints >= 30) {
    risks.push({
      code: 'bury-bottom-points',
      severity: selectedPoints >= 60 ? 'bad' : 'warn',
      message: `底牌有 ${selectedPoints} 分，被闲家末墩抠底会放大影响升级线。`,
      cardIds: selected.filter((card) => pointValue(card) > 0).map((card) => card.id)
    });
  }

  const controls = selected.filter((card) => isControlCard(card, trumpSuit, levelRank));
  if (controls.length > 0) {
    risks.push({
      code: 'bury-control-card',
      severity: 'bad',
      message: `扣掉 ${formatCards(controls)}，这是主牌/级牌/王一类控牌。`,
      cardIds: controls.map((card) => card.id)
    });
  }

  for (const group of groupCards(handBefore, trumpSuit, levelRank)) {
    const selectedInGroup = group.cards.filter((card) => selectedIds.has(card.id));
    if (selectedInGroup.length === 0 || group.cards.length < 2) continue;
    if (selectedInGroup.length < group.cards.length) {
      risks.push({
        code: 'break-structure',
        severity: group.cards.length >= 4 ? 'bad' : 'warn',
        message: `扣掉 ${selectedInGroup.length}/${group.cards.length} 张 ${group.label}，拆散了原有结构。`,
        cardIds: selectedInGroup.map((card) => card.id)
      });
      continue;
    }
    if (group.cards.length >= 4) {
      risks.push({
        code: 'bury-structure',
        severity: 'bad',
        message: `整组扣掉 ${group.cards.length} 张 ${group.label}，这是控牌结构，不应按0分单牌处理。`,
        cardIds: selectedInGroup.map((card) => card.id)
      });
    } else if (group.cards.length >= 2) {
      risks.push({
        code: 'bury-structure',
        severity: 'warn',
        message: `整组扣掉 ${group.cards.length} 张 ${group.label}，需要确认短门收益高于结构损失。`,
        cardIds: selectedInGroup.map((card) => card.id)
      });
    }
  }

  if (risks.some((risk) => risk.code === 'bury-structure' || risk.code === 'break-structure') &&
      selected.every((card) => pointValue(card) === 0)) {
    risks.push({
      code: 'single-card-thinking',
      severity: 'bad',
      message: '这手扣底呈现只看0分、不看结构的坏决策特征。'
    });
  }
  return risks;
}

function pointOnlyBury(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): Card[] {
  return sortCards(cards.filter((card) => card.rank !== 'A'), trumpSuit, levelRank)
    .sort((a, b) => pointValue(a) - pointValue(b))
    .slice(0, 9);
}

function structureReasons(
  handBefore: Card[],
  handAfter: Card[],
  trumpSuit: TrumpSuit,
  levelRank: NormalRank
): string[] {
  const before = summarizeHandStructure(handBefore, trumpSuit, levelRank);
  const after = summarizeHandStructure(handAfter, trumpSuit, levelRank);
  const reasons: string[] = [];
  if (after.trumpCount >= before.trumpCount - 1) reasons.push('尽量保留主牌和级牌控制，服务守底/抢分线。');
  const beforeDoors = new Map(before.doors.map((door) => [door.door, door.count]));
  const voided = after.doors.filter((door) => door.door !== 'trump' && door.count === 0 && (beforeDoors.get(door.door) ?? 0) > 0);
  if (voided.length > 0) reasons.push(`扣后形成 ${voided.map((door) => door.door).join('、')} 断门，后续更容易毙牌或脱手。`);
  return reasons;
}

function estimateHostPower(state: GameState, seat: SeatIndex): number {
  const trumpSuit = requireTrumpSuit(state);
  const hand = state.seats[seat].hand;
  const structure = summarizeHandStructure(hand, trumpSuit, state.dealerLevel);
  const controls = structure.doors.reduce((sum, door) => sum + door.controls, 0);
  const strongGroups = structure.strongGroups.filter((group) => group.count >= 3).length;
  return Math.min(100, structure.trumpCount * 2 + controls * 7 + strongGroups * 8);
}

function groupCards(cards: Card[], trumpSuit: TrumpSuit, levelRank: NormalRank): GroupInfo[] {
  const groups = new Map<string, GroupInfo>();
  for (const card of cards) {
    const key = groupKey(card, trumpSuit, levelRank);
    const door = effectiveSuit(card, trumpSuit, levelRank);
    const label = card.suit === 'joker' ? cardLabel(card) : `${card.rank}${suitSymbol(card.suit)}`;
    const group = groups.get(key) ?? { key, label, door, cards: [] };
    group.cards.push(card);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function groupKey(card: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): string {
  const door = effectiveSuit(card, trumpSuit, levelRank);
  if (card.suit === 'joker') return `${door}:${card.rank}`;
  return `${door}:${card.suit}:${card.rank}`;
}

function rankKeepValue(card: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): number {
  if (card.suit === 'joker') return 80;
  if (card.rank === levelRank) return 60;
  const value = effectiveRankValue(card, trumpSuit, levelRank);
  if (value >= 13) return 12;
  if (value >= 11) return 8;
  if (value >= 9) return 4;
  return 0;
}

function isControlCard(card: Card, trumpSuit: TrumpSuit, levelRank: NormalRank): boolean {
  return effectiveSuit(card, trumpSuit, levelRank) === 'trump' ||
    card.suit === 'joker' ||
    card.rank === levelRank;
}

function riskPenalty(risks: StrategyRisk[]): number {
  return risks.reduce((sum, risk) => {
    if (risk.severity === 'bad') return sum + 35;
    if (risk.severity === 'warn') return sum + 15;
    return sum + 3;
  }, 0);
}

function sumCardPoints(cards: Card[]): number {
  return cards.reduce((sum, card) => sum + pointValue(card), 0);
}

function formatCards(cards: Card[]): string {
  return cards.length ? cards.map(cardLabel).join(' ') : '[]';
}

function requireTrumpSuit(state: GameState): TrumpSuit {
  return state.trumpSuit ?? state.currentBid?.suit ?? 'spades';
}

function actionLabel(action: StrategyDecisionReport['action']): string {
  return {
    bid: '亮主/反底决策',
    'pass-counter': '不亮/不反决策',
    bury: '扣底决策',
    'call-friends': '找朋友决策',
    play: '出牌决策'
  }[action];
}

function suitSymbol(suit: NormalSuit): string {
  return { spades: '♠', hearts: '♥', clubs: '♣', diamonds: '♦' }[suit];
}

export function withStrategy<T extends GameIntent>(intent: T, strategy: StrategyDecisionReport): T {
  return { ...intent, strategy };
}
