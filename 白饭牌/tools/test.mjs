/**
 * 规则测试套件：把《规则定稿》逐条变成可执行断言。
 * 用法：node tools/test.mjs
 *
 * 约定：任何规则改动都应在这里补一个用例；外部只需看退出码。
 */

import { COLUMNS, DECK_SIZE, cardBlurb, createDeck, isDigit } from '../src/engine/cards.js';
import { activeRestrictions, applyAction, cardCounts, createGame, isOver, setForbiddenColumn } from '../src/engine/game.js';
import { allowedRanksOn, hasPurpleLock, legalActions } from '../src/engine/rules.js';
import { createRng } from '../src/engine/random.js';
import { BUILTIN_PROFILES } from '../src/ai/profiles.js';
import { card, findPlace, isLegal, pass, passOf, requirePlace, scene } from './test-helpers.mjs';

let passed = 0;
const failures = [];
let currentGroup = '';

const group = (name) => {
  currentGroup = name;
};

function ok(condition, label) {
  if (condition) passed += 1;
  else failures.push(`[${currentGroup}] ${label}`);
}

const eq = (actual, expected, label) =>
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

const deepEq = (actual, expected, label) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );

const sameAction = (a, b) =>
  Boolean(a) && Boolean(b) && a.type === b.type && (a.type === 'pass' || (a.col === b.col && a.handIndex === b.handIndex));

// ---------------------------------------------------------------------------
group('牌库构成');
{
  const deck = createDeck();
  eq(deck.length, DECK_SIZE, '牌库共 37 张');
  const count = (predicate) => deck.filter(predicate).length;
  eq(count((c) => isDigit(c) && c.color === 'plain' && c.rank === 0), 4, '普通 0 四张');
  eq(count((c) => isDigit(c) && c.color === 'plain'), 24, '普通数字共 24 张');
  eq(count((c) => isDigit(c) && c.color === 'purple'), 1, '紫 0 一张');
  eq(count((c) => isDigit(c) && c.color === 'black'), 2, '黑 5 两张');
  eq(count((c) => c.kind === 'e' && c.color === 'light'), 3, '浅 E 三张');
  eq(count((c) => c.kind === 'e' && c.color === 'dark'), 3, '深 E 三张');
  eq(count((c) => c.kind === 'm' && c.color === 'light'), 2, '浅 M 两张');
  eq(count((c) => c.kind === 'm' && c.color === 'dark'), 2, '深 M 两张');
  eq(new Set(deck.map((c) => c.id)).size, DECK_SIZE, '每张牌 id 唯一');
}

// ---------------------------------------------------------------------------
group('开局');
{
  const game = createGame({ seed: 2024 });
  eq(game.bases.length, COLUMNS, '牌桌为 3 列');
  ok(game.bases.every((stack) => stack.length === 1 && isDigit(stack[0])), '每列基底都是一张数字牌');
  eq(game.hands[0].length, 5, '玩家 1 有 5 张手牌');
  eq(game.hands[1].length, 5, '玩家 2 有 5 张手牌');
  eq(game.deck.length, 24, '牌堆剩 24 张');
  eq(cardCounts(game).total, DECK_SIZE, '开局牌数守恒');
  eq(cardCounts(game).total - cardCounts(game).deck, 13, '13 张牌已进入牌桌与手牌');
}

// ---------------------------------------------------------------------------
group('数字牌接续规则');
{
  const table = [
    ['0', [1, 2]],
    ['1', [2, 3]],
    ['2', [3, 4]],
    ['3', [4, 5]],
    ['4', [5]],
    ['5', [0]],
    ['黑5', [0]],
    ['紫0', [1, 2]],
  ];
  for (const [top, expected] of table) deepEq(allowedRanksOn(card(top)), expected, `顶端 ${top} 的可接数字`);

  const s = scene({ bases: [['3'], ['5'], ['紫0']], hands: [['0', '1', '2', '4', '5'], []] });
  ok(findPlace(s, 0, '4'), '3 上可以放 4');
  ok(findPlace(s, 0, '5'), '3 上可以放 5');
  ok(!findPlace(s, 0, '0'), '3 上不能放 0');
  ok(!findPlace(s, 0, '2'), '3 上不能放 2');
  ok(findPlace(s, 1, '0'), '5 上可以放 0');
  ok(!findPlace(s, 1, '1'), '5 上不能放 1');
  ok(findPlace(s, 2, '1'), '紫 0 上可以放 1');
  ok(findPlace(s, 2, '2'), '紫 0 上可以放 2（按 0 计）');
  ok(!findPlace(s, 2, '0'), '紫 0 上不能放 0');

  // 4 的特例：n+2 是 6 但牌库没有 6，所以只能接 5
  const four = scene({ bases: [['4']], hands: [['0', '5', '1']] });
  ok(findPlace(four, 0, '5'), '4 上可以放 5');
  ok(!findPlace(four, 0, '0'), '4 上不能放 0（没有 6）');
  ok(!findPlace(four, 0, '1'), '4 上不能放 1');

  const black = scene({ bases: [['黑5']], hands: [['0', '1', '2']] });
  ok(findPlace(black, 0, '0'), '黑 5 上可以放 0');
  ok(!findPlace(black, 0, '1'), '黑 5 上不能放 1');
}

// ---------------------------------------------------------------------------
group('卡面提示文案');
{
  // 文案必须和判定一致：4 的 +2 会绕到 0，但牌库里没有 6，所以 4 实际只能接 5。
  ok(cardBlurb(card('4')) === '只能接 5', '4 的提示文案就是「只能接 5」');
  ok(cardBlurb(card('3')) === '只能接 4、5', '3 的提示文案是 4、5');
  ok(cardBlurb(card('5')) === '只能接 0', '5 的提示文案是 0');
  ok(cardBlurb(card('黑5')).includes('只能接 0'), '黑 5 的提示文案是 0');
  ok(cardBlurb(card('紫0')).includes('1') && cardBlurb(card('紫0')).includes('2'), '紫 0 的提示文案是 1、2');

  // 更强的一致性检查：文案里提到的数字必须恰好等于"允许接的数字"。
  for (let rank = 0; rank <= 5; rank++) {
    const notation = String(rank);
    const allowed = [...allowedRanksOn(card(notation))].sort();
    const mentioned = [...new Set((cardBlurb(card(notation)).match(/\d/g) ?? []).map(Number))].sort();
    deepEq(mentioned, allowed, `顶端 ${notation} 的文案数字与可接数字完全一致`);
  }
  for (const notation of ['5', '4', '3', '黑5', '紫0']) {
    ok(!/6|7|8|9/.test(cardBlurb(card(notation))), `${notation} 的提示文案不出现大于 5 的数字`);
  }
  for (const notation of ['5', '4', '3', '黑5', '紫0']) {
    ok(!/6|7|8|9/.test(cardBlurb(card(notation))), `${notation} 的提示文案不出现大于 5 的数字`);
  }
}

// ---------------------------------------------------------------------------
group('E 炸弹');
{
  // 基底只剩一张时不可被炸；有牌压在上面时，炸的是上面那张。
  const light = scene({ bases: [['3'], ['5'], ['3', '4']], hands: [['E·浅', 'E·浅', 'E·浅'], []] });
  ok(!findPlace(light, 0, 'E·浅'), '只剩基底时不能放浅 E（基底不可被炸）');
  ok(!findPlace(light, 1, 'E·浅'), '浅 E 不能炸顶端 5');
  ok(findPlace(light, 2, 'E·浅'), '浅 E 可炸基底之上的 4');
  const afterLight = applyAction(light, requirePlace(light, 2, 'E·浅'));
  eq(afterLight.bases[2].length, 1, '炸掉后只剩基底');
  eq(afterLight.bases[2][0].rank, 3, '保留的正是基底');
  eq(afterLight.outOfPlay.length, 2, '被炸的数字与 E 一起出局');
  eq(afterLight.hands[0].length, 2, '炸弹从手牌移除');

  const deep = scene({ bases: [['5', '3'], ['3', '4']], hands: [['E·深', 'E·深'], []] });
  ok(findPlace(deep, 0, 'E·深'), '深 E 可炸顶端 3（该列有基底保护）');
  ok(findPlace(deep, 1, 'E·深'), '深 E 可炸顶端 4');
  const deepScene = scene({ bases: [['3', '5']], hands: [['E·深']] });
  ok(findPlace(deepScene, 0, 'E·深'), '深 E 可炸 5（浅 E 做不到）');

  // 黑 5 免疫炸弹：浅 E / 深 E 都不能放上去
  const black = scene({ bases: [['3', '黑5'], ['3', '5']], hands: [['E·浅', 'E·深']] });
  ok(!findPlace(black, 0, 'E·浅'), '浅 E 不能炸黑 5');
  ok(!findPlace(black, 0, 'E·深'), '深 E 也不能炸黑 5');
  // 普通 5 可以被深 E 炸掉（和黑 5 的区别就在这里）
  ok(findPlace(black, 1, 'E·深'), '深 E 可以炸普通 5');
  ok(!findPlace(black, 1, 'E·浅'), '浅 E 不能炸普通 5');

  const onBase = scene({ bases: [['3']], hands: [['E·浅', 'E·深']] });
  ok(!findPlace(onBase, 0, 'E·浅'), '只剩基底时浅 E 无处可炸');
  ok(!findPlace(onBase, 0, 'E·深'), '只剩基底时深 E 无处可炸');
}

// ---------------------------------------------------------------------------
group('M 魔法');
{
  const s = scene({ bases: [['0'], ['3'], ['4']], hands: [['M·浅', '0'], []] });
  const lightM = findPlace(s, 0, 'M·浅');
  ok(lightM, '浅 M 可以放在数字上');
  const afterLight = applyAction(s, lightM);
  eq(afterLight.bases[0].length, 1, 'M 不留在列顶（立即出局）');
  eq(afterLight.outOfPlay.length, 1, 'M 进入已出局区');
  deepEq(afterLight.restriction.forbiddenColumns, [0], '浅 M 记录被禁的列');
  eq(afterLight.restriction.applyTo, 1, '浅 M 作用于对手');
  eq(afterLight.current, 1, '施放后换对手行动');

  afterLight.hands[1].push(card('3'), card('E·浅'), card('M·浅'), card('5'));
  const oppMoves = legalActions(afterLight, 1).filter((a) => a.type === 'place');
  ok(oppMoves.length > 0, '限制下对手仍有可行着法');
  ok(oppMoves.every((a) => isDigit(a.card)), '浅 M 下对手只能出数字牌');
  ok(!oppMoves.some((a) => a.col === 0), '浅 M 下对手不能放被禁的列');
  ok(oppMoves.some((a) => a.col === 1), '浅 M 下对手可以在别的列出牌');

  const dark = scene({ bases: [['0'], ['3'], ['4']], hands: [['M·深', '0'], []] });
  const afterDark = applyAction(dark, requirePlace(dark, 0, 'M·深'));
  deepEq(afterDark.restriction.allowedColumns, [0], '深 M 记录强制列');
  afterDark.hands[1].push(card('3'), card('4'), card('E·深'));
  const darkMoves = legalActions(afterDark, 1).filter((a) => a.type === 'place');
  ok(darkMoves.every((a) => a.col === 0), '深 M 下对手只能放指定列');
  ok(darkMoves.every((a) => isDigit(a.card)), '深 M 下对手只能出数字牌');

  // 只作用于紧接的一个回合：对手过牌即消耗
  const chained = scene({ bases: [['0'], ['3'], ['4']], hands: [['1', '0'], ['3']], deck: ['5', '5', '5', '0', '0', '0'] });
  const withMagic = applyAction(chained, requirePlace(chained, 0, '1'));
  const passed = applyAction(withMagic, passOf(1));
  eq(passed.restriction.kind, null, '对手过牌后魔法失效');
  eq(passed.hands[1].length, 3, '过牌者抽 2 张');
  eq(passed.hands[0].length, 2, '对手（原施法者）抽 1 张');
}

// ---------------------------------------------------------------------------
group('通用下回合限制机制');
{
  // 这一组验证的是"承载 M / 禁锢 / 荆棘 的通用机制"本身，
  // 而不是某一个具体技能，所以直接构造 restriction 对象来测。

  // 1) 多列强制（M 只会强制 1 列，禁锢/其它技能可能更强）
  const restrictTwo = {
    kind: 'custom',
    label: '禁锢',
    allowedColumns: [0, 2],
    forbiddenColumns: null,
    digitsOnly: true,
    forbidDigitOnCardId: null,
    setBy: 1,
    applyTo: 0,
  };
  const s = scene({ bases: [['2'], ['2'], ['2']], hands: [['3', 'E·浅'], ['3']], current: 0, restriction: restrictTwo });
  const moves = legalActions(s, 0).filter((a) => a.type === 'place');
  ok(moves.length > 0, '限制下仍有合法着法');
  ok(moves.every((a) => a.col === 0 || a.col === 2), 'allowedColumns 同时允许第 1、3 列');
  ok(moves.every((a) => isDigit(a.card)), 'digitsOnly 禁止 E/M');
  ok(!moves.some((a) => a.col === 1), '未列出的第 2 列被禁止');

  // 2) 允许列 + 禁止列同时存在时，禁止优先
  const conflicting = {
    kind: 'custom',
    label: '混合',
    allowedColumns: [0, 1],
    forbiddenColumns: [1],
    digitsOnly: false,
    forbidDigitOnCardId: null,
    setBy: 1,
    applyTo: 0,
  };
  const s2 = scene({ bases: [['2'], ['2'], ['2']], hands: [['3', 'E·浅', 'M·浅']], current: 0, restriction: conflicting });
  const moves2 = legalActions(s2, 0).filter((a) => a.type === 'place');
  ok(moves2.every((a) => a.col === 0), '同时命中"允许"与"禁止"时按禁止处理');

  // 3) 荆棘：不能压在指定的那张牌上
  //    注意让该列有基底保护，否则"只有基底时不能放 E"会干扰本组断言。
  const thornTarget = card('3');
  const thorn = {
    kind: 'custom',
    label: '荆棘',
    allowedColumns: null,
    forbiddenColumns: null,
    digitsOnly: false,
    forbidDigitOnCardId: thornTarget.id,
    setBy: 1,
    applyTo: 0,
  };
  const s3 = scene({ bases: [['3', '3']], hands: [['4', 'E·浅']], current: 0, restriction: thorn });
  s3.bases[0] = [card('3'), thornTarget];
  const moves3 = legalActions(s3, 0).filter((a) => a.type === 'place');
  ok(!moves3.some((a) => isDigit(a.card)), '荆棘禁止在该数字牌上放数字牌');
  ok(moves3.some((a) => !isDigit(a.card)), '荆棘不禁止放 E（只有数字牌受限）');

  // 4) 限制的生命周期：施加者回合结束不清除，目标回合结束才清除
  const game = scene({
    bases: [['0'], ['3'], ['4']],
    hands: [['1', '0'], ['3', '0']],
    deck: ['5', '5', '5', '0', '0', '0'],
    current: 0,
  });
  const applied = applyAction(game, requirePlace(game, 0, '1')); // 玩家1出数字牌
  eq(applied.current, 1, '轮到对手');
  eq(activeRestrictions(applied, 1).length, 0, '普通出牌不产生限制');
  const withLimit = scene({
    bases: [['0'], ['3'], ['4']],
    hands: [['1', '0'], ['3', '0']],
    deck: ['5', '5', '5', '0', '0', '0'],
    current: 0,
    restriction: { ...restrictTwo, applyTo: 1, setBy: 0 },
  });
  const afterMover = applyAction(withLimit, requirePlace(withLimit, 0, '1'));
  eq(activeRestrictions(afterMover, 1).length, 1, '限制在施加者回合结束后仍然保留（作用于对手）');
  const afterTarget = applyAction(afterMover, passOf(1));
  eq(activeRestrictions(afterTarget, 1).length, 0, '目标玩家回合结束后限制被清除');
}

// ---------------------------------------------------------------------------
group('紫色 0 全局限锁');
{
  const s = scene({ bases: [['紫0'], ['3'], ['4']], hands: [['1', '2', 'E·深', 'M·浅']] });
  ok(hasPurpleLock(s), '任意一列顶端是紫 0 即触发限锁');
  const moves = legalActions(s, 0).filter((a) => a.type === 'place');
  ok(moves.length > 0 && moves.every((a) => isDigit(a.card)), '限锁下只能出数字牌');
  ok(!moves.some((a) => a.col === 1), '限锁下不能用炸弹');
  ok(!moves.some((a) => a.col === 2), '限锁下不能放魔法');

  const locked = scene({
    bases: [['紫0'], ['3'], ['4']],
    hands: [['1'], ['3', '4', 'E·深', '1']],
    current: 1,
    pendingMagic: { type: 'm', variant: 'dark', column: 1, forbiddenColumn: null, setBy: 0, applyTo: 1 },
  });
  const restricted = legalActions(locked, 1).filter((a) => a.type === 'place');
  ok(restricted.length > 0 && restricted.every((a) => isDigit(a.card)), '紫 0 限锁优先于 M：仍只能出数字牌');
  ok(restricted.every((a) => a.col === 1), '紫 0 限锁不解除深 M 的列限制');

  const covered = scene({ bases: [['紫0'], ['3'], ['4']], hands: [['1', 'E·浅']] });
  const afterCover = applyAction(covered, requirePlace(covered, 0, '1'));
  ok(!hasPurpleLock(afterCover), '紫 0 被盖住后限锁解除');

  const purple = scene({ bases: [['3'], ['3'], ['3']], hands: [['紫0']] });
  ok(!findPlace(purple, 0, '紫0'), '紫 0 不能放在 3 上（本身是 0，只接 1/2）');
}

// ---------------------------------------------------------------------------
group('过牌与抽牌');
{
  const s = scene({ bases: [['3'], ['3'], ['3']], hands: [['0'], ['0']], deck: ['5', '5', '5', '1', '1', '1'], padDeck: false });
  const after = applyAction(s, passOf(0));
  eq(after.hands[0].length, 3, '过牌者抽 2 张');
  eq(after.hands[1].length, 2, '对手抽 1 张');
  eq(after.deck.length, 3, '牌堆减少 3 张');
  eq(after.current, 1, '过牌后换手');
  eq(after.consecutivePasses, 1, '连续过牌计数 +1');

  const empty = scene({ bases: [['3'], ['3'], ['3']], hands: [['0'], ['0']], deck: [], padDeck: false });
  const afterEmpty = applyAction(empty, passOf(0));
  eq(afterEmpty.hands[0].length, 1, '牌堆空时不抽牌');
  eq(afterEmpty.current, 1, '牌堆空时直接换手');

  // 连续过牌但牌堆还没空：不结算，继续消耗牌堆
  const mid = scene({
    bases: [['5'], ['5'], ['5']],
    hands: [['0'], ['0']],
    deck: ['5', '5', '5', '5', '5', '5', '5', '5', '5'],
    padDeck: false,
  });
  const firstPass = applyAction(mid, passOf(0));
  ok(!firstPass.result.over, '牌堆未空时过牌不结算');
  const two = applyAction(firstPass, passOf(1));
  eq(two.deck.length, 3, '两次过牌共消耗 6 张');
  ok(!two.result.over, '牌堆还有牌时连续过牌仍不结算');
  // 第三次过牌把牌堆抽空，但"各过两次"还没满足 → 要多等一个回合
  const three = applyAction(two, passOf(0));
  eq(three.deck.length, 0, '第三次过牌把牌堆抽空');
  ok(!three.result.over, '牌堆刚空且只过了 3 次牌：还不到结算（多等一个回合）');
  const four = applyAction(three, passOf(1));
  ok(four.result.over, '双方各过两次牌之后才结算');

  const endgame = scene({ bases: [['3'], ['3'], ['3']], hands: [['0'], ['0', '1']], deck: [], padDeck: false });
  const twiceEach = applyAction(
    applyAction(applyAction(applyAction(endgame, passOf(0)), passOf(1)), passOf(0)),
    passOf(1),
  );
  ok(twiceEach.result.over, '牌堆空且双方各过两次牌后结算');
  eq(twiceEach.result.winner, 0, '手牌少的一方获胜');
  // 只过 3 次还不结算
  const onlyThree = applyAction(applyAction(applyAction(endgame, passOf(0)), passOf(1)), passOf(0));
  ok(!onlyThree.result.over, '牌堆空但只过 3 次牌时不结算');

  // 放置动作不会重置牌堆之外的任何东西
  const placed = scene({ bases: [['3'], ['3'], ['3']], hands: [['4', '5'], ['0']], deck: ['1', '1', '1'], padDeck: false });
  const afterPlace = applyAction(placed, requirePlace(placed, 0, '4'));
  eq(afterPlace.deck.length, 3, '放置不消耗牌堆');
  eq(afterPlace.consecutivePasses, 0, '放置后连续过牌计数归零');
}

// ---------------------------------------------------------------------------
group('胜负判定');
{
  const s = scene({ bases: [['3'], ['3'], ['3']], hands: [['4'], ['0', '1']] });
  const win = applyAction(s, requirePlace(s, 0, '4'));
  ok(win.result.over, '出完手牌立即结束');
  eq(win.result.winner, 0, '出完手牌者获胜');
  eq(win.result.reason, '出完手牌', '胜利原因正确');

  const draw = scene({ bases: [['3'], ['3'], ['3']], hands: [['0'], ['0']], deck: [], padDeck: false });
  const drawn = applyAction(applyAction(draw, passOf(0)), passOf(1));
  eq(drawn.result.winner, null, '手牌相同则平局');
}

// ---------------------------------------------------------------------------
group('先手禁区');
{
  const s = scene({ bases: [['3'], ['3'], ['3']], hands: [['4', '5', '4', '5'], ['4', '4']] });
  const banned = setForbiddenColumn(s, 1);
  const first = legalActions(banned, 0).filter((a) => a.type === 'place');
  ok(first.length > 0, '先手仍有其它列可放');
  ok(first.every((a) => a.col !== 1), '先手第一手不能放禁列');
  const played = applyAction(banned, first[0]);
  eq(played.forbiddenColumn, 1, '禁列记录保留在状态里');
  const opponentMoves = legalActions(played, 1).filter((a) => a.type === 'place');
  ok(opponentMoves.length > 0, '轮到后手时禁列不再生效（后手可放任意列）');
  void findPlace;
}

// ---------------------------------------------------------------------------
group('规则冲突与边界');
{
  // 顶端是 M？M 放完立即出局，所以列顶永远不会是 M
  const s = scene({ bases: [['0'], ['3'], ['4']], hands: [['M·浅', '0'], []] });
  const after = applyAction(s, requirePlace(s, 0, 'M·浅'));
  eq(after.bases[0][after.bases[0].length - 1].kind, 'number', 'M 之后列顶仍是数字牌');

  // 手牌不足 2 张时过牌：牌堆空则无事发生
  const tiny = scene({ bases: [['3'], ['3'], ['3']], hands: [['0'], []], deck: [], padDeck: false });
  const afterTiny = applyAction(tiny, passOf(0));
  eq(afterTiny.deck.length, 0, '牌堆空时过牌不抽牌');

  // 牌堆只剩 1-2 张时（理论上不该出现）过牌不应报错
  const shortDeck = scene({ bases: [['3'], ['3'], ['3']], hands: [['0'], ['0']], deck: ['5', '5'], padDeck: false });
  const afterShort = applyAction(shortDeck, passOf(0));
  eq(afterShort.deck.length, 2, '牌堆不足 3 张时不抽牌（保守处理，不报错）');
}

// ---------------------------------------------------------------------------
group('牌 id 唯一性（回归）');
{
  // 曾经的 bug：同型牌 id 相同（都是 #index），导致
  // "打出一张 0 后又摸到一张 0"时 UI 的选中状态张冠李戴、点击变成取消选中。
  const deckA = createDeck();
  const deckB = createDeck();
  eq(new Set(deckA.map((c) => c.id)).size, 37, '单个牌库内 id 全唯一');
  eq(new Set([...deckA, ...deckB].map((c) => c.id)).size, 74, '不同牌库之间 id 也不重复');

  // 四张普通 0 必须是四个不同的 id（UI 依赖它区分手牌）
  const zeros = deckA.filter((c) => c.rank === 0 && c.color === 'plain');
  eq(new Set(zeros.map((c) => c.id)).size, 4, '四张普通 0 各自有唯一 id');

  // 实战复现：打出一张牌后摸到同型牌，两者 id 不能相同
  const game = createGame({ seed: 77 });
  const allIds = [...game.deck, ...game.hands[0], ...game.hands[1], ...game.bases.flat()].map((c) => c.id);
  eq(new Set(allIds).size, allIds.length, '开局后全场所有牌 id 互不相同');
}

// ---------------------------------------------------------------------------
group('随机对局不变量');
{
  const profiles = Object.values(BUILTIN_PROFILES);
  let games = 0;
  let turns = 0;
  const reasons = new Map();
  const violations = [];

  for (let seed = 1; seed <= 150; seed++) {
    const a = profiles[seed % profiles.length];
    const b = profiles[(seed * 7) % profiles.length];
    let state = createGame({ seed });
    const rng = createRng(seed * 131 + 17);
    let guard = 0;

    while (!isOver(state) && guard < 2000) {
      const player = state.current;
      const actions = legalActions(state, player);

      const counts = cardCounts(state);
      if (counts.total !== DECK_SIZE) violations.push(`种子 ${seed} 第 ${guard} 手牌数不守恒 ${JSON.stringify(counts)}`);
      if (!actions.some((x) => x.type === 'pass')) violations.push(`种子 ${seed} 缺少过牌选项`);
      if (state.hands[player].length === 0) violations.push(`种子 ${seed} 出现空手牌仍在行动`);

      const action = (player === 0 ? a : b).decide(state, player, rng);
      if (!isLegal(state, action)) {
        violations.push(`种子 ${seed} AI ${player === 0 ? a.id : b.id} 给出非法着法`);
        break;
      }

      const deckBefore = state.deck.length;
      state = applyAction(state, action);
      if (action.type === 'place' && state.deck.length !== deckBefore) violations.push(`种子 ${seed} 放置动作改变了牌堆`);
      if (state.result.over === false && state.hands[state.current].length === 0) violations.push(`种子 ${seed} 空手牌却未结束`);

      guard += 1;
      turns += 1;
    }

    if (!isOver(state)) violations.push(`种子 ${seed} 对局未在 2000 手内结束`);
    if (state.result.over && state.result.winner !== null && state.hands[state.result.winner].length !== 0 && state.deck.length !== 0) {
      violations.push(`种子 ${seed} 过早结算：${state.result.reason}`);
    }
    games += 1;
    reasons.set(state.result.reason, (reasons.get(state.result.reason) ?? 0) + 1);
  }

  eq(games, 150, '完成 150 局随机对局');
  eq(violations.length, 0, `随机对局无违规${violations.length ? '：' + violations.slice(0, 3).join(' / ') : ''}`);
  console.log(`  随机对局：${games} 局 / ${turns} 手，平均 ${(turns / games).toFixed(1)} 手`);
  for (const [reason, count] of reasons) console.log(`    · ${reason}：${count} 局`);
}

// ---------------------------------------------------------------------------
group('AI 决策健壮性');
{
  for (const profile of Object.values(BUILTIN_PROFILES)) {
    let state = createGame({ seed: 5 });
    const rng = createRng(3);
    let allLegal = true;
    let guard = 0;
    while (!isOver(state) && guard++ < 2000) {
      const action = profile.decide(state, state.current, rng);
      if (!isLegal(state, action)) {
        allLegal = false;
        break;
      }
      state = applyAction(state, action);
    }
    ok(allLegal && isOver(state), `${profile.id} 能走完整局且只出合法着法`);
    const banned = profile.chooseForbiddenColumn(createGame({ seed: 9 }), createRng(1));
    ok(Number.isInteger(banned) && banned >= 0 && banned < COLUMNS, `${profile.id} 能选出合法禁列`);
  }
}

// ---------------------------------------------------------------------------
group('测试工具自检');
{
  const s = scene({ bases: [['3'], ['3'], ['3']], hands: [['4'], ['0']] });
  ok(isLegal(s, findPlace(s, 0, '4')), 'isLegal 识别合法着法');
  ok(!isLegal(s, findPlace(s, 1, '0')), 'isLegal 识别非法着法');
  ok(sameAction(pass(), pass()), 'sameAction 对过牌成立');
  void pass;
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const failure of failures.slice(0, 40)) console.log('  - ' + failure);
  process.exit(1);
}
