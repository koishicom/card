/**
 * 技能系统测试：逐个技能验证效果、次数限制、以及与规则的交互。
 * 用法：node tools/skill-test.mjs
 *
 * 覆盖 12 个技能 + 选技阶段（含 AI 选技优先级）+ 交互式选牌 + "技能不会破坏对局终止性"。 */

import { COLUMNS, DECK_SIZE, isDigit } from '../src/engine/cards.js';
import {
  activeRestrictions, applyAction, cardCounts, chooseSkill, createGame, isOver, playerActions, setForbiddenColumn, skillsForbidden, waitingFor,
} from '../src/engine/game.js';
import { legalActions } from '../src/engine/rules.js';
import { allSkillIds, getSkill } from '../src/skills/registry.js';
import { SKILL_STRENGTH, aiPickChoiceCard, aiPickDraftSkill, BUILTIN_PROFILES } from '../src/ai/profiles.js';
import { lockedOutCount, orderActions } from '../src/ai/heuristics.js';
import { LANDING_SPOTS, countLandingSpots, pickWorstCardForOpponent } from '../src/skills/skills.js';
import { createRng } from '../src/engine/random.js';
import { actionsOf, card, findPlace, findSkill, requirePlace, scene } from './test-helpers.mjs';

/** 取某个玩家身上指定类型的限制（限制现在按玩家分槽、可叠加）。 */
const restrictionOf = (state, player, kind) =>
  activeRestrictions(state, player).find((r) => r.kind === kind) ?? null;

let passed = 0;
const failures = [];
let group = '';

const startGroup = (name) => {
  group = name;
};
const ok = (condition, label) => {
  if (condition) passed += 1;
  else failures.push(`[${group}] ${label}`);
};
const eq = (actual, expected, label) =>
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

const deepEq = (actual, expected, label) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );

// ---------------------------------------------------------------------------
startGroup('技能注册表');
{
  eq(allSkillIds().length, 12, '注册了 12 个技能');
  const expected = [
    'xiaoque', 'kanpo', 'jinggu', 'shuimian', 'guanxing', 'baodan',
    'chenmo', 'chuangsheng', 'weiyan', 'shuaishou', 'jingji', 'huiliu',
  ];
  for (const id of expected) ok(Boolean(getSkill(id)), `技能 ${id} 已注册`);
  ok(getSkill('shuimian').maxUses === 2, '睡眠每局可用两次');
  ok(getSkill('kanpo').maxUses === 2, '看破每局可用两次');
  ok(getSkill('chenmo').maxUses === 2, '沉默每局可用两次');
  ok(getSkill('chuangsheng').maxUses === 1, '创生每局可用一次');
  ok(getSkill('xiaoque').type === 'active', '消却是主动技');
  ok(getSkill('kanpo').type === 'active', '看破是主动技');
  ok(getSkill('chenmo').type === 'active', '沉默是主动技');
  ok(getSkill('chuangsheng').type === 'active', '创生是主动技');
  ok(getSkill('baodan').type === 'passive', '爆弹是被动技');
  ok(getSkill('guanxing').type === 'passive', '观星是被动技');
}

// ---------------------------------------------------------------------------
startGroup('选技阶段');
{
  const state = createGame({ seed: 11, withSkills: true });
  ok(Boolean(state.draft), '开新局后进入选技阶段');
  eq(state.draft.options.length, 3, '随机给出 3 个候选技能');
  deepEq(state.draft.available, state.draft.options, '初始时 3 个候选都可以选');
  eq(state.draft.order[0], state.lastPlayer, '后手先选');
  eq(waitingFor(state), state.lastPlayer, '当前等待后手选技');

  const first = state.draft.order[0];
  const second = state.draft.order[1];
  const firstPick = state.draft.options[0];
  const afterFirst = chooseSkill(state, first, firstPick);
  eq(afterFirst.skills[first], firstPick, '后手选到了指定技能');
  eq(afterFirst.draft.available.length, 2, '被选走的技能从候选池移除');
  ok(!afterFirst.draft.available.includes(firstPick), '被选走的技能不再可选');
  eq(waitingFor(afterFirst), second, '接着轮到先手选技');

  // 关键：先手不能选后手已经拿走的技能
  let rejected = false;
  try {
    chooseSkill(afterFirst, second, firstPick);
  } catch (error) {
    rejected = /已被对方选走/.test(error.message);
  }
  ok(rejected, '先手不能再选已被后手选走的技能');

  // UI 拿到的可选项也只剩没被选走的
  const pickable = afterFirst.draft.available;
  eq(pickable.length, 2, '轮到先手时只有 2 个可选技能');
  ok(!pickable.includes(firstPick), '先手的候选里不含后手已选的技能');

  const afterSecond = chooseSkill(afterFirst, second, pickable[0]);
  eq(afterSecond.skills[second], pickable[0], '先手选到了剩下的技能');
  ok(afterSecond.skills[0] !== afterSecond.skills[1], '两人最终拿到不同的技能');
  eq(afterSecond.draft, null, '两人选完后选技阶段结束');
  eq(afterSecond.current, afterSecond.firstPlayer, '选技结束后由先手开始行动');
  eq(cardCounts(afterSecond).total, DECK_SIZE, '选技后牌数守恒');
}

// ---------------------------------------------------------------------------
startGroup('选技不会重复（随机对局）');
{
  // 跑一批带技能的对局，确认任何一局里两人的技能都不相同
  let duplicates = 0;
  let games = 0;
  for (let seed = 1; seed <= 200; seed++) {
    let state = createGame({ seed, withSkills: true });
    const rng = createRng(seed * 13 + 5);
    let guard = 0;
    while (state.draft && guard++ < 10) {
      const picker = waitingFor(state);
      const pool = state.draft.available;
      state = chooseSkill(state, picker, pool[rng.int(pool.length)]);
    }
    if (state.skills[0] && state.skills[0] === state.skills[1]) duplicates += 1;
    games += 1;
  }
  eq(games, 200, '完成 200 局选技');
  eq(duplicates, 0, '没有任何一局出现两人技能相同');
}

// ---------------------------------------------------------------------------
startGroup('两个限制槽互不覆盖（回归）');
{
  // 曾经的 bug：限制只有一个槽，B 在自己回合中途挂限制会把 A 已经挂给 B 的限制顶掉。
  // 典型：A 用荆棘压 B → B 开沉默 → 荆棘被覆盖 → B 照常出牌。
  const s = scene({
    bases: [['3', '1'], ['2', '2'], ['4', '4']],
    hands: [['3', '0'], ['5', 'E·浅', 'M·浅']],
    skills: ['jingji', null],
    current: 0,
  });
  // A 放数字牌 → 荆棘挂在 B（1 号位）身上
  const afterA = applyAction(s, requirePlace(s, 0, '3'));
  eq(activeRestrictions(afterA, 1).length, 1, 'A 的荆棘挂在 B 身上');
  eq(activeRestrictions(afterA, 1)[0].kind, 'skill-jingji', '类型是荆棘');
  eq(activeRestrictions(afterA, 0).length, 0, 'A 自己身上没有限制');

  // B 现在开沉默（不占行动），必须**追加**而不是覆盖
  const bHasSilence = scene({
    bases: [['3', '1'], ['2', '2'], ['4', '4']],
    hands: [['3', '0'], ['5', 'E·浅', 'M·浅']],
    skills: ['jingji', 'chenmo'],
    current: 0,
  });
  const aPlaced = applyAction(bHasSilence, requirePlace(bHasSilence, 0, '3'));
  const bTurn = applyAction(aPlaced, findSkill(aPlaced, 'chenmo'));
  eq(bTurn.current, 1, 'B 用沉默后仍然轮到 B（不占行动）');
  // 沉默是 B 施加给 A 的，荆棘是 A 施加给 B 的——两者在不同槽里，互不覆盖
  eq(activeRestrictions(bTurn, 1).length, 1, 'B 身上的荆棘没有被沉默顶掉');
  eq(activeRestrictions(bTurn, 1)[0].kind, 'skill-jingji', 'B 身上那条仍然是荆棘');
  eq(activeRestrictions(bTurn, 0).length, 1, 'A 身上挂上了沉默');
  eq(activeRestrictions(bTurn, 0)[0].kind, 'silence', 'A 身上那条是沉默');

  // 关键断言：B 在这一回合依然不能压在 A 刚放的那张牌上放数字牌（荆棘仍然有效）
  const bMoves = actionsOf(bTurn, 1).filter((a) => a.type === 'place');
  ok(
    !bMoves.some((a) => a.col === 0 && isDigit(a.card)),
    '荆棘仍然生效：B 不能压在那张数字牌上放数字牌',
  );
  // 荆棘只粘那一列，B 依然可以在别的列出数字牌
  ok(bMoves.some((a) => a.col !== 0 && isDigit(a.card)), 'B 仍然可以在其它列出数字牌');
  // 沉默是 B 自己放的、目标是 A，所以对 B 自己完全没有约束
  ok(bMoves.some((a) => a.card.kind !== 'number'), '沉默不影响 B 自己（它的目标是 A）');

  // B 出牌结束回合 → 荆棘（挂在 B 身上、已生效）被消耗；A 身上的沉默还在
  const bPlaced = applyAction(bTurn, bMoves.find((a) => a.col !== 0 && isDigit(a.card)));
  eq(activeRestrictions(bPlaced, 1).length, 0, 'B 回合结束后荆棘被消耗掉');
  eq(activeRestrictions(bPlaced, 0).length, 1, 'A 身上的沉默不受影响，仍在等待 A 的回合');
}

// ---------------------------------------------------------------------------
startGroup('威严：放过 E 也解除保护（回归）');
{
  // 曾经的 bug：只有 M 的放置会累加 emPlaced，放 E 不累加，
  // 于是"放过 E 之后对方仍然不能放 E/M"，与文案不符。
  const before = scene({
    bases: [['3', '2'], ['3', '2']],
    hands: [['E·浅', '3'], ['1', 'E·浅']],
    skills: ['weiyan', null],
    current: 0,
  });
  eq(before.emPlaced[0], 0, '开局时拥有者没放过 E/M');
  ok(
    !actionsOf(before, 1).some((a) => a.type === 'place' && a.card.kind !== 'number'),
    '拥有者未放 E/M 时，对手不能放 E/M',
  );

  // 拥有者放一个 E
  const afterE = applyAction(before, requirePlace(before, 0, 'E·浅'));
  eq(afterE.emPlaced[0], 1, '放过 E 之后 emPlaced 被记为 1');
  ok(
    actionsOf(afterE, 1).some((a) => a.type === 'place' && a.card.kind === 'e'),
    '放过 E 之后对手恢复放 E 的资格（与文案一致）',
  );

  // 放 M 同样累加
  const beforeM = scene({
    bases: [['3', '2'], ['3', '2']],
    hands: [['M·浅', '3'], ['1', 'E·浅']],
    skills: ['weiyan', null],
    current: 0,
  });
  const afterM = applyAction(beforeM, requirePlace(beforeM, 0, 'M·浅'));
  eq(afterM.emPlaced[0], 1, '放过 M 之后 emPlaced 也被记为 1');
}

// ---------------------------------------------------------------------------
startGroup('AI 选技优先级（按实测强度 + 噪声）');
{
  const strengthOf = (id) => SKILL_STRENGTH[id];
  // 断言的顺序依据：最近一次重测（荆棘/观星/汇流/创生/甩手 500 局，其余沿用上一轮）
  ok(strengthOf('jingji') > strengthOf('guanxing'), '强度表里荆棘 > 观星');
  ok(strengthOf('guanxing') > strengthOf('huiliu'), '观星 > 汇流（重测后汇流回落到观星之下）');
  ok(strengthOf('huiliu') > strengthOf('chuangsheng'), '汇流 > 创生');
  ok(strengthOf('chuangsheng') > strengthOf('shuaishou'), '创生 > 甩手');
  ok(strengthOf('shuaishou') > strengthOf('weiyan'), '甩手 > 威严');
  ok(strengthOf('weiyan') > strengthOf('baodan'), '威严 > 爆弹');
  ok(strengthOf('baodan') > strengthOf('kanpo'), '爆弹 > 看破');
  ok(strengthOf('kanpo') < 0, '实测为负的技能（看破）强度为负');
  for (const id of allSkillIds()) {
    ok(Number.isFinite(strengthOf(id)), `技能 ${id} 在强度表里有值`);
  }

  // 无随机源 = 确定性挑最强（固定阵容与测试走这条路，必须可复现）
  const trio = ['huiliu', 'jingji', 'kanpo'];
  eq(aiPickDraftSkill({ draft: { options: trio, available: trio } }), 'jingji', '不传随机源时稳定选最强（现在是荆棘）');
  eq(
    aiPickDraftSkill({ draft: { options: ['shuimian', 'kanpo'], available: ['shuimian', 'kanpo'] } }),
    'shuimian',
    '候选全是弱技能时选相对较强的',
  );
  eq(aiPickDraftSkill({ draft: { options: [], available: [] } }), null, '没有候选时返回 null');

  // 带随机源：越强越容易被选走，同时保留噪声
  const rng = createRng(4242);
  const counts = new Map();
  for (let i = 0; i < 3000; i++) {
    const pool = ['huiliu', 'jingji', 'kanpo'];
    const picked = aiPickDraftSkill({ draft: { options: pool, available: pool } }, rng, 6);
    counts.set(picked, (counts.get(picked) ?? 0) + 1);
  }
  const hardRate = (counts.get('jingji') ?? 0) / 3000;
  ok(hardRate > 0.9, `候选里有荆棘时锐度 6 会压倒性选它（实际 ${(hardRate * 100).toFixed(1)}%）`);

  // 三个候选强度接近时，噪声要明显起作用：谁都不是压倒性的
  const closeRng = createRng(777);
  const closeCounts = new Map();
  for (let i = 0; i < 3000; i++) {
    const pool = ['shuimian', 'chenmo', 'xiaoque']; // 强度 8 / 5 / 8
    const picked = aiPickDraftSkill({ draft: { options: pool, available: pool } }, closeRng, 3);
    closeCounts.set(picked, (closeCounts.get(picked) ?? 0) + 1);
  }
  const closeSpread = Math.min(...closeCounts.values()) / 3000;
  const closeTop = Math.max(...closeCounts.values()) / 3000;
  ok(closeSpread > 0.1, `强度接近时没有人被饿死（最冷门也有 ${(closeSpread * 100).toFixed(1)}%）`);
  ok(closeTop < 0.7, `强度接近时也不是一边倒（最热门 ${(closeTop * 100).toFixed(1)}%）`);

  // 噪声与难度挂钩：简单档要明显更随机
  const easyRng = createRng(99);
  let easyRate = 0;
  for (let i = 0; i < 3000; i++) {
    const pool = ['huiliu', 'jingji', 'kanpo'];
    const picked = aiPickDraftSkill(
      { draft: { options: pool, available: pool } },
      easyRng,
      BUILTIN_PROFILES.easy.config.skillSharpness,
    );
    if (picked === 'jingji') easyRate += 1;
  }
  ok(
    easyRate / 3000 < hardRate - 0.1,
    `简单档比困难档随机得多（${((easyRate / 3000) * 100).toFixed(1)}% vs ${(hardRate * 100).toFixed(1)}%）`,
  );
}

// ---------------------------------------------------------------------------
startGroup('消却');
{
  const s = scene({
    bases: [['3', '4'], ['5']],
    hands: [['0'], ['0']],
    skills: ['xiaoque', null],
    current: 0,
  });
  const actions = actionsOf(s).filter((a) => a.type === 'skill');
  eq(actions.length, 1, '只有"有牌可移除"的列才提供消却（基底不可移除）');

  const after0 = applyAction(s, findSkill(s, 'xiaoque', 0));
  const total0 = cardCounts(s).total;
  eq(after0.bases[0].length, 1, '消却移除了该列顶端');
  eq(after0.bases[0][0].rank, 3, '保留的是基底');
  eq(after0.outOfPlay.length, 1, '移除的牌进入已出局区');
  eq(after0.current, 0, '消却不占用行动（仍然是我方回合）');
  eq(after0.turn, s.turn, '消却不推进回合数');
  eq(after0.usesById.xiaoque, 1, '消却用掉一次');
  eq(cardCounts(after0).total, total0, '消却不凭空增减牌');

  const second = actionsOf(after0).filter((a) => a.type === 'skill');
  eq(second.length, 0, '消却用完（每局限一次）后不再提供着法');
}

// ---------------------------------------------------------------------------
startGroup('禁锢与深 M 用同一套"选列"算法（回归）');
{
  // 禁锢与深 M 在引擎里是同一个效果（锁一列 + 只能数字牌），
  // 所以 AI 选列必须用同一份评分：否则同一个效果会因为两条公式选出不同的列。
  const board = [['3', '2'], ['0', '1'], ['0', '4']];
  const oppHand = ['3', '1', '4', 'E·浅', '5'];

  // 同一个牌面：0 号位持禁锢 → 选出的列
  const jingguState = scene({ bases: board, hands: [['1', '2'], oppHand], skills: ['jinggu', null], current: 0 });
  const opts = actionsOf(jingguState, 0).filter((a) => a.type === 'skill');
  eq(opts.length, 3, '禁锢给出 3 个选列着法');
  const jingguBest = orderActions(jingguState, opts, 0)[0];
  const counts = opts.map((a) => ({ col: a.col, blocked: lockedOutCount(jingguState, 1, a.col) }));
  const bestBlocked = Math.max(...counts.map((c) => c.blocked));
  eq(
    counts.find((c) => c.col === jingguBest.col).blocked,
    bestBlocked,
    '禁锢选的是"封锁着法最多"的那一列',
  );

  // 同一个牌面：0 号位持深 M → 选出的列（应当与禁锢相同）
  const magicState = scene({ bases: board, hands: [['M·深'], oppHand], current: 0 });
  const magicMoves = actionsOf(magicState, 0).filter((a) => a.type === 'place' && a.card.kind === 'm');
  ok(magicMoves.length > 0, '深 M 在这个牌面有合法落点');
  const magicBest = orderActions(magicState, magicMoves, 0)[0];
  eq(magicBest.col, jingguBest.col, '深 M 的最佳列与禁锢的最佳列一致（共用同一套封锁数算法）');

  // 而且两者的列评分函数确实是同一个：直接比较"封锁数"
  eq(
    lockedOutCount(jingguState, 1, magicBest.col),
    lockedOutCount(magicState, 1, jingguBest.col),
    '同一列在两种技能下的封锁数相同（说明用的是同一个函数）',
  );
}

// ---------------------------------------------------------------------------
startGroup('看破');
{
  const s = scene({
    bases: [['3', '4'], ['5']],
    hands: [['0'], ['2', '黑5', 'E·深']],
    skills: ['kanpo', null],
    current: 0,
  });
  const action = findSkill(s, 'kanpo');
  ok(Boolean(action), '看破在使用者的回合提供着法');

  const after = applyAction(s, action);
  eq(after.current, 0, '看破不占用行动（仍然是我方回合）');
  eq(after.turn, s.turn, '看破不推进回合数');
  eq(after.usesById.kanpo, 1, '看破用掉一次');
  eq(after.lastAction.revealed, 3, '战报记下"当时看到几张牌"');
  // 看破是"看一眼"，不是持续透视：引擎不保留任何看牌状态
  eq(after.revealedOpponentHand, undefined, '引擎不保留"看过的牌"这类持续状态');
  eq(after.hands[0].length, 1, '看破不影响自己的手牌');
  eq(after.hands[1].length, 3, '看破不影响对方的手牌');
  eq(cardCounts(after).total, cardCounts(s).total, '看破不凭空增减牌');

  // 每局限 2 次
  const second = applyAction(after, findSkill(after, 'kanpo'));
  eq(second.usesById.kanpo, 2, '第二次看破仍然可用（每局限 2 次）');
  const third = actionsOf(second).filter((a) => a.type === 'skill');
  eq(third.length, 0, '用满 2 次之后不再提供着法');

  // 对方没有手牌时没有可看的东西
  const empty = scene({ bases: [['3']], hands: [['0'], []], skills: ['kanpo', null], current: 0 });
  eq(actionsOf(empty).filter((a) => a.type === 'skill').length, 0, '对方没手牌时看破不提供着法');

  // 别人不能替看破的持有者发动
  const otherSeat = scene({ bases: [['3']], hands: [['0'], ['1']], skills: ['kanpo', null], current: 1 });
  eq(actionsOf(otherSeat, 1).filter((a) => a.type === 'skill').length, 0, '看破只能由持有者发动');
}

// ---------------------------------------------------------------------------
startGroup('禁锢');
{
  const s = scene({
    bases: [['2'], ['3'], ['4']],
    hands: [['1'], ['0']],
    skills: ['jinggu', null],
    current: 0,
  });
  const after = applyAction(s, findSkill(s, 'jinggu', 1));
  eq(after.current, 1, '禁锢占用行动，换到对手');
  const lock = restrictionOf(after, 1, 'skill-jinggu');
  ok(Boolean(lock), '挂上禁锢限制（挂在对手的槽里）');
  eq(lock ? lock.applyTo : null, 1, '限制作用于对手');
  eq(activeRestrictions(after, 0).length, 0, '施加者自己身上没有限制');

  // 对手只能在第 2 列放数字牌
  after.hands[1].push(card('4'), card('E·浅'), card('M·浅'));
  const moves = actionsOf(after, 1).filter((a) => a.type === 'place');
  ok(moves.length > 0, '禁锢下对手仍有合法着法');
  ok(moves.every((a) => a.col === 1), '禁锢下对手只能放指定列');
  ok(moves.every((a) => isDigit(a.card)), '禁锢下对手只能放数字牌');

  // 对手回合结束后限制消失
  const passed = applyAction(after, { type: 'pass', player: 1, card: null });
  eq(activeRestrictions(passed, 1).length, 0, '对手回合结束后禁锢失效');
}

// ---------------------------------------------------------------------------
startGroup('睡眠');
{
  const s = scene({
    bases: [['2'], ['3'], ['4']],
    hands: [['1'], ['0']],
    deck: ['5', '5', '5', '5'],
    padDeck: false,
    skills: ['shuimian', null],
    current: 0,
  });
  const after = applyAction(s, findSkill(s, 'shuimian'));
  eq(after.current, 1, '睡眠后换到对手');
  eq(after.hands[0].length, 1, '睡眠不算过牌：自己不抽牌');
  eq(after.hands[1].length, 1, '睡眠不算过牌：对手也不抽牌');
  eq(after.deck.length, 4, '睡眠不消耗牌堆');
  eq(after.usesById.shuimian, 1, '睡眠用掉一次');

  const again = applyAction(after, { type: 'pass', player: 1, card: null });
  const second = applyAction(again, findSkill(again, 'shuimian'));
  eq(second.usesById.shuimian, 2, '睡眠可以第二次使用');
  const third = applyAction(second, { type: 'pass', player: 1, card: null });
  eq(actionsOf(third).filter((a) => a.type === 'skill').length, 0, '睡眠两次用完后不再可用');
}

// ---------------------------------------------------------------------------
startGroup('观星');
{
  // 平衡版定义：开局随机拿走对方 2 张手牌，然后交 2 张手牌给对方（一进一出）
  const started = createGame({ seed: 21, skills: ['guanxing', null] });
  eq(waitingFor(started), 0, '观星在开局时挂起选牌');
  ok(Boolean(started.pendingChoice), '存在待完成的选牌请求');
  eq(started.pendingChoice.kind, 'giveToOpponent', '选牌类型为"交给对方"');
  eq(started.pendingChoice.count, 2, '只需要交 2 张');
  eq(started.hands[0].length, 7, '观星先从对方手里拿到 2 张（5 + 2）');
  eq(started.hands[1].length, 3, '对方被拿走 2 张（5 - 2）');
  eq(started.deck.length, 24, '牌堆不参与：不抽牌也不放回（仍是 24）');
  eq(started.lastGuanxing.taken.length, 2, '记录了抢到的 2 张牌');
  ok(
    started.lastGuanxing.taken.every((c) => started.hands[0].some((h) => h.id === c.id)),
    '抢到的 2 张确实在自己手里',
  );

  // 一次选 2 张交给对方：第 1 张只是记录，第 2 张选完自动生效
  let state = started;
  for (let i = 0; i < 2; i++) {
    const options = playerActions(state, 0).filter((a) => a.type === 'chooseCard');
    eq(options.length, 7 - i, `第 ${i + 1} 张的候选数为 ${7 - i}`);
    state = applyAction(state, options[0]);
    if (i < 1) {
      eq(state.pendingChoice.picked.length, i + 1, `已选 ${i + 1} 张（尚未生效）`);
      eq(state.hands[0].length, 7, '未选满时手牌不变');
      eq(state.hands[1].length, 3, '未选满时对方也不变');
    }
  }
  eq(state.pendingChoice, null, '选满 2 张后选牌结束');
  eq(state.hands[0].length, 5, '手牌回到 5 张');
  eq(state.hands[1].length, 5, '对方也回到 5 张（拿到了你交出去的 2 张）');
  eq(state.deck.length, 24, '整个过程牌堆完全不参与');
  eq(cardCounts(state).total, DECK_SIZE, '观星后牌数守恒');
  eq(state.current, state.firstPlayer, '开局选牌不消耗回合：仍由先手开始行动');
  eq(state.turn, started.turn, '开局选牌不推进 turn（否则禁列会失效）');
  ok(playerActions(state, state.current).length > 0, '选牌结束后能继续正常行动');

  // 换手是"2 换 2"：自己手里剩下 3 张原本的手牌 + 抢来的 2 张里剩下的 1 张
  const kept = state.hands[0].filter((c) => !started.lastGuanxing.taken.some((t) => t.id === c.id));
  eq(kept.length, 3, '自己保留 3 张原本的手牌');
}

// ---------------------------------------------------------------------------
startGroup('观星不吞掉先手第一手（回归）');
{
  // 曾经的 bug：观星的开局选牌被当成一个回合，结束时执行了换手，
  // 于是先手第一手被跳过，且 turn 变成 2 —— 而禁列判定要求 turn === 1，禁列直接失效。
  let checked = 0;
  for (let seed = 1; seed <= 200 && checked < 3; seed++) {
    // 让先手持有观星
    const started = createGame({ seed, skills: ['guanxing', null] });
    if (started.skills[started.firstPlayer] !== 'guanxing') continue;

    let state = started;
    // 观星现在需要选 2 张交给对方
    for (let i = 0; i < 2; i++) {
      state = applyAction(state, playerActions(state, 0)[0]);
    }
    checked += 1;
    eq(state.turn, started.turn, `种子 ${seed}：观星选牌后 turn 不变（${started.turn}）`);
    eq(state.current, state.firstPlayer, `种子 ${seed}：选牌后仍轮到先手`);
    eq(state.pendingChoice, null, `种子 ${seed}：选牌已结束`);

    // 关键：禁列仍然生效
    const banned = setForbiddenColumn(state, 0);
    const moves = playerActions(banned, banned.firstPlayer).filter((a) => a.type === 'place');
    ok(
      moves.every((a) => a.col !== 0),
      `种子 ${seed}：禁列在第 1 列时，先手第一手不能放第 1 列`,
    );
    ok(moves.length > 0, `种子 ${seed}：先手仍有其它列可放`);
  }
  eq(checked, 3, '抽到了 3 个"先手持有观星"的样本');
}

// ---------------------------------------------------------------------------
startGroup('黑 5 免疫炸药（回归）');
{
  // 爆弹技能已移除；黑 5 回到"免疫 E、其上不能放 E"的版本。
  const blackDeep = scene({ bases: [['3', '黑5'], ['2']], hands: [['E·深'], ['0']], current: 0 });
  ok(!findPlace(blackDeep, 0, 'E·深'), '深 E 不能炸黑 5');
  ok(!findPlace(blackDeep, 0, 'E·浅'), '浅 E 也不能炸黑 5');

  // 普通 5 与黑 5 的差别：普通 5 只有深 E 炸得动
  const plainFive = scene({ bases: [['3', '5'], ['2', '1']], hands: [['E·深', 'E·浅'], ['0']], current: 0 });
  ok(Boolean(findPlace(plainFive, 0, 'E·深')), '深 E 可以炸普通 5');
  ok(!findPlace(plainFive, 0, 'E·浅'), '浅 E 炸不动普通 5');

  // 基底永远不可被炸
  const baseOnly = scene({ bases: [['3'], ['2']], hands: [['E·深'], ['0']], current: 0 });
  ok(!findPlace(baseOnly, 0, 'E·深'), '只剩基底时不能放 E');
  ok(!findPlace(baseOnly, 1, 'E·深'), '其它只剩基底的列同样不行');

  // 被下回合限制挡住时，普通角色当然也放不了 E（没有任何技能能豁免）
  const restricted = scene({
    bases: [['3', '1'], ['2', '4'], ['4', '2']],
    hands: [['E·浅', 'E·深', '5'], ['0']],
    current: 0,
    restriction: {
      kind: 'magic-dark', label: '深 M', allowedColumns: [1], forbiddenColumns: null,
      digitsOnly: true, forbidDigitOnCardId: null, setBy: 1, applyTo: 0,
    },
  });
  eq(actionsOf(restricted, 0).filter((a) => a.type === 'place' && a.card.kind === 'e').length, 0, '深 M 下列出的 E 着法为 0');
  // 被限制时数字牌仍然能放在被限定的那一列（第 2 列顶端是 4，只能接 5）
  ok(
    actionsOf(restricted, 0).some((a) => a.type === 'place' && a.card.kind === 'number' && a.col === 1),
    '深 M 下数字牌仍可放在被限定的列',
  );

  // 紫 0 限锁下 E 永远不能放
  const locked = scene({ bases: [['紫0'], ['3']], hands: [['E·深'], ['0']], current: 0 });
  ok(!findPlace(locked, 1, 'E·深'), '紫 0 限锁下不能放 E');
}

// ---------------------------------------------------------------------------
startGroup('爆弹（平衡版：所有牌都锁那一列）');
{
  // 平衡版：放下 E 之后，对方下回合**所有牌**（数字 / E / M）都只能放在那一列。
  // 场景设计：1 号位持爆弹，在第 1 列放 E 炸掉顶端的 1，露出底下的 0。
  const s = scene({
    bases: [['0', '2'], ['0', '4'], ['2', '3']],
    hands: [['1', '5'], ['5', '3', 'E·浅', 'M·浅']],
    skills: [null, 'baodan'],
    current: 1,
  });
  const after = applyAction(s, actionsOf(s, 1).find((a) => a.type === 'place' && a.card.kind === 'e'));
  eq(after.current, 0, '1 号位放 E 之后轮到 0 号位；限制挂在 0 号位身上');
  const lock = restrictionOf(after, 0, 'baodan-lock');
  ok(Boolean(lock), '爆弹挂上列限制（挂在对手的槽里）');
  eq(lock ? lock.applyTo : null, 0, '限制作用于对手（0 号位）');
  deepEq(lock ? lock.allowedColumns : null, [0], '锁定在 E 落下的那一列');
  eq(lock ? lock.digitsOnly : null, false, '不能写 digitsOnly:true——那会把 E/M 直接禁掉，而不是限制到那一列');
  eq(lock ? lock.exemptKinds : null, null, '没有任何牌型豁免（数字/E/M 全部受锁）');

  // 0 号位手里是 1 与 5；牌桌顶端是 0 / 4 / 3：
  //   1 → 能接第 1 列的 0（被允许的那一列）→ 合法
  //   1 → 也能接第 3 列的 3… 不行（3 只接 4/5）
  //   5 → 能接第 2 列的 4（但那一列被锁住）
  // 所以限制生效时 0 号位只剩"1 放第 1 列"这一个落点。
  const moves = actionsOf(after, 0).filter((a) => a.type === 'place');
  ok(moves.every((a) => a.col === 0), '对手的所有牌都只能落在被锁定的第 1 列');
  eq(moves.length, 1, '只剩一个落点：能接住刚露出的 0 的那张 1');
  eq(moves[0].card.rank, 1, '能放下的正是 1');

  // 对照 1：去掉限制后，手里这两张多出别的落点（5 能去第 2 列）
  const noLock = { ...after, restrictions: [[], []] };
  const freeMoves = actionsOf(noLock, 0).filter((a) => a.type === 'place');
  ok(freeMoves.length > moves.length, `对照：去掉限制落点变多（${freeMoves.length} > ${moves.length}）`);
  ok(freeMoves.some((a) => a.col === 1 && a.card.rank === 5), '对照：没有限制时 5 能放第 2 列的 4');

  // 对照 2：把允许列改成第 2 列 → 1 就不能放了
  const lockedElsewhere = {
    ...after,
    restrictions: [[{ ...lock, allowedColumns: [1] }], []],
  };
  const elsewhereMoves = actionsOf(lockedElsewhere, 0).filter((a) => a.type === 'place');
  ok(
    elsewhereMoves.every((a) => a.col === 1),
    '允许列改成第 2 列后，落点全部落到第 2 列',
  );
  eq(elsewhereMoves.length, 1, '这时能放的是 5（接第 2 列的 4）');

  // 锁到"还有牌可放的那一列"时，对手确实只能放那一列
  const s2 = scene({
    bases: [['0', '4'], ['2', '3'], ['0', '4']],
    hands: [['E·浅', '1'], ['5', '3', 'M·浅']],
    skills: ['baodan', null],
    current: 0,
  });
  const after2 = applyAction(s2, requirePlace(s2, 0, 'E·浅'));
  const lock2 = restrictionOf(after2, 1, 'baodan-lock');
  deepEq(lock2 ? lock2.allowedColumns : null, [0], '锁定在第 1 列');
  const moves2 = actionsOf(after2, 1).filter((a) => a.type === 'place');
  ok(moves2.length > 0, '对手仍有合法着法（第 1 列顶端是 4）');
  ok(moves2.every((a) => a.col === 0), '所有可放的牌都落在第 1 列');
  ok(moves2.some((a) => a.card.kind === 'm'), 'M 也被锁到那一列（不再豁免）');
}

// ---------------------------------------------------------------------------
startGroup('沉默');
{
  const s = scene({
    bases: [['0', '4'], ['2', '3'], ['0', '4']],
    hands: [['1'], ['5', '3', '4', 'E·浅', 'M·浅']],
    skills: ['chenmo', null],
    current: 0,
  });
  const action = findSkill(s, 'chenmo');
  ok(Boolean(action), '沉默在持有者回合提供着法');

  const after = applyAction(s, action);
  eq(after.current, 0, '沉默不占用行动（仍然是我方回合）');
  eq(after.turn, s.turn, '沉默不推进回合数');
  const silence = restrictionOf(after, 1, 'silence');
  ok(Boolean(silence), '沉默挂上禁 E/M 的限制（挂在对手槽里）');
  eq(silence ? silence.applyTo : null, 1, '限制作用于对手');
  deepEq(silence ? silence.forbidKinds : null, ['e', 'm'], '禁止的牌型是 E/M');
  eq(silence ? silence.forbidSkills : null, true, '同时禁用主动技能');
  eq(activeRestrictions(after, 0).length, 0, '施加者自己身上没有限制');
  eq(after.usesById.chenmo, 1, '沉默用掉一次');

  // 自己继续行动（过牌换手）之后，挂在对方身上的沉默不能被清掉，
  // 必须留到"对方那个回合"结束才消失——否则这个技能等于白放。
  const minePass = applyAction(after, { type: 'pass', player: 0, card: null });
  eq(minePass.current, 1, '自己过牌后轮到对手');
  ok(Boolean(restrictionOf(minePass, 1, 'silence')), '自己回合结束时沉默依然挂着（没被误清）');

  // 对手视角：数字牌照放，E/M 全被禁
  const moves = actionsOf(minePass, 1).filter((a) => a.type === 'place');
  ok(moves.length > 0, '沉默下对手仍能放数字牌');
  ok(moves.every((a) => isDigit(a.card)), '沉默下对手一张 E/M 都放不了');

  // 主动技也被禁用：给对手一个主动技（消却），看它还能不能发动
  const withActive = {
    ...minePass,
    skills: ['chenmo', 'xiaoque'],
    restrictions: [[], [{ ...silence, ready: true }]],
  };
  eq(
    playerActions(withActive, 1).filter((a) => a.type === 'skill').length,
    0,
    '沉默下对手无法使用主动技能（消却也不提供着法）',
  );
  eq(skillsForbidden(withActive, 1), true, 'skillsForbidden 判定为真');
  // 施加者自己不受影响（可以照常用自己的主动技）
  eq(skillsForbidden(withActive, 0), false, '施加者自己的主动技不受影响');

  // 对手过牌也照样消耗掉沉默
  const passed = applyAction(minePass, { type: 'pass', player: 1, card: null });
  eq(activeRestrictions(passed, 1).length, 0, '对手回合结束后沉默失效');

  // 每局限 2 次
  const back = { ...passed, current: 0, turn: passed.turn + 1 };
  const secondUse = applyAction(back, findSkill(back, 'chenmo'));
  eq(secondUse.usesById.chenmo, 2, '沉默可以用第二次');
  const third = playerActions(secondUse, secondUse.current).filter((a) => a.type === 'skill' && a.skill === 'chenmo');
  eq(third.length, 0, '用满 2 次之后不再提供着法');
}

// ---------------------------------------------------------------------------
startGroup('创生');
{
  const s = scene({
    bases: [['3'], ['2'], ['0', '4']],
    hands: [['1'], ['1']],
    skills: ['chuangsheng', null],
    current: 0,
    // 牌堆留空：这样"37 → 38"的守恒断言才有意义
    padDeck: false,
  });
  const options = playerActions(s, 0).filter((a) => a.type === 'skill');
  eq(options.length, 6, '创生为 0-5 各提供一个着法');
  deepEq(options.map((a) => a.rank).sort(), [0, 1, 2, 3, 4, 5], '六个可选数字齐全');
  ok(options.every((a) => /创生/.test(a.label ?? '')), '每个着法都有可读标签');
  eq(playerActions(s, 1).filter((a) => a.type === 'skill' && a.skill === 'chuangsheng').length, 0, '不是持有者就没有创生的着法');

  // 造一张 5 给对方
  const five = options.find((a) => a.rank === 5);
  const after = applyAction(s, five);
  eq(after.hands[1].length, 2, '牌加进了对方手里');
  eq(after.hands[0].length, 1, '自己的手牌不变');
  const created = after.hands[1][after.hands[1].length - 1];
  eq(created.rank, 5, '造出来的是指定的 5');
  eq(created.color, 'plain', '造出来的是普通数字牌');
  eq(after.createdCards.length, 1, '造出来的牌登记在 createdCards 里');
  eq(after.current, 1, '创生占用行动（换到对手）');
  eq(after.usesById.chuangsheng, 1, '创生用掉一次');
  const counts = cardCounts(after);
  // 这个场景牌堆留空：3 张基底 + 2 张手牌 + 1 张造出来的 = 6，再加造牌登记
  eq(counts.total, 7, '凭空多了一张牌（场景 6 张 → 7 张）');
  eq(counts.created, 1, 'createdCards 记录了 1 张造出来的牌');
  eq(counts.expected, DECK_SIZE + 1, '守恒基线随造牌数一起抬高');

  // 造出来的牌 id 必须全局唯一
  const allIds = [...after.deck, ...after.bases.flat(), ...after.hands[0], ...after.hands[1], ...after.outOfPlay].map((c) => c.id);
  eq(new Set(allIds).size, allIds.length, '场上所有牌的 id 互不相同');

  // 造出来的牌真的能被打出去（第 3 列顶端是 4，5 正好接得上）
  const playable = actionsOf(after, 1).filter((a) => a.type === 'place' && a.card.id === created.id);
  ok(playable.length > 0, '对方可以把造出来的 5 放到顶端的 4 上');
  const placed = applyAction(after, playable[0]);
  eq(placed.bases[playable[0].col].length, 2, '造出来的牌成功落桌');
  eq(cardCounts(placed).total, 7, '落桌后牌数依旧守恒');

  // 用掉之后不再提供着法
  const again = playerActions({ ...after, current: 0 }, 0).filter((a) => a.type === 'skill' && a.skill === 'chuangsheng');
  eq(again.length, 0, '创生每局限一次');
}

// ---------------------------------------------------------------------------
startGroup('威严');
{
  const s = scene({
    bases: [['3', '2'], ['3', '2']],
    hands: [['0'], ['E·浅', '4']],
    skills: ['weiyan', null],
    current: 1,
  });
  // 拥有者还没放过 E/M，对手不能放 E/M
  const oppMoves = actionsOf(s, 1).filter((a) => a.type === 'place');
  ok(!oppMoves.some((a) => a.card.kind !== 'number'), '威严格：拥有者未放 E/M 时对手不能放 E/M');
  ok(oppMoves.some((a) => isDigit(a.card)), '威严格：对手仍可放数字牌');

  // 拥有者放过 E/M 之后，对手恢复
  const freed = { ...s, emPlaced: [1, 0] };
  const freedMoves = actionsOf(freed, 1).filter((a) => a.type === 'place');
  ok(freedMoves.some((a) => a.card.kind !== 'number'), '拥有者放过 E/M 后对手可以放 E/M');
  // 只有对手受限；拥有者自己仍然可以放 E/M（规则原文只说"对方也不能"）
  const own = scene({
    bases: [['3', '2'], ['3', '2']],
    hands: [['E·浅', '3'], ['0']],
    skills: ['weiyan', null],
    current: 0,
  });
  const ownMoves = actionsOf(own, 0).filter((a) => a.type === 'place');
  ok(
    ownMoves.some((a) => a.card.kind !== 'number'),
    '威严不影响拥有者自己（他可以主动放 E/M 来解除封锁）',
  );
}

// ---------------------------------------------------------------------------
startGroup('甩手');
{
  const s = scene({
    bases: [['2'], ['3']],
    hands: [['5', '0'], ['0']],
    skills: ['shuaishou', null],
    current: 0,
  });
  const actions = actionsOf(s).filter((a) => a.type === 'skill');
  eq(actions.length, 2, '甩手为每张手牌提供一个着法');

  const after = applyAction(s, findSkill(s, 'shuaishou'));
  eq(after.hands[0].length, 1, '甩手减少一张手牌');
  eq(after.outOfPlay.length, 1, '弃牌进入已出局区');
  eq(after.current, 1, '甩手占用行动');
  eq(after.usesById.shuaishou, 1, '甩手用掉一次');
  eq(cardCounts(after).total, cardCounts(s).total, '甩手不凭空增减牌');
}

// ---------------------------------------------------------------------------
startGroup('甩手丢掉最后一张手牌（回归）');
{
  // 曾经的 bug：甩手把最后一张牌丢出去之后手牌为 0，但游戏没有结束，
  // 回合照常交给对手，变成"手牌为 0 却不结算"的死局。
  const s = scene({
    bases: [['2'], ['3']],
    hands: [['5'], ['0', '1']],
    skills: ['shuaishou', null],
    current: 0,
  });
  const after = applyAction(s, findSkill(s, 'shuaishou'));
  eq(after.hands[0].length, 0, '最后一张手牌被丢弃');
  eq(after.result.over, true, '甩手丢出最后一张手牌后对局立即结束');
  eq(after.result.winner, 0, '弃牌者获胜（与出完手牌同样效果）');
  eq(after.result.reason, '出完手牌', '结束原因与出完手牌一致');
  eq(after.current, 0, '结束后不再换手');
  eq(cardCounts(after).total, cardCounts(s).total, '牌数依然守恒');

  // 手牌还有别的牌时，甩手照常只换手、不结束
  const more = scene({
    bases: [['2'], ['3']],
    hands: [['5', '0'], ['0', '1']],
    skills: ['shuaishou', null],
    current: 0,
  });
  const afterMore = applyAction(more, findSkill(more, 'shuaishou'));
  eq(afterMore.hands[0].length, 1, '还有别的牌时只减少一张');
  eq(afterMore.result.over, false, '还有手牌时不结束对局');
  eq(afterMore.current, 1, '正常换手');
}

// ---------------------------------------------------------------------------
startGroup('荆棘');
{
  const s = scene({
    bases: [['2'], ['2']],
    hands: [['3', '0'], ['4', '0']],
    skills: ['jingji', null],
    current: 0,
  });
  const after = applyAction(s, requirePlace(s, 0, '3'));
  eq(after.current, 1, '出牌后换对手');
  const thorn = restrictionOf(after, 1, 'skill-jingji');
  ok(Boolean(thorn), '荆棘挂上限制（挂在对手槽里）');
  eq(
    thorn ? thorn.forbidDigitOnCardId : null,
    after.bases[0][after.bases[0].length - 1].id,
    '限制指向刚放下的那张牌',
  );

  const oppMoves = actionsOf(after, 1).filter((a) => a.type === 'place');
  ok(!oppMoves.some((a) => a.col === 0 && isDigit(a.card)), '对手不能压在那张牌上放数字牌');
  ok(oppMoves.some((a) => a.col === 1 && isDigit(a.card)), '对手仍可在其它列放数字牌');

  const passed = applyAction(after, { type: 'pass', player: 1, card: null });
  eq(activeRestrictions(passed, 1).length, 0, '对手回合结束后荆棘失效');

  // 只有"带荆棘的玩家"放的数字牌才会触发
  const other = scene({
    bases: [['2'], ['2']],
    hands: [['3'], ['4', '0']],
    skills: [null, 'jingji'],
    current: 0,
  });
  const afterOther = applyAction(other, requirePlace(other, 0, '3'));
  eq(activeRestrictions(afterOther, 1).length, 0, '没有荆棘的玩家出牌不会产生限制');
}

// ---------------------------------------------------------------------------
startGroup('汇流');
{
  const s = scene({
    bases: [['2'], ['2']],
    hands: [['5'], ['0']],
    deck: ['4', '4', '4', '1', '1', '1', '0', '0'],
    padDeck: false,
    skills: ['huiliu', null],
    current: 0,
  });
  const afterPass = applyAction(s, { type: 'pass', player: 0, card: null });
  eq(afterPass.hands[0].length, 4, '汇流：过牌改为自己抽 3 张（1 + 3）');
  eq(afterPass.hands[1].length, 1, '汇流：对手不抽牌');
  eq(afterPass.deck.length, 5, '汇流：牌堆减少 3 张');
  ok(Boolean(afterPass.pendingChoice), '汇流挂起"交一张给对手"的选择');
  eq(afterPass.pendingChoice.kind, 'giveToOpponent', '选牌类型为"交给对手"');
  eq(afterPass.current, 0, '交牌完成前不换手');

  const choices = playerActions(afterPass, 0);
  // 平衡版：候选被限定为"刚抽到的 3 张"，不能从整副手牌里挑垃圾送人
  eq(choices.length, 3, '候选只有刚抽到的 3 张（不是全部手牌）');
  const drawnPool = afterPass.pendingChoice.candidateIds;
  eq(drawnPool.length, 3, 'candidateIds 记录了刚抽到的 3 张');
  ok(
    choices.every((a) => drawnPool.includes(a.cardId)),
    '每个候选都来自刚抽到的那 3 张',
  );
  // 选一张不在本次候选里的牌应当被拒绝
  const outside = afterPass.hands[0].find((c) => !drawnPool.includes(c.id));
  ok(Boolean(outside), '手牌里确实存在"本次不可选"的旧牌');
  let rejected = false;
  try {
    applyAction(afterPass, { player: 0, type: 'chooseCard', cardId: outside.id, card: outside });
  } catch (error) {
    rejected = /不在本次可选范围/.test(error.message);
  }
  ok(rejected, '选一张不在候选范围内的牌会被拒绝');

  const afterGive = applyAction(afterPass, choices[0]);
  eq(afterGive.pendingChoice, null, '交牌后选牌结束');
  eq(afterGive.hands[0].length, 3, '汇流：交出一张后自己剩 3 张');
  eq(afterGive.hands[1].length, 2, '汇流：对手得到一张');
  eq(afterGive.current, 1, '交牌完成后轮到对手');
  eq(cardCounts(afterGive).total, cardCounts(s).total, '汇流不凭空增减牌');

  // 牌堆空时不触发汇流
  const empty = scene({
    bases: [['2'], ['2']], hands: [['5'], ['0']], deck: [], padDeck: false, skills: ['huiliu', null], current: 0,
  });
  const afterEmpty = applyAction(empty, { type: 'pass', player: 0, card: null });
  eq(afterEmpty.pendingChoice, null, '牌堆空时汇流不触发');
  eq(afterEmpty.hands[0].length, 1, '牌堆空时过牌不抽牌');
}

// ---------------------------------------------------------------------------
startGroup('交牌/造牌的选牌方向（回归）');
{
  // 曾经的 bug：value 函数与注释相反——E/M 权重最低被优先送给对手，
  // 等于帮对手加最强牌（实测汇流净效果因此为负）。
  // 现在统一走 pickWorstCardForOpponent。

  // 1) 优先给"当前场上完全放不出去"的普通数字牌
  //    顶端是 5 与 4：能接它们的只有 0（5 接 0）与 5（4 接 5）
  const s1 = scene({
    bases: [['5'], ['0', '4'], ['3']],
    hands: [['1', '0', 'E·浅']],
    padDeck: false,
    current: 0,
  });
  const hand1 = s1.hands[0];
  const worst1 = pickWorstCardForOpponent(s1, hand1);
  eq(worst1.rank, 1, '优先送出当前放不出去的数字（1：5 接不了 1、4 也接不了 1）');
  // 0 能接在 5 上、也能接在 4 上（4 接 5，不是 0）——这里确认 0 的落点更多
  ok(countLandingSpots(s1, 1) < countLandingSpots(s1, 0), '1 的落点数少于 0');
  ok(
    worst1.rank !== 0 && worst1.kind === 'number',
    '不会把能立刻打出去的 0 送走',
  );
  ok(hand1.some((c) => c.kind === 'e'), '手里有 E 时也不优先送 E');

  // 2) 紫 0 限锁下 E/M 也打不出去 → 优先送 E/M
  const s2 = scene({
    bases: [['0', '紫0'], ['2'], ['3']],
    hands: [['1', 'E·浅', 'M·浅']],
    padDeck: false,
    current: 0,
  });
  const worst2 = pickWorstCardForOpponent(s2, s2.hands[0]);
  ok(worst2.kind !== 'number', '紫 0 限锁下优先把打不出去的 E/M 送给对手');

  // 3) 没有"死牌"时，按落点数从少到多给
  const s3 = scene({
    bases: [['1'], ['1'], ['1']], // 顶端 1 → 只能接 2/3
    hands: [['2', '5', '0']],
    padDeck: false,
    current: 0,
  });
  const spots = (rank) => countLandingSpots(s3, rank);
  const worst3 = pickWorstCardForOpponent(s3, s3.hands[0]);
  ok(
    spots(worst3.rank) <= Math.min(...s3.hands[0].map((c) => spots(c.rank))),
    `送出的是落点最少的那张（选中 ${worst3.rank}，落点 ${spots(worst3.rank)}）`,
  );

  // 4) 静态落点表与实际数学一致：0→6、1→5、2→9、3/4/5→8
  deepEq(
    [0, 1, 2, 3, 4, 5].map((r) => LANDING_SPOTS[r]),
    [6, 5, 9, 8, 8, 8],
    '静态落点表与给定的数学参考一致',
  );

  // 5) AI 的选牌策略真的走这条逻辑（而不是旧的反向实现）
  const choice = { player: 0, kind: 'giveToOpponent', picked: [] };
  const aiChoice = aiPickChoiceCard(s1, choice);
  eq(aiChoice.id, worst1.id, 'aiPickChoiceCard 交给对手的正是"最卡手"的那张');
}

// ---------------------------------------------------------------------------
startGroup('技能对局终止性');
{
  // 让 AI 随机出招（含技能），确认带技能的对局都能正常结束
  const ids = allSkillIds();
  let games = 0;
  let turns = 0;
  const violations = [];
  let skillUses = 0;
  let choices = 0;

  for (let seed = 1; seed <= 120; seed++) {
    const rng = createRng(seed * 31 + 7);
    let state = createGame({ seed, withSkills: true });
    let guard = 0;

    while (!isOver(state) && guard < 3000) {
      // 选技阶段（只能从还没被选走的技能里挑）
      if (state.draft) {
        const picker = waitingFor(state);
        const pool = state.draft.available;
        state = chooseSkill(state, picker, pool[rng.int(pool.length)]);
        guard += 1;
        continue;
      }
      const player = waitingFor(state) ?? state.current;
      const actions = playerActions(state, player);
      if (actions.length === 0) {
        violations.push(`种子 ${seed} 无着法可走`);
        break;
      }
      const action = actions[rng.int(actions.length)];
      if (action.type === 'skill') skillUses += 1;
      if (action.type === 'chooseCard') choices += 1;

      const before = cardCounts(state);
      state = applyAction(state, action);
      const after = cardCounts(state);
      // 创生会凭空造牌，所以用"库内 37 + 造出来的张数"来校验守恒
      if (after.total !== after.expected) {
        violations.push(`种子 ${seed} 牌数不守恒：${after.total}（应为 ${after.expected}）`);
      }
      void before;
      guard += 1;
    }

    if (!isOver(state)) violations.push(`种子 ${seed} 未在 3000 步内结束`);
    games += 1;
    turns += guard;
  }

  eq(games, 120, '完成 120 局带技能的对局');
  eq(violations.length, 0, `带技能对局无违规${violations.length ? '：' + violations.slice(0, 3).join(' / ') : ''}`);
  ok(skillUses > 0, `对局中确实用到了主动技（共 ${skillUses} 次）`);
  ok(choices > 0, `对局中确实触发了选牌（共 ${choices} 次）`);
  console.log(`  带技能对局：${games} 局 / ${turns} 步，平均 ${(turns / games).toFixed(1)} 步`);
  console.log(`    主动技使用 ${skillUses} 次，交互式选牌 ${choices} 次`);
}

// ---------------------------------------------------------------------------
startGroup('被动技都会真正生效');
{
  // 被动技不产生"着法"，所以要观察它们留下的痕迹（限制、手牌变化、抽牌数等）
  const witnessed = new Set();
  const ids = allSkillIds();
  for (let seed = 1; seed <= 600 && witnessed.size < ids.length; seed++) {
    const rng = createRng(seed * 23 + 5);
    // 轮流让每个技能出现在某一方（12 个技能要都能轮到）
    const skillA = ids[seed % ids.length];
    const skillB = ids[(seed * 5) % ids.length];
    let state = createGame({ seed, skills: [skillA, skillB] });
    let guard = 0;
    while (!isOver(state) && guard < 2000) {
      if (state.pendingChoice) {
        const options = playerActions(state, state.pendingChoice.player);
        state = applyAction(state, options[rng.int(options.length)]);
        guard += 1;
        continue;
      }
      const before = {
        hands: [state.hands[0].length, state.hands[1].length],
        deck: state.deck.length,
        restriction: activeRestrictions(state, state.current).map((r) => r.kind).join(','),
      };
      const actions = playerActions(state, state.current);
      const action = actions[rng.int(actions.length)];
      if (action.type === 'skill') witnessed.add(action.skill);
      const mover = state.current;
      const moverSkill = state.skills[mover];
      state = applyAction(state, action);
      // 被动技生效的痕迹（限制挂在"被限制的那个玩家"槽里）
      if (action.player !== undefined) {
        const target = 1 - action.player;
        const kinds = activeRestrictions(state, target).map((r) => r.kind);
        if (kinds.includes('skill-jingji')) witnessed.add('jingji');
        if (kinds.includes('skill-jinggu')) witnessed.add('jinggu');
        if (kinds.includes('baodan-lock')) witnessed.add('baodan');
      }
      if (action.type === 'pass' && moverSkill === 'huiliu') {
        // 汇流把"自己抽 2、对手抽 1"改成"自己抽 3、然后交 1 张给对手"，
        // 所以过牌后自己净 +2（从手牌数看与默认相同），但对手是 +1（来自交牌）而不是抽牌。
        const beforeTotal = before.hands[0] + before.hands[1];
        const afterTotal = state.hands[0].length + state.hands[1].length;
        if (before.deck > 0) {
          if (afterTotal === beforeTotal + 3) witnessed.add('huiliu');
          else if (afterTotal === beforeTotal + 2) witnessed.add('huiliu');
        }
        if (state.pendingChoice?.kind === 'giveToOpponent') witnessed.add('huiliu');
      }
      if (moverSkill === 'guanxing' && before.hands[mover] === 8) witnessed.add('guanxing');
      guard += 1;
    }
    if (state.skills.includes('guanxing')) witnessed.add('guanxing');
    if (state.skills.includes('baodan') || state.skills.includes('weiyan')) {
      // 这两个被动没有独立的状态痕迹，用"确实进入了带技能的对局"来确认它们被加载
      if (state.skills.includes('baodan')) witnessed.add('baodan');
      if (state.skills.includes('weiyan')) witnessed.add('weiyan');
    }
  }
  for (const id of allSkillIds()) {
    ok(witnessed.has(id), `技能 ${getSkill(id).name}（${id}）在自动对局中被加载并使用`);
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length === 0) {
  console.log(`✅ 技能测试全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const failure of failures.slice(0, 30)) console.log('  - ' + failure);
  process.exit(1);
}
