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
    if (call.matchedBy === null) {
      return `${call.suit}第${call.nth}张A未触发，相关分数最终并入闲家。`;
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
    ? `，${result.mandatoryBottomPenalty.kind === 'main' ? '主' : '副'}${result.mandatoryBottomPenalty.rank}抠底，庄家队打回${result.mandatoryBottomPenalty.target}${formatMandatoryPenaltyAffected(state, result.mandatoryBottomPenalty)}`
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
      ? `闲家总分 ${result.attackerPoints}，底分 ${result.kittyPoints}，抠底倍数 ${result.kittyMultiplier}，结果：${result.outcome}${penaltyText}。`
      : '牌局尚未结束，当前只能生成过程复盘。',
    friendTimeline,
    scoringTimeline,
    keyMoments,
    aiDecisionTimeline,
    badDecisionTimeline: badDecisionLines(state),
    learningSummary: learningSummary(state)
  };
}

function formatMandatoryPenaltyAffected(
  state: GameState,
  penalty: NonNullable<NonNullable<GameState['result']>['mandatoryBottomPenalty']>
) {
  if (penalty.affected.length === 0) return '';
  return `（${penalty.affected.map((item) => `${state.seats[item.seat].name}${item.from}->${item.to}`).join('、')}）`;
}
