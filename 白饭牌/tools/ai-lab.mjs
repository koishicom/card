/**
 * 困难档专项实验：分离"采样未知手牌"里的两个因素——
 *   A) 建模误差（把牌堆里的牌当成对手可能的手牌）
 *   B) 加噪声本身（即使是完美信息，噪声也会带来不确定性）
 * 用小局数多局数配对胜率给出结论。
 *
 * 用法：node tools/ai-lab.mjs [每对局数]
 */

import { applyAction, other, suggestForbiddenColumn } from '../src/engine/game.js';
import { legalActions } from '../src/engine/rules.js';
import { sample } from '../src/engine/random.js';
import { orderActions } from '../src/ai/heuristics.js';
import { bestMoveInWorld } from '../src/ai/search.js';
import { playMatch } from '../src/sim/match.js';

const games = Number(process.argv[2] ?? 150);
const SEARCH = { depth: 2, beamWidth: 14, maxNodes: 6000 };

/** 手牌假设：mode 决定怎么造对手手牌。 */
function buildWorld(state, player, rng, mode) {
  const need = state.hands[player].length;

  if (mode === 'truth') return state; // 完美信息（作弊线，仅作参照）

  const unknown = [...state.deck, ...state.hands[player]];
  // 'noise'：只用对手真实手牌 + 从牌堆里换掉 k 张（制造可控噪声）
  // 'model'：真实手牌 + 从"牌堆+对手手牌"整体采样补齐（正式档用的方式）
  const pool = mode === 'noise' ? state.deck : unknown;
  const cap = mode === 'noise' ? Math.min(need, pool.length) : Math.min(need, pool.length);
  const extra = sample(pool, cap, rng);
  const extraIds = new Set(extra.map((c) => c.id));
  const base = mode === 'noise' ? [] : state.hands[player];
  const modeled = [...base, ...extra].slice(0, need);
  return {
    ...state,
    hands: [player === 0 ? state.hands[0].slice() : modeled, player === 1 ? state.hands[1].slice() : modeled],
    deck: unknown.filter((c) => !extraIds.has(c.id)),
  };
}

const keyOf = (action) => (action.type === 'pass' ? 'pass' : `c${action.col}:${action.card.id}`);

function makeAi({ id, label, samples, aggregate, mode }) {
  return {
    id,
    label,
    chooseForbiddenColumn: (state) => suggestForbiddenColumn(state),
    decide(state, player, rng) {
      const fallback = orderActions(state, legalActions(state, player), player)[0];
      const tally = new Map();
      for (let i = 0; i < samples; i++) {
        const world = buildWorld(state, player, rng, mode);
        const { action, score } = bestMoveInWorld(world, player, SEARCH);
        if (!action) continue;
        const key = keyOf(action);
        const entry = tally.get(key) ?? { action, count: 0, score: 0 };
        entry.count += 1;
        entry.score += score;
        tally.set(key, entry);
      }
      if (tally.size === 0) return fallback;
      const entries = [...tally.values()];
      if (aggregate === 'score') entries.sort((a, b) => b.score - a.score);
      else entries.sort((a, b) => b.count - a.count || b.score - a.score);
      return entries[0].action;
    },
  };
}

const variants = [
  makeAi({ id: 'truth-s1', label: '真实手牌 ×1', samples: 1, aggregate: 'vote', mode: 'truth' }),
  makeAi({ id: 'truth-s6', label: '真实手牌 ×6', samples: 6, aggregate: 'vote', mode: 'truth' }),
  makeAi({ id: 'noise-s1', label: '换牌噪声 ×1', samples: 1, aggregate: 'vote', mode: 'noise' }),
  makeAi({ id: 'noise-s6', label: '换牌噪声 ×6', samples: 6, aggregate: 'vote', mode: 'noise' }),
  makeAi({ id: 'model-s1', label: '采样建模 ×1', samples: 1, aggregate: 'vote', mode: 'model' }),
  makeAi({ id: 'model-s3', label: '采样建模 ×3', samples: 3, aggregate: 'vote', mode: 'model' }),
  makeAi({ id: 'model-s6', label: '采样建模 ×6', samples: 6, aggregate: 'vote', mode: 'model' }),
  makeAi({ id: 'model-s3s', label: '采样建模 ×3 取高分', samples: 3, aggregate: 'score', mode: 'model' }),
];

console.log(`困难档专项实验 · 每对 ${games} 局（交替先后手）`);
console.log('='.repeat(76));

const rate = new Map();
for (let i = 0; i < variants.length; i++) {
  for (let j = i + 1; j < variants.length; j++) {
    const a = variants[i];
    const b = variants[j];
    const stats = playMatch(a, b, { games, startSeed: 31, checkInvariants: false });
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
    return { id: v.id, label: v.label, avg: rates.reduce((s, r) => s + r, 0) / rates.length };
  })
  .sort((a, b) => b.avg - a.avg);

console.log(`${pad('配置', 22)}${pad('平均胜率', 12)}`);
for (const row of rows) console.log(`${pad(row.label, 22)}${pad(`${(row.avg * 100).toFixed(1)}%`, 12)}`);

console.log('='.repeat(76));
console.log('关键对比：');
const cmp = (x, y) => {
  const r = rate.get(`${x}|${y}`);
  return `${r === undefined ? '?' : (r * 100).toFixed(1)}%`;
};
console.log(`  采样建模×6 对 真实手牌×6 : ${cmp('model-s6', 'truth-s6')}`);
console.log(`  采样建模×1 对 真实手牌×1 : ${cmp('model-s1', 'truth-s1')}`);
console.log(`  换牌噪声×1 对 真实手牌×1 : ${cmp('noise-s1', 'truth-s1')}`);
console.log(`  换牌噪声×6 对 换牌噪声×1 : ${cmp('noise-s6', 'noise-s1')}`);
console.log(`  采样建模×6 对 采样建模×1 : ${cmp('model-s6', 'model-s1')}`);
process.exit(0);
