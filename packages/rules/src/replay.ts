import { friendCallRankForLevel } from './cards.js';
import { hostTeamSeats } from './engine.js';
import { badDecisionLines, learningSummary } from './strategy.js';
import type { GameState } from './types.js';

export type ReplayAnalysis = {
  title: string;
  summary: string;
  friendTimeline: string[];
  scoringTimeline: string[];
  keyMoments: string[];
  aiDecisionTimeline: string[];
  badDecisionTimeline: string[];
  learningSummary: string;
};

export function analyzeReplay(state: GameState): ReplayAnalysis {
  const hostTeam = hostTeamSeats(state);
  const friendTimeline = state.friendCalls.map((call) => {
    const rank = call.rank ?? friendCallRankForLevel(state.dealerLevel);
    if (call.matchedBy === null) {
      return `${call.suit}第${call.nth}张${rank}未触发，相关分数最终并入闲家。`;
    }
    const player = state.seats[call.matchedBy];
    return `${player.name} 在第${call.matchedTrick}墩暴露为朋友，暴露前暂存 ${call.pointsAtReveal ?? 0} 分追溯归庄家队。`;
  });

  const scoringTimeline = state.seats.map((seat) => {
    const team = hostTeam.includes(seat.seat) ? '庄家队' : '闲家队';
    return `${seat.name}：${seat.personalPoints} 分，最终归入${team}。`;
  });

  const result = state.result;
  const penaltyText = result?.mandatoryBottomPenalty
    ? `，${result.mandatoryBottomPenalty.kind === 'main' ? '主' : '副'}${result.mandatoryBottomPenalty.rank}抠底，庄家队${formatMandatoryPenaltyTarget(result.mandatoryBottomPenalty)}${formatMandatoryPenaltyAffected(state, result.mandatoryBottomPenalty)}`
    : '';
  const keyMoments = state.events
    .filter((event) => ['trump.bid', 'trump.counter', 'kitty.bury', 'friend.reveal', 'trick.complete', 'round.finish'].includes(event.type))
    .slice(-12)
    .map((event) => event.message);
  const aiDecisionTimeline = state.events
    .filter((event) => event.type === 'ai.decision')
    .slice(-12)
    .map((event) => event.message);

  return {
    title: `第${state.round}局复盘`,
    summary: result
      ? `闲家总分 ${result.attackerPoints}，底分 ${result.kittyPoints}，抠底倍数 ${result.kittyMultiplier}，结果：${formatOutcome(result)}${penaltyText}。`
      : '牌局尚未结束，当前只能生成过程复盘。',
    friendTimeline,
    scoringTimeline,
    keyMoments,
    aiDecisionTimeline,
    badDecisionTimeline: badDecisionLines(state),
    learningSummary: learningSummary(state)
  };
}

function formatOutcome(result: NonNullable<GameState['result']>) {
  if (result.outcome === 'host-big-shutout') return '大光，庄家队升3级';
  if (result.outcome === 'host-small-shutout') return '小光，庄家队升2级';
  if (result.outcome === 'host-level-up') return '庄家队升1级';
  if (result.outcome === 'attackers-down') return '庄家下台，闲家上台不升级';
  return `闲家升${result.levelDelta}级`;
}

function formatMandatoryPenaltyTarget(
  penalty: NonNullable<NonNullable<GameState['result']>['mandatoryBottomPenalty']>
) {
  return penalty.target ? `打回${penalty.target}` : '按个人级数打回';
}

function formatMandatoryPenaltyAffected(
  state: GameState,
  penalty: NonNullable<NonNullable<GameState['result']>['mandatoryBottomPenalty']>
) {
  if (penalty.affected.length === 0) return '';
  return `（${penalty.affected.map((item) => `${state.seats[item.seat].name}${item.from}->${item.to}`).join('、')}）`;
}
