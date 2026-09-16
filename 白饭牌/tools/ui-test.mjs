/**
 * 界面行为测试：在 Node 里跑打包后的真实页面，验证「谁该看见什么、点了会怎样」。
 *
 * 用法：node tools/ui-test.mjs
 *
 * 覆盖：
 *   - 后手时禁列提示条可见；先手时不出现；选择完成后消失
 *   - 牌堆叠放只露牌头（每张牌都有牌条），点开能看完整牌堆
 *   - 限制横幅按优先级正确显示（紫 0 限锁 / M 限制 / 禁列）
 *   - 能自动打完一整局并弹出结算
 *   - hidden 属性真的生效（CSS 不会盖掉它）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage } from './mini-dom.mjs';
import { sourceFingerprint } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const html = fs.readFileSync(path.join(root, '白饭牌.html'), 'utf8');

/** 当前源码指纹，用于确认测试跑的产物是最新构建的。 */
function currentFingerprint() {
  return sourceFingerprint(fs.readFileSync(path.join(root, 'web/ui.js'), 'utf8'));
}

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

/** 启动一局：点「开始对局」，返回页面对象。 */
function startGame(page) {
  const start = page.el('btnStart');
  if (!start) throw new Error('找不到开始按钮');
  start.click();
  page.clock.settle();
  return page;
}

/** 开局弹窗里选对局模式（人机 / 双人 / 演示）。 */
function setMode(page, modeLabel) {
  const nodes = page.document.querySelectorAll('#modeList .diff');
  const target = nodes.find((n) => n.textContent.includes(modeLabel));
  if (!target) throw new Error(`找不到模式：${modeLabel}`);
  target.click();
  return target;
}

/** 在开局弹窗里选 AI 难度（简单 / 普通 / 困难）。 */
function setDifficulty(page, label) {
  const nodes = page.document.querySelectorAll('#diffList .diff');
  const target = nodes.find((n) => n.textContent.includes(label));
  if (!target) throw new Error(`找不到难度：${label}`);
  target.click();
  return target;
}

/**
 * 处理开局阶段：选技 → 指定禁列。
 * 返回是否处于"选技阶段轮到我方"（用于断言）。
 */
function handleSetup(page) {  let sawDraft = false;
  for (let i = 0; i < 120; i++) {
    const state = page.state();
    if (!state || state.result.over) break;
    if (!state.draft && state.forbiddenColumn !== null && !state.pendingChoice) break;

    const banBar = page.el('banBar');
    // 对局结束时不要继续点开局按钮（此时界面已经切到结算）
    if (isResultModal(page)) break;
    if (banBar.hidden) {
      advanceAi(page);
      continue;
    }
    const title = banBar.querySelector('.ban-title').textContent;
    // 选技阶段会把"已被选走"的技能按钮设为 disabled，所以必须挑第一个可用的
    const buttons = [...page.el('banRow').children].filter((b) => !b.disabled);
    if (buttons.length === 0) {
      page.clock.settle();
      continue;
    }
    if (title.includes('技能')) sawDraft = true;
    buttons[0].click();
    page.clock.settle();
  }
  return sawDraft;
}

/**
 * 模拟玩家走一步：
 * 1) 提示条上有人类要做的决定（选技 / 指定禁列）——先点掉它；
 * 2) 选牌阶段点手牌；
 * 3) 正常回合选牌再点列；无法放置就过牌。
 */
function playOneMove(page) {
  const banBar = page.el('banBar');
  if (banBar && !banBar.hidden) {
    const btn = [...page.el('banRow').children].find((b) => !b.disabled);
    if (btn) {
      btn.click();
      page.clock.settle();
      return true;
    }
  }

  const state = page.state();
  if (state && state.pendingChoice) {
    // 只有轮到人类选牌才操作；AI 选牌时不推进时钟（真实游戏里 AI 正在思考）
    if (state.pendingChoice.player !== 0) return false;
    const chips = page.document.querySelectorAll('#myHand .card').filter((c) => !c.classList.contains('picked'));
    if (chips.length === 0) return false;
    chips[0].click();
    page.clock.settle();
    return true;
  }

  const cards = page.document.querySelectorAll('#myHand .card');
  const playable = cards.filter((c) => !c.classList.contains('blocked'));
  if (playable.length > 0) {
    playable[0].click();
    // 选中后只有这张牌能放的列才是 .legal（见 UI 的 computeMoves）
    const col = page.document.querySelector('.column.legal');
    if (col) {
      col.click();
      page.clock.settle();
      return true;
    }
    return false;
  }
  const pass = page.el('btnPass');
  if (pass && !pass.disabled) {
    pass.click();
    page.clock.settle();
    return true;
  }
  return false;
}

/** 处理"AI 正在思考/选牌"：推动时钟，直到又轮到人类或对局结束。 */
function advanceAi(page) {
  const state = page.state();
  if (!state || state.result.over) return;
  if (state.pendingChoice && state.pendingChoice.player !== 0) {
    // AI 在选牌：它的定时器会处理
    page.clock.settle();
    return;
  }
  if (state.current !== 0 || state.draft || state.pendingChoice) page.clock.settle();
}

/** 战报里真正的"出错"行（bad 样式也用于 AI 指定禁列、对局结束，所以按文案筛）。 */
const badLogLines = (page) =>
  page.el('logBox').children
    .filter((d) => d.className === 'bad' && /出错|失败|异常|未定义|is not defined/.test(d.textContent))
    .map((d) => d.textContent);

/**
 * 是否已经分出胜负。
 * 同时看引擎状态：play() 里 afterStep 会先于 render 可能弹出结算，
 * 只判断弹窗可见性会漏掉这个瞬间。
 */
const isResultModal = (page) => {
  const state = page.state();
  if (state && state.result && state.result.over) return true;
  const modal = page.el('modal');
  if (!modal || modal.hidden) return false;
  const heading = page.document.querySelector('#modalBody h2');
  return Boolean(heading) && /赢|输|平局/.test(heading.textContent);
};

// ---------------------------------------------------------------------------
startGroup('产物完整性');
{
  ok(html.includes('data-boot="fail"'), '产物带有启动自检标记');
  ok(html.includes("setAttribute('data-boot', 'ok')"), '产物带有启动自检代码');

  const page = createPage(html);
  ok(page.errors.length === 0, `执行页面脚本无错误${page.errors.length ? '：' + page.errors.join(' / ') : ''}`);
  eq(page.el('boot').getAttribute('data-boot'), 'ok', '启动自检标记被置为 ok');
  ok(page.el('modal').hidden === false, '开局弹出难度选择');

  // 产物必须是最新源码构建的：否则测试验的是旧代码，玩家拿到的却是另一个版本。
  eq(
    page.el('boot').getAttribute('data-fingerprint'),
    currentFingerprint(),
    '产物指纹与当前源码一致（说明 白饭牌.html 是最新构建的）',
  );
}

// ---------------------------------------------------------------------------
startGroup('选技与禁列的开局流程');
{
  let sawDraft = false;
  let checkedSecond = false;
  let checkedFirst = false;

  for (let attempt = 0; attempt < 40 && !(sawDraft && checkedSecond && checkedFirst); attempt++) {
    const page = createPage(html);
    startGame(page);
    const banBar = page.el('banBar');

    // 一开始必然是选技阶段（随机 3 个候选）
    if (!banBar.hidden && !isResultModal(page)) {
      const title = banBar.querySelector('.ban-title').textContent;
      const buttons = page.el('banRow').children;
      if (title.includes('技能')) {
        ok(buttons.length === 3, '选技阶段给出 3 个候选技能');
        sawDraft = true;
      }
    }

    // 处理选技与禁列，记录观察到的禁列阶段
    let sawBan = false;
    for (let i = 0; i < 40; i++) {
      if (isResultModal(page)) break;
      if (banBar.hidden) {
        page.clock.settle();
        if (banBar.hidden) break;
        continue;
      }
      const title = banBar.querySelector('.ban-title').textContent;
      // 选技阶段"已被选走"的技能按钮是 disabled，必须挑可用的点
      const button = [...page.el('banRow').children].find((b) => !b.disabled);
      if (!button) {
        page.clock.settle();
        continue;
      }
      if (title.includes('禁列')) {
        sawBan = true;
        ok(page.el('banRow').children.length === 3, '禁列阶段给出 3 个列选项');
        ok(page.el('banRow').children.every((b) => !b.disabled), '禁列选项全部可点');
      } else {
        // 选技阶段：已被对方选走的技能必须不可点
        const taken = page.el('banRow').children.filter((b) => b.disabled);
        ok(taken.every((b) => b.textContent.includes('已被选走')), '被选走的技能按钮被禁用并标注');
        if (taken.length > 0) {
          const before = page.state();
          taken[0].click();
          page.clock.settle();
          const after = page.state();
          eq(after.skills[after.draft ? 0 : 0] ?? null, before.skills[0] ?? null, '点击被禁用的技能不会生效');
        }
      }
      button.click();
      page.clock.settle();
      if (banBar.hidden) break;
    }

    const state = page.state();
    if (state && !state.result.over && state.forbiddenColumn !== null && !state.pendingChoice && !state.draft) {
      ok(!isResultModal(page), '开局阶段不会误触发结算');
      if (state.lastPlayer === 0) checkedSecond = true;
      else checkedFirst = true;
      break;
    }
    void sawBan;
  }
  ok(sawDraft, '开局先进入选技阶段');
  ok(checkedSecond || checkedFirst, '能走完开局阶段并进入正常回合');
}

// ---------------------------------------------------------------------------
startGroup('技能面板');
{
  const page = createPage(html);
  startGame(page);
  handleSetup(page);
  page.clock.settle();

  const box = page.el('skillBox');
  ok(Boolean(box), '存在技能面板');
  const cards = box.querySelectorAll('.skill-card');
  ok(cards.length === 2, `双方各展示一个技能（实际 ${cards.length} 个）`);
  ok(cards.some((c) => c.classList.contains('mine')), '标出了自己的技能');
  const tags = box.querySelectorAll('.skill-tag');
  ok(tags.length === 2, '每个技能都有类型/次数标记');
  const names = box.querySelectorAll('.skill-name').map((n) => n.textContent);
  ok(names.every((n) => n && n.length > 0), `技能名称正常显示（${names.join('、')}）`);
}

// ---------------------------------------------------------------------------
startGroup('对局模式开关');
{
  // 开局弹窗必须提供三种模式
  {
    const page = createPage(html);
    const modes = page.document.querySelectorAll('#modeList .diff').map((n) => n.textContent);
    eq(modes.length, 3, '开局弹窗提供 3 种对局模式');
    ok(modes.some((t) => t.includes('人机对战')), '包含「人机对战」');
    ok(modes.some((t) => t.includes('双人同机')), '包含「双人同机」');
    ok(modes.some((t) => t.includes('AI 自动演示')), '包含「AI 自动演示」');
  }

  // 人机模式：玩家完全不动，AI 也绝不能替玩家出牌
  {
    const page = createPage(html);
    setMode(page, '人机对战');
    startGame(page);
    handleSetup(page);

    const startHand = page.state().hands[0].length;
    const startTurn = page.state().turn;
    for (let i = 0; i < 60; i++) {
      page.clock.settle();
      const st = page.state();
      if (!st || st.result.over) break;
      // 轮到玩家选牌时也不操作，只推进时钟
    }
    const st = page.state();
    eq(st.hands[0].length, startHand, '人机模式下玩家不出牌，手牌数不变（AI 没接管玩家座位）');
    ok(st.turn === startTurn || st.current === 0, '人机模式下会停在等玩家行动');
    ok(!isResultModal(page) || st.turn === startTurn, '人机模式下不会自己把整局打完');
    eq(badLogLines(page).length, 0, `人机模式没有界面报错${badLogLines(page).length ? '：' + badLogLines(page).join(' / ') : ''}`);

    // 关键不变量：玩家座位在无人操作时，不能有任何着法被执行。
    // （不检查"拦截次数"：AI 的定时器可能先于禁列排入，被护栏静默拦掉属于正常时序。）
    const humanActions = (page.window.BaiFan.__uiTrace ?? []).filter(
      (t) => (String(t.via).startsWith('ai:') || String(t.via).startsWith('ui.play')) && /@0\b/.test(String(t.via)),
    );
    eq(humanActions.length, 0, `玩家座位没有被别人代打${humanActions.length ? '：' + humanActions.map((t) => t.via).join('、') : ''}`);
  }

  // 开局顺序：后手的禁列必须发生在先手第一手之前
  {
    let verified = false;
    for (let round = 0; round < 40 && !verified; round++) {
      const page = createPage(html);
      setMode(page, '人机对战');
      startGame(page);

      // 手动走开局：选技 → 若禁列提示出现，先记录"此刻有没有人出过牌"
      let sawBanPrompt = false;
      let moveBeforeBan = false;
      let banDone = false;
      for (let i = 0; i < 120; i++) {
        const st = page.state();
        if (!st || st.result.over) break;
        if (!st.draft && st.forbiddenColumn !== null && !st.pendingChoice) { banDone = true; break; }

        const banBar = page.el('banBar');
        if (!banBar.hidden) {
          const title = banBar.querySelector('.ban-title').textContent;
          // 提示条两种用途靠标题区分：选技 vs 指定禁列（文案里是"不能放的列"）
          if (title.includes('后手')) {
            sawBanPrompt = true;
            // 禁列还没确定时，棋盘上不应该出现任何新放的牌（基底固定 3 张）
            const boardCards = st.bases.reduce((sum, stack) => sum + stack.length, 0);
            if (boardCards !== 3) moveBeforeBan = true;
          }
          const btn = page.el('banRow').children[0];
          if (btn) { btn.click(); page.clock.settle(); continue; }
        }
        page.clock.settle();
      }

      const endState = page.state();
      if (sawBanPrompt && !endState.result.over) {
        ok(!moveBeforeBan, '后手选禁列之前，先手没有落子（顺序正确）');
        // 以"状态里禁列已确定"为准，而不是循环是否 break 出来
        ok(endState.forbiddenColumn !== null, '禁列选择完成后才进入正常回合');
        verified = true;
      }
    }
    ok(verified, '抽到了"玩家是后手"的开局样本');
  }

  // 演示模式：两边都由 AI 打，能自动跑完
  {
    const page = createPage(html);
    setMode(page, 'AI 自动演示');
    startGame(page);
    handleSetup(page);

    let turns = 0;
    for (let i = 0; i < 3000 && !isResultModal(page); i++) {
      page.clock.settle();
      turns += 1;
    }
    ok(isResultModal(page), `AI 自动演示能自己打完一局（推了 ${turns} 次时钟）`);
    const st = page.state();
    ok(st.result.over, '演示模式结束时对局状态为已结束');
    ok(page.errors.length === 0, `演示模式无脚本错误${page.errors.length ? '：' + page.errors.join(' / ') : ''}`);
    eq(badLogLines(page).length, 0, `演示模式没有界面报错${badLogLines(page).length ? '：' + badLogLines(page).join(' / ') : ''}`);
  }

  // 双人模式：两个座位都由人操作（不会自动推进）
  {
    const page = createPage(html);
    setMode(page, '双人同机');
    startGame(page);
    handleSetup(page);
    const before = page.state();
    const beforeTurn = before.turn;
    // 完全不动，只推时钟
    for (let i = 0; i < 40; i++) page.clock.settle();
    const after = page.state();
    eq(after.turn, beforeTurn, '双人模式下不动就不会自动推进回合');
    ok(after.current === 0 || after.current === 1, '双人模式停在等某位玩家行动');
  }
}

// ---------------------------------------------------------------------------
startGroup('AI 选技真的按强度表走（回归）');
{
  // 曾经的 bug：finishAiStep 的选技分支调用 UI 层旧启发式（只按主动/被动排序），
  // 于是 SKILL_STRENGTH、skillSharpness、profiles 的 aiPickDraftSkill 全都没被使用，
  // 三档难度选技行为完全一致，AI 还会把实测负收益的看破/汇流当宝。
  const API = createPage(html).window.BaiFan;
  const pool = ['jingji', 'weiyan', 'chuangsheng', 'shuaishou', 'shuimian'];

  // 直接用引擎侧 API 验证"档位参数确实生效"（UI 现在把 decide 的结果原样交给 chooseSkill）
  const rates = {};
  for (const [label, profile] of [['简单', API.easy], ['普通', API.normal], ['困难', API.hard]]) {
    const rng = API.createSeededRng(`ui-draft-${label}`);
    let best = 0;
    let used = 0;
    for (let i = 0; i < 400; i++) {
      // 造一个"候选里含最强技能"的选技局面（复刻真实开局：3 个候选）
      const trio = [pool[i % pool.length], pool[(i + 1) % pool.length], pool[(i + 2) % pool.length]];
      const state = { draft: { options: trio, available: trio } };
      const picked = API.aiPickDraftSkill(state, rng, profile.config.skillSharpness);
      const bestId = trio.reduce((b, x) => (API.skillStrength(x) > API.skillStrength(b) ? x : b), trio[0]);
      used += 1;
      if (picked === bestId) best += 1;
    }
    rates[label] = best / used;
  }
  ok(rates.简单 > 0, '简单档有选技记录');
  ok(
    rates.困难 > rates.简单 + 0.1,
    `困难档明显比简单档更会挑最强技能（${(rates.困难 * 100).toFixed(1)}% vs ${(rates.简单 * 100).toFixed(1)}%）`,
  );
  ok(
    rates.普通 > rates.简单 && rates.普通 < rates.困难,
    `普通档位于两者之间（${(rates.普通 * 100).toFixed(1)}%）`,
  );

  // 端到端：真实开局里，AI 选出的技能必须是强度表认同的"当前候选里较强的"
  let checked = 0;
  let good = 0;
  for (let i = 0; i < 60 && checked < 20; i++) {
    const page = createPage(html);
    setMode(page, '人机对战');
    setDifficulty(page, '困难');
    startGame(page);
    const st = page.state();
    if (!st?.draft) continue;
    const options = st.draft.options;
    const aiPick = st.skills[st.firstPlayer ?? 0] ?? null;
    void aiPick;
    // 后手先选；等它选完
    for (let k = 0; k < 10 && page.state().draft; k++) page.clock.settle();
    const after = page.state();
    const pickedId = after.skills.find((x) => x) ?? null;
    if (!pickedId) continue;
    const strongest = options.reduce((b, x) => (API.skillStrength(x) > API.skillStrength(b) ? x : b), options[0]);
    checked += 1;
    if (pickedId === strongest) good += 1;
  }
  ok(checked > 0, `端到端观察到 ${checked} 次 AI 选技`);
  ok(good / Math.max(1, checked) >= 0.6, `困难档 AI 多数情况下拿到候选里最强的技能（${good}/${checked}）`);
}

// ---------------------------------------------------------------------------
startGroup('技能一览');
{
  const page = createPage(html);
  const box = page.el('skillList');
  ok(Boolean(box), '侧栏有技能一览');

  const items = box.querySelectorAll('.skill-item');
  eq(items.length, 12, `技能一览列出全部 12 个技能（实际 ${items.length} 个）`);

  const names = items.map((n) => n.querySelector('b').textContent);
  const expected = ['消却', '看破', '爆弹', '沉默', '创生', '禁锢', '睡眠', '观星', '威严', '甩手', '荆棘', '汇流'];
  for (const name of expected) ok(names.includes(name), `技能一览包含「${name}」`);

  // 每个技能都要有发动方式与效果原文
  const kinds = items.map((n) => n.querySelector('.skill-kind').textContent);
  const descs = items.map((n) => n.querySelector('.skill-desc').textContent);
  ok(kinds.every((k) => k.length > 0), '每个技能都标注了发动方式');
  ok(descs.every((d) => d.length >= 10), '每个技能都有效果说明');
  eq(kinds.filter((k) => k.includes('主动')).length, 7, '7 个主动技（消却/看破/沉默/创生/禁锢/睡眠/甩手）');
  eq(kinds.filter((k) => k.includes('每局限 2 次')).length, 3, '三个技能标注为每局限 2 次（睡眠、看破、沉默）');
  eq(kinds.filter((k) => k === '被动').length, 5, '5 个被动技（爆弹/观星/威严/荆棘/汇流）');

  // 说明文字必须来自技能定义本身（不能各写一份，否则迟早不一致）
  ok(
    page.window.BaiFan.allSkills().every((def) => descs.includes(def.text)),
    '技能说明与技能定义原文完全一致',
  );

  // 规则速查弹窗里也要有技能部分
  page.el('btnRules').click();
  page.clock.settle();
  const modalSkills = page.document.querySelectorAll('#modalBody .skill-list .skill-item');
  eq(modalSkills.length, 12, '规则速查弹窗里也列出 12 个技能');
}

// ---------------------------------------------------------------------------
startGroup('黑 5 免疫炸药：界面行为（回归）');
{
  const page = createPage(html);
  setMode(page, '人机对战');
  startGame(page);
  handleSetup(page);

  const API = page.window.BaiFan;
  const deck = API.createDeck();
  const findCard = (pred) => deck.find(pred) ?? null;
  const blackFive = findCard((c) => c.kind === 'number' && c.color === 'black');
  const plainThree = findCard((c) => c.kind === 'number' && c.rank === 3 && c.color === 'plain');
  const plainOne = findCard((c) => c.kind === 'number' && c.rank === 1 && c.color === 'plain');
  const lightE = findCard((c) => c.kind === 'e' && c.color === 'light');
  const plainTwo = findCard((c) => c.kind === 'number' && c.rank === 2 && c.color === 'plain');

  const base = API.newState(API.createGame({ seed: 20240608 }));
  const injected = {
    ...base,
    bases: [
      [{ ...plainThree, id: 'inj-b0' }, { ...blackFive, id: 'inj-black' }],
      [{ ...plainTwo, id: 'inj-b1' }, { ...plainOne, id: 'inj-t1' }],
      [{ ...plainTwo, id: 'inj-b2' }],
    ],
    hands: [[{ ...lightE, id: 'inj-e1' }], [{ ...plainTwo, id: 'inj-h1' }]],
    deck: [],
    skills: [null, null],
    current: 0,
    turn: 5,
    draft: null,
    pendingChoice: null,
    forbiddenColumn: 2,
    restriction: null,
    result: { over: false, winner: null, reason: null },
  };
  API.__uiInject(injected);
  page.clock.settle();

  // 引擎层面就不该给出"炸黑 5"的着法
  const eMoves = API.playerActions(page.state(), 0).filter((a) => a.type === 'place' && a.card.kind === 'e');
  ok(!eMoves.some((a) => a.col === 0), '引擎不给"把 E 放在黑 5 上"的着法');
  ok(eMoves.some((a) => a.col === 1), '引擎允许 E 炸普通顶端（第 2 列）');

  // 界面上这张 E 仍然能选，但只有第 2 列会亮
  const eNode = page.document.querySelectorAll('#myHand .card').find((c) => /E/.test(c.textContent));
  ok(Boolean(eNode), '手牌里能看到 E');
  if (eNode) {
    eNode.click();
    page.clock.settle();
    const legalCols = page.document.querySelectorAll('.column.legal');
    eq(legalCols.length, 1, '只有可炸的那一列被高亮');
  }
}

// ---------------------------------------------------------------------------
startGroup('看破：看过的对方手牌会显示出来');
{
  const page = createPage(html);
  setMode(page, '人机对战');
  startGame(page);
  handleSetup(page);

  const API = page.window.BaiFan;
  const deck = API.createDeck();
  const findCard = (pred) => deck.find(pred) ?? null;
  const plainTwo = findCard((c) => c.kind === 'number' && c.rank === 2 && c.color === 'plain');
  const plainThree = findCard((c) => c.kind === 'number' && c.rank === 3 && c.color === 'plain');
  const blackFive = findCard((c) => c.kind === 'number' && c.color === 'black');
  const plainOne = findCard((c) => c.kind === 'number' && c.rank === 1 && c.color === 'plain');

  const base = API.newState(API.createGame({ seed: 20240609 }));
  const oppHand = [
    { ...plainTwo, id: 'opp-1' },
    { ...blackFive, id: 'opp-2' },
  ];
  const injected = {
    ...base,
    bases: [[{ ...plainTwo, id: 'inj-b0' }, { ...plainOne, id: 'inj-t0' }], [{ ...plainThree, id: 'inj-b1' }], [{ ...plainThree, id: 'inj-b2' }]],
    hands: [[{ ...plainTwo, id: 'mine-1' }], oppHand],
    deck: [],
    skills: ['kanpo', null],
    current: 0,
    turn: 5,
    draft: null,
    pendingChoice: null,
    forbiddenColumn: 2,
    restriction: null,
    result: { over: false, winner: null, reason: null },
  };
  API.__uiInject(injected);
  page.clock.settle();

  // 发动看破之前：不显示
  ok(page.el('revealBox').hidden, '还没发动看破时不显示对方手牌');

  // 从技能面板发动
  const kanpoBtn = page.document.querySelectorAll('#skillBox button').find((b) => /看破/.test(b.textContent));
  ok(Boolean(kanpoBtn), '技能面板上有看破的发动按钮');
  kanpoBtn.click();
  page.clock.settle();

  const st = page.state();
  eq(st.current, 0, '看破不占用行动（还是我方回合）');
  eq(st.turn, 5, '看破不推进回合数');
  eq(st.usesById.kanpo, 1, '看破用掉一次');

  const box = page.el('revealBox');
  ok(!box.hidden, '发动后显示"看破"面板');
  const chips = box.querySelectorAll('.reveal-card').map((n) => n.textContent);
  eq(chips.length, 2, '列出对方当时 2 张手牌');
  ok(chips.includes('黑 5'), '能看到黑 5');
  ok(box.textContent.includes('看破'), '面板标题写明是看破看到的');
  ok(box.textContent.includes('只看这一眼'), '面板说明这是一次性的一眼，不是持续透视');

  // 对方换牌之后，面板里仍然是"当时看到的那副牌"（不会变成实时追踪）
  API.__uiInject({ ...st, hands: [st.hands[0], [{ ...plainThree, id: 'opp-new' }]] });
  page.clock.settle();
  const chips2 = page.el('revealBox').querySelectorAll('.reveal-card').map((n) => n.textContent);
  eq(chips2.length, 2, '同一回合内看到的仍是当时那副牌（不追踪对方换牌）');
  ok(chips2.includes('黑 5'), '当时看到的黑 5 依然在快照里');

  // 回合一旦前进，看破的显示立即消失
  API.__uiInject({ ...st, turn: 6, current: 1 });
  page.clock.settle();
  ok(page.el('revealBox').hidden, '进入下一回合后看破面板消失（只看当前那一眼）');
}

// ---------------------------------------------------------------------------
startGroup('观星不吞掉先手第一手（界面级）');
{
  // 曾经的 bug：先手持有观星时，开局选牌被当成一个回合并换手，
  // 于是先手第一手被跳过、turn 变成 2，而禁列判定要求 turn === 1，禁列直接失效。
  // 注意：只有当"选观星的人就是先手"时，选牌后 turn 才应该仍然是 1；
  // 若观星在后手手里，先手（AI）的第一手本来就该紧接着发生。
  let checked = 0;
  const wanted = 2;
  // 需要"人类恰好拿到观星且恰好是先手"：12 个技能随机亮 3 个、人类第二手选，
  // 概率不高，所以上限给足（只影响测试时长，不影响断言强度）。
  for (let round = 0; round < 500 && checked < wanted; round++) {
    const page = createPage(html);
    setMode(page, '人机对战');
    startGame(page);

    // 观星的选牌必须"零回合"：它落地后，先手仍站在第 1 回合上等自己的第一手。
    // 判定用的是"一切选牌都结束、也没有待办选择"的那个稳定瞬间——此时若 turn 还是 1，
    // 说明观星真的没有吃掉先手的回合。
    let openingTurn = null;
    let openingCurrent = null;
    let firstPlayer = null;
    let bannedCol = null;
    let guanxingTurn = null;
    let guanxingPicker = null;
    let pickerWasFirst = false;
    let moving = 0;
    for (let i = 0; i < 300; i++) {
      const st = page.state();
      if (!st || st.result.over) break;
      if (st.pendingChoice && /观星/.test(st.pendingChoice.note ?? '')) {
        guanxingPicker = st.pendingChoice.player;
        pickerWasFirst = st.pendingChoice.player === st.firstPlayer;
        guanxingTurn = st.turn;
      }
      if (!st.draft && !st.pendingChoice && st.forbiddenColumn !== null && st.current === st.firstPlayer) {
        openingTurn = st.turn;
        openingCurrent = st.current;
        firstPlayer = st.firstPlayer;
        bannedCol = st.forbiddenColumn;
        break;
      }
      if (!st.draft && st.pendingChoice === null && st.turn > 1) break;
      if (playOneMove(page)) moving = 0;
      else {
        page.clock.settle();
        moving += 1;
        if (moving > 40) break;
      }
    }

    if (guanxingPicker === null || !pickerWasFirst || openingTurn === null) continue;
    checked += 1;

    // 1) 观星选牌发生在第 1 回合
    eq(guanxingTurn, 1, '观星选牌发生在第 1 回合');
    // 2) 观星落地之后，先手仍在第 1 回合、仍由先手行动（回合没有被观星吃掉）
    eq(openingTurn, 1, '观星选完牌后先手仍在第 1 回合');
    eq(openingCurrent, firstPlayer, '观星选完牌后仍轮到先手行动');
    // 3) 先手在"被禁列保护着的第 1 回合"里确实有活干：被禁的列不参与高亮
    if (firstPlayer === 0) {
      const banned = page.document.querySelectorAll('.column')[bannedCol];
      ok(!banned.classList.contains('legal'), '被禁的列没有被高亮为可放');
    }
  }
  eq(checked, wanted, '抽到了 2 个"先手（人类）持有观星、且观星没吃掉第 1 回合"的样本');
}

// ---------------------------------------------------------------------------
startGroup('牌堆叠放与详情');
{
  const page = createPage(html);
  startGame(page);
  handleSetup(page);
  // 走几步，让牌堆至少长出几张（对局若已结束就停止）
  for (let i = 0; i < 6 && !isResultModal(page); i++) playOneMove(page);
  if (isResultModal(page)) {
    // 极小概率开局就分出胜负：此时没有牌堆可看，跳过本组断言
    ok(true, '（本局早早结束，跳过牌堆详情断言）');
  } else {
    const stacks = page.document.querySelectorAll('.fanned');
    ok(stacks.length >= 1, '牌桌上出现叠放牌堆');
    const strips = page.document.querySelectorAll('.card-strip');
    ok(strips.length >= 3, `叠放里每张牌都有牌头（共 ${strips.length} 个）`);
    ok(strips.every((s) => s.children.length >= 1), '每个牌头都带点数');

    // 点牌堆应打开详情弹窗，且列出与牌数相同的行
    stacks[0].click();
    const modal = page.el('modal');
    const heading = page.document.querySelector('#modalBody h2');
    ok(modal.hidden === false, '点牌堆打开详情弹窗');
    ok(heading && /^第 \d+ 列 · 共 \d+ 张$/.test(heading.textContent), `详情标题正确（${heading ? heading.textContent : '无'}）`);
    const rows = page.document.querySelectorAll('.col-detail .detail-row');
    const columnCount = Number((heading.textContent.match(/共 (\d+) 张/) ?? [])[1] ?? -1);
    eq(rows.length, columnCount, '详情列出的张数与标题一致');
    ok(rows.length >= 1 && rows[rows.length - 1].classList.contains('top'), '详情里标出了顶端生效牌');

    const close = page.el('btnDetailClose');
    ok(Boolean(close), '详情弹窗有关闭按钮');
    if (close) {
      close.click();
      ok(modal.hidden === true, '关闭后详情弹窗消失');
    }
  }
}

// ---------------------------------------------------------------------------
startGroup('选中牌后只高亮它的合法列');
{
  const page = createPage(html);
  startGame(page);
  handleSetup(page);
  // 等到"轮到我方且手牌里真有能出的牌"：期间推进 AI、处理选牌、必要时过牌
  let ready = false;
  for (let i = 0; i < 400 && !ready && !isResultModal(page); i++) {
    const state = page.state();
    if (!state) break;

    // 选牌：人类选牌就点，AI 选牌等它自己走
    if (state.pendingChoice) {
      if (state.pendingChoice.player === 0) playOneMove(page);
      else page.clock.settle();
      continue;
    }
    // 选技 / 禁列阶段
    if (state.draft || page.el('banBar').hidden === false) {
      handleSetup(page);
      continue;
    }
    // AI 回合
    if (state.current !== 0) {
      advanceAi(page);
      continue;
    }
    // 我方回合
    const playable = page.document.querySelectorAll('#myHand .card').filter((c) => !c.classList.contains('blocked'));
    if (playable.length > 0) {
      playable[0].click();
      ready = true;
      break;
    }
    const pass = page.el('btnPass');
    if (pass && !pass.disabled) pass.click();
    else page.clock.settle();
  }
  const ended = isResultModal(page);
  ok(ready || ended, '能选中一张可出的牌（或在等到之前对局已结束）');

  if (ready) {
    const columns = page.document.querySelectorAll('.column');
    const highlight = columns.filter((c) => c.classList.contains('legal'));
    const dimmed = columns.filter((c) => c.classList.contains('not-for-selected'));
    ok(highlight.length >= 1, '选中牌后至少有一列被高亮');
    ok(highlight.length + dimmed.length === columns.length, '其余列都被标成"这张牌放不了"');
    ok(dimmed.every((c) => !c.classList.contains('legal')), '变暗的列不会同时是高亮列');

    // 点一个"这张牌放不了"的列，应给出明确提示而不是静默无反应
    if (dimmed.length > 0) {
      dimmed[0].click();
      const status = page.el('statusLine').textContent;
      ok(status.length > 0, `点放不了的列会给出提示（${status}）`);
    }
  }
}

// ---------------------------------------------------------------------------
startGroup('新技能：爆弹 / 沉默 / 创生 的界面行为');
{
  const page = createPage(html);
  setMode(page, '人机对战');
  startGame(page);
  handleSetup(page);

  const API = page.window.BaiFan;
  const deck = API.createDeck();
  const findCard = (pred) => deck.find(pred) ?? null;
  const p1 = findCard((c) => c.kind === 'number' && c.rank === 1 && c.color === 'plain');
  const p2 = findCard((c) => c.kind === 'number' && c.rank === 2 && c.color === 'plain');
  const p3 = findCard((c) => c.kind === 'number' && c.rank === 3 && c.color === 'plain');
  const p4 = findCard((c) => c.kind === 'number' && c.rank === 4 && c.color === 'plain');
  const lightE = findCard((c) => c.kind === 'e' && c.color === 'light');

  const base = API.newState(API.createGame({ seed: 20240701 }));
  const common = {
    ...base,
    bases: [
      [{ ...p3, id: 'inj-b0' }, { ...p1, id: 'inj-t0' }],
      [{ ...p2, id: 'inj-b1' }],
      [{ ...p4, id: 'inj-b2' }],
    ],
    hands: [[{ ...p2, id: 'mine-1' }], [{ ...p1, id: 'opp-1' }]],
    deck: [{ ...p3, id: 'deck-1' }],
    createdCards: [],
    current: 0,
    turn: 6,
    draft: null,
    pendingChoice: null,
    forbiddenColumn: 2,
    result: { over: false, winner: null, reason: null },
  };

  // 1) 爆弹：对手刚放了 E，横幅要说清"数字牌只能放这一列，E/M 不受限"
  API.__uiInject({
    ...common,
    skills: [null, 'baodan'],
    // 限制现在按玩家分槽：这条挂在 0 号位（人类）身上，且已生效
    restrictions: [[{
      kind: 'baodan-lock', label: '爆弹', allowedColumns: [0], forbiddenColumns: null,
      digitsOnly: false, forbidDigitOnCardId: null, exemptKinds: ['m'], forbidKinds: null,
      setBy: 1, applyTo: 0, ready: true,
    }], []],
  });
  page.clock.settle();
  const banner = page.el('actText').textContent;
  ok(banner.includes('爆弹'), `横幅写明是爆弹限制（实际：${banner}）`);
  ok(banner.includes('第 1 列'), '横幅写明只能放那一列');
  ok(banner.includes('M 不受此限'), '横幅写明只有 M 不受这条限制（E 已不豁免）');
  ok(!banner.includes('E/M 不受'), '横幅不再写"E/M 不受"');

  // 2) 沉默：横幅要说清"不能放 E/M"
  API.__uiInject({
    ...common,
    skills: [null, 'chenmo'],
    restrictions: [[{
      kind: 'silence', label: '沉默', allowedColumns: null, forbiddenColumns: null,
      digitsOnly: false, forbidDigitOnCardId: null, exemptKinds: null, forbidKinds: ['e', 'm'],
      setBy: 1, applyTo: 0, ready: true,
    }], []],
  });
  page.clock.settle();
  const silenceBanner = page.el('actText').textContent;
  ok(silenceBanner.includes('沉默'), `横幅写明是沉默（实际：${silenceBanner}）`);
  ok(silenceBanner.includes('不能放 E/M'), '横幅写明本回合不能放 E/M');

  // 2b) 多条限制同时压在一个人身上时，横幅要把两条都写出来
  API.__uiInject({
    ...common,
    skills: [null, 'chenmo'],
    restrictions: [[
      {
        kind: 'skill-jingji', label: '荆棘', allowedColumns: null, forbiddenColumns: null,
        digitsOnly: false, forbidDigitOnCardId: 'inj-t0', exemptKinds: null, forbidKinds: null,
        setBy: 1, applyTo: 0, ready: true,
      },
      {
        kind: 'silence', label: '沉默', allowedColumns: null, forbiddenColumns: null,
        digitsOnly: false, forbidDigitOnCardId: null, exemptKinds: null, forbidKinds: ['e', 'm'],
        setBy: 1, applyTo: 0, ready: true,
      },
    ], []],
  });
  page.clock.settle();
  const bothBanner = page.el('actText').textContent;
  ok(bothBanner.includes('荆棘') && bothBanner.includes('沉默'), `两条限制同时显示（实际：${bothBanner}）`);

  // 3) 沉默下，手里的 E 点不动，数字牌照常能出
  API.__uiInject({
    ...common,
    hands: [[{ ...lightE, id: 'mine-e' }, { ...p2, id: 'mine-2' }], [{ ...p1, id: 'opp-1' }]],
    skills: [null, 'chenmo'],
    restrictions: [[{
      kind: 'silence', label: '沉默', allowedColumns: null, forbiddenColumns: null,
      digitsOnly: false, forbidDigitOnCardId: null, exemptKinds: null, forbidKinds: ['e', 'm'],
      setBy: 1, applyTo: 0, ready: true,
    }], []],
  });
  page.clock.settle();
  const eNode = page.document.querySelectorAll('#myHand .card').find((c) => /E/.test(c.textContent));
  ok(Boolean(eNode), '手牌里能看到 E');
  ok(eNode && eNode.classList.contains('blocked'), '沉默下界面把 E 标成"放不了"');
  const dNode = page.document.querySelectorAll('#myHand .card').find((c) => !/E/.test(c.textContent));
  ok(dNode && !dNode.classList.contains('blocked'), '沉默下数字牌照常能出');

  // 4) 创生：技能面板给出 0-5 六个按钮，点一下牌就进对方手里
  API.__uiInject({ ...common, skills: ['chuangsheng', null], restriction: null });
  page.clock.settle();
  const csButtons = page.document.querySelectorAll('#skillBox .skill-actions button');
  eq(csButtons.length, 6, '创生在技能面板给出 6 个按钮（0-5 各一个）');
  const labels = csButtons.map((b) => b.textContent);
  ok(labels.every((t) => /创生/.test(t)), '每个按钮都写明是创生');
  for (let rank = 0; rank <= 5; rank++) {
    ok(labels.some((t) => t.includes(String(rank))), `按钮里能看到数字 ${rank}`);
  }
  const oppBefore = page.state().hands[1].length;
  const turnBefore = page.state().turn;
  csButtons[0].click();
  page.clock.settle();
  const afterCs = page.state();
  eq(afterCs.hands[1].length, oppBefore + 1, '点一下就往对方手里加了一张牌');
  eq(afterCs.createdCards.length, 1, '界面这条路也走 createdCards 登记');
  // 创生占用行动：发动方让出回合（时钟会把 AI 那一步也走掉，所以只断言"回合确实前进过"）
  ok(afterCs.turn > turnBefore, '创生占用行动（回合确实推进了）');
}

// ---------------------------------------------------------------------------
startGroup('威严：发动中 / 已失效的专属提示');
{
  const page = createPage(html);
  setMode(page, '人机对战');
  startGame(page);
  handleSetup(page);

  const API = page.window.BaiFan;
  const deck = API.createDeck();
  const findCard = (pred) => deck.find(pred) ?? null;
  const p1 = findCard((c) => c.kind === 'number' && c.rank === 1 && c.color === 'plain');
  const p2 = findCard((c) => c.kind === 'number' && c.rank === 2 && c.color === 'plain');
  const p3 = findCard((c) => c.kind === 'number' && c.rank === 3 && c.color === 'plain');
  const lightE = findCard((c) => c.kind === 'e' && c.color === 'light');

  const base = API.newState(API.createGame({ seed: 20240715 }));
  const common = {
    ...base,
    bases: [[{ ...p3, id: 'inj-b0' }, { ...p1, id: 'inj-t0' }], [{ ...p2, id: 'inj-b1' }], [{ ...p2, id: 'inj-b2' }]],
    hands: [[{ ...lightE, id: 'mine-e' }, { ...p2, id: 'mine-2' }], [{ ...p1, id: 'opp-1' }]],
    deck: [{ ...p3, id: 'deck-1' }],
    createdCards: [],
    current: 0,
    turn: 6,
    draft: null,
    pendingChoice: null,
    forbiddenColumn: 2,
    restrictions: [[], []],
    result: { over: false, winner: null, reason: null },
  };

  // 1) AI 持有威严、还没放过 E/M → 状态条写明"发动中"，并指出是谁被限制
  API.__uiInject({ ...common, skills: [null, 'weiyan'], emPlaced: [0, 0] });
  page.clock.settle();
  const live = page.document.querySelectorAll('#skillBox .skill-state');
  eq(live.length, 1, '技能面板出现威严的状态条');
  ok(live[0].textContent.includes('发动中'), `状态条写明"发动中"（实际：${live[0].textContent}）`);
  ok(live[0].textContent.includes('E/M'), '状态条写明禁的是 E/M');
  ok(live[0].classList.contains('on'), '状态条使用"生效中"样式');

  // 2) 界面上 AI 的 E 是灰的，点它会给出"威严"这个原因
  const eNode = page.document.querySelectorAll('#myHand .card').find((c) => /E/.test(c.textContent));
  ok(Boolean(eNode), '手牌里能看到 E');
  ok(eNode && eNode.classList.contains('blocked'), '威严生效时界面把 E 标成"放不了"');
  if (eNode) {
    eNode.click();
    page.clock.settle();
    const status = page.el('statusLine').textContent;
    ok(status.includes('威严'), `点放不了的 E 会说明是威严（实际：${status}）`);
  }

  // 3) 数字牌不受影响
  const dNode = page.document.querySelectorAll('#myHand .card').find((c) => !/E/.test(c.textContent));
  ok(dNode && !dNode.classList.contains('blocked'), '威严不影响数字牌');

  // 4) AI 放过 E/M 之后 → 状态条变成"已失效"，E 也恢复可放
  API.__uiInject({ ...common, skills: [null, 'weiyan'], emPlaced: [0, 1] });
  page.clock.settle();
  const dead = page.document.querySelectorAll('#skillBox .skill-state');
  eq(dead.length, 1, '失效后状态条仍在（变成已失效）');
  ok(dead[0].textContent.includes('已失效'), `状态条写明"已失效"（实际：${dead[0].textContent}）`);
  ok(dead[0].classList.contains('off'), '状态条使用"失效"样式');
  const eNode2 = page.document.querySelectorAll('#myHand .card').find((c) => /E/.test(c.textContent));
  ok(eNode2 && !eNode2.classList.contains('blocked'), '威严失效后 E 恢复可放');

  // 5) 持有者是自己时，状态条同样显示（提醒自己"我也不能放 E/M"）
  API.__uiInject({ ...common, skills: ['weiyan', null], emPlaced: [0, 0] });
  page.clock.settle();
  const own = page.document.querySelectorAll('#skillBox .skill-state');
  eq(own.length, 1, '自己持有威严时也显示状态条');
  ok(own[0].textContent.includes('发动中'), '自己的威严同样标注发动中');
  const eNode3 = page.document.querySelectorAll('#myHand .card').find((c) => /E/.test(c.textContent));
  ok(eNode3 && !eNode3.classList.contains('blocked'), '持有者自己不受自己的威严限制（E 仍可放）');
}

// ---------------------------------------------------------------------------
startGroup('限制横幅');
{
  // 多开几局，收集"横幅显示过哪些状态"，覆盖不同开局
  const seenClasses = new Set();
  const seenTexts = new Set();
  let sawBanBanner = false;
  let sawMagicBanner = false;
  let sawLockBanner = false;
  let sawForcedBanner = false;

  for (let round = 0; round < 12; round++) {
    const page = createPage(html);
    startGame(page);
    handleSetup(page);
    const actBar = page.el('actBar');
    const actText = page.el('actText');

    // 记录开局瞬间的横幅
    if (!actBar.hidden) {
      seenClasses.add(actBar.className);
      seenTexts.add(actText.textContent);
      if (actBar.classList.contains('ban')) sawBanBanner = true;
      if (actBar.classList.contains('magic')) sawMagicBanner = true;
    }

    // 再打一会儿，看看其它状态的横幅
    for (let i = 0; i < 250 && !isResultModal(page); i++) {
      if (!actBar.hidden) {
        seenClasses.add(actBar.className);
        seenTexts.add(actText.textContent);
        if (actBar.classList.contains('lock')) sawLockBanner = true;
        if (actBar.classList.contains('forced')) sawForcedBanner = true;
        if (actBar.classList.contains('ban')) sawBanBanner = true;
        if (actBar.classList.contains('magic')) sawMagicBanner = true;
      }
      if (!playOneMove(page)) break;
    }
  }

  ok(seenClasses.size >= 2, `横幅按状态切换过多种样式（${[...seenClasses].join(' ｜ ')}）`);
  ok(
    sawBanBanner || sawMagicBanner,
    `开局阶段出现过限制横幅（${[...seenTexts].slice(0, 2).join(' ／ ')}）`,
  );
  // 至少见过一种"强限制"（紫色限锁或蓝色魔法）才说明优先级提示真的在工作
  ok(sawLockBanner || sawMagicBanner, '过程中出现过紫 0 限锁或魔法限制的醒目提示');
  void sawForcedBanner;
}

// ---------------------------------------------------------------------------
startGroup('技能发动与选牌界面');
{
  // 多开几局，尽量碰到"人类持有主动技"与"出现选牌请求"两种情况
  let sawSkillButton = false;
  let sawChoiceBar = false;
  let choiceHandled = false;

  for (let round = 0; round < 30 && !(sawSkillButton && sawChoiceBar && choiceHandled); round++) {
    const page = createPage(html);
    startGame(page);
    // 选技时优先挑主动技，保证能测到"发动按钮"
    let pickedActive = false;
    for (let i = 0; i < 40; i++) {
      const banBar = page.el('banBar');
      if (banBar.hidden) {
        page.clock.settle();
        if (banBar.hidden) break;
        continue;
      }
      const title = banBar.querySelector('.ban-title').textContent;
      const buttons = [...page.el('banRow').children];
      if (buttons.length === 0) {
        page.clock.settle();
        continue;
      }
      if (title.includes('技能') && !pickedActive) {
        const active = buttons.find((b) => (b.getAttribute('title') ?? '').includes('占用行动'));
        (active ?? buttons[0]).click();
        pickedActive = true;
      } else {
        buttons[0].click();
      }
      page.clock.settle();
    }

    // 打一段，期间观察技能按钮与选牌条
    for (let i = 0; i < 300 && !isResultModal(page); i++) {
      const state = page.state();
      if (!state) break;

      if (state.pendingChoice && state.pendingChoice.player === 0) {
        const bar = page.el('choiceBar');
        if (!bar.hidden) {
          sawChoiceBar = true;
          const title = page.el('choiceTitle').textContent;
          if (title.includes('已选')) choiceHandled = true;
        }
      }

      const row = page.el('skillBox');
      if (row && row.querySelectorAll('.skill-actions .btn').length > 0) {
        sawSkillButton = true;
        // 真的点一次发动按钮，确认不报错
        const button = row.querySelectorAll('.skill-actions .btn')[0];
        const before = page.errors.length;
        button.click();
        page.clock.settle();
        ok(page.errors.length === before, '点击发动技能不会产生脚本错误');
        break;
      }

      if (!playOneMove(page)) {
        page.clock.settle();
        if (!playOneMove(page)) break;
      }
    }
  }

  ok(sawSkillButton, '轮到玩家且技能可用时，技能面板出现发动按钮');

  // 选牌条是随机对局里的小概率事件（要看当轮候选里正好有观星/汇流），
  // 所以这里用测试钩子把"正在选牌"的局面确定性地塞进来。
  {
    const page = createPage(html);
    setMode(page, '人机对战');
    startGame(page);
    handleSetup(page);
    const API = page.window.BaiFan;
    const hand = API.createDeck().slice(0, 3).map((c, i) => ({ ...c, id: `pick-${i}` }));
    const base = API.newState(API.createGame({ seed: 778899 }));
    API.__uiInject({
      ...base,
      bases: [hand.map((c) => ({ ...c })), [], []],
      hands: [hand.map((c) => ({ ...c })), []],
      deck: [],
      current: 0,
      turn: 5,
      draft: null,
      forbiddenColumn: 1,
      restriction: null,
      skills: ['guanxing', null],
      pendingChoice: {
        player: 0,
        kind: 'returnToDeck',
        count: 3,
        picked: [],
        phase: 'opening',
        ready: false,
        note: '观星：选择 3 张手牌放回抽牌堆',
      },
      result: { over: false, winner: null, reason: null },
    });
    page.clock.settle();
    const bar = page.el('choiceBar');
    ok(!bar.hidden, '有待选牌时选牌提示条可见');
    ok(page.el('choiceTitle').textContent.includes('已选'), '提示条写明已选进度');
    ok(page.el('choiceTitle').textContent.includes('0 / 3'), '提示条显示 0 / 3');
  }
}

// ---------------------------------------------------------------------------
startGroup('汇流选牌：只有刚抽到的牌可交（界面）');
{
  const page = createPage(html);
  setMode(page, '人机对战');
  startGame(page);
  handleSetup(page);

  const API = page.window.BaiFan;
  const deck = API.createDeck();
  const p1 = deck.find((c) => c.kind === 'number' && c.rank === 1 && c.color === 'plain');
  const p2 = deck.find((c) => c.kind === 'number' && c.rank === 2 && c.color === 'plain');
  const p3 = deck.find((c) => c.kind === 'number' && c.rank === 3 && c.color === 'plain');
  const p4 = deck.find((c) => c.kind === 'number' && c.rank === 4 && c.color === 'plain');

  // 手里 4 张：前 1 张是旧牌（不可交），后 3 张是"刚抽到的"（可交）
  const oldCard = { ...p1, id: 'old-1' };
  const fresh = [{ ...p2, id: 'new-1' }, { ...p3, id: 'new-2' }, { ...p4, id: 'new-3' }];
  const base = API.newState(API.createGame({ seed: 551122 }));
  const state = {
    ...base,
    bases: [[{ ...p1, id: 'b0' }, { ...p2, id: 't0' }], [{ ...p3, id: 'b1' }], [{ ...p4, id: 'b2' }]],
    hands: [[oldCard, ...fresh], [{ ...p1, id: 'opp-1' }]],
    deck: [],
    createdCards: [],
    current: 0,
    turn: 5,
    draft: null,
    forbiddenColumn: 1,
    restrictions: [[], []],
    skills: ['huiliu', null],
    pendingChoice: {
      player: 0,
      kind: 'giveToOpponent',
      count: 1,
      picked: [],
      candidateIds: fresh.map((c) => c.id),
      ready: false,
      note: '汇流：从刚抽到的 3 张里选 1 张交给对手',
    },
    result: { over: false, winner: null, reason: null },
  };
  API.__uiInject(state);
  page.clock.settle();

  const cards = page.document.querySelectorAll('#myHand .card');
  eq(cards.length, 4, '手牌里看到 4 张');
  const pickable = cards.filter((c) => c.classList.contains('pickable'));
  const dimmed = cards.filter((c) => c.classList.contains('out-of-pool'));
  eq(pickable.length, 3, '刚抽到的 3 张高亮为可交');
  eq(dimmed.length, 1, '旧牌低亮（不可交）');
  ok(dimmed.every((c) => c.classList.contains('blocked')), '低亮的牌同时带 blocked 样式（和出不了的牌一致）');
  ok(
    pickable.every((c) => fresh.some((f) => c.textContent.includes(API.cardName(f)))),
    '高亮的正是那 3 张新牌',
  );

  // 说明文本要说清"只有高亮的能选"
  const title = page.el('choiceTitle').textContent;
  ok(title.includes('从刚抽到的 3 张里选 1 张'), `提示条写明规则（实际：${title}）`);
  ok(title.includes('只有高亮的这几张能选'), '提示条说明只有高亮的能选');
  ok(title.includes('其余牌这一手不能交出去'), '提示条说明其余牌不能交');

  // 点旧牌：给的是"只能交高亮的"这类提示，而不是含糊的"已经选过了"
  const oldNode = cards.find((c) => c.classList.contains('out-of-pool'));
  oldNode.click();
  page.clock.settle();
  const status = page.el('statusLine').textContent;
  ok(!status.includes('已经选过了'), `点旧牌不会再说"已经选过了"（实际：${status}）`);
  ok(status.includes('只能交出高亮的那几张牌'), `点旧牌说明正确原因（实际：${status}）`);

  // 点新牌：正常被选中
  pickable[0].click();
  page.clock.settle();
  const afterPick = page.state();
  eq(afterPick.pendingChoice, null, '选完 1 张后选牌结束');
  eq(afterPick.hands[1].length, 2, '对手拿到了交出去的那张');
  eq(afterPick.hands[0].length, 3, '自己少了一张');
}

// ---------------------------------------------------------------------------
startGroup('完整对局');
{
  let finished = 0;
  let draws = 0;
  for (let round = 0; round < 3; round++) {
    const page = createPage(html);
    startGame(page);
    handleSetup(page);

    let moves = 0;
    while (moves < 900 && !isResultModal(page)) {
      advanceAi(page);
      if (!playOneMove(page)) {
        // 既不能操作、AI 也没动：给时钟一次机会再试
        page.clock.settle();
        if (!playOneMove(page)) break;
      }
      moves += 1;
    }
    if (isResultModal(page)) {
      finished += 1;
      const heading = page.document.querySelector('#modalBody h2').textContent;
      if (heading.includes('平局')) draws += 1;
      ok(page.errors.length === 0, `第 ${round + 1} 局过程中无脚本错误${page.errors.length ? '：' + page.errors.join(' / ') : ''}`);
      // 结算界面必须能重新开局
      const again = page.el('btnAgain');
      ok(Boolean(again), '结算界面有"再来一局"按钮');
    } else {
      // 没打完：把现场打出来，便于定位卡在哪
      const st = page.state();
      const dbg = page.window.BaiFan.__uiDebug ? page.window.BaiFan.__uiDebug() : null;
      console.log(`  [调试] 第 ${round + 1} 局未打完：moves=${moves} 状态=${JSON.stringify({ turn: st.turn, current: st.current, draft: Boolean(st.draft), pending: st.pendingChoice && st.pendingChoice.kind, ban: st.forbiddenColumn })}`);
      console.log(`         界面=${JSON.stringify(dbg)}`);
    }
  }
  eq(finished, 3, '3 局全部自动打完并出现结算界面');
  void draws;
}

// ---------------------------------------------------------------------------
startGroup('hidden 属性不会被 CSS 盖掉');
{
  // 这是本次修的真实 bug：.ban-bar { display: flex } 会盖过浏览器默认的 [hidden]
  ok(html.includes('[hidden] { display: none !important; }'), '样式中显式保证 hidden 生效');

  const page = createPage(html);
  const banBar = page.el('banBar');
  banBar.hidden = true;
  ok(banBar.hidden === true, 'hidden = true 时属性存在');
  banBar.hidden = false;
  ok(banBar.hidden === false, 'hidden = false 时属性被移除');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length === 0) {
  console.log(`✅ 界面测试全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const failure of failures.slice(0, 30)) console.log('  - ' + failure);
  process.exit(1);
}
