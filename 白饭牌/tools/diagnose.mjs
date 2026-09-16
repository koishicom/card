/**
 * 对局诊断：统计胜负结构、过牌质量、手牌走势，用来判断 AI 是否"打对了方向"。
 * 用法：node tools/diagnose.mjs [每对局数] [起始种子]
 */

import { BUILTIN_PROFILES } from '../src/ai/profiles.js';
import { applyAction, createGame, isOver } from '../src/engine/game.js';
import { createRng } from '../src/engine/random.js';
import { legalActions } from '../src/engine/rules.js';

const games = Number(process.argv[2] ?? 100);
const startSeed = Number(process.argv[3] ?? 1);
const profiles = BUILTIN_PROFILES;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * 跑一局并收集细粒度统计。
 * @param {object} players {0: profile, 1: profile}
 * @param {number} seed
 * @param {boolean} aIsSeat0 A 是否坐在 0 号位
 */
function runDetailed(players, seed, aIsSeat0) {
  let state = createGame({ seed });
  const rng = createRng(seed * 7919 + 13);
  const ban = players[state.lastPlayer].chooseForbiddenColumn(state, rng);
  state = { ...state, forbiddenColumn: ban };

  const stats = {
    turns: 0,
    passes: 0,
    wastedPasses: 0, // 明明有合法放置却选择过牌
    forcedPasses: 0, // 无牌可放只能过牌
    placements: 0,
    bombs: 0,
    magics: 0,
    digits: 0,
    handSizes: { a: 0, b: 0, samples: 0 },
  };

  while (!isOver(state) && stats.turns < 3000) {
    const player = state.current;
    const legal = legalActions(state, player);
    const hasPlacement = legal.some((a) => a.type === 'place');
    const action = players[player].decide(state, player, rng);

    const seat = (player === 0) === aIsSeat0 ? 'a' : 'b';
    stats.handSizes[seat] += state.hands[player].length;
    stats.handSizes.samples += 1;

    if (action.type === 'pass') {
      stats.passes += 1;
      if (hasPlacement) stats.wastedPasses += 1;
      else stats.forcedPasses += 1;
    } else {
      stats.placements += 1;
      const kind = action.card.kind;
      if (kind === 'e') stats.bombs += 1;
      else if (kind === 'm') stats.magics += 1;
      else stats.digits += 1;
    }
    state = applyAction(state, action);
    stats.turns += 1;
  }
  return { stats, state };
}

function batch(a, b, count) {
  const acc = {
    games: count,
    aWins: 0,
    draws: 0,
    winByHand: 0,
    winBySettle: 0,
    turns: 0,
    passes: 0,
    wastedPasses: 0,
    forcedPasses: 0,
    placements: 0,
    bombs: 0,
    magics: 0,
    aHandAvg: 0,
    bHandAvg: 0,
    handSamples: 0,
  };
  for (let i = 0; i < count; i++) {
    const aIsSeat0 = i % 2 === 0;
    const players = aIsSeat0 ? { 0: a, 1: b } : { 0: b, 1: a };
    const { stats, state } = runDetailed(players, startSeed + i, aIsSeat0);
    const aSeat = aIsSeat0 ? 0 : 1;
    if (state.result.winner === aSeat) acc.aWins += 1;
    if (state.result.winner === null) acc.draws += 1;
    if (state.result.reason === '出完手牌') acc.winByHand += 1;
    else acc.winBySettle += 1;
    acc.turns += stats.turns;
    acc.passes += stats.passes;
    acc.wastedPasses += stats.wastedPasses;
    acc.forcedPasses += stats.forcedPasses;
    acc.placements += stats.placements;
    acc.bombs += stats.bombs;
    acc.magics += stats.magics;
    acc.aHandAvg += stats.handSizes.a;
    acc.bHandAvg += stats.handSizes.b;
    acc.handSamples += stats.handSizes.samples;
  }
  return acc;
}

console.log(`白饭牌 · AI 对局诊断（每对 ${games} 局，起始种子 ${startSeed}）`);
for (const [aId, bId] of [['easy', 'normal'], ['easy', 'hard'], ['normal', 'hard']]) {
  const a = profiles[aId];
  const b = profiles[bId];
  const acc = batch(a, b, games);
  const bWins = acc.games - acc.aWins - acc.draws;
  console.log(`\n【${a.label} vs ${b.label}】`);
  console.log(`  胜率：${a.label} ${pct(acc.aWins / acc.games)} ｜ ${b.label} ${pct(bWins / acc.games)} ｜ 平 ${pct(acc.draws / acc.games)}`);
  console.log(`  结束：出完手牌 ${pct(acc.winByHand / acc.games)} ｜ 抽空结算 ${pct(acc.winBySettle / acc.games)}`);
  console.log(`  平均手数 ${(acc.turns / acc.games).toFixed(1)}，其中放置 ${(acc.placements / acc.games).toFixed(1)} / 过牌 ${(acc.passes / acc.games).toFixed(1)}（被迫 ${(acc.forcedPasses / acc.games).toFixed(1)}，主动 ${(acc.wastedPasses / acc.games).toFixed(1)}）`);
  console.log(`  平均每局炸弹 ${(acc.bombs / acc.games).toFixed(2)} 张、魔法 ${(acc.magics / acc.games).toFixed(2)} 张`);
  console.log(`  平均手牌数：${a.label} ${(acc.aHandAvg / acc.games).toFixed(2)} ｜ ${b.label} ${(acc.bHandAvg / acc.games).toFixed(2)}`);
}
