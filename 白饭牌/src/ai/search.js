/**
 * 定深搜索（negamax + alpha-beta），支持"信息不完全"下的确定性采样。
 *
 * 真实对局里 AI 看不到对手手牌，所以搜索前先把对手手牌按剩余未知牌采样一次
 * （determinization），在这套假定完整信息上搜索。多次采样取平均即为困难档。
 *
 * 视角约定（重要）：search() 返回的是「当前该走的一方」的分数，标准 negamax。
 * 父节点取负号后即为自己的分数。这样在任意深度的静态评估都不会出现视角错位。
 */

import { applyAction, playerActions } from '../engine/game.js';
import { evaluate, orderActions, terminalScore } from './heuristics.js';

/**
 * @typedef {object} SearchConfig
 * @property {number} depth      搜索深度（层数 = 双方各走一步算 2 层）
 * @property {number} beamWidth  每层最多展开的着法数
 * @property {number} maxNodes   节点预算上限（防止长考）
 */

/** @type {SearchConfig} */
export const DEFAULT_SEARCH = Object.freeze({ depth: 4, beamWidth: 12, maxNodes: 2500 });

/**
 * @param {object} state
 * @param {number} toMove    当前该谁走（也是返回值视角）
 * @param {number} depth
 * @param {number} alpha
 * @param {number} beta
 * @param {SearchConfig} config
 * @param {{nodes: number}} counter
 */
export function search(state, toMove, depth, alpha, beta, config, counter) {
  // 终局：从"该走的一方"视角看，若对局已结束，直接给结果分。
  const terminal = terminalScore(state, toMove);
  if (terminal !== null) return terminal;
  // 交互式选牌节点（观星/汇流的中间态）：不继续展开，直接静态评估。
  // 这类节点的行动方可能不是 toMove，展开会破坏"按层交替"的假设。
  if (state.pendingChoice || state.draft) return evaluate(state, toMove);
  if (depth <= 0 || counter.nodes >= config.maxNodes || state.turn > state.turnLimit) {
    return evaluate(state, toMove);
  }
  counter.nodes += 1;

  // 用 playerActions：它包含主动技与技能带来的各类着法
  const actions = orderActions(state, playerActions(state, toMove), toMove).slice(0, config.beamWidth);
  if (actions.length === 0) return evaluate(state, toMove);

  let best = -Infinity;
  for (const action of actions) {
    const next = applyAction(state, action);
    const value = -search(next, 1 - toMove, depth - 1, -beta, -alpha, config, counter);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * 在一个（采样后的）完整信息局面上挑最佳着法。
 * @returns {{action: object, score: number, nodes: number}} score 从 player 视角
 */
export function bestMoveInWorld(state, player, config = DEFAULT_SEARCH) {
  // 处于选牌中间态时不做搜索：交给专门的选牌策略
  if (state.pendingChoice || state.draft) {
    const actions = playerActions(state, player);
    return { action: actions[0] ?? null, score: evaluate(state, player), nodes: 0 };
  }
  const actions = orderActions(state, playerActions(state, player), player);
  const counter = { nodes: 0 };
  let best = actions[0];
  let bestScore = -Infinity;

  for (const action of actions) {
    const next = applyAction(state, action);
    // 走完这一手后轮到对手，对手视角的分数取负即为自己的分数。
    const opponentView = search(next, 1 - player, Math.max(0, config.depth - 1), -Infinity, Infinity, config, counter);
    const score = -opponentView;
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return { action: best, score: bestScore, nodes: counter.nodes };
}
