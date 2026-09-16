/**
 * 配置扫描（早期探索）：对比不同评估/搜索/建模配置的胜率。
 *
 * 注意：本脚本是早期实验台，里面的变体自定义了建模方式，
 * 与 src/ai/profiles.js 的现役实现不完全一致；现役配置的强度请用
 * node tools/tournament.mjs 200 验证，深度结论见 tools/ai-lab3.mjs。
 *
 * 用法：node tools/sweep.mjs [每对局数]
 */

import { applyAction, other, suggestForbiddenColumn } from '../src/engine/game.js';
import { legalActions } from '../src/engine/rules.js';
import { sample } from '../src/engine/random.js';
import { evaluate, orderActions } from '../src/ai/heuristics.js';
import { bestMoveInWorld } from '../src/ai/search.js';
import { playMatch } from '../src/sim/match.js';

const games = Number(process.argv[2] ?? 60);

/** garbage 建模：用牌堆+对手手牌里随机补齐对手手牌。 */
function modelGarbage(state, player, rng) {
  const unknown = [...state.deck, ...state.hands[player]];
  const need = state.hands[player].length;
  const extra = sample(unknown, Math.min(need, unknown.length), rng);
  const ids = new Set(extra.map((c) => c.id));
  const modeled = [...state.hands[player], ...extra].slice(0, need);
  return {
    ...state,
    hands: [player === 0 ? state.hands[0].slice() : modeled, player === 1 ? state.hands[1].slice() : modeled],
    deck: unknown.filter((c) => !ids.has(c.id)),
  };
}

/** 搜索型 AI：model 决定是否对对手手牌做采样假设。 */
function makeSearchAi(cfg, id, label) {
  return {
    id,
    label,
    chooseForbiddenColumn: (state) => suggestForbiddenColumn(state),
    decide(state, player, rng) {
      const fallback = orderActions(state, legalActions(state, player), player)[0];
      const tally = new Map();
      for (let i = 0; i < cfg.samples; i++) {
        const world = cfg.model === 'exact' ? state : modelGarbage(state, player, rng);
        const { action } = bestMoveInWorld(world, player, {
          depth: cfg.depth,
          beamWidth: cfg.beamWidth,
          maxNodes: cfg.maxNodes,
        });
        if (!action) continue;
        const key = action.type === 'pass' ? 'pass' : `c${action.col}:${action.card.id}`;
        const entry = tally.get(key) ?? { action, count: 0 };
        entry.count += 1;
        tally.set(key, entry);
      }
      if (tally.size === 0) return fallback;
      return [...tally.values()].sort((a, b) => b.count - a.count)[0].action;
    },
  };
}

function makeRandom(id, label) {
  return {
    id,
    label,
    chooseForbiddenColumn: (state, rng) => rng.int(3),
    decide(state, player, rng) {
      const actions = legalActions(state, player);
      const placements = actions.filter((a) => a.type === 'place');
      if (placements.length === 0) return actions.find((a) => a.type === 'pass');
      return placements[rng.int(placements.length)];
    },
  };
}

/** 纯启发式：只评估自己这一手（depth 0 搜索）或加一层对手回应。 */
function makeHeuristic(id, label, replyPlies) {
  return {
    id,
    label,
    chooseForbiddenColumn: (state) => suggestForbiddenColumn(state),
    decide(state, player) {
      const actions = orderActions(state, legalActions(state, player), player);
      if (actions.length === 0) return { type: 'pass', player, card: null };
      const { action } = bestMoveInWorld(state, player, { depth: replyPlies, beamWidth: 999, maxNodes: 1e9 });
      return action ?? actions[0];
    },
  };
}

const variants = [
  makeRandom('random', '随机'),
  makeHeuristic('heur0', '启发式 d0'),
  makeHeuristic('heur1', '启发式 d1'),
  makeHeuristic('heur2', '启发式 d2'),
  makeSearchAi({ depth: 2, beamWidth: 12, maxNodes: 20000, samples: 1, model: 'garbage' }, 'samp-d2', '采样 d2'),
  makeSearchAi({ depth: 4, beamWidth: 8, maxNodes: 8000, samples: 1, model: 'garbage' }, 'samp-d4', '采样 d4 b8'),
  makeSearchAi({ depth: 2, beamWidth: 12, maxNodes: 20000, samples: 2, model: 'garbage' }, 'samp-d2x2', '采样 d2×2'),
];

console.log(`配置扫描 v2 · 每对 ${games} 局`);
console.log('='.repeat(72));

const rate = new Map();
for (let i = 0; i < variants.length; i++) {
  for (let j = i + 1; j < variants.length; j++) {
    const a = variants[i];
    const b = variants[j];
    const stats = playMatch(a, b, { games, startSeed: 7, checkInvariants: false });
    rate.set(`${a.id}|${b.id}`, stats.aWinRate);
    rate.set(`${b.id}|${a.id}`, stats.bWinRate);
  }
}

const pad = (t, w) => {
  const s = String(t);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - visual));
};

const rows = variants
  .map((v) => {
    const rates = variants.filter((o) => o.id !== v.id).map((o) => rate.get(`${v.id}|${o.id}`));
    return {
      id: v.id,
      label: v.label,
      avg: rates.reduce((s, r) => s + r, 0) / rates.length,
      vsRandom: rate.get(`${v.id}|random`) ?? null,
    };
  })
  .sort((a, b) => b.avg - a.avg);

console.log(`${pad('配置', 20)}${pad('平均胜率', 12)}${pad('对随机', 10)}`);
for (const row of rows) {
  console.log(`${pad(row.label, 20)}${pad(`${(row.avg * 100).toFixed(1)}%`, 12)}${pad(row.vsRandom === null ? '—' : `${(row.vsRandom * 100).toFixed(1)}%`, 10)}`);
}
console.log('='.repeat(72));
process.exit(0);
