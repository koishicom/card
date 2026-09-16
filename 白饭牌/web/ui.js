// ===========================================================================
// UI 层：只负责渲染与交互，所有规则判断都来自引擎
// ===========================================================================

const HUMAN = 0;
const el = (id) => document.getElementById(id);

/**
 * 对局模式。
 *   'ai'    人机对战：玩家控制 0 号位，AI 控制 1 号位
 *   'duo'   双人同机：两个座位都由人操作（本地轮流）
 *   'demo'  AI 自动演示：两个座位都由 AI 操作，纯观战
 */
const PLAY_MODES = {
  ai: { id: 'ai', label: '人机对战', desc: '你操作先手座（玩家 1），AI 操作另一个座位' },
  duo: { id: 'duo', label: '双人同机', desc: '两个座位都由人操作，本地轮流；视角固定为玩家 1' },
  demo: { id: 'demo', label: 'AI 自动演示', desc: '两边都由 AI 操作，纯观战，用于观察技能与 AI 表现' },
};

const ui = {
  state: null,
  ai: BUILTIN_PROFILES.normal,
  rng: createSeededRng('ui-' + Date.now()),
  selectedCard: null,
  selectedCol: null,
  coachCache: null,
  busy: false,
  log: [],
  // 是否需要人类选择禁列（后手时）
  awaitingBan: false,
  // 对局模式：默认人机对战
  playMode: 'ai',
  /**
   * 看破的一次性快照：{ viewer, target, turn, cards:[...] }。
   * 只是"当场看一眼"——发动之后一旦进行到下一步（不管是谁走的），就清空。
   */
  reveal: null,
};

/** 该座位是否由人操作。 */
function isHumanSeat(player) {
  if (ui.playMode === 'demo') return false;
  if (ui.playMode === 'duo') return true;
  if (ui.playMode === 'ai') return player === HUMAN;
  return player === HUMAN;
}

// 把界面内部状态暴露给自动化测试与浏览器控制台（只读用途）
if (window.BaiFan) {
  window.BaiFan.__uiDebug = () => ({
    playMode: ui.playMode,
    awaitingBan: ui.awaitingBan,
    busy: ui.busy,
    current: ui.state ? ui.state.current : null,
    lastPlayer: ui.state ? ui.state.lastPlayer : null,
    firstPlayer: ui.state ? ui.state.firstPlayer : null,
    forbiddenColumn: ui.state ? ui.state.forbiddenColumn : null,
    humanActor: humanActor(),
    humanSeat0: isHumanSeat(0),
    humanSeat1: isHumanSeat(1),
    handLabels: [ui.state ? ui.state.hands[0].length : null, ui.state ? ui.state.hands[1].length : null],
  });
}

/**
 * 着法追踪（默认开启，供排查"谁替我出了牌"这类问题）。
 * 浏览器控制台执行 BaiFan.uiTrace() 可看最近 200 手。
 */
if (window.BaiFan) {
  window.BaiFan.__uiTrace = [];
  window.BaiFan.uiTrace = () => window.BaiFan.__uiTrace.slice();
}

/**
 * 状态转移监控：把引擎返回的每个新状态都记一笔（带调用栈）。
 * 用它来回答"这一步到底是谁推进的"——包括遗留定时器、递归 afterStep 等所有来源。
 */
let lastSeenState = null;
function watchState(state, via) {
  if (!state || state === lastSeenState) return;
  const prev = lastSeenState;
  lastSeenState = state;
  const api = window.BaiFan;
  if (api && Array.isArray(api.__uiTrace)) {
    api.__uiTrace.push({
      via,
      turn: prev ? prev.turn : null,
      nextTurn: state.turn,
      current: state.current,
      draft: Boolean(state.draft),
      pending: state.pendingChoice ? state.pendingChoice.kind : null,
      ban: state.forbiddenColumn,
      over: state.result.over,
      stack: String(new Error().stack).split('\n').slice(2, 6).map((s) => s.trim()),
    });
    if (api.__uiTrace.length > 300) api.__uiTrace.shift();
  }
}

/** 当前是否应该由"人"来行动（选技/选牌/正常回合都算）。 */
function humanActor() {
  const s = ui.state;
  if (!s || s.result.over) return null;
  if (s.draft) {
    const picker = waitingFor(s);
    return picker !== null && isHumanSeat(picker) ? picker : null;
  }
  if (s.pendingChoice) {
    return isHumanSeat(s.pendingChoice.player) ? s.pendingChoice.player : null;
  }
  return isHumanSeat(s.current) ? s.current : null;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function render() {
  const s = ui.state;
  // 只在一次渲染里算一遍合法着法，保证牌桌高亮与手牌灰显永远一致
  const moves = computeMoves();
  renderBoard(s, moves);
  renderHand(s, moves);
  renderReveal(s);
  renderSide(s);
  renderHeader(s);
}

/**
 * 看破：把"当场看到的那一眼"显示给发动者。
 *
 * 这是一次性快照，绑在**当时那个回合**上：快照里记了 turn，
 * 一旦回合前进（自己出牌换了手、或对手行动）面板立刻消失，
 * 所以不会变成"持续透视"。对方之后摸到的牌、以及此刻之后的变化都不在快照里。
 */
function renderReveal(s) {
  const box = el('revealBox');
  const snap = ui.reveal;
  const stale = !snap || snap.turn !== s.turn || s.result.over;
  if (stale || snap.viewer !== viewSeat()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  const title = document.createElement('span');
  title.className = 'reveal-title';
  title.textContent = `看破（本回合看到的）：${seatName(snap.target)}当时的手牌`;
  box.appendChild(title);
  for (const card of snap.cards) {
    const chip = document.createElement('span');
    chip.className = 'reveal-card';
    chip.textContent = cardName(card);
    chip.title = cardBlurb(card);
    box.appendChild(chip);
  }
  const note = document.createElement('span');
  note.className = 'reveal-note';
  note.textContent = '（只看这一眼，之后的变化不再可知）';
  box.appendChild(note);
}

function cardEl(card, size = '') {
  const node = document.createElement('div');
  node.className = `card ${size} theme-${cardTheme(card)}`;
  const rank = cardName(card);
  node.innerHTML = `<span class="pip">${isDigit(card) ? '' : ''}</span><span class="rank">${rank}</span><span class="kind">${isBomb(card) ? '炸弹' : isMagic(card) ? '魔法' : isBlackFive(card) ? '黑' : isPurpleZero(card) ? '紫' : '数字'}</span>`;
  node.title = `${cardName(card)}：${cardBlurb(card)}`;
  return node;
}

/**
 * 把一条"下回合限制"翻译成人话。
 * 泛化处理 M 魔法 / 禁锢 / 荆棘 / 爆弹 / 沉默 等所有同类限制。
 * @param {object} restriction
 * @param {boolean} forMe 是否针对人类玩家（影响措辞）
 */
function describeRestriction(restriction, forMe) {
  if (!restriction || !restriction.kind) return '';
  const label = restriction.label ?? '限制';
  const who = forMe ? '你' : '对手';
  const parts = [];
  if (restriction.allowedColumns) {
    parts.push(`只能放第 ${restriction.allowedColumns.map((c) => c + 1).join('、')} 列`);
  }
  if (restriction.forbiddenColumns) {
    parts.push(`不能放第 ${restriction.forbiddenColumns.map((c) => c + 1).join('、')} 列`);
  }
  if (restriction.digitsOnly) parts.push('只能放数字牌');
  if (restriction.forbidKinds?.length) parts.push('不能放 E/M');
  if (restriction.forbidSkills) parts.push('不能使用主动技能');
  if (restriction.forbidDigitOnCardId) parts.push('不能压在刚放下的那张数字牌上');
  const exempt = restriction.exemptKinds?.length
    ? `（${restriction.exemptKinds.map((k) => (k === 'e' ? 'E' : 'M')).join('/')} 不受此限）`
    : '';
  return `${label}：本回合${who}${parts.join('，')}。${exempt}`;
}

/** 某座位的称呼。 */
function seatName(player) {
  if (ui.playMode === 'duo') return `玩家 ${player + 1}`;
  return player === HUMAN ? '你' : 'AI';
}

function renderHeader(s) {
  const turnBadge = el('turnBadge');
  if (s.result.over) {
    turnBadge.className = 'badge';
    const winner = s.result.winner;
    turnBadge.textContent = winner === null
      ? '平局'
      : ui.playMode === 'demo'
        ? `${seatName(winner)}获胜`
        : (isHumanSeat(winner) ? `${seatName(winner)}赢了` : `${seatName(winner)}赢了`);
    turnBadge.style.background = winner === null
      ? 'var(--muted)'
      : (isHumanSeat(winner) ? 'var(--ok)' : 'var(--danger)');
    turnBadge.style.color = '#0d1117';
  } else {
    turnBadge.className = 'badge turn';
    turnBadge.style = '';
    const actor = humanActor();
    if (actor !== null) {
      turnBadge.textContent = ui.playMode === 'duo' ? `轮到玩家 ${actor + 1}` : '轮到你了';
    } else if (s.draft) {
      turnBadge.textContent = `${seatName(waitingFor(s) ?? s.current)} 选技能中…`;
    } else {
      turnBadge.textContent = ui.playMode === 'demo' ? 'AI 演示中…' : 'AI 思考中…';
    }
  }
  const lock = hasPurpleLock(s);
  const lockBadge = el('lockBadge');
  lockBadge.hidden = !lock;
  const magic = el('magicBadge');
  // 限制可能是多条（每人一个独立槽，且可叠加），全部列出来
  const mine = restrictionsOn(s, s.current);
  if (mine.length > 0 && !s.result.over) {
    magic.hidden = false;
    magic.textContent = mine.map((r) => describeRestriction(r, isHumanSeat(s.current))).join(' ').replace(/。$/, '');
  } else {
    magic.hidden = true;
  }
  renderActBar(s);
}

/**
 * 某个玩家身上当前生效的全部限制。
 * 限制自「每人一个独立槽」重构后可能有多条（例如同时被荆棘粘住 + 被沉默）。
 */
function restrictionsOn(state, player) {
  const api = window.BaiFan;
  if (api && typeof api.activeRestrictions === 'function') return api.activeRestrictions(state, player);
  return [];
}

/**
 * 把"当前生效的限制"做成手牌上方一条显眼的横幅。
 * 优先级：紫 0 全局限锁 > 针对当前玩家的下回合限制 > 开局禁列 > 无牌可放。
 */
function renderActBar(s) {
  const bar = el('actBar');
  const text = el('actText');
  bar.className = 'act-bar';
  bar.hidden = false;

  if (ui.awaitingBan) {
    bar.classList.add('ban');
    text.textContent = `开局：${seatName(s.lastPlayer)}是后手，请先指定对方第一手不能放的那一列（选项在下方）。`;
    return;
  }

  if (s.draft) {
    bar.classList.add('ban');
    text.textContent = humanActor() !== null
      ? '选技阶段：从下方 3 个候选技能里选 1 个。'
      : `选技阶段：${seatName(waitingFor(s) ?? s.current)} 正在选技能…`;
    return;
  }

  if (s.pendingChoice) {
    bar.classList.add('forced');
    text.textContent = humanActor() !== null
      ? `${s.pendingChoice.note ?? '请选择手牌'}（直接点手牌）`
      : `${seatName(s.pendingChoice.player)} 正在选牌：${s.pendingChoice.note ?? ''}`;
    return;
  }

  if (hasPurpleLock(s)) {
    bar.classList.add('lock');
    const suffix = humanActor() !== null ? '本回合你只能出数字牌，E / M 都不能用。' : '当前双方都只能出数字牌。';
    text.textContent = `紫 0 限锁生效：场上有一列顶端是紫 0，${suffix}`;
    return;
  }

  const active = restrictionsOn(s, s.current);
  if (active.length > 0 && !s.result.over) {
    bar.classList.add('magic');
    text.textContent = active.map((r) => describeRestriction(r, true)).join(' ');
    return;
  }

  const banApplies = s.forbiddenColumn !== null && s.turn === 1 && s.current === s.firstPlayer && !s.result.over;
  if (banApplies) {
    bar.classList.add('ban');
    text.textContent = isHumanSeat(s.current)
      ? `开局禁列：${seatName(s.current)}的第一手不能放第 ${s.forbiddenColumn + 1} 列（之后不再受限）。`
      : `开局禁列：${seatName(s.current)}的第一手不能放第 ${s.forbiddenColumn + 1} 列。`;
    return;
  }

  if (!s.result.over && humanActor() !== null && currentLegalPlacements().length === 0) {
    bar.classList.add('forced');
    text.textContent = '当前没有合法放置，只能过牌（自己抽 2 张、对方抽 1 张）。';
    return;
  }

  bar.hidden = true;
}

/**
 * 当前可选的手牌 + 每张牌各自能放的列。
 *
 * 关键：列的"可放"高亮必须针对某一张具体的牌，否则会出现
 * "这张牌是亮的、这一列也是绿的，但两者组合非法"的误导，
 * 玩家点了却没有任何反应。
 */
function computeMoves() {
  const s = ui.state;
  const byCard = new Map(); // cardId -> Set(col)
  const actor = humanActor();
  if (!s || s.result.over || actor === null) return byCard;
  // 只有轮到自己能放牌时才计算（选技 / 选牌阶段不算）
  if (s.draft || s.pendingChoice || s.current !== actor) return byCard;
  // 用 playerActions：它才是引擎认可的合法着法集合（含主动技与各类技能例外）
  for (const action of playerActions(s, actor)) {
    if (action.type !== 'place') continue;
    const set = byCard.get(action.card.id) ?? new Set();
    set.add(action.col);
    byCard.set(action.card.id, set);
  }
  return byCard;
}

/** 当前列高亮：选中了牌就只亮这张牌的合法列，否则亮所有可放列。 */
function legalColumnsForHighlight(moves) {
  if (ui.selectedCard && moves.has(ui.selectedCard)) return moves.get(ui.selectedCard);
  const all = new Set();
  for (const set of moves.values()) for (const col of set) all.add(col);
  return all;
}

function renderBoard(s, moves) {
  const grid = el('boardGrid');
  grid.innerHTML = '';
  const legalCols = legalColumnsForHighlight(moves ?? computeMoves());
  const selectedSet = ui.selectedCard && (moves ?? computeMoves()).has(ui.selectedCard)
    ? (moves ?? computeMoves()).get(ui.selectedCard)
    : null;

  for (let col = 0; col < s.bases.length; col++) {
    const column = document.createElement('div');
    const isBanned = s.forbiddenColumn === col && s.turn === 1 && s.current === s.firstPlayer;
    const isHighlighted = legalCols.has(col);
    const isBlockedForSelected = selectedSet !== null && !selectedSet.has(col);
    column.className = [
      'column',
      ui.selectedCol === col ? 'selected' : '',
      isHighlighted && isHumanTurn() ? 'legal' : '',
      isBlockedForSelected && isHumanTurn() ? 'not-for-selected' : '',
      isBanned ? 'banned' : '',
    ].join(' ');

    const top = s.bases[col][s.bases[col].length - 1] ?? null;
    const head = document.createElement('div');
    head.className = 'column-head';
    head.innerHTML = `<b>第 ${col + 1} 列</b><span>${isBanned ? '先手禁列' : top ? `顶端 ${cardName(top)}` : '空'}</span>`;
    column.appendChild(head);

    // 只显示顶端那一条规则，避免挤压牌堆
    if (top) {
      const hint = document.createElement('div');
      hint.className = 'stack-hint';
      hint.textContent = isBanned ? '先手第一手不能放这里' : cardBlurb(top);
      column.appendChild(hint);
    }

    const stack = document.createElement('div');
    if (s.bases[col].length === 0) {
      stack.className = 'empty-slot';
      stack.textContent = '空列';
      column.appendChild(stack);
    } else {
      column.appendChild(fannedStack(s.bases[col], col));
    }

    // 点列本身 = 选这一列放牌（仅轮到我且该列可放时）
    if (isHumanTurn()) {
      column.classList.add('clickable');
      column.onclick = () => onColumnClick(col);
    }
    grid.appendChild(column);
  }
}

/**
 * 叠放用的牌条：横向显示"点数 + 类型"，高度固定 54px，
 * 配合负 margin 就能实现"只露出牌头"的叠放效果。
 */
function cardStrip(card, isTop) {
  const node = document.createElement('div');
  node.className = `card-strip theme-${cardTheme(card)}${isTop ? ' is-top' : ''}`;

  const rank = document.createElement('span');
  rank.className = 'strip-rank';
  rank.textContent = cardName(card);

  const kind = document.createElement('span');
  kind.className = 'strip-kind';
  kind.textContent = isDigit(card) ? '' : isBomb(card) ? '炸弹' : '魔法';

  node.append(rank, kind);
  node.title = `${cardName(card)}：${cardBlurb(card)}`;
  return node;
}

/**
 * 把一列牌画成"只露出牌头"的叠放：越往上的牌越靠下、盖住下面那张，
 * 因此每张牌的牌头都露在外面，最顶端的牌完整可见。点整摞打开详情。
 * @param {Array} stack 自下而上的牌
 * @param {number} col
 */
function fannedStack(stack, col) {
  const wrap = document.createElement('div');
  wrap.className = 'fanned';
  wrap.title = `点击查看第 ${col + 1} 列的全部 ${stack.length} 张牌`;

  // 每张牌露出的高度：牌少露得多，牌多自动收紧，避免撑爆布局。
  const stripHeight = 54;
  const peek = stack.length <= 3 ? 30 : stack.length <= 6 ? 24 : stack.length <= 10 ? 19 : 15;

  stack.forEach((card, index) => {
    const isTop = index === stack.length - 1;
    const holder = document.createElement('div');
    holder.className = 'fanned-card';
    if (index > 0) holder.style.marginTop = `${peek - stripHeight}px`;
    holder.style.zIndex = String(index + 1);
    holder.appendChild(cardStrip(card, isTop));
    wrap.appendChild(holder);
  });

  const depth = document.createElement('span');
  depth.className = 'stack-depth';
  depth.textContent = `共 ${stack.length} 张`;
  wrap.appendChild(depth);

  const flag = document.createElement('span');
  flag.className = 'top-flag';
  flag.textContent = '顶端';
  wrap.appendChild(flag);

  wrap.onclick = (event) => {
    // 阻止冒泡到列的"放牌"点击
    event.stopPropagation();
    showColumnDetail(col);
  };
  return wrap;
}

/** 牌堆详情弹窗：从底到顶列出整列。 */
function showColumnDetail(col) {
  // 详情与"开局/结算"共用同一个 modal，这里避免互相串扰。
  const modal = el('modal');
  const heading = el('modalBody').querySelector('h2');
  const modalBusy = !modal.hidden && heading && !/^第 \d+ 列/.test(heading.textContent);
  if (modalBusy) return;

  const s = ui.state;
  const stack = s.bases[col];
  const body = el('modalBody');
  const rows = stack
    .map((card, index) => {
      const isTop = index === stack.length - 1;
      return `
        <div class="detail-row${isTop ? ' top' : ''}">
          <div class="card mini theme-${cardTheme(card)}"><span class="rank">${cardName(card)}</span></div>
          <div class="detail-text">
            <span class="detail-name">${cardName(card)}${isTop ? '（顶端，生效中）' : ''}</span>
            <span class="detail-blurb">${cardBlurb(card)}</span>
          </div>
          <span class="detail-order">第 ${index + 1} 张${index === 0 ? ' · 基底' : ''}</span>
        </div>`;
    })
    .join('');

  body.innerHTML = `
    <h2>第 ${col + 1} 列 · 共 ${stack.length} 张</h2>
    <p>列表已按牌堆顺序排列：最下面是基底，最上面是当前生效的牌。</p>
    <div class="col-detail">${rows}</div>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="btnDetailClose">关闭</button>
    </div>
  `;
  el('modal').hidden = false;
  body.querySelector('#btnDetailClose').onclick = () => {
    el('modal').hidden = true;
  };
}

function renderHand(s, moves) {
  const hand = el('myHand');
  hand.innerHTML = '';
  const byCard = moves ?? computeMoves();
  const seat = viewSeat();

  // 选牌阶段：手牌改为"可点选"，而不是"可放置"
  const choosing = Boolean(s.pendingChoice) && humanActor() === s.pendingChoice.player;
  const picked = new Set(choosing ? s.pendingChoice.picked ?? [] : []);

  for (const card of s.hands[seat]) {
    const node = cardEl(card, '');
    const playable = byCard.has(card.id);

    if (choosing) {
      // 选牌阶段的候选可以再被 candidateIds 收窄（汇流：只能交刚抽到的那几张）。
      // 不在候选里的牌要跟"不能出的牌"一样低亮，而不是含糊地说"已经选过了"。
      const inPool = !s.pendingChoice.candidateIds
        || s.pendingChoice.candidateIds.includes(card.id);
      if (picked.has(card.id)) node.classList.add('picked');
      else if (!inPool) node.classList.add('blocked', 'out-of-pool');
      else if (picked.size >= (s.pendingChoice.count ?? 1)) node.classList.add('blocked');
      else node.classList.add('pickable');
      node.onclick = () => {
        if (!canHumanAct()) return;
        onHandCardForChoice(card);
      };
      hand.appendChild(node);
      continue;
    }

    if (s.draft) {
      // 选技阶段：手牌只做展示，不可操作
      node.classList.add('blocked');
      hand.appendChild(node);
      continue;
    }

    if (!playable) node.classList.add('blocked');
    if (ui.selectedCard === card.id) node.classList.add('selected');
    node.onclick = () => {
      if (!canHumanAct()) return;
      if (!playable) {
        setStatus(`${cardName(card)}：${cardBlockedReason(card)}`);
        return;
      }
      const wasSelected = ui.selectedCard === card.id;
      ui.selectedCard = wasSelected ? null : card.id;
      if (wasSelected) {
        // 取消选中：清掉列选择，避免残留的选中列影响下一步操作
        ui.selectedCol = null;
        render();
        return;
      }
      // 选中这张牌后，牌桌只高亮它真正能放的列
      const cols = byCard.get(card.id) ?? new Set();
      const colList = [...cols].sort((a, b) => a - b);
      setStatus(
        colList.length > 0
          ? `${cardName(card)} 可以放：${colList.map((c) => `第 ${c + 1} 列`).join('、')}`
          : `${cardName(card)} 当前无列可放`,
      );
      // 若之前选中的列正好也能放这张牌，就直接出牌
      if (ui.selectedCol !== null && cols.has(ui.selectedCol)) {
        render();
        tryPlay();
        return;
      }
      ui.selectedCol = null;
      render();
    };
    hand.appendChild(node);
  }

  el('myCount').textContent = `${s.hands[seat].length} 张`;
  const rivalName = ui.playMode === 'demo' ? 'AI' : ui.playMode === 'duo' ? '对方' : 'AI';
  el('oppInfo').textContent = `${rivalName} 手牌 ${s.hands[rivalSeat()].length} 张 · 牌堆 ${s.deck.length} 张`;
}

/** 选牌阶段点手牌：累加选择，选够张数就自动生效。 */
function onHandCardForChoice(card) {
  const s = ui.state;
  const choice = s.pendingChoice;
  if (!choice) return;
  const action = playerActions(s, choice.player).find((a) => a.type === 'chooseCard' && a.cardId === card.id);
  if (!action) {
    // 三种"点不动"的原因要分开说，否则玩家只会看到一句含糊的"已经选过了"
    const alreadyPicked = (choice.picked ?? []).includes(card.id);
    const outOfPool = Array.isArray(choice.candidateIds) && !choice.candidateIds.includes(card.id);
    const reason = alreadyPicked
      ? '已经选过这张了'
      : outOfPool
        ? '这一手只能交出高亮的那几张牌（刚抽到的新牌）'
        : '这张牌现在不能选';
    if (window.BaiFan) {
      window.BaiFan.__lastChoice = {
        ok: false,
        why: reason,
        cardId: card.id,
        picked: choice.picked ?? [],
        count: choice.count ?? 1,
        outOfPool,
      };
    }
    setStatus(`${cardName(card)}：${reason}`);
    return;
  }
  if (window.BaiFan) {
    window.BaiFan.__lastChoice = { ok: true, cardId: card.id, picked: (choice.picked?.length ?? 0) + 1 };
  }
  play(action, `选牌：${cardName(card)}（${(choice.picked?.length ?? 0) + 1}/${choice.count ?? 1}）`);
}

function renderSide(s) {
  el('statDeck').textContent = String(s.deck.length);
  el('statOpp').textContent = String(s.hands[rivalSeat()].length);
  el('statMine').textContent = String(s.hands[viewSeat()].length);
  el('statOut').textContent = String(s.outOfPlay.length);
  el('statAi').textContent = ui.ai.label;

  // 模式徽章 + 手牌区标题：让人一眼看清"现在谁在操作、这是谁的牌"
  const modeBadge = el('modeBadge');
  if (modeBadge) modeBadge.textContent = PLAY_MODES[ui.playMode].label;
  const handLabel = el('myHandLabel');
  if (handLabel) {
    const seat = viewSeat();
    handLabel.textContent = ui.playMode === 'duo'
      ? `玩家 ${seat + 1} 的手牌`
      : (seat === HUMAN ? '我的手牌' : 'AI 的手牌（演示）');
  }
  renderTrace();

  const out = el('outPile');
  out.innerHTML = '';
  if (s.outOfPlay.length === 0) out.innerHTML = '<span class="subtitle">暂无</span>';
  else for (const card of s.outOfPlay) out.appendChild(cardEl(card, 'mini'));

  const logBox = el('logBox');
  logBox.innerHTML = '';
  for (const entry of ui.log.slice(-60)) {
    const line = document.createElement('div');
    line.className = entry.tone ?? '';
    line.textContent = entry.text;
    logBox.appendChild(line);
  }
  logBox.scrollTop = logBox.scrollHeight;

  const passBtn = el('btnPass');
  // 选技/选牌阶段不能过牌；其余轮到自己的时候可以
  const canPass = canHumanAct() && !s.draft && !s.pendingChoice;
  passBtn.disabled = !canPass;
  el('btnHint').disabled = !(canHumanAct() && !s.draft && !s.pendingChoice);
  renderBanBar(s);
  renderChoiceBar(s);
  renderSkillPanel(s);
}

/** 把"着法溯源"渲染出来，方便定位"谁替我出了牌"。 */
function renderTrace() {
  const box = el('traceBox');
  if (!box) return;
  const trace = window.BaiFan && Array.isArray(window.BaiFan.__uiTrace) ? window.BaiFan.__uiTrace : [];
  box.innerHTML = '';
  if (trace.length === 0) {
    box.innerHTML = '<div>暂无记录</div>';
    return;
  }
  for (const entry of trace.slice(-12).reverse()) {
    const line = document.createElement('div');
    const isBlocked = entry.via === 'AI被拦截';
    if (isBlocked) line.className = 'bad';
    if (entry.via && entry.via.startsWith('play:')) {
      line.textContent = `你操作：${entry.via.slice(5)}`;
    } else if (entry.via === 'AI被拦截') {
      line.textContent = `已拦截：AI 试图在轮到人时行动（回合 ${entry.turn}）`;
    } else if (entry.via && entry.via.startsWith('ai:')) {
      line.textContent = `AI 操作：${entry.via.slice(3)}（回合 ${entry.turn}→${entry.nextTurn}）`;
    } else {
      line.textContent = `${entry.via ?? '?'}（回合 ${entry.turn}→${entry.nextTurn}）`;
    }
    box.appendChild(line);
  }
}

/** 交互式选牌提示条（观星 / 汇流）。 */
function renderChoiceBar(s) {
  const bar = el('choiceBar');
  const choice = s.pendingChoice;
  if (!choice) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const count = choice.count ?? 1;
  const picked = choice.picked?.length ?? 0;
  const mine = humanActor() === choice.player;
  const who = ui.playMode === 'duo' ? `玩家 ${choice.player + 1}` : 'AI';
  // 候选被收窄时（汇流：只能交刚抽到的牌），说清楚"只有这几张能选"
  const limited = Array.isArray(choice.candidateIds) && choice.candidateIds.length < (s.hands[choice.player]?.length ?? 0);
  const hint = limited ? '（只有高亮的这几张能选）' : '（直接点手牌即可）';
  el('choiceTitle').textContent = mine
    ? `${choice.note ?? '请选择手牌'}（已选 ${picked} / ${count}${hint}`
      + `${limited ? '，其余牌这一手不能交出去' : ''}）`
    : `${who} 正在选牌：${choice.note ?? ''}（已选 ${picked} / ${count}）`;

  const row = el('choiceRow');
  row.innerHTML = '';
  // 需要选多张时提供"确认"（选够张数后会自动生效，这里给个手动兜底）
  if (mine && picked > 0 && count > 1) {
    const confirm = playerActions(s, choice.player).find((a) => a.type === 'confirmChoice');
    if (confirm) {
      const button = document.createElement('button');
      button.className = 'btn primary sm';
      button.textContent = `确认（已选 ${picked} 张）`;
      button.onclick = () => play(confirm, `确认选牌（${picked} 张）`);
      row.appendChild(button);
    }
  }
}

/** 技能面板：展示双方技能与可用操作。 */
function renderSkillPanel(s) {
  const box = el('skillBox');
  box.innerHTML = '';
  const context = skillContextOf(s);
  const actor = humanActor();
  const actions = canHumanAct() && !s.draft && !s.pendingChoice && actor !== null ? playerActions(s, actor) : [];
  const skillActions = actions.filter((a) => a.type === 'skill');

  // 先手优先展示（与技能的结算优先级一致）
  const ordered = [...context.entries].sort((a, b) => a.player - b.player);

  if (ordered.length === 0) {
    box.innerHTML = '<span class="subtitle">本局没有技能</span>';
    return;
  }

  for (const entry of ordered) {
    const def = entry.skill;
    const used = s.usesById[def.id] ?? 0;
    const remaining = def.type === 'active' ? Math.max(0, def.maxUses - used) : 0;
    // 双人模式下"我的"跟着当前视角座位走
    const mine = entry.player === viewSeat();

    const card = document.createElement('div');
    card.className = `skill-card${mine ? ' mine' : ''}`;

    const mineActions = entry.player === actor ? skillActions.filter((a) => a.skill === def.id) : [];
    if (mineActions.length > 0) card.classList.add('usable');

    const head = document.createElement('div');
    head.className = 'skill-head';
    const name = document.createElement('span');
    name.className = 'skill-name';
    name.textContent = def.name;
    const owner = document.createElement('span');
    owner.className = 'skill-owner';
    owner.textContent = mine
      ? (ui.playMode === 'duo' ? `玩家 ${entry.player + 1}（你）` : '你')
      : (ui.playMode === 'duo' ? `玩家 ${entry.player + 1}` : 'AI');
    const tag = document.createElement('span');
    tag.className = 'skill-tag';
    if (def.type === 'passive') {
      tag.textContent = '被动';
    } else if (remaining > 0) {
      tag.textContent = `主动 ${remaining}/${def.maxUses}`;
      tag.classList.add('active');
    } else {
      tag.textContent = '已用完';
      tag.classList.add('used');
    }
    head.append(name, owner, tag);
    card.appendChild(head);

    const text = document.createElement('div');
    text.className = 'skill-text';
    text.textContent = def.text;
    card.appendChild(text);

    // 威严专属状态条：发动中 / 已失效（持有者放过 E/M 之后失效）
    if (def.id === 'weiyan') {
      const status = weiyanStatus(s);
      if (status) {
        const active = status.active;
        card.classList.add(active ? 'live' : 'dead');
        const line = document.createElement('div');
        line.className = `skill-state ${active ? 'on' : 'off'}`;
        line.textContent = active
          ? `⚔ 发动中：${seatName(status.blockedPlayer)}不能放置 E/M（${seatName(status.holder)}一旦放过 E 或 M 就失效）`
          : '— 已失效：持有者已经放过 E 或 M，双方恢复自由';
        card.appendChild(line);
      }
    }

    if (mineActions.length > 0) {
      const row = document.createElement('div');
      row.className = 'skill-actions';
      for (const action of mineActions) {
        const button = document.createElement('button');
        button.className = 'btn sm';
        button.textContent = action.label ?? `发动 ${def.name}`;
        button.onclick = () => {
          const actor2 = humanActor();
          const who = ui.playMode === 'duo' ? `玩家 ${(actor2 ?? 0) + 1}` : '你';
          play(action, `${who}发动了 ${def.name}${action.label ? `：${action.label.replace(/^[^：]*：/, '')}` : ''}`);
        };
        row.appendChild(button);
      }
      card.appendChild(row);
    }

    box.appendChild(card);
  }
}

function setStatus(text) {
  el('statusLine').textContent = text;
}

/** 当前由人操作的那个座位（没有则返回 null）。 */
function isHumanTurn() {
  return humanActor() !== null && !ui.awaitingBan;
}

function canHumanAct() {
  return isHumanTurn() && !ui.busy;
}

/**
 * 界面视角座位：手牌区展示谁的手牌、提示与教练针对谁。
 * - 人机 / 演示：固定看 0 号位
 * - 双人：跟随当前行动方，轮到谁就展示谁的牌
 */
function viewSeat() {
  const actor = humanActor();
  if (ui.playMode === 'duo' && actor !== null) return actor;
  return HUMAN;
}

/** 对方座位（相对当前视角）。 */
function rivalSeat() {
  return 1 - viewSeat();
}

function currentLegalPlacements() {
  const actor = humanActor();
  if (!ui.state || ui.state.result.over || actor === null) return [];
  return playerActions(ui.state, actor).filter((a) => a.type === 'place');
}

/**
 * 这张牌"为什么放不了"。返回 null 表示能放。
 *
 * 必须走 playerActions（引擎认可的完整合法着法集合）而不是裸的 canPlaceAt：
 * 威严这类"整类禁牌"的技能不是 rules 层的限制，只用 canPlaceAt 会查不出来，
 * 于是"能放"和"被禁"的结论互相矛盾。
 */
function cardBlockedReason(card) {
  const actor = humanActor();
  if (!ui.state || actor === null) return '现在不是你的回合';
  const legal = playerActions(ui.state, actor).some((a) => a.type === 'place' && a.card.id === card.id);
  if (legal) return null;

  // 先问技能层的"整类禁牌"
  const kinds = legalKindsFor(ui.state, actor);
  if (kinds && !kinds.includes(card.kind)) {
    const status = weiyanStatus(ui.state);
    if (status && status.active && status.holder !== actor) {
      return `${seatName(status.holder)}的威严发动中：本局对方不能放置 E/M`;
    }
    return '当前的限制不允许放这一类牌';
  }
  // 否则是牌桌上的硬规则（列顶接不上 / 基底不可炸 / 黑 5 免疫…）
  for (let col = 0; col < ui.state.bases.length; col++) {
    const verdict = canPlaceAt(ui.state, actor, col, card);
    if (verdict.ok) {
      const blocked = restrictionBlocks(ui.state, col, card, actor);
      return blocked.ok ? '当前没有可放置的位置' : blocked.reason;
    }
  }
  for (let col = 0; col < ui.state.bases.length; col++) {
    const verdict = canPlaceAt(ui.state, actor, col, card);
    if (!verdict.ok) return verdict.reason;
  }
  return '当前没有可放置的位置';
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------
function onColumnClick(col) {
  // 记录最近一次点击，便于排查"点了没反应"这类问题（浏览器控制台可直接查看）
  if (window.BaiFan) {
    window.BaiFan.__lastClick = {
      col,
      humanTurn: isHumanTurn(),
      busy: ui.busy,
      selectedCard: ui.selectedCard,
      current: ui.state ? ui.state.current : null,
    };
  }
  if (!isHumanTurn() || ui.busy) return;
  ui.selectedCol = ui.selectedCol === col ? null : col;
  render();
  if (ui.selectedCard && ui.selectedCol !== null) tryPlay();
}

function tryPlay() {
  const s = ui.state;
  const actor = humanActor();
  if (actor === null) return;
  const card = s.hands[actor].find((c) => c.id === ui.selectedCard);
  if (!card) {
    if (window.BaiFan) window.BaiFan.__lastTryPlay = { ok: false, why: '选中牌已不在手中', selectedCard: ui.selectedCard };
    return;
  }
  // 走 playerActions：它才是引擎认可的合法着法集合（含技能例外）
  const action = playerActions(s, actor).find(
    (a) => a.type === 'place' && a.col === ui.selectedCol && a.card.id === card.id,
  );
  if (!action) {
    if (window.BaiFan) {
      window.BaiFan.__lastTryPlay = {
        ok: false,
        why: '引擎判定不能放这里',
        col: ui.selectedCol,
        cardId: card.id,
        reason: (canPlaceAt(s, actor, ui.selectedCol, card) || {}).reason ?? null,
      };
    }
    const verdict = canPlaceAt(s, actor, ui.selectedCol, card);
    setStatus(`不能放在第 ${ui.selectedCol + 1} 列：${verdict.ok ? '未知原因' : verdict.reason}`);
    return;
  }
  if (window.BaiFan) window.BaiFan.__lastTryPlay = { ok: true, col: action.col, cardId: card.id };
  const who = ui.playMode === 'duo' ? `玩家 ${actor + 1} 放置了` : '你放置了';
  play(action, `${who} ${cardName(card)}`);
}

/**
 * 界面层的最后一道错误兜底：任何异常都写进战报，而不是静默失败。
 * 静默失败会让界面看起来"点了没反应"，非常难排查。
 */
function reportUiError(where, error) {
  const message = error && error.message ? error.message : String(error);
  pushLog(`界面出错（${where}）：${message}`, 'bad');
  if (error && error.stack) pushLog(String(error.stack).split('\n').slice(0, 3).join(' / '), 'bad');
  try {
    render();
  } catch (nested) {
    // 渲染本身也失败时不再递归，避免死循环
    void nested;
  }
}

/** 往溯源数组里塞一条记录（统一入口，避免各处直接摸 window.BaiFan）。 */
function traceRaw(entry) {
  const api = window.BaiFan;
  if (!api || !Array.isArray(api.__uiTrace)) return;
  api.__uiTrace.push(entry);
  if (api.__uiTrace.length > 300) api.__uiTrace.shift();
}

/** 记录一次由界面发起的着法（含调用栈），用于排查"谁替我出了牌"。 */
function traceUiAction(action, label, before, after) {
  traceRaw({
    via: 'ui.play',
    mode: ui.playMode,
    action: action.type,
    player: action.player,
    label,
    turn: before.turn,
    nextTurn: after ? after.turn : null,
    stack: String(new Error().stack).split('\n').slice(2, 7).map((s) => s.trim()),
  });
}

function play(action, label) {
  try {
    const before = ui.state;
    const next = applyAction(before, action);
    traceUiAction(action, label, before, next);
    watchState(next, `play:${action.type}@${action.player}`);
    ui.state = next;
    ui.selectedCard = null;
    ui.selectedCol = null;
    ui.coachCache = null;
    // 看破：在"这一步"记下对手当时的手牌（下一次操作时会被清掉）
    if (action.type === 'skill' && action.skill === 'kanpo') {
      captureReveal(before, action.player);
    }
    pushLog(label, actionTone(action, before, ui.state));
    setStatus('');
    render();
    afterStep();
  } catch (error) {
    traceUiAction(action, `（失败）${label}`, ui.state, null);
    reportUiError('执行着法', error);
  }
}

/**
 * 记下看破"当场看到的那一眼"。
 * 用发动前的状态取手牌，这样拿到的正是"看之前"那一刻的对方手牌。
 */
function captureReveal(before, viewer) {
  const target = 1 - viewer;
  ui.reveal = {
    viewer,
    target,
    turn: before.turn,
    cards: (before.hands[target] ?? []).map((c) => ({ ...c })),
  };
}

/** 人类在选技阶段选择技能。 */
function playSkillChoice(skillId) {
  try {
    const before = ui.state;
    const picker = waitingFor(before);
    const next = chooseSkill(before, picker, skillId);
    watchState(next, `playSkillChoice@${picker}`);
    ui.state = next;
    pushLog(`你选择了技能：${getSkill(skillId)?.name ?? skillId}`, 'hi');
    render();
    afterStep();
  } catch (error) {
    reportUiError('选择技能', error);
  }
}

function actionTone(action, before, after) {
  if (after.result.over) {
    if (after.result.winner === null) return '';
    return isHumanSeat(after.result.winner) ? 'good' : 'bad';
  }
  if (action.type === 'skill') return 'hi';
  if (action.type === 'place' && after.lastAction.destroyed?.length) return 'hi';
  if (action.type === 'place' && action.card.kind === 'm') return 'hi';
  return '';
}

function onPass() {
  if (!canHumanAct()) return;
  const s = ui.state;
  const actor = humanActor();
  if (actor === null) return;
  const action = playerActions(s, actor).find((a) => a.type === 'pass');
  const who = ui.playMode === 'duo' ? `玩家 ${actor + 1} 过牌` : '你过牌';
  const rival = seatName(1 - actor);
  play(action, s.deck.length >= 3 ? `${who}：你抽 2 张，${rival}抽 1 张` : `${who}（牌堆已空，双方都不抽牌）`);
}

/**
 * AI 回合：先画一帧"AI 思考中"，稍后同步结算。
 *
 * 一个"AI 步骤"可能是：选技能、选牌、或正常的出牌/过牌/发动技能——
 * 统一由 waitingFor / playerActions 决定，AI 只需要在候选里挑一个。
 */
const AI_THINK_DELAY = 200;

/**
 * 选技阶段的界面：把 3 个候选做成按钮放进操作条。
 * （不遮挡手牌，与禁列提示条同一套做法）
 */
function renderBanBar(s) {
  const bar = el('banBar');
  if (ui.awaitingBan) {
    bar.hidden = false;
    el('banBar').querySelector('.ban-title').textContent = '你是后手：请先指定禁列（对方第一手不能放的列）';
    const row = el('banRow');
    row.innerHTML = '';
    for (let col = 0; col < s.bases.length; col++) {
      const stack = s.bases[col];
      const top = stack[stack.length - 1];
      const button = document.createElement('button');
      button.className = 'btn primary sm';
      button.textContent = `第 ${col + 1} 列（基底 ${cardName(stack[0])}｜顶端 ${cardName(top)}）`;
      button.onclick = () => chooseBan(col);
      row.appendChild(button);
    }
    return;
  }

  const picker = s.draft ? waitingFor(s) : null;
  if (s.draft && picker !== null && isHumanSeat(picker)) {
    bar.hidden = false;
    el('banBar').querySelector('.ban-title').textContent = `请${seatName(picker)}选择一个技能（已被选走的不能再选）`;
    const row = el('banRow');
    row.innerHTML = '';
    // 已经被对方选走的技能要显示出来但不能点，避免"技能凭空消失"的困惑
    for (const id of s.draft.options) {
      const def = getSkill(id);
      const taken = !s.draft.available.includes(id);
      const button = document.createElement('button');
      button.className = `btn sm${taken ? '' : ' primary'}`;
      button.textContent = `${def?.name ?? id}（${def?.type === 'active' ? '主动' : '被动'}）${taken ? ' · 已被选走' : ''}`;
      button.title = def?.text ?? '';
      button.disabled = taken;
      if (!taken) button.onclick = () => playSkillChoice(id);
      row.appendChild(button);
    }
    return;
  }

  bar.hidden = true;
}

/**
 * 挂起的 AI 定时器集合。
 * 用集合而不是单个 id：任何时刻都可能存在多个排队中的 AI 回合，
 * 只要"该由人行动"，就必须把它们全部取消，否则会出现"过期定时器晚一步替人行动"。
 */
const aiTimers = new Set();

/** 取消所有尚未触发的 AI 定时器。 */
function cancelAiTimer() {
  for (const id of aiTimers) clearTimeout(id);
  aiTimers.clear();
}

function scheduleAi() {
  ui.busy = true;
  render();
  const id = setTimeout(() => {
    aiTimers.delete(id);
    finishAiStep();
  }, AI_THINK_DELAY);
  aiTimers.add(id);
}

/** AI 一步的实际执行逻辑（从定时器回调里分离出来，便于阅读与测试）。 */
function finishAiStep() {
  try {
    if (ui.state.result.over) {
      ui.busy = false;
      return;
    }
    if (isHumanTurn()) {
      // 轮到人类：交给交互，不要抢回合
      ui.busy = false;
      render();
      return;
    }

    // 人类还在选禁列：AI 的先手第一手必须等禁列确定之后
    if (ui.awaitingBan) {
      ui.busy = false;
      render();
      return;
    }

    // 硬护栏：只要此刻该由人操作，AI 一律不许行动。
    // 正常情况下不会走到这里（轮到人时上面的 isHumanTurn 已经拦住，且过期定时器会被取消），
    // 真走到这里说明有异常时序，只静默跳过，不替人行动。
    if (humanActor() !== null) {
      ui.busy = false;
      traceRaw({
        via: 'AI被拦截',
        mode: ui.playMode,
        action: 'blocked',
        player: humanActor(),
        label: '该由人操作，AI 已拒绝行动',
        turn: ui.state.turn,
        stack: String(new Error().stack).split('\n').slice(2, 6).map((s) => s.trim()),
      });
      render();
      return;
    }

    const before = ui.state;
    let action = null;
    let label = '';

    if (before.draft) {
      const picker = waitingFor(before);
      // 走 profile.decide：选技优先级由 AI 层统一决定（实测强度表 + 档位锐度），
      // UI 不再维护自己的选技启发式——否则档位配置与强度表都会被绕过。
      const decided = ui.ai.decide(before, picker, ui.rng);
      const available = before.draft.available ?? before.draft.options ?? [];
      const skillId = typeof decided === 'string' && available.includes(decided) ? decided : available[0];
      label = `${seatName(picker)}选择了技能：${getSkill(skillId)?.name ?? skillId}`;
      const next = chooseSkill(before, picker, skillId);
      watchState(next, `aiSkillChoice@${picker}`);
      ui.state = next;
      pushLog(label, 'hi');
      ui.busy = false;
      render();
      afterStep();
      return;
    }

    // 正常回合 / 选牌阶段：都从 playerActions 里挑
    const actor = before.pendingChoice ? before.pendingChoice.player : before.current;
    action = ui.ai.decide(before, actor, ui.rng);
    label = describeActorAction(action, before, actor);
    const aiNext = applyAction(before, action);
    watchState(aiNext, `ai:${action && action.type}@${actor}`);
    ui.state = aiNext;
    pushLog(label, actionTone(action, before, ui.state));
    ui.busy = false;
    render();
    afterStep();
  } catch (error) {
    // 出错时必须清掉 busy，否则界面会卡在"AI 思考中"且所有操作都不可用。
    ui.busy = false;
    if (window.BaiFan) {
      window.BaiFan.__aiError = {
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? String(error.stack).split('\n').slice(0, 4) : null,
      };
    }
    pushLog(`AI 出错：${error && error.message ? error.message : error}`, 'bad');
    if (error && error.stack) pushLog(String(error.stack).split('\n').slice(0, 3).join(' / '), 'bad');
    render();
  }
}

/**
 * 把 AI 的着法翻译成战报文案。
 * 过牌要把双方抽牌都写清楚：自己抽 2、对方抽 1（只写一半会让人以为对方没抽牌）。
 */
function describeActorAction(action, before, actor) {
  const who = seatName(actor);
  if (action.type === 'pass') {
    const rival = seatName(1 - actor);
    return before.deck.length >= 3
      ? `${who}过牌：${who}抽 2 张，${rival}抽 1 张`
      : `${who}过牌（牌堆已空，双方都不抽牌，直接换手）`;
  }
  if (action.type === 'chooseCard') return `${who}选了 ${cardName(action.card)}`;
  if (action.type === 'confirmChoice') return `${who}确认了选牌`;
  if (action.type === 'skill') {
    const def = getSkill(action.skill);
    return `${who}发动了 ${def?.name ?? action.skill}${action.label ? `：${action.label.replace(/^[^：]*：/, '')}` : ''}`;
  }
  return `${who}把 ${cardName(action.card)} 放到第 ${action.col + 1} 列`;
}

/** 一步结束之后：判胜负、处理开局阶段、把行动权交给人类或继续让 AI 走。 */
function afterStep() {
  const s = ui.state;
  if (s.result.over) return showResult();

  // 选技阶段
  if (s.draft) {
    if (isHumanTurn()) afterHumanTurnStart();
    else scheduleAi();
    return;
  }

  // 禁列：由"后手那一方的操作者"决定，必须先于先手的第一手。
  // 只在第 1 回合还有意义（引擎里禁列也只对 turn === 1 的第一次放置生效），
  // 并且必须让先手的开局技能选牌（观星）先落地——否则人类玩家还没选牌，
  // 界面就跳到禁列上，看起来像"AI 抢着先出牌"。
  const pastBan = s.forbiddenColumn !== null || s.turn > 1;
  const humanChoosing = Boolean(s.pendingChoice) && isHumanSeat(s.pendingChoice.player);
  if (!pastBan && !ui.awaitingBan && !humanChoosing) {
    const banSeat = s.lastPlayer;
    if (isHumanSeat(banSeat)) {
      // 人类是后手：先让他指定禁列，并且**必须停在这里等**。
      // 之前这里没有 return，流程会落到下面的 scheduleAi()，
      // 结果先手 AI 的第一手抢在禁列选择之前发生——顺序反了。
      cancelAiTimer();
      ui.awaitingBan = true;
      pushLog(`选技完成：${seatName(banSeat)}是后手，请先指定对方第一手不能放的列`, 'hi');
      render();
      return;
    }
    const col = ui.ai.chooseForbiddenColumn(s, ui.rng);
    ui.state = setForbiddenColumn(s, col);
    pushLog(`${seatName(banSeat)}指定：${seatName(s.firstPlayer)}的第一手不能放第 ${col + 1} 列`, 'bad');
    render();
    afterStep();
    return;
  }

  // 等待人类指定禁列期间，任何一方都不该动
  if (ui.awaitingBan) return;

  if (humanActor() !== null) {
    cancelAiTimer();
    afterHumanTurnStart();
    return;
  }
  scheduleAi();
}

/** 每轮到人类时：处理"无牌可放"提示，并在先手第一手前处理禁列。 */
function afterHumanTurnStart() {
  const s = ui.state;
  if (s.result.over) return;
  if (s.draft) {
    setStatus('请选择一个技能。');
    render();
    return;
  }
  if (s.pendingChoice) {
    setStatus(s.pendingChoice.note ?? '请选择手牌。');
    render();
    return;
  }
  if (humanActor() === null) return;
  if (currentLegalPlacements().length === 0) {
    setStatus('当前没有合法放置，只能过牌。');
  }
  render();
}

function pushLog(text, tone = '') {
  ui.log.push({ text, tone });
}

// ---------------------------------------------------------------------------
// 开局 / 禁列 / 结算
// ---------------------------------------------------------------------------
function showSetup() {
  const body = el('modalBody');
  body.innerHTML = `
    <h2>开始对局</h2>
    <p>先选对局模式，再选 AI 难度。开局会随机亮出 3 个技能，后手先选，然后指定禁列。</p>
    <div class="section-label">对局模式</div>
    <div class="diff-list" id="modeList"></div>
    <div class="section-label">AI 难度（仅 AI 参与的座位使用）</div>
    <div class="diff-list" id="diffList"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="btnStart">开始对局</button>
      <span id="setupHint" class="subtitle" style="align-self:center"></span>
    </div>
  `;

  let pickedMode = ui.playMode;
  let picked = ui.ai.id;

  const modeList = body.querySelector('#modeList');
  const drawModes = () => {
    modeList.innerHTML = '';
    for (const mode of Object.values(PLAY_MODES)) {
      const node = document.createElement('div');
      node.className = `diff${mode.id === pickedMode ? ' selected' : ''}`;
      node.innerHTML = `<div><div class="name">${mode.label}</div><div class="desc">${mode.desc}</div></div>`;
      node.onclick = () => {
        pickedMode = mode.id;
        drawModes();
      };
      modeList.appendChild(node);
    }
  };

  const list = body.querySelector('#diffList');
  const draw = () => {
    list.innerHTML = '';
    for (const profile of PROFILE_LIST) {
      const node = document.createElement('div');
      node.className = `diff${profile.id === picked ? ' selected' : ''}`;
      node.innerHTML = `<div><div class="name">${profile.label}</div><div class="desc">${profile.description}</div></div>`;
      node.onclick = () => {
        picked = profile.id;
        draw();
      };
      list.appendChild(node);
    }
  };

  drawModes();
  draw();
  el('modal').hidden = false;
  body.querySelector('#btnStart').onclick = () => {
    ui.ai = BUILTIN_PROFILES[picked];
    ui.playMode = pickedMode;
    el('modal').hidden = true;
    newGame();
  };
}

function newGame() {
  // 带技能开局：先进入"随机 3 个技能、后手先选"的选技阶段
  cancelAiTimer();
  ui.state = createGame({ seed: Math.floor(Math.random() * 1e9), withSkills: true });
  ui.selectedCard = null;
  ui.selectedCol = null;
  ui.coachCache = null;
  ui.busy = false;
  ui.log = [];
  ui.awaitingBan = false;

  const s = ui.state;
  const mode = PLAY_MODES[ui.playMode];
  pushLog(`新对局开始（${mode.label}）：你操作玩家 1，对手是「${ui.ai.label}」`);
  pushLog(`基底：${s.bases.map((b, i) => `第${i + 1}列 ${cardName(b[0])}`).join('，')}`);
  if (s.draft) {
    pushLog(`候选技能：${s.draft.options.map((id) => getSkill(id)?.name ?? id).join('、')}`, 'hi');
    pushLog('后手先选技能；选完技能再指定禁列', 'hi');
  }
  render();
  afterStep();
}

/** 人类作为后手指定禁列。 */
function chooseBan(col) {
  if (!ui.awaitingBan) return;
  const banSeat = ui.state.lastPlayer;
  ui.state = { ...ui.state, forbiddenColumn: col };
  ui.awaitingBan = false;
  pushLog(`${seatName(banSeat)}指定：${seatName(ui.state.firstPlayer)}的第一手不能放第 ${col + 1} 列`, 'hi');
  render();
  afterStep();
}

function showResult() {
  const s = ui.state;
  const draw = s.result.winner === null;
  const winner = s.result.winner;
  const won = !draw && isHumanSeat(winner);
  const title = draw
    ? '平局'
    : ui.playMode === 'demo'
      ? `${seatName(winner)}获胜`
      : won ? `${seatName(winner)}赢了` : `${seatName(winner)}赢了`;
  const body = el('modalBody');
  body.innerHTML = `
    <h2>${title}</h2>
    <p>${s.result.reason ?? ''}<br>
       剩余手牌 — 玩家 1：${s.hands[0].length} 张 / 玩家 2：${s.hands[1].length} 张<br>
       共 ${s.turn - 1} 手，牌堆剩余 ${s.deck.length} 张</p>
    <div class="row">
      <button class="btn primary" id="btnAgain">再来一局</button>
      <button class="btn" id="btnReview">查看牌桌</button>
      <button class="btn" id="btnMode">切换模式</button>
    </div>
  `;
  el('modal').hidden = false;
  body.querySelector('#btnAgain').onclick = () => {
    el('modal').hidden = true;
    newGame();
  };
  body.querySelector('#btnReview').onclick = () => {
    el('modal').hidden = true;
  };
  body.querySelector('#btnMode').onclick = () => {
    el('modal').hidden = true;
    showSetup();
  };
  pushLog(`对局结束：${s.result.reason}`, draw ? '' : won ? 'good' : 'bad');
  render();
}

function showRules() {
  const body = el('modalBody');
  body.innerHTML = `
    <h2>规则速查</h2>
    <ul style="font-size:13px;line-height:1.8;color:var(--muted);padding-left:18px">
      ${RULES_TEXT.map((line) => `<li>${line}</li>`).join('')}
    </ul>
    <h2 style="font-size:16px;margin-top:18px">技能一览</h2>
    <div class="skill-list" style="font-size:13px">
      ${allSkills().map((def) => {
        const kind = def.type === 'active' ? `主动 · 每局限 ${def.maxUses} 次` : '被动';
        return `<div class="skill-item"><b>${def.name}</b><span class="skill-kind">${kind}</span><span class="skill-desc">${def.text}</span></div>`;
      }).join('')}
    </div>
    <div class="row" style="margin-top:16px"><button class="btn primary" id="btnClose">知道了</button></div>
  `;
  el('modal').hidden = false;
  body.querySelector('#btnClose').onclick = () => {
    el('modal').hidden = true;
  };
}

function onHint() {
  if (!canHumanAct()) return;
  setStatus('教练计算中…');
  el('btnHint').disabled = true;
  setTimeout(() => {
    try {
      const result = coach(ui.state, humanActor());
      const move = result.best;
      const moveText = !move ? '无' : move.type === 'pass' ? '过牌' : `第 ${move.col + 1} 列放 ${cardName(move.card)}`;
      const alts = result.alternatives
        .map((alt) => `${alt.action.type === 'pass' ? '过牌' : `第 ${alt.action.col + 1} 列放 ${cardName(alt.action.card)}`}`)
        .join('、');
      el('hintBox').textContent = `推荐：${moveText}\n理由：${result.reason}${alts ? `\n备选：${alts}` : ''}`;
      setStatus('');
    } catch (error) {
      el('hintBox').textContent = `提示失败：${error.message}`;
    } finally {
      el('btnHint').disabled = false;
      render();
    }
  }, 30);
}

// 暴露给调试与自动化探针使用（浏览器控制台可读当前 UI 状态）
if (window.BaiFan) window.BaiFan.__uiState = () => ui.state;

/**
 * 测试钩子：把一个构造好的引擎状态直接塞进界面并重新进入"一步之后"的流程。
 * 只给 tools/ui-test.mjs 用，让"黑 5 免疫""看破"这类需要特定牌面的场景可以被
 * 确定性地复现，不必靠随机对局碰运气。正式游玩不会走这里。
 */
if (window.BaiFan) {
  window.BaiFan.__uiInject = (state) => {
    ui.state = state;
    ui.awaitingBan = false;
    ui.busy = false;
    ui.selectedCard = null;
    ui.selectedCol = null;
    afterStep();
  };
}


// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
el('ruleList').innerHTML = RULES_TEXT.map((line) => `<li>${line}</li>`).join('');

/**
 * 技能一览：直接读技能定义，所以文案只有一份（改技能就自动跟着变）。
 * 显示格式：名称 + 发动方式（主动：每局限 N 次 / 被动）+ 原文效果。
 */
function renderSkillList() {
  const box = el('skillList');
  if (!box) return;
  box.innerHTML = '';
  for (const def of allSkills()) {
    const item = document.createElement('div');
    item.className = 'skill-item';
    const kind = def.type === 'active' ? `主动 · 每局限 ${def.maxUses} 次` : '被动';
    item.innerHTML = `<b>${def.name}</b><span class="skill-kind">${kind}</span><span class="skill-desc">${def.text}</span>`;
    box.appendChild(item);
  }
}

renderSkillList();
el('btnPass').onclick = onPass;
el('btnHint').onclick = onHint;
el('btnNew').onclick = () => {
  el('modal').hidden = true;
  showSetup();
};
el('btnRules').onclick = showRules;

showSetup();
