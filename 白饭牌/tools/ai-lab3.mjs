/**
 * 深度实验（轻量版）：只看"真实信息下加深一层搜索是否更强"。
 * 用法：node tools/ai-lab3.mjs [每对局数]
 */

import { suggestForbiddenColumn } from '../src/engine/game.js';
import { legalActions } from '../src/engine/rules.js';
import { bestMoveInWorld } from '../src/ai/search.js';
import { playMatch } from '../src/sim/match.js';
import { BUILTIN_PROFILES } from '../src/ai/profiles.js';

const games = Number(process.argv[2] ?? 60);

function makeDepthAi(depth, beamWidth, maxNodes, label) {
  return {
    id: label,
    label,
    chooseForbiddenColumn: (state) => suggestForbiddenColumn(state),
    decide(state, player) {
      const { action } = bestMoveInWorld(state, player, { depth, beamWidth, maxNodes });
      return action ?? legalActions(state, player)[0];
    },
  };
}

const d2 = makeDepthAi(2, 14, 4000, '真实 d2 b14');
const d3 = makeDepthAi(3, 10, 12000, '真实 d3 b10');
const d4 = makeDepthAi(4, 8, 20000, '真实 d4 b8');

const variants = [
  { id: 'easy', label: '简单（现役）', profile: BUILTIN_PROFILES.easy },
  { id: 'd2', label: '真实 d2 b14', profile: d2 },
  { id: 'd3', label: '真实 d3 b10', profile: d3 },
  { id: 'd4', label: '真实 d4 b8', profile: d4 },
];

console.log(`深度实验（轻量）· 每对 ${games} 局`);
console.log('='.repeat(64));

const rate = new Map();
for (let i = 0; i < variants.length; i++) {
  for (let j = i + 1; j < variants.length; j++) {
    const stats = playMatch(variants[i].profile, variants[j].profile, { games, startSeed: 17, checkInvariants: false });
    rate.set(`${variants[i].id}|${variants[j].id}`, stats.aWinRate);
    rate.set(`${variants[j].id}|${variants[i].id}`, stats.bWinRate);
    console.log(`  ${variants[i].label} vs ${variants[j].label}: ${(stats.aWinRate * 100).toFixed(1)}% / ${(stats.bWinRate * 100).toFixed(1)}% （平 ${(stats.drawRate * 100).toFixed(1)}%）`);
  }
}

const pad = (t, w) => {
  const s = String(t);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - visual));
};

console.log('='.repeat(64));
const rows = variants
  .map((v) => {
    const rates = variants.filter((o) => o.id !== v.id).map((o) => rate.get(`${v.id}|${o.id}`));
    return { label: v.label, avg: rates.reduce((s, r) => s + r, 0) / rates.length };
  })
  .sort((a, b) => b.avg - a.avg);
console.log(`${pad('配置', 24)}${pad('平均胜率', 12)}`);
for (const row of rows) console.log(`${pad(row.label, 24)}${pad(`${(row.avg * 100).toFixed(1)}%`, 12)}`);
console.log('='.repeat(64));
console.log(`d3 对 d2：${((rate.get('d3|d2') ?? 0) * 100).toFixed(1)}%  → 加深一层${(rate.get('d3|d2') ?? 0) > 0.5 ? '有效 ✅' : '无效 ❌'}`);
console.log(`d4 对 d2：${((rate.get('d4|d2') ?? 0) * 100).toFixed(1)}%`);
process.exit(0);
