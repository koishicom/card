/**
 * 九个技能的实现。
 *
 * 与引擎的接口约定（由 game.js 保证）：
 *   - 钩子里的 state 已经是"本次着法的克隆体"，可以直接就地修改。
 *   - 主动技通过 extraActions 提供着法，通过 applyAction 执行。
 *   - 需要玩家选牌的技能用 setPendingChoice 挂起，等 chooseCard 着法回来再 applyChoice。
 *   - 技能优先级低于紫 0 限锁与禁列：那两项由 rules.js 判定，技能只做"额外的限制"。
 *
 * 规则裁定（来自需求确认）：
 *   - 弃牌 = 已出局（复用 outOfPlay，不新增区域）
 *   - 消却不能移除基底（该列只剩基底时不可选）
 *   - 睡眠不算过牌：双方都不抽牌；但为避免僵局，仍计入"连续跳过"用于结算
 *   - 选牌由持牌的人自己选
 *   - 汇流从全部手牌里选 1 张交给对手
 */

import { COLUMNS, createExtraCard, isDigit } from '../engine/cards.js';
import { addRestriction, allowedRanksOn, hasPurpleLock } from '../engine/rules.js';
import { defineSkill } from './registry.js';

/** 该列是否"只剩基底"（基底不可被炸，也不可被消却）。 */
const onlyBase = (state, col) => state.bases[col].length <= 1;

// ---------------------------------------------------------------------------
// 消却：免费移除任意牌堆顶的一张牌（不占行动）
// ---------------------------------------------------------------------------
defineSkill({
  id: 'xiaoque',
  name: '消却',
  type: 'active',
  maxUses: 1,
  text: '在你的回合，立刻移除任意牌堆顶的一张牌（不能移除基底）。不占用行动。',
  hooks: {
    extraActions(_ctx, state, player) {
      const actions = [];
      for (let col = 0; col < COLUMNS; col++) {
        if (onlyBase(state, col)) continue;
        actions.push({ player, type: 'skill', skill: 'xiaoque', col, card: null, label: `消却：移除第 ${col + 1} 列顶端` });
      }
      return actions;
    },
    applyAction(_ctx, state, action, log) {
      const stack = state.bases[action.col];
      const removed = stack.length > 1 ? stack.pop() : null;
      if (removed) state.outOfPlay.push(removed);
      log.removed = removed ? [removed] : [];
      log.turnEnds = false; // 不占用行动
      return true;
    },
  },
});

// ---------------------------------------------------------------------------
// 看破：观看对方手牌（不占行动，每局限 2 次）
// ---------------------------------------------------------------------------
defineSkill({
  id: 'kanpo',
  name: '看破',
  type: 'active',
  maxUses: 2,
  text: '在你的回合，你可以观看对方的手牌。不会占用你的行动。',
  hooks: {
    extraActions(_ctx, state, player) {
      // 对方没手牌就没什么可看的
      const target = 1 - player;
      if ((state.hands[target] ?? []).length === 0) return [];
      return [{ player, type: 'skill', skill: 'kanpo', col: null, card: null, label: '看破：观看对方手牌' }];
    },
    applyAction(_ctx, state, action, log) {
      // 看破只是"当场看一眼"：不写入任何持续状态，只留一条战报。
      // 看过的牌不保留、不追踪——对方之后摸到什么牌，你依然不知道。
      const target = 1 - action.player;
      log.revealed = (state.hands[target] ?? []).length;
      log.turnEnds = false; // 不占用行动：看破之后还能照常出牌
      return true;
    },
  },
});

// ---------------------------------------------------------------------------
// 禁锢：对方下回合只能在这一列放数字牌（占用行动）
// ---------------------------------------------------------------------------
defineSkill({
  id: 'jinggu',
  name: '禁锢',
  type: 'active',
  maxUses: 1,
  text: '选定一个牌堆，对方下回合只能在这里放置牌，且只能放数字牌。占用行动。',
  hooks: {
    extraActions(_ctx, state, player) {
      return Array.from({ length: COLUMNS }, (_unused, col) => ({
        player,
        type: 'skill',
        skill: 'jinggu',
        col,
        card: null,
        label: `禁锢：把对手锁在第 ${col + 1} 列`,
      }));
    },
    applyAction(_ctx, state, action, log) {
      log.restriction = addRestriction(state, 1 - action.player, {
        kind: 'skill-jinggu',
        label: '禁锢',
        allowedColumns: [action.col],
        digitsOnly: true,
        setBy: action.player,
      });
      log.turnEnds = true;
      return true;
    },
  },
});

// ---------------------------------------------------------------------------
// 睡眠：跳过这次行动，直接换手（每局两次）
// ---------------------------------------------------------------------------
defineSkill({
  id: 'shuimian',
  name: '睡眠',
  type: 'active',
  maxUses: 2,
  text: '跳过一次行动，直接轮到对方（双方都不抽牌）。每局可用两次。',
  hooks: {
    extraActions(_ctx, state, player) {
      return [{ player, type: 'skill', skill: 'shuimian', col: null, card: null, label: '睡眠：跳过这次行动' }];
    },
    applyAction(_ctx, state, _action, log) {
      // 不算过牌：双方都不抽牌。但仍计入"连续跳过"，避免双方都靠它拖成僵局。
      state.consecutivePasses += 1;
      log.skipped = true;
      log.turnEnds = true;
      return true;
    },
  },
});

// ---------------------------------------------------------------------------
// 观星：开局随机拿走对方 2 张手牌，然后交 2 张手牌给对方
// ---------------------------------------------------------------------------
defineSkill({
  id: 'guanxing',
  name: '观星',
  type: 'passive',
  maxUses: 0,
  text: '游戏开始时，你随机获得对方 2 张牌，然后选择 2 张手牌交给对方。',
  hooks: {
    /**
     * 开局：
     *   1. 从对方手里随机抽走 2 张，放进自己手里（相当于"抢"）→ 自己 7 张、对方 3 张；
     *   2. 挂起选牌，让发动者从这 7 张里挑 2 张交给对方。
     * 一进一出正好 2 张，双方手牌数回到 5，只是把对方的 2 张换成了自己的 2 张。
     */
    onGameStart(_ctx, state, player, api, rng) {
      const target = 1 - player;
      const taken = [];
      const times = Math.min(2, state.hands[target].length);
      for (let i = 0; i < times; i++) {
        const size = state.hands[target].length;
        const index = rng && typeof rng.int === 'function' ? rng.int(size) : Math.floor(Math.random() * size);
        taken.push(state.hands[target].splice(index, 1)[0]);
      }
      state.hands[player].push(...taken);
      state.lastGuanxing = { by: player, taken: taken.map((c) => ({ ...c })) };

      api.setPendingChoice(state, {
        player,
        kind: 'giveToOpponent',
        count: 2,
        picked: [],
        // 标记为"开局阶段的选牌"：引擎不会把它当成一个回合
        //（否则会吃掉先手第一手，并让禁列判定失效）
        phase: 'opening',
        ready: false,
        note: '观星：选择 2 张手牌交给对方',
      });
    },
    applyChoice(_ctx, state, choice) {
      const target = 1 - choice.player;
      for (const id of choice.cardIds) {
        const index = state.hands[choice.player].findIndex((c) => c.id === id);
        if (index < 0) continue;
        state.hands[target].push(state.hands[choice.player].splice(index, 1)[0]);
      }
      state.pendingChoice = null;
      return true;
    },
    /**
     * 观星需要"一次选 2 张"，所以这里把候选全部标出来，
     * 引擎会在选牌时校验选中的张数是否等于 count。
     */
    requiredCount() {
      return 2;
    },
  },
});

// ---------------------------------------------------------------------------
// 爆弹：你放下 E 之后，对方下回合所有的牌都只能放在那一列
// ---------------------------------------------------------------------------
defineSkill({
  id: 'baodan',
  name: '爆弹',
  type: 'passive',
  maxUses: 0,
  text: '你放置 E 的下一回合，对方的牌只能在那个位置放置。',
  hooks: {
    /**
     * E 落桌后给对手挂一条"列限制"，把**所有牌型**都锁到那一列。
     *   - digitsOnly:false —— 写 true 会变成"本回合只能放数字牌"，那是禁掉 E/M 而不是锁列；
     *   - exemptKinds:null —— 没有任何牌型豁免（数字牌 / E / M 全部只能去那一列）。
     * 被炸掉的牌不会留在牌桌上，所以只有真正"放上去"的 E 才触发。
     */
    onPlaced(_ctx, state, action) {
      if (state.skills?.[action.player] !== 'baodan') return;
      if (!action.card || action.card.kind !== 'e') return;

      addRestriction(state, 1 - action.player, {
        kind: 'baodan-lock',
        label: '爆弹',
        allowedColumns: [action.col],
        digitsOnly: false,
        exemptKinds: null,
        setBy: action.player,
      });
    },
  },
});

// ---------------------------------------------------------------------------
// 沉默：对方下回合不能放 E/M，也不能使用主动技能（不占用行动）
// ---------------------------------------------------------------------------
defineSkill({
  id: 'chenmo',
  name: '沉默',
  type: 'active',
  maxUses: 2,
  text: '在你的回合，对方的下一回合不能放置 E/M，也不能使用主动技能。不会占用你的行动。',
  hooks: {
    extraActions(_ctx, state, player) {
      return [{ player, type: 'skill', skill: 'chenmo', col: null, card: null, label: '沉默：对方下回合不能放 E/M、不能用主动技' }];
    },
    applyAction(_ctx, state, action, log) {
      addRestriction(state, 1 - action.player, {
        kind: 'silence',
        label: '沉默',
        // 只管 E/M：数字牌照常放，所以不用 digitsOnly
        digitsOnly: false,
        forbidKinds: ['e', 'm'],
        // 主动技能一并禁用（引擎在 playerActions 里整段跳过主动技）
        forbidSkills: true,
        setBy: action.player,
      });
      log.silenced = log.player;
      // 不占用行动：沉默之后仍然是自己的回合，照常出牌。
      // 限制挂在对手的槽里（且 ready=false），所以自己继续行动不会把它清掉。
      log.turnEnds = false;
      return true;
    },
  },
});

// ---------------------------------------------------------------------------
// 创生：凭空给对方塞一张指定数字牌（占用行动）
// ---------------------------------------------------------------------------
defineSkill({
  id: 'chuangsheng',
  name: '创生',
  type: 'active',
  maxUses: 1,
  text: '在你的回合，你可以选择一张 {0，1，2，3，4，5} 凭空加入对方的手牌。占用行动。',
  hooks: {
    extraActions(_ctx, state, player) {
      // 六个数字各一个着法：由发动者自己挑要送给对方哪一张
      return Array.from({ length: 6 }, (_unused, rank) => ({
        player,
        type: 'skill',
        skill: 'chuangsheng',
        col: null,
        card: null,
        rank,
        label: `创生：把 ${rank} 加入对方手牌`,
      }));
    },
    applyAction(_ctx, state, action, log) {
      const rank = action.rank;
      if (!Number.isInteger(rank) || rank < 0 || rank > 5) throw new Error(`创生只能造 0-5 的数字牌：${rank}`);
      const target = 1 - action.player;
      const created = createExtraCard(rank);
      state.hands[target].push(created);
      // 这张牌不在牌库的 37 张里：登记到 createdCards，牌数守恒检查把它算进去
      state.createdCards = [...(state.createdCards ?? []), created];
      log.created = [created];
      log.createdFor = target;
      return true; // 占用行动
    },
  },
});

// ---------------------------------------------------------------------------
// 威严：只要你没放过 E/M，对方也不能放 E/M
// ---------------------------------------------------------------------------
defineSkill({
  id: 'weiyan',
  name: '威严',
  type: 'passive',
  maxUses: 0,
  text: '本局游戏中，如果你没有放置过 E 或 M，对方也不能放置 E 或 M。',
  hooks: {
    legalKinds(_ctx, state, player) {
      // 与 UI 的"发动中/已失效"共用同一份判断，避免两处逻辑走偏
      const status = weiyanStatus(state);
      if (!status || status.holder === player) return null;
      if (!status.active) return null;
      return ['number'];
    },
  },
});

/**
 * 威严的当前状态（供 UI 显示"发动中 / 已失效"）。
 *
 * @returns {null | {holder:number, active:boolean, blockedPlayer:number}}
 *   holder 是持有者；active=true 表示保护仍然生效（持有者还没放过 E/M）；
 *   blockedPlayer 是当前被限制的那一方（持有者自己不受影响）。
 */
export function weiyanStatus(state) {
  const holder = state.skills?.findIndex((id) => id === 'weiyan') ?? -1;
  if (holder < 0) return null;
  return {
    holder,
    active: (state.emPlaced?.[holder] ?? 0) === 0,
    blockedPlayer: 1 - holder,
  };
}

// ---------------------------------------------------------------------------
// 甩手：丢弃一张手牌（占用行动）
// ---------------------------------------------------------------------------
defineSkill({
  id: 'shuaishou',
  name: '甩手',
  type: 'active',
  maxUses: 1,
  text: '在你的回合，把一张手牌丢弃（进入已出局区）。占用行动。丢弃最后一张手牌时等同于出完手牌，立即获胜。',
  hooks: {
    extraActions(_ctx, state, player) {
      if (state.hands[player].length === 0) return [];
      return [{ player, type: 'skill', skill: 'shuaishou', col: null, card: null, label: '甩手：丢弃一张手牌', needsCard: true }];
    },
    applyAction(_ctx, state, action, log, api) {
      // 引擎已经按 handIndex 把这张牌从手牌里取出来了，这里只需要把它丢进已出局区。
      const carried = action.card ?? api.takeFromHand(state, action.player, action.cardId);
      if (!carried) return false;
      state.outOfPlay.push(carried);
      log.discarded = [carried];
      log.turnEnds = true;
      return true;
    },
  },
});

// ---------------------------------------------------------------------------
// 荆棘：对方不能在你刚放置的数字牌上立刻放数字牌
// ---------------------------------------------------------------------------
defineSkill({
  id: 'jingji',
  name: '荆棘',
  type: 'passive',
  maxUses: 0,
  text: '对方不能在你刚才放置的数字牌上立刻放置数字牌。',
  hooks: {
    onPlaced(ctx, state, action) {
      if (!isDigit(action.card)) return null;
      // 只记录"带荆棘的玩家"放的牌
      if (state.skills?.[action.player] !== 'jingji') return null;
      const target = 1 - action.player;
      const applied = addRestriction(state, target, {
        kind: 'skill-jingji',
        label: '荆棘',
        digitsOnly: false,
        forbidDigitOnCardId: action.card.id,
        setBy: action.player,
      });
      void ctx;
      return applied;
    },
  },
});

// ---------------------------------------------------------------------------
// 汇流：过牌时改为自己抽 3 张，然后交一张手牌给对手
// ---------------------------------------------------------------------------
defineSkill({
  id: 'huiliu',
  name: '汇流',
  type: 'passive',
  maxUses: 0,
  text: '你过牌时，如果牌堆还有牌，改为你抽 3 张牌，然后选择这 3 张牌中的一张牌交给对手。',
  hooks: {
    drawOnPass(_ctx, state, player) {
      if (state.skills?.[player] !== 'huiliu') return null;
      if (state.deck.length === 0) return null;
      // 抽 3 张；不足 3 张时按实际数量抽
      return { self: Math.min(3, state.deck.length), opponent: 0, thenGiveOne: true };
    },
    /**
     * 过牌抽完之后挂起"从刚抽的 3 张里交一张给对手"的选择。
     * 关键区别（相对旧版）：候选只限**这次抽到的牌**，不能从整副手牌里挑垃圾送人——
     * 那正是让汇流强度失控的那条路径。
     */
    afterPassDraw(_ctx, state, player, api, plan) {
      if (!plan || !plan.thenGiveOne) return false;
      const hand = state.hands[player] ?? [];
      // 刚抽到的牌 = 手牌末尾的 plan.self 张（drawCards 是 push 进手牌）
      const drawnIds = hand.slice(Math.max(0, hand.length - plan.self)).map((c) => c.id);
      if (drawnIds.length === 0) return false;
      api.setPendingChoice(state, {
        player,
        kind: 'giveToOpponent',
        count: 1,
        picked: [],
        // 只允许从这次抽到的牌里选
        candidateIds: drawnIds,
        ready: false,
        note: '汇流：从刚抽到的 3 张里选 1 张交给对手',
      });
      return true;
    },
    applyChoice(_ctx, state, choice, api) {
      const picked = choice.cardIds[0];
      const allowed = choice.candidateIds ?? null;
      if (allowed && !allowed.includes(picked)) return false;
      const card = api.takeFromHand(state, choice.player, picked);
      if (card) state.hands[1 - choice.player].push(card);
      state.pendingChoice = null;
      return true;
    },
  },
});

/**
 * 某个数字牌"别人能接到它上面"的落点数（越小越卡手）。
 *
 * 数学参考（本报告里的实测口径）：
 *   0 → 6 张（任何 4/5/黑 5 都能接 0，加上 0 自己那一档）
 *   1 → 5 张
 *   2 → 9 张
 *   3 / 4 / 5 → 8 张
 * 注意这是"牌库里有几张牌能压住它"，因此在给定牌面下更准确的算法是
 * 直接数当前列顶允许接它的列数（见 scoreCardForOpponent）。
 */
export const LANDING_SPOTS = Object.freeze({ 0: 6, 1: 5, 2: 9, 3: 8, 4: 8, 5: 8 });

/**
 * 某个数字在当前牌面上有几个落点（有多少列顶端能接它）。
 * 越小越"卡手"——这是"塞给对手哪张牌最难受"的核心指标。
 */
export function countLandingSpots(state, rank) {
  let count = 0;
  for (const stack of state.bases ?? []) {
    const top = stack[stack.length - 1];
    if (!top || top.kind !== 'number') continue;
    if (allowedRanksOn(top).includes(rank)) count += 1;
  }
  return count;
}

/**
 * 挑一张"最适合塞给对手"的牌（汇流的交牌 / 创生的造牌共用）。
 *
 * 优先级：
 *   1. 当前场上**实际放不出去**的普通数字牌（落点数为 0）——塞给对手就是纯负担；
 *   2. 紫 0 限锁生效时，E/M 也打不出去，这时优先给 E/M；
 *   3. 否则按"当前落点数"从少到多给普通数字牌（落点越少越卡手）；
 *   4. 都不适用时，退回静态落点数表（越少越优先）。
 *
 * @param {object} state
 * @param {Array} cards 候选牌
 * @returns {object|null} 选中的牌
 */
export function pickWorstCardForOpponent(state, cards) {
  if (!cards || cards.length === 0) return null;

  const scored = cards.map((card) => {
    if (card.kind !== 'number') {
      // E/M：平时留着（对对手有用），紫 0 限锁下反而变成废牌
      return { card, score: hasPurpleLock(state) ? -100 : 100 };
    }
    const spots = countLandingSpots(state, card.rank);
    return { card, score: spots * 10 + (LANDING_SPOTS[card.rank] ?? 8) };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored[0].card;
}

// ---------------------------------------------------------------------------
// 供引擎使用的小工具（放在技能模块里，避免污染引擎）
// ---------------------------------------------------------------------------

/** 某玩家是否拥有某个技能。 */
export const hasSkill = (state, player, skillId) => state.skills?.[player] === skillId;

/** 找出"拥有指定技能"的玩家（没有则 -1）。 */
export function holderOf(state, skillId) {
  if (!state.skills) return -1;
  return state.skills.findIndex((id) => id === skillId);
}

export { isDigit };
