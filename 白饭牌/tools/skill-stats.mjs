/**
 * 实战技能统计：跟真实对局一样——开局随机亮 3 个候选、后手先选、先手再选，
 * 双方都带技能一路打完。用来量"在实际选技+对局里，每个技能被选中的频率、
 * 拿到它的人赢多少、以及到底发动了几次"。
 *
 * 用法：
 *   node tools/skill-stats.mjs [总对局数] [起始种子] [--difficulty=hard|normal]
 *
 * 输出：整体先手优势 + 每个技能一行（选中率 / 持有者胜率 / 发动率 / 平均次数）。
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
const games = Number(numeric[0] ?? 400);
const startSeed = Number(numeric[1] ?? 1);
const difficulty = (args.find((a) => a.startsWith('--difficulty=')) ?? '--difficulty=hard').split('=')[1];
const profile = BUILTIN_PROFILES[difficulty];
if (!profile) throw new Error(`未知难度：${difficulty}`);

const ids = allSkillIds();
const stat = new Map(ids.map((id) => [id, {
  id,
  name: getSkill(id)?.name ?? id,
  type: getSkill(id)?.type ?? '?',
  picked: 0,
  holderWins: 0,
  used: 0,
  uses: 0,
  gamesWithSkill: 0,
}]));

let firstWins = 0;
let secondWins = 0;
let draws = 0;
let turns = 0;
let violations = 0;

for (let i = 0; i < games; i++) {
  const seed = startSeed + i;
  const result = playGame({
    players: [profile, profile],
    seed,
    withSkills: true,
    checkInvariants: true,
  });
  if (result.violations.length) violations += result.violations.length;
  turns += result.turns;

  if (result.winner === null) draws += 1;
  else if (result.winner === result.state.firstPlayer) firstWins += 1;
  else secondWins += 1;

  for (const player of [0, 1]) {
    const skillId = result.state.skills[player];
    if (!skillId || !stat.has(skillId)) continue;
    const entry = stat.get(skillId);
    entry.picked += 1;
    entry.gamesWithSkill += 1;
    if (result.winner === player) entry.holderWins += 1;
    const uses = result.skillUses?.[skillId] ?? 0;
    if (uses > 0) entry.used += 1;
    entry.uses += uses;
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (text, width) => {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - visual));
};

const totalPickSlots = games * 2;
console.log(`实战技能统计（${profile.label} 自战，${games} 局，双方都走真实选技流程，种子 ${startSeed}）`);
console.log(`先手胜率 ${pct(firstWins / games)} ｜ 后手胜率 ${pct(secondWins / games)} ｜ 平局 ${pct(draws / games)} ｜ 平均 ${(turns / games).toFixed(1)} 步 ｜ 违规 ${violations}`);
console.log('');
console.log('技能        类型   被选中   持有者胜率  发动率   平均发动');
console.log('-'.repeat(64));

const rows = [...stat.values()].sort((a, b) => b.picked - a.picked);
for (const row of rows) {
  process.stdout.write(pad(row.name, 11));
  process.stdout.write(pad(row.type === 'active' ? '主动' : '被动', 7));
  process.stdout.write(pad(`${row.picked}（${pct(row.picked / totalPickSlots)}）`, 9));
  process.stdout.write(pad(row.picked ? pct(row.holderWins / row.picked) : '-', 12));
  process.stdout.write(pad(row.picked ? pct(row.used / row.picked) : '-', 9));
  process.stdout.write(row.picked ? (row.uses / row.picked).toFixed(2) : '-');
  console.log('');
}

const outPath = path.join(root, 'tools', '.skill-stats.json');
fs.writeFileSync(outPath, JSON.stringify({
  difficulty,
  games,
  startSeed,
  firstWins,
  secondWins,
  draws,
  avgTurns: turns / games,
  violations,
  rows,
}, null, 2), 'utf8');
console.log('-'.repeat(64));
console.log(`明细已写入 ${path.relative(root, outPath)}`);
