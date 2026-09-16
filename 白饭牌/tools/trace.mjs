/**
 * 调试用：逐手打印一局，定位异常节奏。
 * 用法：node tools/trace.mjs <AI1> <AI2> [seed]
 */
import { createGame, applyAction, isOver, summarize, cardCounts } from '../src/engine/game.js';
import { legalActions } from '../src/engine/rules.js';
import { cardName } from '../src/engine/cards.js';
import { createRng } from '../src/engine/random.js';
import { BUILTIN_PROFILES } from '../src/ai/profiles.js';

const [, , aiA = 'normal', aiB = 'normal', seedArg = '7'] = process.argv;
const seed = Number(seedArg);
const A = BUILTIN_PROFILES[aiA];
const B = BUILTIN_PROFILES[aiB];
if (!A || !B) {
  console.error(`可用 AI：${Object.keys(BUILTIN_PROFILES).join(', ')}`);
  process.exit(1);
}

let state = createGame({ seed });
const rng = createRng(seed * 31 + 7);
console.log(`种子 ${seed} | 先手 玩家${state.firstPlayer + 1}`);
console.log('初始:', summarize(state));

let step = 0;
while (!isOver(state) && step < 400) {
  const player = state.current;
  const profile = player === 0 ? A : B;
  const legal = legalActions(state, player);
  const placementCount = legal.filter((a) => a.type === 'place').length;
  const action = profile.decide(state, player, rng);
  const before = cardCounts(state);
  const next = applyAction(state, action);
  const after = cardCounts(next);

  const what = action.type === 'pass' ? '过牌' : `放 ${cardName(action.card)} → 第${action.col + 1}列`;
  const drawn = action.type === 'pass' && next.lastAction.drawn
    ? `抽 ${next.lastAction.drawn[player].length}+${next.lastAction.drawn[1 - player].length}`
    : action.type === 'pass' ? '堆不足，不抽' : '';
  const beforeHands = state.hands.map((h) => h.length);
  const afterHands = next.hands.map((h) => h.length);
  console.log(
    `#${String(step).padStart(3)} P${player + 1} ${what.padEnd(20)} ${drawn.padEnd(8)} 可选${String(placementCount).padStart(2)} | 堆 ${before.deck}→${after.deck} 手 ${beforeHands[0]}:${beforeHands[1]}→${afterHands[0]}:${afterHands[1]}`,
  );
  state = next;
  step++;
  if (state.result.over) break;
}
console.log('结果:', state.result);
console.log('最终:', summarize(state), '| 守恒', JSON.stringify(cardCounts(state)));
