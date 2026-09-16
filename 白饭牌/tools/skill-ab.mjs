/**
 * 配对 A/B 技能测量（本仓库衡量技能强度的主口径）。
 *
 * 做法：固定同一批种子与同一套先后手安排，只切换"这一方带不带这个技能"，
 * 并与"两边都空手"的同种子基线逐局配对，得到该技能的净效果。
 *
 * 为什么必须配对：抽技阶段是"后手先选"，谁拿到某个技能与座位强相关，
 * 直接统计"持有者胜率"会把位置效应算到技能头上（实测能把零收益的看破
 * 算成 38%，完全是假信号）。
 *
 * 用法：
 *   node tools/skill-ab.mjs [每技能局数] [技能id...]
 *   node tools/skill-ab.mjs 200 shuimian chenmo
 *   node tools/skill-ab.mjs 200              # 不带 id 时测全部技能
 *   node tools/skill-ab.mjs 200 --difficulty=normal
 *   node tools/skill-ab.mjs 125 --start=1 --out=.ab-part1.json
 *
 * 分片：--start 指定起始种子，--out 把结果写成 JSON。
 * 分片时每片用同一批种子各自算一次基线：基线局数 = --baseline（默认跟 --start 有关的 200 局），
 * 因此**同一批种子下不同片的基线是一致的**，可以合并比较。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playGame } from '../src/sim/match.js';
import { BUILTIN_PROFILES } from '../src/ai/profiles.js';
import { allSkillIds, getSkill } from '../src/skills/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const numeric = args.filter((a) => !a.startsWith('--'));
const games = Number(numeric[0] ?? 200);
const ids = numeric.slice(1).length > 0 ? numeric.slice(1) : allSkillIds();
const difficulty = (args.find((a) => a.startsWith('--difficulty=')) ?? '--difficulty=hard').split('=')[1];
const startSeed = Number((args.find((a) => a.startsWith('--start=')) ?? '--start=1').split('=')[1]);
// 基线局数固定为 200 并用固定种子：所有分片共享同一条基线，合并时才可比
const baselineSeeds = Number((args.find((a) => a.startsWith('--baseline=')) ?? '--baseline=200').split('=')[1]);
const baselineStart = Number((args.find((a) => a.startsWith('--baseline-start=')) ?? '--baseline-start=1').split('=')[1]);
const outArg = (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] ?? '';
const profile = BUILTIN_PROFILES[difficulty];
if (!profile) throw new Error(`未知难度：${difficulty}`);
for (const id of ids) {
  if (!getSkill(id)) throw new Error(`未知技能：${id}`);
}

/** 一局：holder 是否先手由 i 的奇偶决定，与基线保持完全相同的安排。 */
function playOne(seed, holderIsFirst, skillsPair) {
  const result = playGame({
    players: [profile, profile],
    seed,
    lastPlayer: holderIsFirst ? 1 : 0,
    skills: skillsPair,
    checkInvariants: true,
  });
  const holder = holderIsFirst ? 0 : 1;
  // 平局按半分计
  const score = result.winner === null ? 0.5 : result.winner === holder ? 1 : 0;
  return { score, uses: result.skillUses ?? {}, violations: result.violations.length };
}

let violations = 0;

// 基线：固定种子、两边空手。所有分片共享同一条基线，因此分片结果可以合并比较。
// 逐局分数存下来，供每个技能算配对差值（同一局种子的"有技能 - 无技能"）。
const baselineScores = new Array(baselineSeeds);
let baseSum = 0;
for (let i = 0; i < baselineSeeds; i++) {
  const holderIsFirst = i % 2 === 0;
  const r = playOne(baselineStart + i, holderIsFirst, [null, null]);
  baselineScores[i] = r.score;
  baseSum += r.score;
  violations += r.violations;
}
const baseRate = baseSum / baselineSeeds;

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (text, width) => {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - visual));
};

console.log(`配对 A/B（${profile.label} 自战，每技能 ${games} 局，基线与随后的技能共用同一批种子）`);
console.log(`基线（两边空手）胜率 ${pct(baseRate)}`);
console.log('');
console.log('技能        类型   净效果    胜率    发动率  平均发动');
console.log('-'.repeat(58));

const rows = [];
for (const id of ids) {
  let sum = 0;
  let used = 0;
  let uses = 0;
  const deltas = new Array(games);
  for (let i = 0; i < games; i++) {
    const holderIsFirst = i % 2 === 0;
    const r = playOne(startSeed + i, holderIsFirst, holderIsFirst ? [id, null] : [null, id]);
    sum += r.score;
    // 逐局配对差值：同种子下"带技能 - 不带技能"。配对会大幅削减方差，
    // 独立假设只是保守上界，所以这里如实算出来。
    deltas[i] = r.score - (baselineScores[i] ?? baseRate);
    const u = r.uses[id] ?? 0;
    if (u > 0) used += 1;
    uses += u;
    violations += r.violations;
  }
  const rate = sum / games;
  const delta = rate - baseRate;
  const def = getSkill(id);

  const dMean = deltas.reduce((a, b) => a + b, 0) / games;
  const dVar = games > 1 ? deltas.reduce((a, b) => a + (b - dMean) ** 2, 0) / (games - 1) : 0;
  const pairedSe = Math.sqrt(dVar / games);
  const pairedT = pairedSe > 0 ? dMean / pairedSe : 0;

  rows.push({
    id,
    name: def.name,
    type: def.type,
    rate,
    delta,
    usedRate: used / games,
    avgUses: uses / games,
    games,
    pairedMean: dMean,
    pairedSe,
    pairedT,
  });

  process.stdout.write(pad(def.name, 11));
  process.stdout.write(pad(def.type === 'active' ? '主动' : '被动', 7));
  process.stdout.write(pad(`${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`, 10));
  process.stdout.write(pad(`±${(pairedSe * 100).toFixed(1)}`, 8));
  process.stdout.write(pad(def.type === 'active' ? pct(used / games) : '-', 8));
  process.stdout.write(def.type === 'active' ? (uses / games).toFixed(2) : '-');
  console.log('');
}

console.log('-'.repeat(58));
rows.sort((a, b) => b.delta - a.delta);
console.log('强度排序：' + rows.map((r) => `${r.name} ${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}`).join(' ｜ '));
console.log(`违规 ${violations} 处`);
console.log(`配对标准误（逐局算出来的真值）：${rows.map((r) => `${r.name} ±${(r.pairedSe * 100).toFixed(1)}`).join(' ｜ ')}`);

if (outArg) {
  const outPath = path.isAbsolute(outArg) ? outArg : path.join(root, outArg);
  fs.writeFileSync(outPath, JSON.stringify({
    difficulty,
    games,
    startSeed,
    baselineSeeds,
    baselineStart,
    baseRate,
    rows,
    violations,
  }, null, 2), 'utf8');
  console.log(`分片结果已写入 ${path.relative(root, outPath)}`);
}
