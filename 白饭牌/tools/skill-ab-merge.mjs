/**
 * 合并 tools/skill-ab.mjs 的多个分片结果，输出总表。
 *
 * 前提：所有分片用同一批 --baseline-start/--baseline（默认 1 / 200），
 * 因此各片共享同一条基线，可以并在一起看。
 *
 * 用法：
 *   node tools/skill-ab-merge.mjs .ab-p1.json .ab-p2.json ...
 *   node tools/skill-ab-merge.mjs            # 自动收集 tools/ 下所有 .ab-*.json
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
const baselines = new Set();
let totalGames = 0;
let maxGamesPerSkill = 0;
let violations = 0;

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  baselines.add(`${data.baselineStart}+${data.baselineSeeds}=${data.baseRate.toFixed(4)}`);
  totalGames += data.games * data.rows.length;
  maxGamesPerSkill = Math.max(maxGamesPerSkill, data.games);
  violations += data.violations ?? 0;
  for (const row of data.rows) rows.push(row);
}

if (baselines.size > 1) {
  console.log(`⚠️ 分片基线不一致（${[...baselines].join(' / ')}）：不同片的净效果不能直接合并比较。`);
}
const baseRate = Number([...baselines][0].split('=')[1]);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (text, width) => {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - visual));
};

rows.sort((a, b) => b.delta - a.delta);

console.log(`技能对白板 · 合并结果（${files.length} 片，共 ${totalGames} 局对局，基线 ${pct(baseRate)}）`);
console.log('');
console.log('技能        类型   净效果    胜率    发动率  平均发动  局数');
console.log('-'.repeat(62));
for (const row of rows) {
  process.stdout.write(pad(row.name, 11));
  process.stdout.write(pad(row.type === 'active' ? '主动' : '被动', 7));
  process.stdout.write(pad(`${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(1)}pp`, 10));
  process.stdout.write(pad(pct(row.rate), 8));
  process.stdout.write(pad(row.type === 'active' ? pct(row.usedRate) : '-', 8));
  process.stdout.write(pad(row.type === 'active' ? row.avgUses.toFixed(2) : '-', 10));
  process.stdout.write(String(row.games));
  console.log('');
}
console.log('-'.repeat(62));
const sigma = (50 / Math.sqrt(maxGamesPerSkill)).toFixed(1);
console.log(`每技能 ${maxGamesPerSkill} 局 → 1σ ≈ ±${sigma}pp；小于 2σ（±${(sigma * 2).toFixed(1)}pp）的差异不要当结论`);
console.log(`违规 ${violations} 处`);
