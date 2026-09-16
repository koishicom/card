/**
 * 局面评估启发式。
 *
 * AI 的每一档难度都共用这里的评估函数，区别只在于"看得多远"：
 *   简单 = 只收集合法着法后随机选
 *   普通 = 评估当前选择 + 一步对手最佳回应
 *   困难 = 在采样出的对手手牌上做定深搜索
 * 因此想调 AI 强度，改这里的权重即可影响全部难度。
 */

import { isBlackFive, isBomb, isDark, isDigit, isMagic, isPurpleZero } from '../engine/cards.js';
import { allowedRanksOn, canPlaceAt, hasPurpleLock, legalActions, restrictionsFor, topOf } from '../engine/rules.js';
import { outcomeFor, other, playerActions, skillContextOf } from '../engine/game.js';
import { countLandingSpots } from '../skills/skills.js';

/** 权重集中在这里，方便用模拟器调参。 */
export const WEIGHTS = Object.freeze({
  handDiff: 10,
  mobility: 2.0, // 牌桌可接数字的种类数
  playable: 2.6, // 手牌里现在就能打出去的张数
  control: 1.6,
  tempo: 2.5,
  endgame: 6,
  pressure: 24,
  bombBase: 6,
  bombPerRank: 1.5,
  bombOnFive: 3, // 黑 5 免疫炸弹，炸它没意义（引擎本来也不给这个着法）
  bombOnBase: -4,
  magicBase: 2.5,
  magicPerOption: 0.7,
  digitBase: 1,
  digitExactHalf: 0.6,
  digitOnFive: 2.5,
  digitToZero: 2,
  purple: 12,
  purpleLocked: 4,
  revealBase: 5,
  blackFiveSafe: 0.8, // 黑 5 免疫炸弹 + 只接 0，是很安全的窄口顶牌
});

/** 形成"控制"的顶端牌：对手可接的数字越少越强。 */
export function controlValue(card) {
  if (!card || !isDigit(card)) return 0;
  if (isPurpleZero(card)) return 12;
  if (isBlackFive(card)) return 5;
  const options = allowedRanksOn(card).length;
  return options === 1 ? 6 : 1.5;
}

/** 牌桌上可接数字的总种类数（列越"宽"越自由）。 */
export function columnMobility(state) {
  let total = 0;
  for (let col = 0; col < state.bases.length; col++) {
    const top = topOf(state, col);
    if (top) total += allowedRanksOn(top).length;
  }
  return total;
}

/** 玩家 p 手牌里"现在就能打出去"的张数（真实的行动自由）。 */
export function playableCount(state, p) {
  if (!state.hands[p]) return 0;
  let count = 0;
  for (const card of state.hands[p]) {
    for (let col = 0; col < state.bases.length; col++) {
      if (canPlaceAt(state, p, col, card).ok) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

/** 综合行动自由：牌桌宽度 + 自己能出的牌数。 */
export function mobility(state, p) {
  return columnMobility(state) + playableCount(state, p);
}

/**
 * 从 p 视角评估局面（正数对 p 有利）。不含终局判断。
 * @param {object} state
 * @param {number} p
 * @param {object} [w] 权重覆盖，便于模拟器调参
 */
export function evaluate(state, p, w = WEIGHTS) {
  const opp = other(p);
  let score = 0;

  // 1) 手牌差：自己手牌越少越好。
  score += w.handDiff * (state.hands[opp].length - state.hands[p].length);

  // 2) 行动自由：牌桌可接的数字种类（对双方等价，作为整体宽度）+ 自己现在就能出的牌数。
  score += w.mobility * (columnMobility(state) - 4);
  score += w.playable * (playableCount(state, p) - playableCount(state, opp));

  // 3) 顶端控制：让对手可选数字变少的顶端更强。
  for (let col = 0; col < state.bases.length; col++) {
    const top = topOf(state, col);
    if (top) score += w.control * controlValue(top);
  }

  // 4) 节奏：谁在推进局面，谁就掌握主动。
  const recent = state.history.slice(-6);
  if (recent.length > 0) {
    const mine = recent.filter((e) => e[0] === p && e[1] === 'place').length;
    const theirs = recent.filter((e) => e[0] === opp && e[1] === 'place').length;
    score += WEIGHTS.tempo * (mine - theirs);
  }

  // 5) 终局阶段：牌堆见底时，手牌数直接决定胜负。
  if (state.deck.length === 0) {
    score += WEIGHTS.endgame * (state.hands[opp].length - state.hands[p].length);
  }

  // 6) 临门一脚：对手快要出完时，必须优先压制。
  if (state.hands[opp].length <= 2) score -= WEIGHTS.pressure * (3 - state.hands[opp].length);
  if (state.hands[p].length <= 2) score += WEIGHTS.pressure * (3 - state.hands[p].length);

  return score;
}

/**
 * 技能着法的价值评估。
 * 这里只做"粗评"，作用是让排序不至于把技能排到过牌之后；
 * 真正的取舍由搜索在后续层里体现。
 */
function skillScore(state, action, p) {
  const opp = other(p);
  // 限制是"每人一槽、可叠加"的：沉默（禁 E/M）和荆棘（禁压某张牌）可以和别的限制共存，
  // 但"把牌锁到某一列"这一类是互斥的——禁锢 / 爆弹 / 深 M 都写 allowedColumns，
  // 再补一条只会把前一条顶掉，纯亏一次技能次数。所以只对这一类做抑制。
  const COLUMN_LOCKS = ['magic-dark', 'magic-light', 'baodan-lock', 'skill-jinggu'];
  const oppRestrictions = restrictionsFor(state, opp);
  const hasColumnLock = oppRestrictions.some((r) => COLUMN_LOCKS.includes(r.kind));
  if (hasColumnLock && action.skill === 'jinggu') return -50;

  // 沉默现在同时禁 E/M 和主动技能：两者都打不到才不值得用
  if (action.skill === 'chenmo') {
    const hasEM = state.hands[opp].some((c) => c.kind !== 'number');
    // 对手还有没用完的主动技吗（沉默也会把它一起封掉）
    const oppHasActive = skillContextOf(state).entries.some((e) => {
      if (e.player !== opp) return false;
      if (e.skill.type !== 'active') return false;
      return (state.usesById[e.skill.id] ?? 0) < e.skill.maxUses;
    });
    if (!hasEM && !oppHasActive) return -20;
  }

  switch (action.skill) {
    case 'xiaoque': {
      // 移除顶端：如果移除后对手的行动自由明显变小，就更值得
      const before = mobility(state, opp);
      const top = topOf(state, action.col);
      const freed = top ? allowedRanksOn(top).length : 0;
      return 3 + freed * 1.2 + (before > 0 ? 0.5 : 0);
    }
    case 'jinggu':
      // 与深 M 完全同一个效果，因此共用同一个"封锁着法数"算法与同一套权重
      return 5.5 + lockedOutCount(state, opp, action.col) * WEIGHTS.magicPerOption;
    case 'shuimian': {
      // 跳过对手一次行动 ≈ 白赚一个回合；牌堆空时几乎没有意义
      if (state.deck.length === 0) return 0.5;
      const oppE = state.hands[opp].filter((c) => c.kind !== 'number').length;
      return 5 + oppE * 0.5;
    }
    case 'shuaishou': {
      // 丢一张手牌：手牌越多越值（更快出完）。
      // 手里只剩最后一张时这一手直接获胜，必须给一个压倒性的分数。
      if (state.hands[p].length <= 1) return 60;
      return 2 + Math.min(3, state.hands[p].length * 0.4);
    }
    case 'kanpo':
      // 不占行动，纯信息收益：排在"随便出牌"之后，但明显优于过牌。
      return 4;
    case 'chenmo': {
      // 沉默：封掉对手下回合的 E/M。对手手里的 E/M 越多越值；
      // 对手手牌越少、"少一张牌可出"的伤害越大。
      const oppEM = state.hands[opp].filter((c) => c.kind !== 'number').length;
      const pressure = state.hands[opp].length <= 3 ? 1.5 : 0;
      return 4.5 + oppEM * 1.5 + pressure;
    }
    case 'chuangsheng': {
      // 创生：塞给对方一张牌。与汇流共用同一套判断——
      // 数这张牌在对方手里有几个落点，落点越少越卡手（0 落点 = 完全打不出去）。
      const rank = action.rank ?? 0;
      const spots = countLandingSpots(state, rank);
      const dead = Math.max(0, 3 - spots); // 0 个落点 = 3 分，3 个及以上 = 0 分
      const pressure = Math.max(0, 3 - state.hands[opp].length) * 1.0;
      return 2.5 + dead * 1.5 + pressure;
    }
    default:
      return 1.5;
  }
}

/**
 * "把对手锁到 col 这一列（且只能出数字牌）"能封掉对手多少个着法。
 *
 * 深 M 与禁锢在引擎里是同一个效果（列限制 + digitsOnly），所以**必须共用这一份算法**，
 * 否则同一个效果会因为两条不同的评分公式而选出不同的列。
 * @returns {number} 被封锁的着法数
 */
export function lockedOutCount(state, player, col) {
  const options = playerActions(state, player).filter((a) => a.type === 'place');
  return options.filter((a) => a.col !== col || a.card.kind !== 'number').length;
}

/** 评估"某张牌放到某列"这一手本身的价值（从 p 视角）。 */
export function scoreMove(state, action, p) {
  const opp = other(p);
  let score = 0;

  if (action.type === 'pass') {
    // 过牌：手牌变多，但换来对手也拿 1 张；牌堆空时可用来拖到结算。
    if (state.deck.length === 0) {
      const passScore = WEIGHTS.handDiff * 0.4;
      return -2 + passScore;
    }
    return -6;
  }

  // 技能与选牌着法没有"牌 + 列"结构，单独给分（避免下面按牌类型判断时崩掉）
  if (action.type === 'skill') {
    return skillScore(state, action, p);
  }
  if (action.type === 'chooseCard') {
    // 选牌本身不是收益，给一个很小的正值以便它不会被当成"过牌"那样被压掉
    return 0.5;
  }
  if (action.type === 'confirmChoice') return 0.4;

  const card = action.card;
  const stack = state.bases[action.col];
  const top = topOf(state, action.col);

  if (isBomb(card)) {
    const rank = top?.rank ?? 0;
    score += WEIGHTS.bombBase + rank * WEIGHTS.bombPerRank;
    if (top && isBlackFive(top)) score -= WEIGHTS.bombOnFive;
    if (stack.length === 2) score += WEIGHTS.bombOnBase; // 炸掉后基底直接暴露
  } else if (isMagic(card)) {
    // 深 M：锁一列；浅 M：封一列。两者都用"被封掉的着法数"衡量，只是作用范围不同
    const options = legalActions(state, opp).filter((a) => a.type === 'place');
    const blocked = isDark(card)
      ? lockedOutCount(state, opp, action.col)
      : options.filter((a) => a.col === action.col).length;
    score += WEIGHTS.magicBase + blocked * WEIGHTS.magicPerOption;
  } else {
    score += WEIGHTS.digitBase;
    if (top) {
      // 放 5 或 0 能制造"只有一种接法"的窄口。
      if (card.rank === 5) score += WEIGHTS.digitOnFive;
      if (card.rank === 0) score += WEIGHTS.digitToZero;
      const options = allowedRanksOn(card);
      if (options.length === 1) score += WEIGHTS.digitExactHalf;
      if (card.rank === top.rank + 1) score += 0.5; // 略微偏好更自然的连牌
    }
    if (isPurpleZero(card)) score += WEIGHTS.purple;
    if (isBlackFive(card)) score += WEIGHTS.blackFiveSafe;
    // 把基底盖住（列高 1 -> 2）能防止对手直接炸基底。
    if (stack.length === 1) score += WEIGHTS.revealBase * 0.2;
  }

  // 全局紫 0 限锁下，出数字牌是唯一选择，额外加分以体现"能出就出"。
  if (hasPurpleLock(state) && isDigit(card)) score += WEIGHTS.purpleLocked;
  return score;
}

/**
 * 搜索专用的"技能探索加成"。
 *
 * 搜索按 beamWidth 只保留前 N 个着法，技能着法的静态分普遍低于出牌，
 * 结果就是"技能根本没进搜索树"，AI 永远不会考虑它。
 * 这里只在排序时人为抬高技能着法，让它们至少被评估过——
 * **最终打分不加这个加成**，所以不会因此高估技能。
 */
export const SKILL_SEARCH_BIAS = 12;

/** 立刻能赢的着法检查（出完手牌 / 把最后一张手牌弃掉）。 */
export function immediateWin(state, action, p) {
  if (state.hands[p].length !== 1) return false;
  if (action.type === 'place') return true;
  // 甩手丢掉最后一张手牌，引擎里同样判"出完手牌"获胜
  return action.type === 'skill' && action.skill === 'shuaishou';
}

/** 给着法排序，供搜索剪枝使用。 */
export function orderActions(state, actions, p) {
  return actions
    .map((action) => ({
      action,
      score: (immediateWin(state, action, p) ? 1e6 : 0)
        + scoreMove(state, action, p)
        + (action.type === 'skill' ? SKILL_SEARCH_BIAS : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.action);
}

/** 若局面已结束，返回从 p 视角的终局分值。 */
export function terminalScore(state, p) {
  const outcome = outcomeFor(state, p);
  if (outcome === null) return null;
  if (outcome > 0) return 1e9 + state.hands[other(p)].length * 100;
  if (outcome < 0) return -(1e9 + state.hands[p].length * 100);
  return 0;
}
