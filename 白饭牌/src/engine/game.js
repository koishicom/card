/**
 * 游戏状态机：创建对局、执行着法、判定胜负。
 *
 * 设计约定：
 *  - applyAction 永不修改传入的 state，总是返回全新的 state（浅层结构化克隆）。
 *  - 所有随机来源于外部注入的 RandomSource，因此对局可完整复现。
 *  - 引擎是纯逻辑，不依赖 DOM / 计时器 / 网络，可无头运行。
 *
 * 技能系统：
 *  - state.skills 记录每人的技能 id；技能通过 src/skills/registry.js 的钩子接入。
 *  - 着法类型：place（放牌）、pass（过牌）、skill（主动技）、chooseCard（交互式选牌）。
 *  - 优先级：紫 0 全局限锁 > 禁列 > 下回合限制 > 技能 > 常规规则。
 */

import { BASE_COUNT, COLUMNS, DECK_SIZE, HAND_SIZE, createDeck, isBomb, isDigit, isMagic } from './cards.js';
import { createRng, shuffle } from './random.js';
import {
  addRestriction,
  consumeRestrictions,
  firstRestriction,
  hasPurpleLock,
  legalActions,
  markRestrictionsReady,
  noRestriction,
  restrictionBlocks,
  restrictionFromMagic,
  restrictionsFor,
  topOf,
} from './rules.js';
import { allSkillIds, getSkill, skillsContext, shuffleSkillIds } from '../skills/registry.js';
// 技能定义必须随引擎一起加载：否则 allSkillIds() 为空，选技阶段会拿到 0 个候选。
// （曾经因为漏了这行，只有显式 import 过 skills.js 的测试才能跑技能模式。）
import '../skills/skills.js';

export const PLAYERS = Object.freeze([0, 1]);
export const DEFAULT_TURN_LIMIT = 900;
/** 记录最近若干手，供 AI 判断"谁在推进局面"。 */
export const HISTORY_LIMIT = 8;
/** 开局随机给出的候选技能数量。 */
export const DRAFT_OPTIONS = 3;

export const other = (player) => 1 - player;

/**
 * @typedef {object} GameState
 * @property {Array} deck                 抽牌堆
 * @property {Array<Array>} bases         3 列牌堆（每列自下而上）
 * @property {Array<Array>} hands         两名玩家的手牌
 * @property {Array} outOfPlay            已移出游戏的牌（弃牌也放这里）
 * @property {number} current             当前行动方
 * @property {number} turn                回合序号（从 1 开始）
 * @property {number} firstPlayer         先手
 * @property {Array<string|null>} skills  每人选定的技能 id
 * @property {Array<number>} skillUses    每人已使用主动技的次数（按玩家记，不是按技能）
 * @property {Array<number>} usesById     记录每个技能已用次数（用于"每局限 N 次"）
 * @property {Array<number>} emPlaced     每人已放置的 E/M 张数（威严用）
 * @property {Array<{turn:number, cardId:string|null}>} lastDigit 每人最近放置的数字牌
 * @property {{options: string[], picks: Array<number|null>}|null} draft 选技阶段
 * @property {{player:number, kind:string, count:number, ready:boolean, note:string}|null} pendingChoice
 * @property {object} restriction         作用于"当前行动方本回合"的下回合限制
 */

/**
 * 状态构造的唯一入口：createGame、clone、以及各处"补字段"都走这里。
 * 以后新增状态字段只需要改这一个函数，不会出现"某处克隆漏了字段"的问题。
 */
export function newState(base = {}) {
  const firstPlayer = base.firstPlayer ?? 0;
  return {
    version: base.version ?? 0,
    deck: base.deck ? base.deck.slice() : [],
    bases: base.bases ? base.bases.map((stack) => stack.slice()) : [],
    hands: base.hands ? [base.hands[0].slice(), base.hands[1].slice()] : [[], []],
    outOfPlay: base.outOfPlay ? base.outOfPlay.slice() : [],
    current: base.current ?? firstPlayer,
    turn: base.turn ?? 1,
    firstPlayer,
    lastPlayer: base.lastPlayer ?? other(firstPlayer),
    forbiddenColumn: base.forbiddenColumn ?? null,
    restriction: base.restriction ? { ...base.restriction } : noRestriction(),
    // 每个玩家一个独立的下回合限制槽：互不覆盖，同一个人可以同时背多条
    restrictions: Array.isArray(base.restrictions)
      ? [base.restrictions[0].map((r) => ({ ...r })), base.restrictions[1].map((r) => ({ ...r }))]
      : [[], []],
    consecutivePasses: base.consecutivePasses ?? 0,
    history: base.history ? base.history.slice() : [],
    turnLimit: base.turnLimit ?? DEFAULT_TURN_LIMIT,
    result: base.result ? { ...base.result } : { over: false, winner: null, reason: null },
    lastAction: base.lastAction ?? null,
    // ---- 技能相关 ----
    skills: base.skills ? [...base.skills] : [null, null],
    skillUses: base.skillUses ? [...base.skillUses] : [0, 0],
    usesById: base.usesById ? { ...base.usesById } : {},
    emPlaced: base.emPlaced ? [...base.emPlaced] : [0, 0],
    lastDigit: base.lastDigit
      ? base.lastDigit.map((entry) => (entry ? { ...entry } : null))
      : [null, null],
    draft: base.draft
      ? {
        options: [...(base.draft.options ?? [])],
        available: [...(base.draft.available ?? base.draft.options ?? [])],
        order: [...(base.draft.order ?? [])],
        picks: [...(base.draft.picks ?? [])],
      }
      : null,
    pendingChoice: base.pendingChoice ? { ...base.pendingChoice } : null,
    // 创生造出来的牌（不属于牌库的 37 张）：登记在这里，牌数守恒检查把它算进去
    createdCards: base.createdCards ? base.createdCards.map((c) => ({ ...c })) : [],
    // 观星开局抢到的牌（仅用于调试/展示，不影响规则判定）
    lastGuanxing: base.lastGuanxing ? { ...base.lastGuanxing } : null,
  };
}

function buildDeckState(rng) {
  const deck = shuffle(createDeck(), rng);
  const bases = [];
  for (let i = 0; i < BASE_COUNT; i++) {
    // 基底只从"数字牌"里抽（普通 0-5 / 紫 0 / 黑 5 都可以）。
    const index = deck.findIndex((c) => isDigit(c));
    bases.push([deck.splice(index, 1)[0]]);
  }
  const hands = [[], []];
  for (let i = 0; i < HAND_SIZE; i++) {
    for (const p of PLAYERS) hands[p].push(deck.pop());
  }
  return { deck, bases, hands };
}

/**
 * 开新局。
 * @param {{seed?: number|string, rng?: object, firstPlayer?: number, lastPlayer?: number,
 *          turnLimit?: number, bases?: Array, hands?: Array, deck?: Array,
 *          withSkills?: boolean, skills?: Array<string|null>}} [options]
 *
 * withSkills 为 true 时进入"选技阶段"：随机抽 DRAFT_OPTIONS 个技能，由后手先选。
 */
export function createGame(options = {}) {
  const rng = options.rng ?? createRng(typeof options.seed === 'string' ? hashSeed(options.seed) : (options.seed ?? Date.now()));
  const draw = options.deck && options.bases && options.hands
    ? { deck: options.deck, bases: options.bases, hands: options.hands }
    : buildDeckState(rng);
  const firstPlayer = options.firstPlayer ?? rng.int(2);
  const lastPlayer = options.lastPlayer ?? other(firstPlayer);

  const state = newState({
    ...draw,
    firstPlayer,
    lastPlayer,
    turnLimit: options.turnLimit ?? DEFAULT_TURN_LIMIT,
  });

  if (options.skills) {
    // 直接指定技能（测试与"固定阵容"模式用），跳过选技阶段。
    state.skills = [options.skills[0] ?? null, options.skills[1] ?? null];
    runGameStartHooks(state, rng);
    // 开局钩子可能挂起交互式选牌（观星）：把行动权交给需要选牌的人
    if (state.pendingChoice) state.current = state.pendingChoice.player;
    return state;
  }

  if (options.withSkills) {
    const candidates = shuffleSkillIds(allSkillIds(), rng).slice(0, DRAFT_OPTIONS);
    state.draft = {
      options: candidates,
      // available 是"还没被选走"的候选：每有一人选走就从这里移除，
      // 保证同一个技能不会被两人同时拿到。
      available: [...candidates],
      // 后手先选：order 是"选择顺序"（玩家号），picks 按顺序追加已选玩家
      order: [lastPlayer, firstPlayer],
      picks: [],
    };
    state.current = lastPlayer;
  }
  return state;
}

function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 后手指定"先手第一手禁放"的列。 */
export function setForbiddenColumn(state, col) {
  if (state.forbiddenColumn !== null || state.result.over) return state;
  if (!Number.isInteger(col) || col < 0 || col >= COLUMNS) throw new Error(`非法列：${col}`);
  const next = { ...newState(state), forbiddenColumn: col };
  next.version = state.version + 1;
  return next;
}

/** 给后手 AI 选禁放列：简单启发式，避免在对手刚开局时白送一列。 */
export function suggestForbiddenColumn(state) {
  let best = 0;
  let bestScore = -Infinity;
  for (let col = 0; col < COLUMNS; col++) {
    const top = topOf(state, col);
    const score = top ? (top.rank >= 2 && top.rank <= 4 ? 2 : top.rank <= 1 ? 1 : 0.5) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = col;
    }
  }
  return best;
}

function clone(state) {
  return newState(state);
}

function drawCards(state, player, count) {
  const drawn = [];
  for (let i = 0; i < count && state.deck.length > 0; i++) {
    const card = state.deck.pop();
    state.hands[player].push(card);
    drawn.push(card);
  }
  return drawn;
}

// ---------------------------------------------------------------------------
// 技能接入
// ---------------------------------------------------------------------------

/** 当前技能上下文（按先手优先排序，技能冲突时先手先生效）。 */
export function skillContextOf(state) {
  return skillsContext(state.skills ?? [null, null]);
}

/**
 * 某玩家本回合允许放置的牌型；返回 null 表示不额外限制。
 *
 * 注意：这里只处理"技能带来的额外禁牌"（例如威严）与紫 0 全局限锁。
 * "下回合限制只许放数字牌"不在这里处理——那条属于限制层，
 * 由 legalActions 统一做限制过滤。
 */
export function legalKindsFor(state, player) {
  if (hasPurpleLock(state)) return ['number'];
  // 限制层整类禁掉的牌型（沉默：本回合不能放 E/M）。
  // 可能同时有多条这类限制，取并集。
  const banned = new Set();
  for (const restriction of restrictionsFor(state, player)) {
    for (const kind of restriction.forbidKinds ?? []) banned.add(kind);
  }
  if (banned.size > 0) {
    return ['number', 'e', 'm'].filter((k) => !banned.has(k));
  }
  const context = skillContextOf(state);
  for (const entry of context.entries) {
    const hook = entry.skill.hooks.legalKinds;
    if (!hook) continue;
    const kinds = hook(context, state, player, entry.player);
    if (kinds) return kinds;
  }
  return null;
}

/** 某个玩家本回合是否被禁止使用主动技能（沉默）。 */
export function skillsForbidden(state, player = state.current) {
  return restrictionsFor(state, player).some((r) => r.forbidSkills === true);
}

/** 某玩家当前的全部合法着法（含普通着法与主动技）。 */
export function playerActions(state, player = state.current) {
  if (state.pendingChoice) {
    const choice = state.pendingChoice;
    if (choice.player !== player) return [{ player, type: 'pass', card: null, reason: '等待对方选牌' }];
    // 候选来自"持牌者"的手牌（观星是自己、汇流是发动者）。
    // candidateIds 可以进一步把候选限定成"其中一部分"（汇流：只能交刚抽到的牌）。
    const hand = state.hands[choice.player] ?? [];
    const allowed = choice.candidateIds
      ? hand.filter((c) => choice.candidateIds.includes(c.id))
      : hand;
    const picked = new Set(choice.picked ?? []);
    const need = (choice.count ?? 1) - picked.size;
    const actions = [];

    if (need > 1) {
      // 需要选多张：逐张选，选满后再确认
      for (const card of allowed) {
        if (picked.has(card.id)) continue;
        actions.push({ player, type: 'chooseCard', card, cardId: card.id, pending: true });
      }
      if (picked.size === (choice.count ?? 1)) {
        actions.push({ player, type: 'confirmChoice', card: null, cardIds: [...picked] });
      }
      return actions;
    }

    // 只差一张（或本来就只需一张）：直接选完即生效
    for (const card of allowed) {
      if (picked.has(card.id)) continue;
      actions.push({ player, type: 'chooseCard', card, cardId: card.id });
    }
    return actions;
  }

  const context = skillContextOf(state);
  const kinds = legalKindsFor(state, player);
  const actions = legalActions(state, player).filter((action) => {
    if (action.type === 'pass') return true;
    // 技能对"可放牌型"的额外限制（例如威严）
    return !kinds || kinds.includes(action.card.kind);
  });

  if (state.result.over || player !== state.current) return actions;

  // 沉默这类限制会禁用主动技能：整段"主动技着法"都不生成
  if (skillsForbidden(state, player)) return actions;

  for (const entry of context.entries) {
    if (entry.player !== player) continue;
    const skill = entry.skill;
    const used = state.usesById[skill.id] ?? 0;
    if (skill.type !== 'active' || used >= skill.maxUses) continue;
    const hook = skill.hooks.extraActions;
    if (!hook) continue;
    for (const action of hook(context, state, player) ?? []) {
      let expanded = [action];
      if (action.needsCard) {
        // 需要指定一张手牌：为每张手牌生成一个着法
        expanded = state.hands[player].map((card, handIndex) => ({
          ...action,
          handIndex,
          card,
          label: `${action.label}（${cardNameSafe(card)}）`,
        }));
      }
      actions.push(...expanded.map((a) => ({ ...a, skill: skill.id, usesLeft: skill.maxUses - used })));
    }
  }
  return actions;
}

/** 卡面名称（避免 game.js 直接依赖 UI 文案，这里用简短形式）。 */
function cardNameSafe(card) {
  if (!card) return '?';
  if (isDigit(card)) {
    if (card.color === 'purple') return '紫0';
    if (card.color === 'black') return '黑5';
    return String(card.rank);
  }
  return `${card.color === 'dark' ? '深' : '浅'}${isBomb(card) ? 'E' : 'M'}`;
}

/** 是否存在除过牌以外的合法着法。 */
export function canAct(state, player = state.current) {
  return playerActions(state, player).some((a) => a.type !== 'pass');
}

/** 技能提供的抽牌方案（过牌时）。 */
function drawPlanFor(state, player) {
  for (const entry of skillContextOf(state).entries) {
    if (entry.player !== player) continue;
    const hook = entry.skill.hooks.drawOnPass;
    if (!hook) continue;
    const plan = hook(skillContextOf(state), state, player);
    if (plan) return plan;
  }
  return null;
}

/** 挂起一个交互式选牌请求。 */
function setPendingChoice(state, request) {
  state.pendingChoice = { ready: false, ...request };
}

/** 从手牌里取走一张（按 id）。 */
function takeFromHand(state, player, cardId) {
  const hand = state.hands[player];
  const index = hand.findIndex((c) => c.id === cardId);
  if (index < 0) return null;
  return hand.splice(index, 1)[0];
}

/** 技能可用的引擎接口（以参数形式传给钩子，避免技能反向依赖 game.js）。 */
const SKILL_API = {
  drawCards,
  setPendingChoice,
  takeFromHand,
  other,
};

/** 选技完成或直接指定技能后，执行 onGameStart 钩子。 */
function runGameStartHooks(state, rng) {
  for (const entry of skillContextOf(state).entries) {
    const hook = entry.skill.hooks.onGameStart;
    // rng 传给钩子：观星要"随机"拿对方 3 张牌，必须可复现
    if (hook) hook(skillContextOf(state), state, entry.player, SKILL_API, rng);
  }
}

/** 选择技能（选技阶段）。picks 按"选择顺序"记录，元素是玩家号。 */
export function chooseSkill(state, player, skillId) {
  if (!state.draft) throw new Error('当前不在选技阶段');
  if (state.result.over) throw new Error('对局已结束');
  const order = state.draft.order;
  const pickedCount = state.draft.picks.length;
  const nextPicker = order[pickedCount];
  if (player !== nextPicker) throw new Error(`还没轮到玩家 ${player} 选技能`);
  if (!state.draft.options.includes(skillId)) throw new Error('该技能不在候选里');
  // 已经被选走的技能不能重复选——否则"后手先选"就没有意义了
  if (!state.draft.available.includes(skillId)) throw new Error('该技能已被对方选走');
  if (state.skills[player]) throw new Error('该玩家已经选过技能');

  const next = clone(state);
  next.draft.picks.push(player);
  next.skills[player] = skillId;
  next.draft.available = next.draft.available.filter((id) => id !== skillId);

  if (next.draft.picks.length >= order.length) {
    next.draft = null;
    next.current = next.firstPlayer;
    runGameStartHooks(next, createRng(next.turn * 7919 + 13));
    // 开局钩子可能挂起交互式选牌（观星）：此时把行动权交给需要选牌的人
    if (next.pendingChoice) next.current = next.pendingChoice.player;
  } else {
    next.current = order[next.draft.picks.length];
  }
  return next;
}

/** 当前该由谁做决定（选技 / 选牌），没有则返回 null。 */
export function waitingFor(state) {
  if (state.result.over) return null;
  if (state.draft) return state.draft.order[state.draft.picks.length] ?? null;
  if (state.pendingChoice && !state.pendingChoice.ready) return state.pendingChoice.player;
  return null;
}

/** 牌堆抽空后，需要连续过牌几次才结算（双方各两次 = 每人多等一个回合）。 */
export const SETTLE_PASSES = 4;

/** 跳过行动或过牌之后的收尾：结算判断 + 换手。 */
function finishTurn(state, actionType) {
  // 结算条件：牌堆已空 且 双方各连续过了两次牌（跳过行动也计入，避免僵局）。
  // 原来是"各过 1 次"，等于无路可走时立刻收场；现在多给一个回合的缓冲，
  // 让双方还有机会靠技能/最后的牌改变结果。
  if (actionType === 'pass' || actionType === 'skip') {
    if (state.consecutivePasses >= SETTLE_PASSES && state.deck.length === 0) {
      settle(state);
      return;
    }
  }
  if (state.turn > state.turnLimit) {
    settle(state, '达到回合上限，按手牌数结算');
    return;
  }
  // 下回合限制只作用于"对方紧接的那一个回合"。
  // 按玩家分槽存储 + ready 标记：
  //   - 刚挂上、还没轮到他的限制（ready=false）留到他的回合才生效；
  //   - 他这个回合结束了，才把已生效的那批清掉。
  // 这样在自己回合内挂给对手的限制不会被自己清掉，也不会覆盖对手已有的限制。
  consumeRestrictions(state, state.current);
  state.current = other(state.current);
  markRestrictionsReady(state, state.current);
}

function settle(state, reason = '牌堆已空，双方连续过牌两轮') {
  const a = state.hands[0].length;
  const b = state.hands[1].length;
  if (a === b) state.result = { over: true, winner: null, reason: `${reason}：手牌相同，平局` };
  else state.result = { over: true, winner: a < b ? 0 : 1, reason: `${reason}：手牌 ${a} : ${b}` };
}

/**
 * 执行一个着法。
 * @returns {GameState} 新状态（永不修改入参）
 */
export function applyAction(state, action) {
  if (state.result.over) throw new Error('对局已结束');
  if (!action || !['place', 'pass', 'skill', 'chooseCard', 'confirmChoice'].includes(action.type)) {
    throw new Error('未知着法');
  }

  // 选技阶段与交互式选牌期间，只接受对应的着法
  if (state.draft) throw new Error('当前在选技阶段，请先选择技能');
  if (state.pendingChoice) {
    if (action.type !== 'chooseCard' && action.type !== 'confirmChoice') throw new Error('当前需要先完成选牌');
    return applyChoiceStep(state, action);
  }
  // 校验"该谁走"时以着法自带的 player 为准，而不是 state.current。
  // 原因：AI 搜索会按层交替推演双方，用 toMove 生成着法但不改 state.current——
  // 这是合法的内部用法，不该被当成"抢回合"。传错玩家时仍会被下面的合法性校验拦下。
  if (action.player !== 0 && action.player !== 1) throw new Error(`非法玩家：${action.player}`);

  const next = clone(state);
  next.turn = state.turn + 1;
  const log = { type: action.type, player: action.player, col: action.col ?? null, card: action.card ?? null };
  next.lastAction = log;

  if (action.type === 'pass') return applyPass(next, action, log);

  // 合法性统一用"原状态"校验，避免克隆体带来的差异
  verifyLegal(state, action);

  if (action.type === 'skill') return applySkill(next, state, action, log);

  // ---- 放置卡牌 ----
  const hand = next.hands[action.player];
  const card = hand[action.handIndex];
  verifyHandIds(hand);

  hand.splice(action.handIndex, 1);
  next.consecutivePasses = 0;
  next.history.push([action.player, 'place']);

  const stack = next.bases[action.col];
  if (isBomb(card)) {
    // 炸掉顶端数字；基底（该列最下面那张）本身不可被炸。
    const canDestroy = stack.length > 1;
    const destroyed = canDestroy ? stack.pop() : null;
    next.outOfPlay.push(card);
    if (destroyed) next.outOfPlay.push(destroyed);
    // 放过 E 也算"放过 E/M"——威严的保护条件用 emPlaced 判定，必须两边都记
    next.emPlaced[action.player] += 1;
    log.destroyed = destroyed ? [destroyed] : [];
  } else if (isMagic(card)) {
    next.outOfPlay.push(card);
    next.emPlaced[action.player] += 1;
    // M 产生的就是一条"下回合限制"，与禁锢/荆棘走同一套机制。
    next.restriction = addRestriction(next, 1 - action.player, restrictionFromMagic(action.player, action.col, card));
    log.magic = next.restriction;
  } else {
    // 数字牌落桌同样算"放过牌"——爆弹的被动效果挂在这里
    stack.push(card);
    next.lastDigit[action.player] = { turn: next.turn, cardId: card.id };
  }

  // 技能：牌落桌之后触发（荆棘在这里挂上限制）
  for (const entry of skillContextOf(next).entries) {
    const hook = entry.skill.hooks.onPlaced;
    if (hook) hook(skillContextOf(next), next, action, SKILL_API);
  }

  if (hand.length === 0) {
    next.result = { over: true, winner: action.player, reason: '出完手牌' };
    return next;
  }

  finishTurn(next, 'place');
  return next;
}

function applyPass(next, action, log) {
  next.history.push([action.player, 'pass']);
  next.consecutivePasses += 1;

  // 抽牌方案：默认自己 2 张、对方 1 张；技能可以改写（汇流）。
  const plan = drawPlanFor(next, action.player);
  const selfDraw = plan ? plan.self : 2;
  const opponentDraw = plan ? plan.opponent : 1;
  const needed = selfDraw + opponentDraw;
  if (next.deck.length >= (plan ? 1 : 3)) {
    log.drawn = {
      [action.player]: drawCards(next, action.player, selfDraw),
      [other(action.player)]: drawCards(next, other(action.player), opponentDraw),
    };
    if (next.deck.length < needed) log.drawnShort = true;
  } else {
    log.drawn = null;
  }

  // 技能：过牌抽完之后（汇流在这里挂起"交一张给对手"）
  for (const entry of skillContextOf(next).entries) {
    if (entry.player !== action.player) continue;
    const hook = entry.skill.hooks.afterPassDraw;
    if (hook) hook(skillContextOf(next), next, action.player, SKILL_API, plan);
  }
  if (next.pendingChoice) {
    log.turnPending = true;
    return next;
  }

  finishTurn(next, 'pass');
  return next;
}

function applySkill(next, prev, action, log) {
  const skill = getSkill(action.skill);
  if (!skill) throw new Error(`未知技能：${action.skill}`);
  if (next.skills[action.player] !== action.skill) throw new Error('你没有这个技能');
  const used = next.usesById[action.skill] ?? 0;
  if (skill.type !== 'active' || used >= skill.maxUses) throw new Error(`技能 ${action.skill} 已用完`);

  // 需要指定手牌的技能（甩手）：先把那张牌从手牌里取出来交给钩子
  let carried = null;
  if (action.handIndex !== undefined && action.handIndex !== null) {
    carried = takeFromHand(next, action.player, action.card?.id);
    if (!carried) throw new Error('指定的手牌不存在');
    action = { ...action, card: carried };
  }

  const handled = skill.hooks.applyAction?.(skillContextOf(next), next, action, log, SKILL_API);
  if (handled === false) throw new Error(`技能 ${action.skill} 执行失败`);

  next.usesById[action.skill] = used + 1;
  next.skillUses[action.player] = (next.skillUses[action.player] ?? 0) + 1;
  next.history.push([action.player, 'skill']);

  // 手牌清空即胜——不管牌是怎么离开手的。
  // 甩手把最后一张手牌丢进已出局区时，效果与"出完手牌"完全一致：
  // 立刻结束对局、弃牌者获胜（否则会出现手牌为 0 却不结束的死局）。
  if (next.hands[action.player].length === 0) {
    next.result = { over: true, winner: action.player, reason: '出完手牌' };
    return next;
  }

  // 不占用行动的技能（消却）：回合数回退，保持"还是这个回合"
  if (log.turnEnds === false) {
    next.turn = prev.turn;
    return next;
  }
  if (next.pendingChoice) return next;
  finishTurn(next, action.skill === 'shuimian' ? 'skip' : 'place');
  return next;
}

/**
 * 交互式选牌的一步。
 * - chooseCard：记录一张；若已经选够 count 张，就地生效。
 * - confirmChoice：把已选的若干张一次性生效（用于"一次选 3 张"的技能）。
 */
function applyChoiceStep(state, action) {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('当前没有待完成的选牌');
  if (action.player !== choice.player) throw new Error(`该由玩家 ${choice.player} 选牌`);

  const hand = state.hands[choice.player] ?? [];
  const picked = [...(choice.picked ?? [])];

  if (action.type === 'chooseCard') {
    if (!hand.some((c) => c.id === action.cardId)) throw new Error('所选牌不在手牌里');
    // candidateIds 把候选限定成一部分时（汇流：只能交刚抽到的牌），这里必须同样校验
    if (choice.candidateIds && !choice.candidateIds.includes(action.cardId)) {
      throw new Error('这张牌不在本次可选范围里');
    }
    if (picked.includes(action.cardId)) throw new Error('这张牌已经选过了');
    picked.push(action.cardId);
  } else {
    if (picked.length === 0) throw new Error('还没有选任何牌');
  }

  const need = choice.count ?? 1;
  const shouldApply = action.type === 'confirmChoice' || picked.length >= need;

  const next = clone(state);
  next.turn = state.turn + 1;

  if (!shouldApply) {
    // 还没选够：只更新进度，回合不结束
    next.pendingChoice = { ...choice, picked };
    next.turn = state.turn;
    next.lastAction = { type: 'chooseCard', player: choice.player, card: action.card ?? null };
    return next;
  }

  if (picked.length !== need) throw new Error(`需要选 ${need} 张，实际选了 ${picked.length} 张`);

  const skill = getSkill(next.skills[choice.player]);
  const request = { ...choice, cardIds: picked, picked, ready: true };
  const handled = skill?.hooks.applyChoice?.(skillContextOf(next), next, request, SKILL_API);
  if (handled === false) throw new Error('选牌结果无法应用');

  next.pendingChoice = null;
  next.lastAction = { type: 'chooseCard', player: choice.player, card: action.card ?? null };

  // 开局阶段的选牌（观星在游戏开始时触发）**不是一个回合**：
  // 它必须原样交还给先手，既不能吃掉先手的第一手，也不能推进 turn
  // ——否则禁列判定（要求 turn === 1）会失效。
  if (choice.phase === 'opening') {
    next.turn = state.turn;
    next.current = state.firstPlayer;
    return next;
  }

  // 回合内的选牌（汇流交牌）属于发动者那一回合的一部分：先回到发动者，再正常结束回合换手。
  next.current = choice.player;
  finishTurn(next, 'place');
  return next;
}

/** 校验着法是否在当前合法着法集合里（用原状态校验）。 */
function verifyLegal(state, action) {
  const legal = playerActions(state, action.player);
  const found = legal.some((a) => {
    if (a.type !== action.type) return false;
    if (action.type === 'place') return a.col === action.col && a.handIndex === action.handIndex;
    if (action.type === 'skill') {
      if (a.skill !== action.skill) return false;
      if (a.col !== action.col) return false;
      if (a.handIndex !== undefined) return a.handIndex === action.handIndex;
      return true;
    }
    if (action.type === 'chooseCard') return a.cardId === action.cardId;
    if (action.type === 'confirmChoice') return true;
    return true;
  });
  if (!found) throw new Error('非法着法');
}

function verifyHandIds(hand) {
  const ids = new Set();
  for (const card of hand) {
    if (ids.has(card.id)) throw new Error(`手牌出现重复 id：${card.id}`);
    ids.add(card.id);
  }
}

/** 对局是否结束。 */
export const isOver = (state) => state.result.over;

/** 从某玩家视角的胜负（1 胜 / 0 平 / -1 负；未结束返回 null）。 */
export function outcomeFor(state, player) {
  if (!state.result.over) return null;
  if (state.result.winner === null) return 0;
  return state.result.winner === player ? 1 : -1;
}

/**
 * 牌数守恒校验：牌堆 + 基底 + 双方手牌 + 已出局 = 37。
 *
 * 「创生」会凭空造牌，所以 expected 会把造出来的张数一起算上：
 * 这样"牌数守恒"这条不变量依然成立，同时又能抓出真正丢牌/多牌的 bug。
 */
export function cardCounts(state) {
  const inPlay = state.bases.reduce((sum, stack) => sum + stack.length, 0);
  const hands = state.hands[0].length + state.hands[1].length;
  const created = state.createdCards?.length ?? 0;
  const total = state.deck.length + inPlay + hands + state.outOfPlay.length;
  return {
    deck: state.deck.length,
    board: inPlay,
    hands,
    outOfPlay: state.outOfPlay.length,
    created,
    total,
    expected: DECK_SIZE + created,
  };
}

/** 取"当前行动方身上生效的下回合限制"（第一条；供只关心单条限制的调用方）。 */
export function activeRestriction(state) {
  return firstRestriction(state, state.current) ?? null;
}

/** 取"某个玩家身上生效的全部下回合限制"（可能有 0 条、1 条或多条）。 */
export function activeRestrictions(state, player = state.current) {
  return restrictionsFor(state, player);
}

/** 把状态整理成一行摘要，便于 CLI 与日志。 */
export function summarize(state) {
  const label = (c) => {
    if (isDigit(c)) {
      if (c.color === 'purple') return '紫0';
      if (c.color === 'black') return '黑5';
      return String(c.rank);
    }
    return `${c.color === 'dark' ? '深' : '浅'}${isBomb(c) ? 'E' : 'M'}`;
  };
  const board = state.bases.map((stack) => stack.map(label).join('>'));
  const restriction = activeRestriction(state);
  const restrictionLabel = restriction ? ` ${restriction.label ?? restriction.kind}限制` : '';
  const skills = state.skills?.some(Boolean) ? ` 技能[${state.skills.map((id) => (id ? getSkill(id)?.name ?? id : '—')).join('/')}]` : '';
  return `T${state.turn} 玩家${state.current + 1} 列[${board.join(' | ')}] 手牌 ${state.hands[0].length}:${state.hands[1].length} 堆 ${state.deck.length}${hasPurpleLock(state) ? ' 紫0限锁' : ''}${restrictionLabel}${skills}`;
}
