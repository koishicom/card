/**
 * 卡牌定义与牌库构成。
 *
 * 37 张牌：
 *   普通数字 0-5 各 4 张 ............ 24
 *   紫色 0 .........................  1
 *   黑色 5 .........................  2
 *   浅色 E / 深色 E ................   6
 *   浅色 M / 深色 M ................   4
 */

export const CARD = Object.freeze({
  KIND: Object.freeze({ NUMBER: 'number', E: 'e', M: 'm' }),
  COLOR: Object.freeze({ PLAIN: 'plain', PURPLE: 'purple', BLACK: 'black', LIGHT: 'light', DARK: 'dark' }),
});

export const CARD_TEXT = Object.freeze({
  number: '数字',
  e: '炸弹',
  m: '魔法',
  plain: '普通',
  purple: '紫色',
  black: '黑色',
  light: '浅色',
  dark: '深色',
});

export const DECK_SIZE = 37;
export const HAND_SIZE = 5;
export const BASE_COUNT = 3;
export const COLUMNS = 3;

export const isDigit = (card) => card.kind === CARD.KIND.NUMBER;
export const isBomb = (card) => card.kind === CARD.KIND.E;
export const isMagic = (card) => card.kind === CARD.KIND.M;
export const isDark = (card) => card.color === CARD.COLOR.DARK;
export const isBlackFive = (card) => isDigit(card) && card.color === CARD.COLOR.BLACK;
export const isPurpleZero = (card) => isDigit(card) && card.color === CARD.COLOR.PURPLE;

/** 构造完整牌库时用的唯一前缀：每次调用都不同，保证 id 全局唯一。 */
let deckSerial = 0;

function cardId(card, index, serial) {
  const parts = [CARD_TEXT[card.kind], CARD_TEXT[card.color]];
  if (isDigit(card)) parts.push(String(card.rank));
  return `${parts.join('.')}#${serial}-${index}`;
}

/** 构造一张牌：{id, kind, color, rank}。rank 仅数字牌有值。 */
function makeCard(kind, color, rank, index, serial) {
  return { id: cardId({ kind, color, rank }, index, serial), kind, color, rank };
}

/**
 * 构造完整的 37 张牌库（每次新建，避免共享可变对象）。
 *
 * id 里带一个每次调用都递增的 serial，因为四张普通 0（以及其它同型牌）
 * 必须能被区分开：否则"打出一张 0 后又摸到一张 0"会让新牌的 id
 * 与刚打出的那张相同，UI 的选中状态、AI 的着法比较都会张冠李戴。
 */
export function createDeck() {
  const cards = [];
  const serial = deckSerial++;
  let n = 0;
  for (let rank = 0; rank <= 5; rank++) {
    for (let copy = 0; copy < 4; copy++) cards.push(makeCard('number', 'plain', rank, n++, serial));
  }
  cards.push(makeCard('number', 'purple', 0, n++, serial));
  for (let copy = 0; copy < 2; copy++) cards.push(makeCard('number', 'black', 5, n++, serial));
  for (let copy = 0; copy < 3; copy++) cards.push(makeCard('e', 'light', null, n++, serial));
  for (let copy = 0; copy < 3; copy++) cards.push(makeCard('e', 'dark', null, n++, serial));
  for (let copy = 0; copy < 2; copy++) cards.push(makeCard('m', 'light', null, n++, serial));
  for (let copy = 0; copy < 2; copy++) cards.push(makeCard('m', 'dark', null, n++, serial));
  return cards;
}

/**
 * 凭空造一张普通数字牌（技能「创生」用）。
 * 它不在牌库的 37 张里，因此 id 用独立前缀，永远不与牌库里的牌撞号。
 */
export function createExtraCard(rank) {
  const value = Number(rank);
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error(`创生只能造 0-5 的数字牌：${rank}`);
  return { id: `创生.${value}@${deckSerial++}`, kind: 'number', color: 'plain', rank: value };
}

/** 人类可读的卡名。 */
export function cardName(card) {
  if (!card) return '（空）';
  if (isDigit(card)) {
    if (isPurpleZero(card)) return '紫 0';
    if (isBlackFive(card)) return '黑 5';
    return String(card.rank);
  }
  return `${isDark(card) ? '深' : '浅'}${isBomb(card) ? 'E' : 'M'}`;
}

/** 简短规则说明，供 UI 提示与 AI 使用。 */
export function cardBlurb(card) {
  if (!card) return '空位：只能放数字牌（没有任何可压的牌）';
  if (isDigit(card)) {
    if (isPurpleZero(card)) return '按 0 计：只能接 1 / 2；位于顶端时全场只能出数字牌';
    if (isBlackFive(card)) return '只能接 0；免疫炸弹，其上不能放 E';
    // 牌库最大只有 5，所以 4 的 +2（6）不存在，4 实际只能接 5。
    if (card.rank === 5) return '只能接 0';
    if (card.rank === 4) return '只能接 5';
    return `只能接 ${card.rank + 1}、${card.rank + 2}`;
  }
  if (isBomb(card)) {
    return isDark(card)
      ? '深 E：炸掉顶端 0-5（黑 5 免疫），连同自身出局'
      : '浅 E：炸掉顶端 0-4，连同自身出局';
  }
  return isDark(card)
    ? '深 M：对方下回合只能在这一列放数字牌'
    : '浅 M：对方下回合只能放数字牌，且不能放这一列';
}

/** 卡面色彩主题（引擎无关，供 UI 使用）。 */
export function cardTheme(card) {
  if (isDigit(card)) {
    if (isPurpleZero(card)) return 'purple';
    if (isBlackFive(card)) return 'black';
    return 'plain';
  }
  if (isBomb(card)) return isDark(card) ? 'dark' : 'light';
  return isDark(card) ? 'magic-dark' : 'magic-light';
}
