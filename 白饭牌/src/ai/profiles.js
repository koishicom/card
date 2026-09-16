/**
 * AI 难度档位。
 *
 * 三档共用同一套引擎与启发式，差别只在"算得多深"：
 *   easy   随机出牌（会犯明显错误，适合先熟悉规则）
 *   normal 在真实局面上搜索 2 层（能算出对手的最佳回应）
 *   hard   在真实局面上搜索 3 层（能看到"我出 → 对手回敬 → 我再回敬"）
 *
 * 实测（tools/ai-lab3.mjs，每对 60 局、交替先后手）：
 *   d2 对随机 65% ｜ d3 对随机 73% ｜ d4 对随机 77%
 *   d3 对 d2 63.3% ｜ d4 对 d2 63.3%（d3 → d4 收益已趋平）
 * 因此 hard 取 d3：强度提升明显，单步耗时仍在 ~40ms 量级。
 *
 * 为什么困难档不"猜对手手牌"：tools/ai-lab.mjs 实测表明，把对手手牌换成
 * 未知牌池里的牌（哪怕只换一部分）会让胜率从 ~60% 掉到 ~38%——
 * 这个游戏对"某张关键牌是否在对手手里"极其敏感，错误的建模比不建模更糟。
 * 所以三档都只用公开信息 + 真实手牌，强度靠搜索深度拉开。
 *
 * 想加新档位用 createProfile，不必修改本文件的现役配置。
 */

import { COLUMNS } from '../engine/cards.js';
import { playerActions, skillContextOf, suggestForbiddenColumn, waitingFor } from '../engine/game.js';
import { allowedRanksOn } from '../engine/rules.js';
import { createRng } from '../engine/random.js';
import { getSkill } from '../skills/registry.js';
import { pickWorstCardForOpponent } from '../skills/skills.js';
import { orderActions } from './heuristics.js';
import { bestMoveInWorld } from './search.js';

/** 简单档：完全随机，只在小概率下主动过牌。 */
function randomPick(state, player, rng) {
  const actions = playerActions(state, player);
  const placements = actions.filter((a) => a.type === 'place' || a.type === 'skill');
  if (placements.length === 0) return actions.find((a) => a.type === 'pass') ?? actions[0];
  if (rng.next() < 0.05) return actions.find((a) => a.type === 'pass') ?? placements[0];
  return placements[rng.int(placements.length)];
}

/** 普通/困难档：在真实局面上做定深搜索。 */
function treePick(state, player, rng, config) {
  const { action } = bestMoveInWorld(state, player, {
    depth: config.depth,
    beamWidth: config.beamWidth,
    maxNodes: config.maxNodes,
  });
  if (action) return action;
  return orderActions(state, playerActions(state, player), player)[0];
}

/**
 * 只在"有牌可放却想空过"时兜底：避免 AI 用无意义的过牌拖时间。
 * 牌堆已空时过牌是合法的拖时间手段（能逼出比手牌的结算），保留不干预。
 * 技能可以对过牌做出修正（例如汇流），这时候也不干预——否则会把技能收益丢掉。
 */
function guardWastefulPass(state, player, action) {
  if (!action || action.type !== 'pass') return action;
  if (state.deck.length === 0) return action;
  const modifier = passModifierFor(state, player);
  if (modifier) return action;
  const placements = playerActions(state, player).filter((a) => a.type === 'place');
  if (placements.length === 0) return action;
  return orderActions(state, placements, player)[0];
}

/**
 * 主动技的使用判断。
 * 目前用保守策略：只有当"这一手不是唯一出路"时才会考虑技能，
 * 避免简单/普通档因为用技能而放弃必要的出牌。
 */
function shouldUseSkill(state, player, action) {
  if (!action || action.type !== 'skill') return true;
  const placements = playerActions(state, player).filter((a) => a.type === 'place');
  // 手牌马上出完时优先出牌（能直接赢）
  if (state.hands[player].length === 1 && placements.length > 0) return false;
  // 看破不占行动，而且看得越早越有用（能提前规划），所以有就先用
  if (action.skill === 'kanpo') return true;
  return true;
}

/** 该玩家的过牌是否被技能改写（汇流）。改写过就不要用"出牌"去替换过牌。 */
function passModifierFor(state, player) {
  for (const entry of skillContextOf(state).entries) {
    if (entry.player !== player) continue;
    const hook = entry.skill.hooks.drawOnPass;
    if (hook && hook(skillContextOf(state), state, player)) return true;
  }
  return false;
}

/**
 * 技能强度表：用配对 A/B 实测得到的净胜率（技能对白板），单位是百分点。
 *
 * 来源：`技能强度报告-重测.md`（12 技能各 500 局，配对标准误 ±2.2pp，
 * 12 个里 10 个统计显著、8 个过 Bonferroni）。这张表只影响**选技优先级**，
 * 不参与对局内的着法评估。
 *
 * 关于「沉默」：它是**对技能持有者的特攻**（禁对方 E/M + 禁对方主动技），
 * 而本表用的是"技能对白板"口径（对手不带任何技能）——那个口径里沉默没有打击目标，
 * 测出来只会是 ≈0，没有意义。所以沉默的分数按"它克制的技能越多越值"给一个固定值，
 * 不参与重测。
 */
export const SKILL_STRENGTH = Object.freeze({
  jingji: 25, // 荆棘  +25.3
  guanxing: 19, // 观星  +19.1（重测：3 张改 2 张后从 +23.5 小幅回落）
  huiliu: 17, // 汇流  +17.4（重测：改成"只能交刚抽到的 3 张里那张"后，从 +32.1 大幅回落）
  chuangsheng: 16, // 创生  +16.4
  shuaishou: 13, // 甩手  +13.2
  weiyan: 8, // 威严   +8.4
  xiaoque: 8, // 消却   +7.9
  shuimian: 8, // 睡眠   +7.8
  jinggu: 6, // 禁锢   +5.8（重测：与深 M 统一选列算法后基本不变）
  // 沉默：特攻型（禁对方 E/M + 禁对方主动技），"对白板"口径测不出它的价值，
  // 这里给一个固定估值，不参与重测。
  chenmo: 5,
  baodan: 5, // 爆弹   +4.6（重测：取消全部豁免后略升，但仍不显著）
  kanpo: -1, // 看破   −1.1（不显著，对 AI 无价值）
});

/** 取技能强度分（未知技能给一个保守的中间值）。 */
export function skillStrength(id) {
  return SKILL_STRENGTH[id] ?? 6;
}

/**
 * AI 在选技阶段挑一个候选。
 *
 * 策略：按实测强度做 softmax。强度高的技能大概率被选走，
 * 但保留噪声——`sharpness` 越小越随机（简单档容易被"看着还行"的技能骗走），
 * 越大越接近"永远选最强"（困难档）。
 *
 * @param {object} state
 * @param {object} [rng] 随机源；不传就退化成"直接选最强"（测试与固定阵容用）
 * @param {number} [sharpness] 选择锐度：0 = 均匀随机，6 ≈ 95% 选到最强
 */
export function aiPickDraftSkill(state, rng = null, sharpness = 6) {
  const pool = state.draft?.available?.length ? state.draft.available : (state.draft?.options ?? []);
  if (pool.length === 0) return null;
  if (!rng || sharpness <= 0) {
    // 无随机源：确定性挑最强（并列时保持候选原顺序，保证可复现）
    return pool.reduce((best, id) => (skillStrength(id) > skillStrength(best) ? id : best), pool[0]);
  }
  const weights = pool.map((id) => Math.exp((skillStrength(id) * sharpness) / 10));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * AI 的选牌策略（观星交牌 / 汇流交牌 / 创生选数字）。
 *
 * 三种场景现在都是"从自己手里挑一张给对方"，方向完全一致：
 * 交给对手**对他最没用（最卡手）**的牌 —— 统一走 pickWorstCardForOpponent：
 *   1. 当前场上放不出去的普通数字牌（落点 0）
 *   2. 紫 0 限锁下 E/M 也打不出去，这时优先给 E/M
 *   3. 否则按当前落点数从少到多给
 *
 * 曾经的 bug：实现与注释相反，E/M 权重最低被最先送出去，等于帮对手加最强牌
 * （实测汇流净效果为负，与这个 bug 吻合）。
 *
 * 注意观星在平衡性改动后不再"放回抽牌堆"，所以这里已经没有 returnToDeck 分支；
 * 万一以后有技能再引入该 kind，会走到末尾的兜底（按"留最有用的"排序）。
 */
export function aiPickChoiceCard(state, choice) {
  const hand = state.hands[choice.player] ?? [];
  const picked = new Set(choice.picked ?? []);
  const candidates = hand.filter((c) => !picked.has(c.id));
  if (candidates.length === 0) return null;

  if (choice.kind === 'giveToOpponent') {
    return pickWorstCardForOpponent(state, candidates);
  }

  // 兜底：放回牌堆类 — 留下最有用的（E/M > 紫 0 > 黑 5 > 当前接得上的数字）
  const keepValue = (card) => {
    if (card.kind !== 'number') return 100;
    if (card.color === 'purple') return 90;
    if (card.color === 'black') return 80;
    return countLandingSpots(state, card.rank) * 10 + card.rank;
  };
  const sorted = [...candidates].sort((a, b) => keepValue(a) - keepValue(b));
  return sorted[0];
}

/** @typedef {{id:string, label:string, description:string, decide:Function, chooseForbiddenColumn:Function}} AiProfile */

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.label
 * @param {string} [options.description]
 * @param {(state:object, player:number, rng:object, config:any) => object} options.pick
 * @param {any} [options.config]
 * @param {(state:object, rng:object) => number} [options.ban]
 * @returns {AiProfile}
 */
export function createProfile({ id, label, description = '', pick, config = {}, ban }) {
  /**
   * 处理"非正常回合"的决策：选技与选牌。
   * 选技用 config.skillSharpness 控制"多认真挑最强技能"：
   * 简单档小（容易被弱技能骗走），困难档大（基本都拿最强）。
   */
  function handleSpecial(state, player, rng) {
    if (state.draft) {
      if (waitingFor(state) !== player) return null;
      // 选技阶段返回技能 id（调用方交给 chooseSkill）
      const sharpness = config.skillSharpness ?? 6;
      return { kind: 'skill', skillId: aiPickDraftSkill(state, rng, sharpness) };
    }
    if (state.pendingChoice && state.pendingChoice.player === player) {
      const card = aiPickChoiceCard(state, state.pendingChoice);
      if (!card) return null;
      const action = playerActions(state, player).find((a) => a.type === 'chooseCard' && a.cardId === card.id);
      return action ? { kind: 'action', action } : null;
    }
    return null;
  }

  return {
    id,
    label,
    description,
    config,
    decide(state, player, rng = createRng(1)) {
      const special = handleSpecial(state, player, rng);
      if (special) return special.kind === 'skill' ? special.skillId : special.action;

      const action = pick(state, player, rng, config);
      if (!shouldUseSkill(state, player, action)) {
        const placements = playerActions(state, player).filter((a) => a.type === 'place');
        return orderActions(state, placements, player)[0] ?? action;
      }
      return guardWastefulPass(state, player, action);
    },
    chooseForbiddenColumn(state, rng = createRng(1)) {
      if (ban) return ban(state, rng);
      return suggestForbiddenColumn(state);
    },
  };
}

export const easy = createProfile({
  id: 'easy',
  label: '简单',
  description: '随机出牌，不考虑后果，适合先熟悉规则。',
  pick: randomPick,
  // 选技最随便：经常挑到强度低的技能（"被弱技能骗走"）
  config: { skillSharpness: 0.7 },
  ban: (state, rng) => rng.int(COLUMNS),
});

export const normal = createProfile({
  id: 'normal',
  label: '普通',
  description: '会算对手的最佳回应，懂得用炸弹和魔法争节奏。',
  pick: treePick,
  config: { depth: 2, beamWidth: 14, maxNodes: 4000, skillSharpness: 1.6 },
});

export const hard = createProfile({
  id: 'hard',
  label: '困难',
  description: '会往前多看一步，能把"我出、你回敬、我再回敬"三步一起算进来。',
  pick: treePick,
  // 锐度刻意不拉满：困难档大部分时候选最强，但仍保留"被弱技能诱惑"的概率
  config: { depth: 3, beamWidth: 10, maxNodes: 12000, skillSharpness: 3 },
});

export const BUILTIN_PROFILES = Object.freeze({ easy, normal, hard });
export const PROFILE_LIST = Object.freeze([easy, normal, hard]);
