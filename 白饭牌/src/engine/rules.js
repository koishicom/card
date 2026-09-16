/**
 * 规则判定层：纯函数，不修改任何入参。
 *
 * 所有"什么能放、什么能炸、什么被锁"的判断都集中在这里，
 * UI、AI、模拟器都只通过这些函数理解规则，因此改规则只需改这一处。
 */

import { COLUMNS, isBomb, isDigit, isMagic, isPurpleZero, isBlackFive, isDark } from './cards.js';

/** 已确认的规则说明书（供 UI 展示，也是本文件的判定依据）。 */
export const RULES_TEXT = Object.freeze([
  '每列只看最上方那张牌，被压住的牌不受任何影响。',
  '数字牌：顶端 0-4 可接 +1/+2；顶端 5（或黑 5）只能接 0；顶端紫 0 按 0 计，只能接 1/2。',
  '浅 E 炸掉顶端 0-4；深 E 炸掉顶端 0-5，但黑 5 免疫，且黑 5 上不能放 E。',
  '基底那张牌本身不可被炸，但它上面的牌可以。炸掉的牌与炸弹一起移出游戏。',
  '浅 M：对方下一回合只能放数字牌，且不能放这一列。深 M：对方下一回合只能在这一列放数字牌。',
  'M 放完立即移出游戏；效果只作用于对方紧接的那一个回合，对方若过牌也照样消耗掉。',
  '只要任意一列顶端是紫 0，全场双方都只能放数字牌，E/M 全部禁用（优先级最高）。',
  '无法放置或不想放置：牌堆有牌则自己抽 2 张、对方抽 1 张；牌堆空则直接换手。',
  '牌堆空且双方连续各过 2 次牌，立即结算，手牌少者胜。',
  '先手第一手不能放在后手指定的那一列。',
]);

/**
 * 顶端是数字时，允许接上的数字集合。
 *
 * 规则：普通 0-3 接 n+1、n+2；5 / 黑 5 只接 0；紫 0 按 0 计只接 1/2。
 * 特例：4 的 n+2 是 6，而牌库最大只有 5，所以 4 实际只能接 5（不能接 0）。
 * @returns {number[]}
 */
export function allowedRanksOn(card) {
  if (!card || !isDigit(card)) return [];
  if (isPurpleZero(card)) return [1, 2];
  if (card.rank === 5) return [0];
  if (card.rank === 4) return [5];
  return [card.rank + 1, card.rank + 2];
}

/** 该列顶端（空列返回 null）。 */
export function topOf(state, col) {
  const stack = state.bases[col];
  if (!stack || stack.length === 0) return null;
  return stack[stack.length - 1];
}

/** 是否满足"任意一列顶端是紫 0"的全局限锁。 */
export function hasPurpleLock(state) {
  for (let col = 0; col < COLUMNS; col++) {
    const top = topOf(state, col);
    if (top && isPurpleZero(top)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 下回合限制：统一承载 M 魔法、禁锢、荆棘、爆弹、沉默等"作用于对手下一个回合"的限制
//
// 优先级（从高到低）：紫 0 全局限锁 > 禁列 > 下回合限制 > 常规规则。
//
// 存储：**每个玩家一个独立列表**（state.restrictions[player]）。这样：
//   - A 身上已有的限制不会被 B 的挂载覆盖（曾经的 bug：荆棘挂上后，对手一个沉默就把它顶掉）；
//   - 同一名玩家可以同时背着多条限制（例如被荆棘粘住之后对手又补一个沉默），
//     任意一条禁止这次放置，这次放置就不合法。
// 每条限制都作用到"该玩家紧接的那一个回合"，他那个回合结束时整批清掉。
// ---------------------------------------------------------------------------

/** 中立的限制对象（没有任何限制）。 */
export function noRestriction() {
  return {
    kind: null,
    label: null,
    allowedColumns: null,
    forbiddenColumns: null,
    digitsOnly: false,
    forbidDigitOnCardId: null,
    // 不受这条限制约束的牌型（例如爆弹：M 不受"只能放这一列"的约束）
    exemptKinds: null,
    // 被这条限制完全禁止的牌型（例如沉默：本回合不能放 E/M）
    forbidKinds: null,
    // 是否禁用主动技能（例如沉默：本回合不能使用主动技能）
    forbidSkills: false,
    setBy: null,
    applyTo: null,
  };
}

/** 给某个玩家挂一条限制（追加，绝不覆盖已有的）。 */
export function addRestriction(state, player, restriction) {
  // ready=false：这条限制还没"生效过"。它要等到该玩家的回合开始才置为 ready，
  // 只有 ready 的限制才会在该玩家回合结束时被清掉——这样在自己回合内挂给对手的限制
  // 不会被自己的回合结束顺手清掉。
  const entry = { ...noRestriction(), ...restriction, applyTo: player, ready: false };
  if (!Array.isArray(state.restrictions) || state.restrictions.length !== 2) {
    state.restrictions = [[], []];
  }
  state.restrictions[player].push(entry);
  return entry;
}

/** 某个玩家当前生效的全部限制（没有就是空数组）。 */
export function restrictionsFor(state, player) {
  if (!Array.isArray(state.restrictions)) return [];
  return (state.restrictions[player] ?? []).filter((r) => r && r.kind);
}

/** 某个玩家的回合开始时，把他身上的限制全部标记为"已生效"。 */
export function markRestrictionsReady(state, player) {
  if (!Array.isArray(state.restrictions)) return;
  for (const restriction of state.restrictions[player] ?? []) {
    if (restriction && restriction.kind) restriction.ready = true;
  }
}

/**
 * 某个玩家的回合结束时，清掉他身上**已经生效过**的限制。
 * 刚挂上、还没轮到他行动的限制（ready=false）会保留到他真的用掉那个回合。
 */
export function consumeRestrictions(state, player) {
  if (!Array.isArray(state.restrictions)) {
    state.restrictions = [[], []];
    return;
  }
  state.restrictions[player] = (state.restrictions[player] ?? []).filter((r) => r && r.kind && !r.ready);
}

/** 由 M 魔法牌产生的限制（语义与重构前完全一致）。 */
export function restrictionFromMagic(playedPlayer, col, card) {
  const dark = isDark(card);
  return {
    kind: dark ? 'magic-dark' : 'magic-light',
    label: dark ? '深 M' : '浅 M',
    allowedColumns: dark ? [col] : null,
    forbiddenColumns: dark ? null : [col],
    digitsOnly: true,
    forbidDigitOnCardId: null,
    setBy: playedPlayer,
    applyTo: 1 - playedPlayer,
  };
}

/**
 * 单个限制对象是否禁止这次放置（内部用）。
 *
 * exemptKinds 列出的牌型只躲开"列约束"，不被整类禁止；
 * 但如果这条限制同时写了 digitsOnly，exemptKinds 里的牌型也不再被它约束
 * （爆弹就是靠这个让 M 在任意列自由落子）。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function singleRestrictionBlocks(state, restriction, col, card) {
  const label = restriction.label ?? '限制';
  const exempt = Boolean(restriction.exemptKinds?.includes(card.kind));

  if (restriction.forbidKinds?.includes(card.kind)) {
    return { ok: false, reason: `${label}：本回合不能放这一类牌` };
  }
  if (!exempt && restriction.allowedColumns && !restriction.allowedColumns.includes(col)) {
    return { ok: false, reason: `${label}：本回合只能放在第 ${restriction.allowedColumns.map((c) => c + 1).join('、')} 列` };
  }
  if (!exempt && restriction.forbiddenColumns && restriction.forbiddenColumns.includes(col)) {
    return { ok: false, reason: `${label}：本回合不能放在第 ${restriction.forbiddenColumns.map((c) => c + 1).join('、')} 列` };
  }
  if (restriction.digitsOnly && !isDigit(card) && !exempt) {
    return { ok: false, reason: `${label}：本回合只能放数字牌` };
  }
  if (restriction.forbidDigitOnCardId && isDigit(card)) {
    const top = topOf(state, col);
    if (top && top.id === restriction.forbidDigitOnCardId) {
      return { ok: false, reason: `${label}：不能放在对方刚放置的那张数字牌上` };
    }
  }
  return { ok: true };
}

/**
 * 当前行动方身上的**全部**限制是否禁止这次放置。
 * 任意一条禁止即不合法（多条限制之间是"与"的关系）。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function restrictionBlocks(state, col, card, player = state.current) {
  for (const restriction of restrictionsFor(state, player)) {
    const verdict = singleRestrictionBlocks(state, restriction, col, card);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** 兼容旧接口：取某个玩家身上"第一条"限制（供只关心单条限制的老代码使用）。 */
export function firstRestriction(state, player = state.current) {
  return restrictionsFor(state, player)[0] ?? noRestriction();
}

/**
 * 某张手牌能否放在某列顶端。
 * 只判断"牌本身能不能放"，不包含下回合限制（那部分由 legalActions 与 applyAction 统一施加）。
 *
 * @returns {{ok: true, effect: object} | {ok: false, reason: string}}
 */
export function canPlaceAt(state, player, col, card) {
  // 开局限制：后手指定的禁列只约束先手的第一手。
  if (
    state.forbiddenColumn !== null &&
    col === state.forbiddenColumn &&
    state.turn === 1 &&
    player === state.firstPlayer
  ) {
    return { ok: false, reason: `开局限制：先手第一手不能放在第 ${col + 1} 列` };
  }

  // 紫 0 全局限锁优先级最高，压过一切技能与 M 限制。
  const digitsOnly = hasPurpleLock(state);

  if (isDigit(card)) {
    const stack = state.bases[col];
    if (!stack || stack.length === 0) return { ok: false, reason: '空列没有可压的牌，无法放数字牌' };
    const top = stack[stack.length - 1];
    if (!isDigit(top)) return { ok: false, reason: `顶端是 ${isMagic(top) ? 'M' : '非数字牌'}，不能压数字牌` };
    if (!allowedRanksOn(top).includes(card.rank)) {
      return { ok: false, reason: `顶端是 ${top.rank}，只能接 ${allowedRanksOn(top).join(' / ')}` };
    }
    return { ok: true, effect: { type: 'digit' } };
  }

  if (isBomb(card)) {
    if (digitsOnly) {
      return { ok: false, reason: '紫 0 限锁生效：全场只能放数字牌' };
    }
    const stack = state.bases[col];
    const top = topOf(state, col);
    if (!top) return { ok: false, reason: '空列没有可炸的牌' };
    if (!isDigit(top)) return { ok: false, reason: '顶端不是数字牌，炸弹只能炸数字' };
    // 黑 5 免疫炸弹：既炸不掉它，也不能把 E 放在它上面。
    if (isBlackFive(top)) {
      return { ok: false, reason: '黑 5 免疫炸弹，且其上不能放 E' };
    }
    // 基底那张牌本身不可被炸：当顶端就是基底时（列高 1）不允许放炸弹。
    if (stack.length <= 1) {
      return { ok: false, reason: '基底不可被炸，此列没有可炸的牌' };
    }
    if (card.color !== 'dark' && top.rank > 4) {
      return { ok: false, reason: '浅 E 只能炸 0-4（普通 5 炸不动）' };
    }
    return {
      ok: true,
      effect: { type: 'bomb', destroyedRank: top.rank, destroyedColor: top.color },
    };
  }

  if (isMagic(card)) {
    if (digitsOnly) {
      return { ok: false, reason: '紫 0 限锁生效：全场只能放数字牌' };
    }
    const top = topOf(state, col);
    if (!top) return { ok: false, reason: '空列没有数字，魔法需要放在数字牌上' };
    if (!isDigit(top)) return { ok: false, reason: '魔法需要放在数字牌上' };
    return {
      ok: true,
      effect: { type: 'magic', variant: isDark(card) ? 'dark' : 'light' },
    };
  }

  return { ok: false, reason: '未知卡牌类型' };
}

/**
 * 组合判定：牌本身能不能放 + 是否被下回合限制禁止。
 */
export function canPlaceWithRestriction(state, player, col, card) {
  const base = canPlaceAt(state, player, col, card);
  if (!base.ok) return base;
  const blocked = restrictionBlocks(state, col, card, player);
  if (!blocked.ok) return blocked;
  return base;
}

/**
 * 枚举某个玩家当前的全部合法着法（永远包含"过牌"）。
 */
export function legalActions(state, player = state.current) {
  const actions = [];
  const hand = state.hands[player] ?? [];
  for (let col = 0; col < COLUMNS; col++) {
    for (let handIndex = 0; handIndex < hand.length; handIndex++) {
      const card = hand[handIndex];
      const verdict = canPlaceWithRestriction(state, player, col, card);
      if (verdict.ok) {
        actions.push({ player, type: 'place', col, handIndex, card, effect: verdict.effect });
      }
    }
  }
  actions.push({
    player,
    type: 'pass',
    card: null,
    reason: actions.length > 0 ? '可放置但选择不放置' : '没有任何合法放置',
  });
  return actions;
}

/** 是否存在除过牌以外的合法着法。 */
export function hasLegalPlacement(state, player = state.current) {
  return legalActions(state, player).some((a) => a.type === 'place');
}

/** 文案：着法的人类可读描述。 */
export function describeAction(action, state) {
  if (!action) return '—';
  if (action.type === 'pass') return `过牌（${action.reason ?? ''}）`;
  const top = topOf(state, action.col);
  return `第 ${action.col + 1} 列（顶端 ${top ? top.rank : '空'}）放置 ${action.card.rank ?? ''}`;
}
