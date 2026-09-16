/**
 * 着法提示与讲解：给人类玩家用的"教练"功能。
 *
 * 复用 AI 的搜索，但返回可解释的结果（推荐着法 + 前几名排名 + 一句话理由），
 * 而不是像 AI 那样只吐一个动作。
 */

import { cardName, isBlackFive, isDark, isPurpleZero } from '../engine/cards.js';
import { applyAction, other } from '../engine/game.js';
import { allowedRanksOn, hasPurpleLock, legalActions, topOf } from '../engine/rules.js';
import { evaluate, orderActions } from './heuristics.js';
import { DEFAULT_SEARCH, bestMoveInWorld } from './search.js';

/** 对手对某一手的"最强回应"。 */
export function opponentBestReply(state, player) {
  const next = { ...state, current: other(player) };
  const reply = orderActions(next, legalActions(next, other(player)), other(player))[0] ?? null;
  return reply;
}

/** 用搜索给全部合法着法打分（简化假设：对手手牌用真实信息替代）。 */
export function rankMoves(state, player, searchConfig = DEFAULT_SEARCH) {
  const ranked = [];
  for (const action of orderActions(state, legalActions(state, player), player)) {
    const next = applyAction(state, action);
    const { score } = bestMoveInWorld({ ...next, current: other(player) }, player, searchConfig);
    ranked.push({ action, score, reply: opponentBestReply(next, other(player)) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/** 一句话解释这一手为什么值得下。 */
export function explainAction(state, action, player) {
  if (!action || action.type === 'pass') {
    if (state.deck.length === 0) return '牌堆已空：过牌不抽牌，直接换手，可以用来逼对手也过牌从而进入结算。';
    const legal = legalActions(state, player).filter((a) => a.type === 'place');
    if (legal.length === 0) return '没有任何合法放置，只能过牌（自己抽 2 张、对手抽 1 张）。';
    return '主动过牌会让自己多 2 张牌、对手多 1 张，通常只有在牌堆见底、想拖到结算时才划算。';
  }

  const card = action.card;
  const top = topOf(state, action.col);
  const reasons = [];
  const colName = `第 ${action.col + 1} 列`;

  if (isBomb(card)) {
    reasons.push(`深/浅 E 直接炸掉${colName}顶端的 ${top?.rank}${top && isBlackFive(top) ? '（黑 5 免疫，不可）' : ''}`);
    if (state.bases[action.col].length === 2) reasons.push('但该列只剩基底，炸完会直接暴露基底');
  } else if (isMagic(card)) {
    reasons.push(
      isDark(card)
        ? `深 M 会逼对手下回合只能在${colName}出数字牌`
        : `浅 M 会封掉${colName}，对手下回合只能去别的列出数字牌`,
    );
  } else {
    if (isPurpleZero(card)) reasons.push('紫 0 能触发全场限锁：双方下回合都只能出数字牌，压制力最强');
    else if (isBlackFive(card)) reasons.push('黑 5 免疫炸弹，是很好的安全顶牌');
    else if (card.rank === 5) reasons.push(`5 放上去后对手只能接 0，选择很少`);
    else if (card.rank === 0) reasons.push(`0 也是窄口牌，对手只有 1/2 两条路`);
    if (top) {
      const options = allowedRanksOn(top);
      if (options.length === 1) reasons.push(`当前顶端 ${top.rank} 本来就只有一条出路，出牌可以继续保持收紧`);
    }
  }

  if (hasPurpleLock(state)) reasons.push('当前有紫 0 限锁，只能出数字牌');
  if (state.hands[player].length === 1) reasons.push('这是最后一张手牌，出了就直接获胜');

  if (reasons.length === 0) reasons.push(`把 ${cardName(card)} 压到${colName}顶端 ${top ? top.rank : '空'} 上`);
  return reasons.join('；') + '。';
}

/** 给 UI 用的完整提示包。 */
export function coach(state, player, searchConfig = DEFAULT_SEARCH) {
  const ranked = rankMoves(state, player, searchConfig).slice(0, 3);
  const best = ranked[0];
  return {
    best: best?.action ?? null,
    reason: best ? explainAction(state, best.action, player) : '当前没有可用着法',
    alternatives: ranked.slice(1).map((entry) => ({
      action: entry.action,
      text: entry.action.type === 'pass' ? '过牌' : `第 ${entry.action.col + 1} 列放 ${cardName(entry.action.card)}`,
    })),
    evaluation: best ? Math.round(best.score) : 0,
  };
}

/** 给 UI 用的局面评估条（-1 ~ 1，正数代表当前行动方占优）。 */
export function advantage(state, player) {
  const raw = evaluate(state, player);
  return Math.max(-1, Math.min(1, raw / 40));
}
