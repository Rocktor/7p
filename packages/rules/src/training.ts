import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decideBotIntent } from './ai.js';
import { LEVEL_ORDER, type NormalRank } from './cards.js';
import { createGame, dispatch } from './engine.js';
import type { GameEvent, GameIntent, GameState, RoundResult, SeatIndex, StrategyDecisionReport, StrategyRisk } from './types.js';

export type TrainingOptions = {
  rounds: number;
  seedPrefix: string;
  maxStepsPerRound?: number;
};

export type TrainingRoundSummary = {
  round: number;
  seed: string;
  dealerSeat: SeatIndex | null;
  dealerLevel: NormalRank;
  outcome: RoundResult['outcome'];
  levelDelta: number;
  attackerPoints: number;
  rawAttackerPoints: number;
  bottomSaved: boolean;
  kittyPoints: number;
  kittyMultiplier: number;
  mandatoryPenalty: TrainingMandatoryPenalty | null;
  steps: number;
  decisionCount: number;
  riskCount: number;
  badRiskCount: number;
  riskCodes: Record<string, number>;
  levelsAfter: string[];
  playerStatesAfter: TrainingPlayerState[];
  passedASeats: SeatIndex[];
};

export type TrainingMandatoryPenalty = {
  rank: 'J' | 'A';
  kind: 'main' | 'off';
  target: NormalRank | null;
  affected: {
    seat: SeatIndex;
    from: NormalRank;
    to: NormalRank;
  }[];
};

export type TrainingPlayerState = {
  seat: SeatIndex;
  level: NormalRank;
  passedJ: boolean;
  passedA: boolean;
  label: string;
};

export type TrainingRun = {
  startedAt: string;
  options: Required<TrainingOptions>;
  completedRounds: number;
  stoppedReason: 'round-limit' | 'stuck';
  firstAPassedRound: number | null;
  firstAPassedSeats: SeatIndex[];
  outcomeCounts: Record<RoundResult['outcome'], number>;
  totalDecisions: number;
  totalRisks: number;
  totalBadRisks: number;
  riskCodes: Record<string, number>;
  averageAttackerPoints: number;
  bottomDugRate: number;
  attackerDownRate: number;
  attackerUpgradeRate: number;
  finalLevels: string[];
  rounds: TrainingRoundSummary[];
  doubts: string[];
  rolePlaySummary: string[];
  learningSummary: string[];
};

const PLAYER_COUNT = 7;
const DEFAULT_MAX_STEPS_PER_ROUND = 3000;

export function trainUpgradeAi(options: TrainingOptions): TrainingRun {
  const resolved: Required<TrainingOptions> = {
    rounds: options.rounds,
    seedPrefix: options.seedPrefix,
    maxStepsPerRound: options.maxStepsPerRound ?? DEFAULT_MAX_STEPS_PER_ROUND
  };
  let state = createGame(`training-${resolved.seedPrefix}`, `AI训练 ${resolved.seedPrefix}`);
  for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
    state = dispatch(state, { type: 'toggle-bot', seat: seat as SeatIndex, enabled: true }).state;
  }
  state.events = [];

  const rounds: TrainingRoundSummary[] = [];
  let firstAPassedRound: number | null = null;
  let firstAPassedSeats: SeatIndex[] = [];
  let stoppedReason: TrainingRun['stoppedReason'] = 'round-limit';

  for (let roundIndex = 1; roundIndex <= resolved.rounds; roundIndex += 1) {
    const seed = `${resolved.seedPrefix}-round-${roundIndex}`;
    state = dispatch(state, state.phase === 'lobby' ? { type: 'start-game', seed } : { type: 'next-round', seed }).state;
    const eventStart = state.events.length;
    const { state: finishedState, steps, stuck } = playRoundToFinish(state, resolved.maxStepsPerRound);
    state = finishedState;
    if (stuck || !state.result) {
      stoppedReason = 'stuck';
      break;
    }

    const events = state.events.slice(eventStart);
    const summary = summarizeRound(state, seed, steps, events);
    rounds.push(summary);
    if (firstAPassedRound === null && summary.passedASeats.length > 0) {
      firstAPassedRound = summary.round;
      firstAPassedSeats = summary.passedASeats;
    }
    state.events = [];
  }

  return summarizeRun(new Date().toISOString(), resolved, stoppedReason, firstAPassedRound, firstAPassedSeats, state, rounds);
}

function playRoundToFinish(state: GameState, maxSteps: number): { state: GameState; steps: number; stuck: boolean } {
  let current = state;
  let steps = 0;
  while (current.phase !== 'finished' && steps < maxSteps) {
    const intent = nextTrainingIntent(current);
    if (!intent) return { state: current, steps, stuck: true };
    current = dispatch(current, intent).state;
    steps += 1;
  }
  return { state: current, steps, stuck: current.phase !== 'finished' };
}

function nextTrainingIntent(state: GameState): GameIntent | null {
  if (state.phase === 'bidding' || state.phase === 'counter' || state.phase === 'playing') {
    return state.activeSeat === null ? null : decideBotIntent(state, state.activeSeat);
  }
  if (state.phase === 'bury' && state.bottomOwner !== null) return decideBotIntent(state, state.bottomOwner);
  if (state.phase === 'friend-call' && state.dealerSeat !== null) return decideBotIntent(state, state.dealerSeat);
  return null;
}

function summarizeRound(state: GameState, seed: string, steps: number, events: GameEvent[]): TrainingRoundSummary {
  const result = state.result;
  if (!result) throw new Error('训练轮次尚未结束，不能汇总。');
  const risks = collectRisks(events);
  return {
    round: state.round,
    seed,
    dealerSeat: state.dealerSeat,
    dealerLevel: state.dealerLevel,
    outcome: result.outcome,
    levelDelta: result.levelDelta,
    attackerPoints: result.attackerPoints,
    rawAttackerPoints: result.rawAttackerPoints,
    bottomSaved: result.bottomSaved,
    kittyPoints: result.kittyPoints,
    kittyMultiplier: result.kittyMultiplier,
    mandatoryPenalty: result.mandatoryBottomPenalty
      ? {
          rank: result.mandatoryBottomPenalty.rank,
          kind: result.mandatoryBottomPenalty.kind,
          target: result.mandatoryBottomPenalty.target,
          affected: result.mandatoryBottomPenalty.affected
        }
      : null,
    steps,
    decisionCount: events.filter((event) => event.type === 'ai.decision').length,
    riskCount: risks.length,
    badRiskCount: risks.filter((risk) => risk.severity === 'bad').length,
    riskCodes: countBy(risks.map((risk) => risk.code)),
    levelsAfter: state.seats.map(levelStatusLabel),
    playerStatesAfter: state.seats.map((seat) => ({
      seat: seat.seat,
      level: seat.level,
      passedJ: seat.passedMandatory.J,
      passedA: seat.passedMandatory.A,
      label: levelStatusLabel(seat)
    })),
    passedASeats: state.seats.filter((seat) => seat.passedMandatory.A).map((seat) => seat.seat)
  };
}

function summarizeRun(
  startedAt: string,
  options: Required<TrainingOptions>,
  stoppedReason: TrainingRun['stoppedReason'],
  firstAPassedRound: number | null,
  firstAPassedSeats: SeatIndex[],
  state: GameState,
  rounds: TrainingRoundSummary[]
): TrainingRun {
  const outcomeCounts = emptyOutcomeCounts();
  for (const round of rounds) outcomeCounts[round.outcome] += 1;
  const totalDecisions = sum(rounds.map((round) => round.decisionCount));
  const totalRisks = sum(rounds.map((round) => round.riskCount));
  const totalBadRisks = sum(rounds.map((round) => round.badRiskCount));
  const riskCodes = mergeCounts(rounds.map((round) => round.riskCodes));
  const bottomDug = rounds.filter((round) => !round.bottomSaved).length;
  const attackerDowns = rounds.filter((round) => round.outcome === 'attackers-down' || round.outcome === 'attackers-level-up').length;
  const attackerUpgrades = rounds.filter((round) => round.outcome === 'attackers-level-up').length;
  const averageAttackerPoints = round2(ratio(sum(rounds.map((round) => round.attackerPoints)), rounds.length));
  const run: TrainingRun = {
    startedAt,
    options,
    completedRounds: rounds.length,
    stoppedReason,
    firstAPassedRound,
    firstAPassedSeats,
    outcomeCounts,
    totalDecisions,
    totalRisks,
    totalBadRisks,
    riskCodes,
    averageAttackerPoints,
    bottomDugRate: round2(ratio(bottomDug, rounds.length)),
    attackerDownRate: round2(ratio(attackerDowns, rounds.length)),
    attackerUpgradeRate: round2(ratio(attackerUpgrades, rounds.length)),
    finalLevels: state.seats.map((seat) => `${seat.name}:${seat.level}${seat.passedMandatory.A ? '(A已过)' : ''}`),
    rounds,
    doubts: [],
    rolePlaySummary: [],
    learningSummary: []
  };
  run.doubts = buildDoubts(run);
  run.rolePlaySummary = buildRolePlaySummary(run);
  run.learningSummary = buildLearningSummary(run);
  return run;
}

export function trainingReportMarkdown(run: TrainingRun): string {
  const lines = [
    '# 升级导向 AI 训练报告',
    '',
    '## 训练口径',
    '',
    `- 训练时间：${run.startedAt}`,
    `- 训练轮数：目标 ${run.options.rounds} 轮，完成 ${run.completedRounds} 轮。`,
    `- 随机种子前缀：\`${run.options.seedPrefix}\`。`,
    `- 策略版本：upgrade，自博弈全员 AI。`,
    `- 停止原因：${run.stoppedReason === 'round-limit' ? '达到轮数上限' : '某轮无法继续，已停止'}。`,
    '',
    '## 核心结果',
    '',
    `- A 打过：${run.firstAPassedRound === null ? '100轮内未出现 A 已过' : `第 ${run.firstAPassedRound} 轮首次出现，座位 ${run.firstAPassedSeats.map((seat) => seat + 1).join('、')}`}`,
    `- 平均闲家总分：${run.averageAttackerPoints}`,
    `- 庄家下台率/闲家上台率：${percent(run.attackerDownRate)}；闲家升级率：${percent(run.attackerUpgradeRate)}；抠底成功率：${percent(run.bottomDugRate)}。`,
    `- AI 决策快照：${run.totalDecisions} 个；风险 ${run.totalRisks} 个，其中 bad ${run.totalBadRisks} 个。`,
    '',
    '## 结果分档',
    '',
    `- 0分大光：${run.outcomeCounts['host-big-shutout']} 轮`,
    `- 1-119小光：${run.outcomeCounts['host-small-shutout']} 轮`,
    `- 120-239庄家升1级：${run.outcomeCounts['host-level-up']} 轮`,
    `- 240-359庄家下台、闲家上台但不升级：${run.outcomeCounts['attackers-down']} 轮`,
    `- 360起闲家升级：${run.outcomeCounts['attackers-level-up']} 轮`,
    '',
    '## 风险分布',
    '',
    ...formatCounts(run.riskCodes),
    '',
    '## 训练总结',
    '',
    ...run.learningSummary.map((item) => `- ${item}`),
    '',
    '## AI 扮演复盘',
    '',
    ...run.rolePlaySummary.map((item) => `- ${item}`),
    '',
    '## 疑问登记',
    '',
    ...run.doubts.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 末10轮明细',
    '',
    '| 轮次 | 庄家级 | 结果 | 闲家分 | 底牌 | 风险 | 等级 |',
    '| --- | --- | --- | ---: | --- | ---: | --- |',
    ...run.rounds.slice(-10).map((round) => `| ${round.round} | ${round.dealerLevel} | ${round.outcome}/${round.levelDelta} | ${round.attackerPoints} | ${round.bottomSaved ? '守住' : `${round.kittyPoints}x${round.kittyMultiplier}`} | ${round.badRiskCount}/${round.riskCount} | ${round.levelsAfter.join(' ')} |`)
  ];
  return `${lines.join('\n')}\n`;
}

export function levelProgressMarkdown(run: TrainingRun): string {
  const lines = [
    '# 100轮等级推进明细',
    '',
    '## 说明',
    '',
    '- 每一行是该轮结束后的 1-7 号玩家等级状态。',
    '- `J过` 表示该玩家已经按规则通过 J 必打关。',
    '- `A过` 表示该玩家已经按规则通过 A 必打关。',
    '- `attackers-down/0` 表示庄家下台、闲家上台但闲家不升级；`attackers-level-up/n` 表示闲家上台并升 n 级。',
    '',
    '| 轮次 | 庄家 | 庄家级 | 结果 | 闲家分 | 打回 | 1号 | 2号 | 3号 | 4号 | 5号 | 6号 | 7号 |',
    '| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...run.rounds.map((round) => {
      const cells = round.playerStatesAfter.length > 0 ? round.playerStatesAfter.map((player) => player.label) : round.levelsAfter;
      return `| ${round.round} | ${round.dealerSeat === null ? '-' : round.dealerSeat + 1} | ${round.dealerLevel} | ${round.outcome}/${round.levelDelta} | ${round.attackerPoints} | ${formatPenalty(round.mandatoryPenalty)} | ${cells.join(' | ')} |`;
    })
  ];
  return `${lines.join('\n')}\n`;
}

async function writeTrainingArtifacts(run: TrainingRun, outDir: string) {
  await mkdir(outDir, { recursive: true });
  const slug = `${run.options.seedPrefix}-${run.completedRounds}r-${run.startedAt.replace(/[:.]/g, '-').slice(0, 19)}`;
  const jsonPath = join(outDir, `${slug}.json`);
  const mdPath = join(outDir, `${slug}.md`);
  const levelPath = join(outDir, `${slug}-levels.md`);
  const latestJsonPath = join(outDir, 'latest-upgrade-training.json');
  const latestMdPath = join(outDir, 'latest-upgrade-training.md');
  const latestLevelPath = join(outDir, 'latest-level-progress.md');
  const json = `${JSON.stringify(run, null, 2)}\n`;
  const markdown = trainingReportMarkdown(run);
  const levelMarkdown = levelProgressMarkdown(run);
  await writeFile(jsonPath, json, 'utf8');
  await writeFile(mdPath, markdown, 'utf8');
  await writeFile(levelPath, levelMarkdown, 'utf8');
  await writeFile(latestJsonPath, json, 'utf8');
  await writeFile(latestMdPath, markdown, 'utf8');
  await writeFile(latestLevelPath, levelMarkdown, 'utf8');
  return { jsonPath, mdPath, levelPath, latestJsonPath, latestMdPath, latestLevelPath };
}

function buildLearningSummary(run: TrainingRun): string[] {
  const summary = [
    `当前策略在 ${run.completedRounds} 轮中的庄家队保升轮数为 ${hostOutcomeCount(run)}，庄家下台/闲家上台轮数为 ${run.outcomeCounts['attackers-down'] + run.outcomeCounts['attackers-level-up']}。`,
    `训练期平均每轮 AI 决策 ${round2(ratio(run.totalDecisions, run.completedRounds))} 次，bad 风险 ${round2(ratio(run.totalBadRisks, run.completedRounds))} 次。`
  ];
  if ((run.riskCodes['bury-structure'] ?? 0) > 0 || (run.riskCodes['break-structure'] ?? 0) > 0) {
    summary.push('扣底仍是主要学习点：需要继续减少拆对子、四张同点和控牌结构的选择。');
  }
  if ((run.riskCodes['lead-trump-risk'] ?? 0) === 0) {
    summary.push('首出调主风险在本批样本中没有成为 selected bad risk，说明记忆策略至少避开了已标记的盲目调主。');
  } else {
    summary.push(`首出调主风险出现 ${run.riskCodes['lead-trump-risk']} 次；当前策略已把“无副牌可出”的调主降为 warn，但仍要抽样确认是否存在可避免调主。`);
  }
  if (run.firstAPassedRound === null) {
    summary.push('100轮内没有完成 A 已过，后续训练要强化高等级阶段的保级/过关策略，而不只优化单局分数。');
  } else {
    summary.push(`第 ${run.firstAPassedRound} 轮已经出现 A 已过，可以从这轮前后抽取决策快照做升级路径复盘。`);
  }
  return summary;
}

function buildRolePlaySummary(run: TrainingRun): string[] {
  const last = run.rounds.at(-1);
  const bestAttacker = [...run.rounds].sort((a, b) => b.attackerPoints - a.attackerPoints)[0];
  const worstAttacker = [...run.rounds].sort((a, b) => a.attackerPoints - b.attackerPoints)[0];
  return [
    `我作为庄家队：我的第一目标不是赢一墩，而是把闲家压在 240 以下；如果能压到 0 或 1-119，才追求多升。`,
    `我作为闲家队：240 只是打下庄并上台，不是升级；真正要冲的是 360、480 这些线，末墩抠底的倍数要围绕这些线服务。`,
    `我作为复盘员：最高闲家分出现在第 ${bestAttacker?.round ?? '-'} 轮（${bestAttacker?.attackerPoints ?? 0} 分），最低闲家分出现在第 ${worstAttacker?.round ?? '-'} 轮（${worstAttacker?.attackerPoints ?? 0} 分）。`,
    `我作为训练器：最后一轮结果是 ${last?.outcome ?? '无'}，等级状态 ${last?.levelsAfter.join(' ') ?? '无'}，下一步应抽样检查高风险扣底和高分抠底轮。`
  ];
}

function buildDoubts(run: TrainingRun): string[] {
  const doubts: string[] = [];
  if (run.firstAPassedRound === null) {
    doubts.push('A 打过的验收口径需要确认：当前代码定义为玩家在打 A 时作为庄家队获胜并设置 passedMandatory.A=true；闲家在 A 下台是否也应算过 A？');
  }
  if (run.completedRounds < run.options.rounds) {
    doubts.push(`训练在第 ${run.completedRounds + 1} 轮前停止，说明存在状态机或 AI 无动作场景，需要先定位卡住阶段。`);
  }
  if ((run.riskCodes['bury-bottom-points'] ?? 0) > 0) {
    doubts.push('扣高分底在部分牌型下是否可接受，需要你确认：强庄为了造短门，能否接受 30 分以上底牌风险？');
  }
  if ((run.riskCodes['self-friend'] ?? 0) > 0) {
    doubts.push('强牌自找朋友目前只降级为 warn；需要确认多强才允许自己叫自己。');
  }
  if ((run.riskCodes['lead-trump-risk'] ?? 0) > 0) {
    doubts.push('只有主牌可首出时，训练器现在记为 warn 而非 bad；是否还要进一步区分“剩余全主可控”和“被迫送主”？');
  }
  if (run.attackerUpgradeRate === 0 && run.attackerDownRate > 0) {
    doubts.push('闲家已经能下台但没有升级，是否要把 360/480 临界线作为闲家后半局更强的抢分目标？');
  }
  if (doubts.length === 0) doubts.push('本批训练没有发现必须人工确认的新规则疑问，下一步可以扩大到更多 seed 并抽查具体决策快照。');
  return doubts;
}

function collectRisks(events: GameEvent[]): StrategyRisk[] {
  return events
    .filter((event) => event.type === 'ai.decision')
    .flatMap((event) => ((event.payload as StrategyDecisionReport | undefined)?.risks ?? []));
}

function emptyOutcomeCounts(): Record<RoundResult['outcome'], number> {
  return {
    'host-big-shutout': 0,
    'host-small-shutout': 0,
    'host-level-up': 0,
    'attackers-down': 0,
    'attackers-level-up': 0
  };
}

function hostOutcomeCount(run: TrainingRun): number {
  return run.outcomeCounts['host-big-shutout'] + run.outcomeCounts['host-small-shutout'] + run.outcomeCounts['host-level-up'];
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function mergeCounts(items: Record<string, number>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

function formatCounts(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return ['- 无已标记风险。'];
  return entries.map(([key, value]) => `- ${key}: ${value}`);
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

function percent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}

function formatPenalty(penalty: TrainingMandatoryPenalty | null): string {
  if (!penalty) return '-';
  const kind = `${penalty.kind === 'main' ? '主' : '副'}${penalty.rank}`;
  const affected = penalty.affected.length > 0
    ? penalty.affected.map((item) => `${item.seat + 1}:${item.from}->${item.to}`).join('、')
    : '无生效打回';
  return `${kind} ${affected}`;
}

function levelStatusLabel(seat: GameState['seats'][number]): string {
  const flags = [
    seat.passedMandatory.J ? 'J过' : null,
    seat.passedMandatory.A ? 'A过' : null
  ].filter(Boolean);
  return flags.length > 0 ? `${seat.level}(${flags.join('/')})` : seat.level;
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (const arg of argv) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    args.set(key, value);
  }
  return {
    rounds: Number(args.get('rounds') ?? 100),
    seedPrefix: args.get('seed') ?? 'upgrade-training',
    maxStepsPerRound: Number(args.get('maxSteps') ?? DEFAULT_MAX_STEPS_PER_ROUND),
    outDir: args.get('outDir') ?? 'work/training'
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const run = trainUpgradeAi({
    rounds: args.rounds,
    seedPrefix: args.seedPrefix,
    maxStepsPerRound: args.maxStepsPerRound
  });
  const paths = await writeTrainingArtifacts(run, args.outDir);
  console.log(trainingReportMarkdown(run));
  console.log(`Artifacts:\n- ${paths.jsonPath}\n- ${paths.mdPath}\n- ${paths.levelPath}\n- ${paths.latestJsonPath}\n- ${paths.latestMdPath}\n- ${paths.latestLevelPath}`);
}
