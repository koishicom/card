/**
 * 锦标赛：让各难度两两对打，检验"分层"是否真的成立。
 * 用法：
 *   node tools/tournament.mjs [局数] [起始种子] [--skills]
 *   node tools/tournament.mjs 200 1
 *   node tools/tournament.mjs 200 1 --skills
 */

import { BUILTIN_PROFILES, PROFILE_LIST } from '../src/ai/profiles.js';
import { playMatch } from '../src/sim/match.js';

const args = process.argv.slice(2);
const withSkills = args.includes('--skills');
const numeric = args.filter((a) => !a.startsWith('--'));
const games = Number(numeric[0] ?? 200);
const startSeed = Number(numeric[1] ?? 1);
const matchOptions = { games, startSeed, withSkills };

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (text, width) => {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - visual));
};

console.log(`白饭牌 · AI 锦标赛（每组 ${games} 局，交替先后手，起始种子 ${startSeed}）`);
console.log('='.repeat(96));
console.log(`${pad('对局', 26)}${pad('A 胜率', 10)}${pad('B 胜率', 10)}${pad('平局', 9)}${pad('A 先手胜率', 13)}${pad('A 后手胜率', 13)}${pad('平均手数', 10)}`);
console.log('-'.repeat(96));

const pairs = [];
for (let i = 0; i < PROFILE_LIST.length; i++) {
  for (let j = i + 1; j < PROFILE_LIST.length; j++) pairs.push([PROFILE_LIST[i], PROFILE_LIST[j]]);
}

const results = [];
for (const [a, b] of pairs) {
  const stats = playMatch(a, b, matchOptions);
  results.push({ a, b, stats });
  const firstRate = stats.aGamesAsFirst ? stats.aWinsAsFirst / stats.aGamesAsFirst : 0;
  const secondRate = stats.aGamesAsSecond ? stats.aWinsAsSecond / stats.aGamesAsSecond : 0;
  console.log(
    `${pad(`${a.label} vs ${b.label}`, 26)}${pad(pct(stats.aWinRate), 10)}${pad(pct(stats.bWinRate), 10)}${pad(pct(stats.drawRate), 9)}${pad(pct(firstRate), 13)}${pad(pct(secondRate), 13)}${pad(stats.avgTurns.toFixed(1), 10)}`,
  );
}

console.log('-'.repeat(96));
console.log('同档自战（检验先手优势与对局稳定性）:');
for (const profile of PROFILE_LIST) {
  const stats = playMatch(profile, profile, { ...matchOptions, games: Math.round(games / 2) });
  console.log(
    `${pad(`${profile.label} vs ${profile.label}`, 26)}${pad('—', 10)}${pad('—', 10)}${pad(pct(stats.drawRate), 9)}${pad(pct(stats.aGamesAsFirst ? stats.aWinsAsFirst / stats.aGamesAsFirst : 0), 13)}${pad(pct(stats.aGamesAsSecond ? stats.aWinsAsSecond / stats.aGamesAsSecond : 0), 13)}${pad(stats.avgTurns.toFixed(1), 10)}`,
  );
}

console.log('='.repeat(96));
console.log('分层结论:');
const checks = [
  ['普通 应强于 简单', results.find((r) => r.a.id === 'easy' && r.b.id === 'normal'), 'normal'],
  ['困难 应强于 简单', results.find((r) => r.a.id === 'easy' && r.b.id === 'hard'), 'hard'],
  ['困难 应强于 普通', results.find((r) => r.a.id === 'normal' && r.b.id === 'hard'), 'hard'],
];
let allGood = true;
for (const [label, entry, strongerId] of checks) {
  const strongerRate = strongerId === entry.a.id ? entry.stats.aWinRate : entry.stats.bWinRate;
  const weakerRate = strongerId === entry.a.id ? entry.stats.bWinRate : entry.stats.aWinRate;
  const pass = strongerRate > weakerRate;
  if (!pass) allGood = false;
  console.log(`  ${pass ? '✅' : '❌'} ${label}：${pct(Math.max(strongerRate, weakerRate))} vs ${pct(Math.min(strongerRate, weakerRate))}`);
}

const violations = results.flatMap((r) => r.stats.violations);
console.log(violations.length === 0 ? '  ✅ 全部对局无规则违规' : `  ❌ 发现 ${violations.length} 处违规`);
console.log('='.repeat(96));
console.log(allGood && violations.length === 0 ? '分层正确 ✅' : '分层需要调整 ❌');
process.exit(allGood && violations.length === 0 ? 0 : 1);
