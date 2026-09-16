/**
 * 可注入的随机源。
 *
 * 引擎与 AI 都不直接调用 Math.random，而是接收一个 RandomSource，
 * 这样：模拟可复现、AI 可控制噪声、对战回放可重演。
 *
 * @typedef {object} RandomSource
 * @property {() => number} next     返回 [0, 1) 的浮点数
 * @property {(n: number) => number} int  返回 [0, n) 的整数
 * @property {() => number} state    导出当前内部状态（用于回放）
 */

/** @param {number} seed @returns {RandomSource} */
export function createRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => {
      if (!Number.isInteger(n) || n <= 0) throw new Error(`rng.int 需要正整数，收到 ${n}`);
      return Math.floor(next() * n);
    },
    state: () => s,
  };
}

/** @returns {RandomSource} 每次调用产生独立随机序列 */
export function createSeededRng(seedString) {
  const text = String(seedString ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return createRng(h);
}

/** Fisher-Yates 洗牌，返回新数组，不修改入参。 */
export function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 从数组中随机取 k 个不重复元素（返回新数组）。 */
export function sample(items, k, rng) {
  if (k <= 0) return [];
  if (k >= items.length) return shuffle(items, rng);
  const pool = items.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    const j = rng.int(pool.length);
    out.push(pool[j]);
    pool[j] = pool[pool.length - 1];
    pool.pop();
  }
  return out;
}
