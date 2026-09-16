/**
 * 给配对 A/B 的结果附上统计显著性与检验力分析。
 *
 * 关键点：文件里只存了每个技能的胜率（win rate），没有存逐局配对差值，
 * 所以这里算的是**保守上界**——把配对差值当作独立样本来估标准误。
 * 真正的配对设计方差只会更小，因此"显著"的结论是可信的，"不显著"的也可能其实显著。
 *
 * 用法：
 *   node tools/skill-ab-stats.mjs                      # 读 tools/.ab-*.json
 *   node tools/skill-ab-stats.mjs .ab-p1.json ...
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let files = process.argv.slice(2);
if (files.length === 0) {
  files = fs.readdirSync(root).filter((f) => /^\.ab-.*\.json$/.test(f)).map((f) => path.join(root, f));
}
if (files.length === 0) throw new Error('没有找到分片结果（.ab-*.json）');

const rows = [];
let baseRate = null;
let baselineSeeds = 0;
let gamesPerSkill = 0;
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (baseRate === null) {
    baseRate = data.baseRate;
    baselineSeeds = data.baselineSeeds;
  }
  gamesPerSkill = Math.max(gamesPerSkill, data.games);
  for (const row of data.rows) rows.push({ ...row, games: row.games ?? data.games });
}

// 正态分位数（避免引入依赖）：用误差函数近似
function normCdf(z) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
const twoSidedP = (z) => 2 * (1 - normCdf(Math.abs(z)));

/** 双侧检验达到 power 所需样本量（近似）：n ≈ (z_{α/2}+z_β)² σ² / δ²，σ=0.5 */
function sampleSizeFor(delta, power = 0.8, alpha = 0.05) {
  const za = 1.959964; // α=0.05 双侧
  const zb = power === 0.8 ? 0.841621 : 1.281552; // 80% / 90%
  return Math.ceil(((za + zb) ** 2) * 0.25 / (delta ** 2));
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (text, width) => {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - visual));
};

const alpha = 0.05;
const k = rows.length;
const bonferroni = alpha / k;

// BH (Benjamini-Hochberg) FDR 控制，q = 0.05
const indexed = rows.map((row) => {
  const n = row.games;
  const se = Math.sqrt(row.rate * (1 - row.rate) / n); // 保守：忽略配对相关性
  const seDelta = row.pairedSe != null ? row.pairedSe : Math.sqrt(2) * se;
  const z = row.delta / seDelta;
  const p = twoSidedP(z);
  return { ...row, n, se, seDelta, z, p, ciLow: row.delta - 1.96 * seDelta, ciHigh: row.delta + 1.96 * seDelta };
});
const sorted = [...indexed].sort((a, b) => a.p - b.p);
let bhCutoffP = 0;
for (let i = 0; i < sorted.length; i++) {
  if (sorted[i].p <= ((i + 1) / k) * alpha) bhCutoffP = sorted[i].p;
}
for (const row of indexed) row.bhSignificant = row.p <= bhCutoffP && bhCutoffP > 0;

console.log(`统计检验：技能对白板（${gamesPerSkill} 局/技能，基线 ${pct(baseRate)} / ${baselineSeeds} 局）`);
console.log(`零假设 H0：带这个技能不改变胜率）。标准误取逐局配对差值算出的真值（没有则退回独立假设的保守上界）。`);
console.log('');
console.log('技能        净效果    95% 置信区间        z       p       显著性(BH)');
console.log('-'.repeat(74));
for (const row of [...indexed].sort((a, b) => b.delta - a.delta)) {
  process.stdout.write(pad(row.name, 11));
  process.stdout.write(pad(`${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(1)}pp`, 10));
  process.stdout.write(pad(`[${(row.ciLow * 100).toFixed(1)}, ${(row.ciHigh * 100).toFixed(1)}]`, 20));
  process.stdout.write(pad(row.z.toFixed(2), 8));
  process.stdout.write(pad(row.p < 0.0001 ? '<0.0001' : row.p.toFixed(4), 9));
  process.stdout.write(row.bhSignificant ? '是' : '否');
  console.log('');
}

// 家族错误率与多重比较
const rawSignificant = indexed.filter((r) => r.p < alpha).length;
const bonferroniSignificant = indexed.filter((r) => r.p < bonferroni).length;
console.log('-'.repeat(74));
console.log(`同时检验 ${k} 个技能（多重比较）：`);
console.log(`  不做校正时"显著"（p<0.05）的有 ${rawSignificant} 个；`);
console.log(`  Bonferroni 校正后阈值 p<${bonferroni.toFixed(5)}，能过的只有 ${bonferroniSignificant} 个；`);
console.log(`  BH-FDR(q=0.05) 能过的有 ${indexed.filter((r) => r.bhSignificant).length} 个。`);
console.log('');

// 检验力：要分辨某个净效果，需要多少局
console.log('检验力换算（每个技能需要多少局，才能以 80% 把握测出一个真实存在的效果）：');
for (const delta of [0.20, 0.15, 0.10, 0.05, 0.03]) {
  console.log(`  真实效果 ${pct(delta).padStart(6)} → 需要约 ${String(sampleSizeFor(delta)).padStart(5)} 局/技能（当前 ${gamesPerSkill} 局）`);
}
console.log('');
console.log('分辨率：当前样本能可靠分辨（≥2σ）的最小效果 ≈ '
  + pct(2 * Math.sqrt(2) * Math.sqrt(0.25 / gamesPerSkill)) + '；'
  + '想分辨 3pp 级别则需要 ' + sampleSizeFor(0.03) + ' 局/技能。');

const outPath = path.join(root, 'tools', '.ab-stats.json');
fs.writeFileSync(outPath, JSON.stringify({ baseRate, baselineSeeds, alpha, bonferroni, bhCutoffP, rows: indexed }, null, 2), 'utf8');
console.log(`统计明细已写入 ${path.relative(root, outPath)}`);
