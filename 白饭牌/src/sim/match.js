/**
 * 无头对局引擎：跑一局、跑一批、统计胜负。
 * 供 CLI（tools/*.mjs）和测试使用；不涉及任何 IO 与 UI。
 */

import { applyAction, cardCounts, chooseSkill, createGame, isOver, newState, playerActions, setForbiddenColumn, waitingFor } from '../engine/game.js';
import { createRng } from '../engine/random.js';
import { DECK_SIZE } from '../engine/cards.js';
/** 两个着法是否等价（用于校验 AI 给出的着法确实在合法集合里）。 */
function isSameAction(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'place') return a.col === b.col && a.handIndex === b.handIndex;
  if (a.type === 'skill') return a.skill === b.skill && a.col === b.col;
  if (a.type === 'chooseCard') return a.cardId === b.cardId;
  return true;
}

/**
 * 跑一局完整对局。
 * @param {object} options
 * @param {object} options.players  {0: profile, 1: profile}
 * @param {number} options.seed
 * @param {number} [options.lastPlayer] 指定后手（用于平衡先手优势）
 * @param {number} [options.turnLimit]
 * @param {boolean} [options.checkInvariants]
 * @param {number} [options.rngSeed] AI 自己的随机源
 * @returns {{winner: (number|null), reason: string, turns: number, passes: number, cards: object,
 *            finalHands: number[], deckLeft: number, violations: string[], state: object}}
 */
export function playGame({
  players,
  seed,
  lastPlayer,
  turnLimit,
  checkInvariants = true,
  withSkills = false,
  skills = null,
  rngSeed = seed * 7919 + 13,
}) {
  const gameOptions = { seed, withSkills };
  if (turnLimit) gameOptions.turnLimit = turnLimit;
  // 固定阵容（技能强度测量用）：直接指定双方技能，跳过选技阶段
  if (skills) gameOptions.skills = skills;
  let state = createGame(gameOptions);
  // 只覆盖座位信息：不要用 newState 重包（那会丢字段，曾经把 draft.options 清空）
  if (lastPlayer === 0 || lastPlayer === 1) {
    state = { ...state, lastPlayer, firstPlayer: 1 - lastPlayer };
  }
  const rng = createRng(rngSeed);

  // 开局：选技 → 后手指定禁列
  // AI 在选技阶段返回技能 id（见 src/ai/profiles.js 的 decide）；
  // 这里做一次兜底校验，避免 AI 给出已被对方选走/不在候选里的技能。
  let guardDraft = 0;
  while (state.draft && guardDraft++ < 20) {
    const picker = waitingFor(state);
    const decided = players[picker].decide(state, picker, rng);
    const available = state.draft.available;
    const skillId = typeof decided === 'string' && available.includes(decided)
      ? decided
      : available[0];
    state = chooseSkill(state, picker, skillId);
  }

  const banPicker = players[state.lastPlayer];
  const banned = banPicker.chooseForbiddenColumn(state, rng);
  state = setForbiddenColumn(state, banned);

  const violations = [];
  let turns = 0;
  let passes = 0;

  while (!isOver(state) && turns < 3000) {
    const player = waitingFor(state) ?? state.current;
    const legal = playerActions(state, player);
    const action = players[player].decide(state, player, rng);

    if (!legal.some((a) => isSameAction(a, action))) {
      violations.push(`玩家 ${player} 在第 ${turns} 手给出非法着法（${action && action.type}）`);
      break;
    }
    if (action.type === 'pass') passes += 1;

    const before = checkInvariants ? cardCounts(state) : null;
    state = applyAction(state, action);
    if (checkInvariants) {
      const after = cardCounts(state);
      // 用 expected 而不是 DECK_SIZE：创生会凭空造牌，基线随之抬高
      if (after.total !== after.expected) violations.push(`第 ${turns} 手牌数不守恒：${JSON.stringify(after)}`);
      if (action.type === 'place' && after.deck !== before.deck) violations.push(`第 ${turns} 手放置动作改变了牌堆`);
    }
    turns += 1;
  }

  if (!isOver(state)) violations.push('对局未在上限内结束');

  return {
    winner: state.result.winner,
    reason: state.result.reason,
    turns,
    passes,
    cards: cardCounts(state),
    finalHands: [state.hands[0].length, state.hands[1].length],
    deckLeft: state.deck.length,
    // 各主动技本局发动次数（技能强度测量用）
    skillUses: { ...(state.usesById ?? {}) },
    violations,
    state,
  };
}

/**
 * 两个 AI 对打 n 局，每种先后手各一半，返回统计。
 * @param {object} profileA
 * @param {object} profileB
 * @param {{games?: number, startSeed?: number, checkInvariants?: boolean}} [options]
 */
export function playMatch(profileA, profileB, options = {}) {
  const games = options.games ?? 200;
  const startSeed = options.startSeed ?? 1;
  const stats = {
    games: 0,
    aWins: 0,
    bWins: 0,
    draws: 0,
    aWinsAsFirst: 0,
    aGamesAsFirst: 0,
    aWinsAsSecond: 0,
    aGamesAsSecond: 0,
    turns: 0,
    passes: 0,
    finishesByHand: 0,
    violations: [],
  };

  for (let i = 0; i < games; i++) {
    const seed = startSeed + i;
    const aIsFirst = i % 2 === 0; // 交替先后手，抵消先手优势
    const players = aIsFirst ? { 0: profileA, 1: profileB } : { 0: profileB, 1: profileA };
    const result = playGame({
      players,
      seed,
      lastPlayer: aIsFirst ? 1 : 0,
      checkInvariants: options.checkInvariants ?? false,
      withSkills: options.withSkills ?? false,
    });

    stats.games += 1;
    stats.turns += result.turns;
    stats.passes += result.passes;
    if (result.violations.length) stats.violations.push({ seed, issues: result.violations });
    if (result.reason === '出完手牌') stats.finishesByHand += 1;

    const aPlayer = aIsFirst ? 0 : 1;
    if (result.winner === null) stats.draws += 1;
    else if (result.winner === aPlayer) {
      stats.aWins += 1;
      if (aIsFirst) stats.aWinsAsFirst += 1;
      else stats.aWinsAsSecond += 1;
    } else stats.bWins += 1;

    if (aIsFirst) stats.aGamesAsFirst += 1;
    else stats.aGamesAsSecond += 1;
  }

  stats.aWinRate = stats.games ? stats.aWins / stats.games : 0;
  stats.bWinRate = stats.games ? stats.bWins / stats.games : 0;
  stats.drawRate = stats.games ? stats.draws / stats.games : 0;
  stats.avgTurns = stats.games ? stats.turns / stats.games : 0;
  stats.avgPasses = stats.games ? stats.passes / stats.games : 0;
  return stats;
}
