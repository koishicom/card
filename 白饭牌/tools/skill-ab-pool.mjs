/**
 * 池化"同一个技能、多个种子分片"的结果。
 *
 * 场景：想验证某个技能的强度，把它拆成若干片、每片用不同的种子区间各测一遍。
 * 因为每片的配对基线与种子都不同，不能靠 skill-ab-merge 简单相加——这里按
 * "各片均值 → 池化均值 + 池化标准误"来算，并给出合并后的置信区间与 z 值。
 *
 * 用法：
 *   node tools/skill-ab-pool.mjs .ab-h1.json .ab-h2.json ...
 *   （只取各分片里"同一个技能"的行；有多个技能会分别池化）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('请给出若干分片文件');

// 按技能聚合：每个技能收集（均值, 标准误, 局数）
const bySkill = new Map();
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
  for (const row of data.rows) {
    if (!bySkill.has(row.id)) bySkill.set(row.id, { name: row.name, parts: [], baseRates: [] });
    const entry = bySkill.get(row.id);
    entry.parts.push({ mean: row.delta, se: row.pairedSe ?? row.se ?? 0, games: row.games ?? data.games, start: data.startSeed });
    entry.baseRates.push(data.baseRate);
  }
}

function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (text, width) => {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - visual));
};

console.log(`池化 ${files.length} 个分片（每个分片自带配对基线与种子区间）`);
console.log('');
for (const [id, entry] of bySkill) {
  const totalGames = entry.parts.reduce((a, p) => a + p.games, 0);
  // 各片等权（局数相同）：均值取简单平均，方差取 sqrt(Σ se²)/n
  const n = entry.parts.length;
  const mean = entry.parts.reduce((a, p) => a + p.mean, 0) / n;
  const pooledSe = Math.sqrt(entry.parts.reduce((a, p) => a + p.se ** 2, 0)) / n;
  const z = pooledSe > 0 ? mean / pooledSe : 0;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const spans = entry.parts.map((p) => p.mean).sort((a, b) => a - b);
  console.log(`${entry.name}（${id}）：${totalGames} 局，分 ${n} 片`);
  console.log(`  各片净效果：${entry.parts.map((p) => `${(p.mean * 100).toFixed(1)}`).join(' / ')}  （范围 ${(spans[0] * 100).toFixed(1)} ~ ${(spans[spans.length - 1] * 100).toFixed(1)}）`);
  console.log(`  池化估计：${mean >= 0 ? '+' : ''}${(mean * 100).toFixed(1)}pp  标准误 ±${(pooledSe * 100).toFixed(1)}pp  `
    + `95% CI [${((mean - 1.96 * pooledSe) * 100).toFixed(1)}, ${((mean + 1.96 * pooledSe) * 100).toFixed(1)}]`);
  console.log(`  z = ${z.toFixed(2)}   p ${p < 0.0001 ? '< 0.0001' : `= ${p.toFixed(4)}`}`);
  console.log('');
}
