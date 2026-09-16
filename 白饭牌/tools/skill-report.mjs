/**
 * 技能强度报告：固定 AI 难度，把某个技能强行发给 0 号位（1 号位不带技能），
 * 交替先后手跑 N 局，量出"这个技能值多少胜率"。
 *
 * 用法：
 *   node tools/skill-report.mjs [每技能局数] [起始种子] [--difficulty=hard]
 *
 * 输出刻意做得很短（每个技能一行），方便在对话里直接看趋势、反复试参数。
 * 详细 JSON 写到 tools/.skill-report.json，供正式报告使用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playGame } from '../src/sim/match.js';
import { BUILTIN_PROFILES } from '../src/ai/profiles.js';
import { allSkillIds } from '../src/skills/registry.js';
import { getSkill } from '../src/skills/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const numeric = args.filter((a) => !a.startsWith('--'));
const gamesPerSkill = Number(numeric[0] ?? 200);
const startSeed = Number(numeric[1] ?? 1);
const difficulty = (args.find((a) => a.startsWith('--difficulty=')) ?? '--difficulty=hard').split('=')[1];
const profile = BUILTIN_PROFILES[difficulty];
if (!profile) throw new Error(`未知难度：${difficulty}`);

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** 跑一个技能：技能发给 0 号位，1 号位空手。 */
function measure(skillId, games, seed0) {
  let wins = 0;
  let draws = 0;
  let winsAsFirst = 0;
  let gamesAsFirst = 0;
  let usedGames = 0;
  let useCount = 0;
  let turns = 0;
  const violations = [];

  for (let i = 0; i < games; i++) {
    const seed = seed0 + i;
    const holderIsFirst = i % 2 === 0;
    const skills = holderIsFirst ? [skillId, null] : [null, skillId];
    const result = playGame({
      players: [profile, profile],
      seed,
      // lastPlayer = 后手那一方；holder 先手时后手是 1 号位
      lastPlayer: holderIsFirst ? 1 : 0,
      withSkills: false,
      skills,
      checkInvariants: true,
    });
    if (result.violations.length) violations.push(...result.violations);

    const holder = holderIsFirst ? 0 : 1;
    turns += result.turns;
    if (result.winner === null) draws += 1;
    else if (result.winner === holder) wins += 1;
    if (holderIsFirst) {
      gamesAsFirst += 1;
      if (result.winner === holder) winsAsFirst += 1;
    }
    const uses = result.skillUses?.[skillId] ?? 0;
    if (uses > 0) usedGames += 1;
    useCount += uses;
  }

  return {
    skillId,
    name: getSkill(skillId)?.name ?? skillId,
    type: getSkill(skillId)?.type ?? '?',
    games,
    wins,
    draws,
    winRate: wins / games,
    drawRate: draws / games,
    firstWinRate: gamesAsFirst ? winsAsFirst / gamesAsFirst : 0,
    secondWinRate: gamesAsFirst ? (wins - winsAsFirst) / (games - gamesAsFirst) : 0,
    usedRate: usedGames / games,
    avgUses: useCount / games,
    avgTurns: turns / games,
    violations,
  };
}

/** 对照组：双方都不带技能，量出"先手优势"以外的基础胜率。 */
function measureControl(games, seed0) {
  let wins = 0;
  let draws = 0;
  let winsAsFirst = 0;
  let gamesAsFirst = 0;
  for (let i = 0; i < games; i++) {
    const holderIsFirst = i % 2 === 0;
    const result = playGame({
      players: [profile, profile],
      seed: seed0 + i,
      lastPlayer: holderIsFirst ? 1 : 0,
      withSkills: false,
      skills: [null, null],
      checkInvariants: true,
    });
    const holder = holderIsFirst ? 0 : 1;
    if (result.winner === null) draws += 1;
    else if (result.winner === holder) wins += 1;
    if (holderIsFirst) {
      gamesAsFirst += 1;
      if (result.winner === holder) winsAsFirst += 1;
    }
  }
  return {
    skillId: null,
    name: '（对照：无技能）',
    type: '-',
    games,
    wins,
    draws,
    winRate: wins / games,
    drawRate: draws / games,
    firstWinRate: gamesAsFirst ? winsAsFirst / gamesAsFirst : 0,
    secondWinRate: gamesAsFirst ? (wins - winsAsFirst) / (games - gamesAsFirst) : 0,
    usedRate: 0,
    avgUses: 0,
    violations: [],
  };
}

const ids = allSkillIds();
console.log(`技能强度测量（${profile.label} 自战，每技能 ${gamesPerSkill} 局，交替先后手，种子 ${startSeed}）`);
console.log('技能        类型   胜率    平局   先手胜率 后手胜率 发动率  平均次数');
console.log('-'.repeat(72));

const rows = [];
const control = measureControl(gamesPerSkill, startSeed);
rows.push(control);

for (const id of ids) {
  const row = measure(id, gamesPerSkill, startSeed);
  rows.push(row);
}

for (const row of rows) {
  const visual = [...row.name].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  process.stdout.write(row.name + ' '.repeat(Math.max(0, 11 - visual)));
  process.stdout.write(String(row.type === 'active' ? '主动' : row.type === 'passive' ? '被动' : '-') + '   ');
  process.stdout.write(pct(row.winRate).padEnd(7));
  process.stdout.write(pct(row.drawRate).padEnd(7));
  process.stdout.write(pct(row.firstWinRate).padEnd(9));
  process.stdout.write(pct(row.secondWinRate).padEnd(9));
  process.stdout.write((row.skillId ? pct(row.usedRate) : '-').padEnd(8));
  process.stdout.write(row.skillId ? row.avgUses.toFixed(2) : '-');
  console.log('');
}

const violations = rows.flatMap((r) => r.violations);
const totalTurns = rows.reduce((s, r) => s + r.avgTurns * r.games, 0);
const totalGames = rows.reduce((s, r) => s + r.games, 0);
console.log('-'.repeat(72));
console.log(`平均步数 ${(totalTurns / totalGames).toFixed(1)}，违规 ${violations.length} 处`);

const outPath = path.join(root, 'tools', '.skill-report.json');
fs.writeFileSync(outPath, JSON.stringify({ difficulty, gamesPerSkill, startSeed, rows }, null, 2), 'utf8');
console.log(`明细已写入 ${path.relative(root, outPath)}`);
