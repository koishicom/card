/**
 * 测试辅助：构造受控局面与着法。
 * 只服务于 tools/test.mjs，不进入游戏运行时。
 */

import { COLUMNS, DECK_SIZE, createDeck, isDigit } from '../src/engine/cards.js';
import { createGame, newState, playerActions } from '../src/engine/game.js';
import { legalActions, noRestriction } from '../src/engine/rules.js';
// 引入技能定义：注册表本身不含技能，技能是在 skills.js 里注册的
import '../src/skills/skills.js';

/**
 * 把 '0'…'5' '紫0' '黑5' 'E·浅' 'E·深' 'M·浅' 'M·深' 解析成一张牌。
 * 每次都从新牌库里取，并带上唯一后缀，避免同一场景里两张同型牌 id 相同。
 */
let cardSerial = 0;

export function card(notation) {
  const text = String(notation);
  const deck = createDeck();
  let found = null;
  if (text === '紫0') found = deck.find((c) => isDigit(c) && c.color === 'purple');
  else if (text === '黑5') found = deck.find((c) => isDigit(c) && c.color === 'black');
  else if (text.startsWith('E')) found = deck.find((c) => c.kind === 'e' && c.color === (text.includes('深') ? 'dark' : 'light'));
  else if (text.startsWith('M')) found = deck.find((c) => c.kind === 'm' && c.color === (text.includes('深') ? 'dark' : 'light'));
  else {
    const rank = Number(text);
    if (!Number.isInteger(rank)) throw new Error(`无法解析牌：${text}`);
    found = deck.find((c) => isDigit(c) && c.color === 'plain' && c.rank === rank);
  }
  if (!found) throw new Error(`牌库里找不到：${text}`);
  return { ...found, id: `${found.id}~${cardSerial++}` };
}

/** 同一张牌可能在牌库里有多张，测试里统一取第一张。 */
export function cardId(notation) {
  return card(notation).id;
}

/**
 * 构造受控局面。
 * @param {{bases: string[][], hands: string[][], deck?: string[], current?: number,
 *          forbiddenColumn?: number|null, pendingMagic?: object|null, restriction?: object|null,
 *          skills?: Array<string|null>}} spec
 *
 * spec.pendingMagic 是旧的"只支持 M 魔法"写法，这里自动转成通用的 restriction 形状，
 * 方便测试直接描述"某玩家身上带着一条下回合限制"。
 */
/** 场景默认可用的牌堆（数字牌，用于补足牌数守恒）。 */
function paddingDeck() {
  const deck = createDeck();
  return deck.slice();
}

export function scene(spec) {
  const base = createGame({ seed: 42 });
  const hands = [spec.hands?.[0] ?? [], spec.hands?.[1] ?? []];
  const restriction = spec.restriction ?? (spec.pendingMagic ? magicRestriction(spec.pendingMagic) : noRestriction());
  // 牌桌固定 3 列：测试只写关心的列，其余补空列，避免出现 undefined
  const columnSpecs = [...spec.bases];
  while (columnSpecs.length < COLUMNS) columnSpecs.push([]);
  // 牌堆：测试给的牌放在"最上面"（会被先抽到），其余用真实牌库补足，
  // 这样"牌数守恒"这类断言才有意义。
  // padDeck: false 表示只用测试给的牌（用于验证"牌堆空"这类场景）。
  const customDeck = (spec.deck ?? []).map((n) => card(n));
  const deck = spec.padDeck === false ? customDeck : [...paddingDeck(), ...customDeck];
  return {
    ...newState(base),
    bases: columnSpecs.slice(0, COLUMNS).map((stack) => stack.map((n) => card(n))),
    hands: hands.map((list) => list.map((n) => card(n))),
    deck,
    current: spec.current ?? 0,
    turn: 1,
    forbiddenColumn: spec.forbiddenColumn ?? null,
    restriction,
    // 限制按玩家分槽存储：场景里给了 restriction 就把它放进"它作用的那个玩家"的槽，
    // 并标记为已生效（ready），等价于"这个玩家本回合确实背着这条限制"。
    restrictions: (() => {
      const slots = [[], []];
      if (restriction && restriction.kind) {
        const target = restriction.applyTo ?? (spec.current ?? 0);
        slots[target].push({ ...restriction, applyTo: target, ready: true });
      }
      return slots;
    })(),
    skills: spec.skills ? [...spec.skills] : [null, null],
    // 场景里默认没有"凭空造出来的牌"（创生相关测试自己塞）
    createdCards: [],
    consecutivePasses: 0,
    history: [],
    result: { over: false, winner: null, reason: null },
  };
}

/**
 * 找到某个技能产生的着法（可选按列筛选）。
 * 技能着法不在 legalActions 里，而是由 playerActions 提供。
 */
export function findSkill(state, skillId, col = null) {
  const actions = playerActions(state, state.current).filter((a) => a.type === 'skill' && a.skill === skillId);
  if (col === null) return actions[0];
  return actions.find((a) => a.col === col);
}

/** 当前玩家的全部合法着法（含主动技）。 */
export function actionsOf(state, player = state.current) {
  return playerActions(state, player);
}

/** 把旧的 pendingMagic 描述转成通用 restriction。 */
function magicRestriction(pending) {
  return {
    kind: pending.variant === 'dark' ? 'magic-dark' : 'magic-light',
    label: pending.variant === 'dark' ? '深 M' : '浅 M',
    allowedColumns: pending.column != null ? [pending.column] : null,
    forbiddenColumns: pending.forbiddenColumn != null ? [pending.forbiddenColumn] : null,
    digitsOnly: true,
    forbidDigitOnCardId: null,
    setBy: pending.setBy ?? null,
    applyTo: pending.applyTo ?? null,
  };
}

/**
 * 找到"把某张牌放到某列"的合法着法；不合法返回 undefined。
 *
 * 注意两点：
 *  - 按"牌型"（kind/color/rank）匹配而不是按 id——每次调用 card() 都会得到新 id 的等价牌。
 *  - 走 playerActions（含技能与限制），而不是裸的 legalActions，
 *    否则"被技能或限制改变过的合法性"就查不到着法。
 */
export function findPlace(state, col, notation) {
  const wanted = card(notation);
  return playerActions(state, state.current).find(
    (a) =>
      a.type === 'place' &&
      a.col === col &&
      a.card.kind === wanted.kind &&
      a.card.color === wanted.color &&
      a.card.rank === wanted.rank,
  );
}

/**
 * 断言用：找到着法，找不到时抛出带上下文的错误，
 * 避免测试场景本身写错（例如把 1 放到顶端 3 上）时只看到一句"未知着法"。
 */
export function requirePlace(state, col, notation) {
  const action = findPlace(state, col, notation);
  if (!action) {
    const tops = state.bases.map((stack) => (stack.length ? stack[stack.length - 1].rank ?? stack[stack.length - 1].kind : '空'));
    throw new Error(
      `测试场景有误：无法把 ${notation} 放到第 ${col + 1} 列（顶端 ${tops[col]}；各列顶端 ${tops.join(' / ')}）`,
    );
  }
  return action;
}

/** 某个着法是否合法（用于断言）。 */
export function isLegal(state, action) {
  if (!action) return false;
  return playerActions(state, state.current).some(
    (a) => a.type === action.type && a.col === action.col && a.handIndex === action.handIndex,
  );
}

/** 过牌着法。 */
export function pass(state = null) {
  return { type: 'pass', card: null, reason: '测试', player: state ? state.current : 0 };
}

/** 指定玩家的过牌着法。 */
export function passOf(player) {
  return { type: 'pass', card: null, reason: '测试', player };
}

export { DECK_SIZE };
