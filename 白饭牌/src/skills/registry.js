/**
 * 技能注册表。
 *
 * 设计目标：加一个新技能 = 新增一个定义并注册，不用改引擎主流程。
 *
 * 每个技能定义可提供以下钩子（全部可选）：
 *   onGameStart(ctx, state)            开局时执行一次（在选技之后、禁列之前）
 *   extraActions(ctx, state, player)   提供额外的合法着法（主动技）
 *   applyAction(ctx, state, action)    执行自己的着法（就地修改传入的 state）
 *   applyChoice(ctx, state, choice)    执行"选牌"结果（就地修改传入的 state）
 *   legalKinds(ctx, state, player)     额外禁止某些牌型（例如威严）
 *   drawOnPass(ctx, state, player)     过牌时的抽牌方案
 *   onPlaced(ctx, state, action)       某张牌落桌后触发（例如荆棘）
 *   onTurnEnd(ctx, state, player)      回合结束时触发
 *
 * 约定：钩子直接修改传入的 state（引擎已经为这一次着法克隆好了新状态），
 * 返回值只在需要"追加信息"时使用。
 */

/** @typedef {{id:string, name:string, type:'active'|'passive', maxUses:number, text:string, hooks:object}} SkillDef */

const registry = new Map();

/** 注册一个技能。 */
export function defineSkill(def) {
  if (!def || !def.id) throw new Error('技能定义必须有 id');
  if (registry.has(def.id)) throw new Error(`技能 id 重复：${def.id}`);
  registry.set(def.id, {
    type: def.type ?? 'passive',
    maxUses: def.maxUses ?? (def.type === 'active' ? 1 : 0),
    hooks: def.hooks ?? {},
    ...def,
  });
  return def.id;
}

/** 取技能定义。 */
export function getSkill(id) {
  return registry.get(id) ?? null;
}

/** 全部技能 id（按注册顺序，供随机抽取与测试使用）。 */
export function allSkillIds() {
  return [...registry.keys()];
}

/** 全部技能定义。 */
export function allSkills() {
  return [...registry.values()];
}

/** 用给定随机源打乱技能 id 列表（供开局随机抽候选）。 */
export function shuffleSkillIds(ids, rng) {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * 把一条技能 id 列表整理成可供引擎查询的"技能上下文"。
 *
 * 优先级：紫 0 全局限锁 > 禁列 > 下回合限制 > 技能 > 常规规则。
 * 技能之间冲突时按座位顺序结算（先手优先），所以这里按 (先手, 后手) 排序。
 */
export function skillsContext(skillIds) {
  const entries = [];
  const consider = (player) => {
    const id = skillIds?.[player];
    const skill = id ? getSkill(id) : null;
    if (skill) entries.push({ player, skill });
  };
  consider(0);
  consider(1);
  return {
    entries,
    has(skillId) {
      return entries.some((e) => e.skill.id === skillId);
    },
    of(player) {
      return entries.filter((e) => e.player === player).map((e) => e.skill);
    },
  };
}

/** 只给测试用：清空注册表（正常游戏流程不会调用）。 */
export function _clearRegistry() {
  registry.clear();
}
