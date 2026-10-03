import {
  GRADES, gradeIndex, isTier, SUPPRESSION, TIER_SUPPRESSION, TIER_GRADES, DOMAIN_BUFF,
} from './tables.js'

/**
 * 战斗公式集中地。
 * 原文第六节面板里的公式与第五节正文略有出入（一处含"咒力效率"作乘数，一处不含）。
 * 这里统一采用面板版（玩家实际看到的那个），并用 USE_EFFICIENCY_AS_MULTIPLIER 开关保留回退能力。
 */
export const USE_EFFICIENCY_AS_MULTIPLIER = true

/**
 * 防御力。
 *
 * 设定原文写的是「防御力 = 体术伤害 × 0.3 + 咒力效率 × 20」。
 * 照字面实现会出事：咒力效率是个 0.5~1.5 的无量纲数，×20 得到 10~30 的**固定加法**，
 * 而体术伤害横跨 5（四级）到 400000（龙级）五个数量级。
 * 结果是被加的常数在低级把整个攻击力吞掉 —— 实测四级同级的体术和术式
 * 全部触底到 1 点伤害，两个四级互殴要 75 回合，而引擎回合上限是 30，必然强制平局；
 * 二级要 43 击，同样打不完。
 *
 * 所以把效率项改成与自身量级成比例的乘数，物理含义不变（咒力效率越高，防御越强），
 * 但不再对低等级失衡。系数在 tables.js 里可调。
 */
export function defenseOf(unit) {
  const pd = unit.physicalDamage.value
  const eff = unit.efficiency.value
  return pd * (DEFENSE_PHYSICAL_RATIO + eff * DEFENSE_EFFICIENCY_RATIO)
}

/**
 * 防御构成：体术伤害占比 + 咒力效率带来的附加占比。
 *
 * 0.2 是照着原公式在**一级**的配比校准的：
 *   原文  体术伤害×0.3 + 效率×20  →  0.3×115 = 34.5，0.9×20 = 18，效率约占防御的 34%
 *   现式  体术伤害×(0.3 + 0.9×0.2) → 0.3×115 = 34.5，0.18×115 = 20.7，效率约占 37%
 * 也就是说在一级这个锚点上几乎没改手感，只是把低等级修正了。
 */
export const DEFENSE_PHYSICAL_RATIO = 0.3
export const DEFENSE_EFFICIENCY_RATIO = 0.2

/**
 * 单次伤害不能低于原始伤害的这个比例。
 * 防止"防御力 ≥ 攻击力"导致战斗永远打不完 —— 同级互殴要能分出胜负。
 * 跨大级压制仍然有效：弱方的原始伤害本来就被压制系数砍到很小，
 * 这个地板只是按比例兜底，不会让弱方越级破防。
 */
export const MIN_DAMAGE_RATIO = 0.1

/**
 * 等级压制系数。
 * 返回 { atkMul, defMul, nullify, domainLock, note }
 *   atkMul 作用于攻方输出，defMul 作用于守方防御值。
 * 特级之间走特级内部表（取代而非叠加）。
 */
export function suppression(atkGrade, defGrade) {
  const ia = gradeIndex(atkGrade)
  const ib = gradeIndex(defGrade)
  if (ia < 0 || ib < 0) {
    return { atkMul: 1, defMul: 1, nullify: 0, domainLock: false, note: '等级未知' }
  }
  const diff = ia - ib
  const bothTier = isTier(atkGrade) && isTier(defGrade)

  let high, low
  // pairNullify / pairDomainLock 是"这一对"的属性，作用于较弱的一方：
  // 弱方施术可能被无效化，弱方领域可能被锁。
  let pairNullify = 0
  let pairDomainLock = false

  if (bothTier) {
    // 按"较低一方的细分档位"逐级复合，不是按等级差查表
    const subA = TIER_GRADES.indexOf(atkGrade)
    const subB = TIER_GRADES.indexOf(defGrade)
    const from = Math.min(subA, subB)
    const to = Math.max(subA, subB)
    high = 1
    low = 1
    for (let k = from; k < to; k++) {
      high *= TIER_SUPPRESSION[k].high
      low *= TIER_SUPPRESSION[k].low
    }
    if (to - from >= 2) pairNullify = 0.4 // 跨两档以上，弱方术式更容易被无效化
    // 龙级对下位特级的碾压包含领域压制
    if (GRADES[Math.max(ia, ib)] === '龙级') pairDomainLock = true
  } else {
    const row = SUPPRESSION[Math.min(3, Math.abs(diff))]
    high = row.high
    low = row.low
    pairNullify = row.nullify
    pairDomainLock = row.domainLock
  }

  const attackerIsHigher = diff > 0
  const out = {
    atkMul: attackerIsHigher ? high : low,
    defMul: attackerIsHigher ? low : high,
    // 无效化只作用于较弱一方的术式 —— 也就是攻方处于劣势时
    nullify: diff < 0 ? pairNullify : 0,
    // domainLock 的语义是"**攻方**的领域能否展开"。
    // 只有攻方处于劣势时才谈得上被锁。早先这里写成了恒 false 的死逻辑。
    domainLock: diff < 0 ? pairDomainLock : false,
  }

  out.note = `${atkGrade} vs ${defGrade}（差 ${diff}）`
  out.diff = diff
  out.tierInternal = bothTier
  return out
}

/**
 * 伤害下限：至少为原始伤害的 MIN_DAMAGE_RATIO，同时至少 1 点。
 * 防御再高也不能把伤害完全吃掉，否则同级战斗会变成无限回合。
 */
export function applyDamageFloor(raw, afterDefense) {
  const floor = Math.max(1, Math.round(raw * MIN_DAMAGE_RATIO))
  return Math.max(floor, Math.round(afterDefense))
}

/** 领域展开时的输出加成与消耗减免 */
export function domainModifier(unit) {
  const d = unit.domain
  if (!d?.active) return { atk: 1, cost: 1 }
  return { atk: 1 + DOMAIN_BUFF.atkBonus, cost: 1 - DOMAIN_BUFF.costReduction }
}

/**
 * 术式伤害（第五/六节）：
 *   咒术伤害 × 术式倍率 × 咒力效率 × 相性 × 等级压制 × rand(0.9~1.1) - 敌方防御
 */
export function techniqueDamage(atk, def, { affinity = 1, rng } = {}) {
  const sup = suppression(atk.grade, def.grade)
  const dom = domainModifier(atk)
  // 跨级过多时术式可能被部分无效化
  let nullified = false
  if (sup.nullify > 0 && rng && rng() < sup.nullify) {
    affinity *= 0.5
    nullified = true
  }
  const roll = rng ? 0.9 + rng() * 0.2 : 1
  const effMul = USE_EFFICIENCY_AS_MULTIPLIER ? atk.efficiency.value : 1
  const raw = atk.cursedDamage.value * atk.technique.multiplier * effMul * affinity * sup.atkMul * dom.atk * roll
  const dmg = raw - defenseOf(def) * sup.defMul
  return {
    damage: applyDamageFloor(raw, dmg),
    sup,
    nullified,
    domainActive: !!atk.domain?.active,
    breakdown: {
      咒术伤害: atk.cursedDamage.value,
      术式倍率: atk.technique.multiplier,
      咒力效率: effMul,
      相性: affinity,
      等级压制: Number(sup.atkMul.toFixed(3)),
      领域加成: Number(dom.atk.toFixed(2)),
      随机: Number(roll.toFixed(3)),
      敌方防御: Math.round(defenseOf(def) * sup.defMul),
    },
  }
}

/** 体术伤害：不吃术式倍率，其余同源 */
export function physicalStrike(atk, def, { affinity = 1, rng } = {}) {
  const sup = suppression(atk.grade, def.grade)
  const dom = domainModifier(atk)
  const roll = rng ? 0.9 + rng() * 0.2 : 1
  const raw = atk.physicalDamage.value * affinity * sup.atkMul * dom.atk * roll
  const dmg = raw - defenseOf(def) * sup.defMul
  return {
    damage: applyDamageFloor(raw, dmg),
    sup,
    breakdown: {
      体术伤害: atk.physicalDamage.value,
      相性: affinity,
      等级压制: Number(sup.atkMul.toFixed(3)),
      领域加成: Number(dom.atk.toFixed(2)),
      随机: Number(roll.toFixed(3)),
      敌方防御: Math.round(defenseOf(def) * sup.defMul),
    },
  }
}

/** 实际消耗 = 基础消耗 ÷ 效率，领域展开时减免 */
export function techniqueCost(unit, baseCost) {
  const dom = domainModifier(unit)
  return Math.max(1, Math.round((baseCost / unit.efficiency.value) * dom.cost))
}

export function hpStatus(hp) {
  const r = hp.cur / hp.max
  if (hp.cur <= 0) return '濒死'
  if (r < 0.2) return '重伤'
  if (r < 0.6) return '轻伤'
  return '正常'
}
