import { tuneAttributeProfile } from './rolls.js'
import { DOMAIN_TIER, GRADES, isTier, numeric } from './tables.js'
import { hpStatus } from './formula.js'
import { DOMAIN_TYPE_DEFAULT, defaultDomainTypeFor, normalizeDomainType } from './domains.js'
import { TECH_COST_RATIO, DOMAIN_COST_RATIO } from './state.js'

/**
 * 改自己。
 *
 * 开局那套「自主定义 → 逐项调数值」只活在创建流程里：掷完、选定、进游戏之后，
 * 那张卡就没了。但一个数值驱动的游戏，玩家总会有"我想把这局调成我想要的样子"
 * 的时候 —— 与其让他去改存档文件，不如把这扇门摆在面板上。
 *
 * 三条规矩，和开局调数值（rolls.tuneAttributeProfile）完全一致：
 *   1. 数值夹在合法区间里，只是封顶放宽到**龙级** —— 已经走到那儿的人
 *      不该因为动了一下滑条就被打回超特级的上限。
 *   2. 等级一律由最终数字反推，玩家能定的是数字，等级只是它的标签。
 *   3. 领域觉醒、防御、术式消耗都是派生量，一起重算。
 *
 * 派生规则不在这里抄第二遍：把角色投影成一份属性档案，交给 tuneAttributeProfile，
 * 再投影回来。两处各写一套的话，迟早会分叉成"开局按一套、游戏里按另一套"。
 */

/** 局内能改到多高。开局卡封在超特级，是因为龙级该靠成长走到；走到之后再改就不该被砍回来 */
const LIVE_CAP = GRADES.at(-1)

/** 角色 → 属性档案。只取 tuneAttributeProfile 认得的那几个字段 */
function toProfile(p) {
  return {
    hp: { value: p.hp.max, grade: p.hp.grade },
    ce: { value: p.ce.max, grade: p.ce.grade },
    cursedDamage: { value: p.cursedDamage.value, grade: p.cursedDamage.grade },
    physicalDamage: { value: p.physicalDamage.value, grade: p.physicalDamage.grade },
    efficiency: { value: p.efficiency.value, grade: p.efficiency.grade },
    techniqueGrade: p.technique.grade,
    techniqueMultiplier: p.technique.multiplier,
    techniqueCooldown: p.technique.cooldown,
    overallGrade: p.grade,
    domain: p.domain,
    domainUnlocked: !!p.domain?.unlocked,
    domainTierName: p.domain?.tierName,
  }
}

const fmt = (v) => Math.round(v).toLocaleString()

/**
 * 改这一局的主角。就地改 state.player，返回一句句人话描述改了什么
 * （界面拿它写回执 —— 静默生效的话，玩家会怀疑自己有没有点中）。
 */
export function tunePlayer(state, numbers = {}) {
  const p = state.player
  if (!p) return []

  const before = {
    hpMax: p.hp.max, ceMax: p.ce.max,
    cd: p.cursedDamage.value, pd: p.physicalDamage.value,
    eff: p.efficiency.value, mult: p.technique.multiplier,
    cd2: p.technique.cooldown, grade: p.grade,
  }

  const next = tuneAttributeProfile(toProfile(p), numbers, { cap: LIVE_CAP })

  /*
   * 当前值怎么办。
   *
   * 显式给了就按要求夹在 [0, 上限] 里；没给就**按比例跟着走** ——
   * 把血条上限从 100 改到 800 的人，多半想让自己"满血地"变强，
   * 而不是变成一个 40/800 的半死人。反过来，一个 40/100 的伤员
   * 也不该因为改了上限就凭空痊愈：比例是这两件事里唯一说得通的不变量。
   */
  const follow = (raw, oldMax, newMax, oldCur) => {
    const v = numeric(raw)
    if (!Number.isNaN(v)) return Math.max(0, Math.min(newMax, Math.round(v)))
    if (oldMax <= 0) return newMax
    const ratio = Math.max(0, Math.min(1, oldCur / oldMax))
    return Math.max(0, Math.min(newMax, Math.round(newMax * ratio)))
  }

  p.hp.max = next.hp.value
  p.hp.grade = next.hp.grade
  p.hp.cur = follow(numbers.hpCur, before.hpMax, next.hp.value, p.hp.cur)

  p.ce.max = next.ce.value
  p.ce.grade = next.ce.grade
  p.ce.cur = follow(numbers.ceCur, before.ceMax, next.ce.value, p.ce.cur)

  p.cursedDamage = { ...p.cursedDamage, value: next.cursedDamage.value, grade: next.cursedDamage.grade }
  p.physicalDamage = { ...p.physicalDamage, value: next.physicalDamage.value, grade: next.physicalDamage.grade }
  p.efficiency = { ...p.efficiency, value: next.efficiency.value, grade: next.efficiency.grade }

  p.technique = {
    ...p.technique,
    grade: next.techniqueGrade,
    multiplier: next.techniqueMultiplier,
    cooldown: next.techniqueCooldown,
    // 消耗是咒力上限的比例，不是自由变量 —— 上限一改就得跟着走
    cost: Math.max(1, Math.round(p.ce.max * TECH_COST_RATIO)),
  }

  p.grade = next.overallGrade
  p.domain = next.domainUnlocked
    ? {
        ...next.domain,
        unlocked: true,
        grade: p.grade,
        tierName: DOMAIN_TIER[p.grade] || next.domain?.tierName || '半成品',
        // 从没觉醒过的人被数值顶上特级：领域得有个能认的名字和打法
        name: next.domain?.name || '未命名领域',
        sureHit: next.domain?.sureHit || '',
        type: normalizeDomainType(next.domain?.type)
          || defaultDomainTypeFor(DOMAIN_TIER[p.grade] || '半成品')
          || DOMAIN_TYPE_DEFAULT,
        active: false,
        cost: Math.max(1, Math.round(p.ce.max * DOMAIN_COST_RATIO)),
      }
    : { ...next.domain, unlocked: false, active: false }

  p.status = hpStatus(p.hp)

  const notes = []
  const row = (label, was, now, suffix = '') => {
    if (was === now) return
    notes.push(`${label} ${fmt(was)} → ${fmt(now)}${suffix}`)
  }
  row('血条上限', before.hpMax, p.hp.max)
  row('咒力上限', before.ceMax, p.ce.max)
  row('咒术伤害', before.cd, p.cursedDamage.value)
  row('体术伤害', before.pd, p.physicalDamage.value)
  if (before.eff !== p.efficiency.value) {
    notes.push(`咒力效率 ${Math.round(before.eff * 100)}% → ${Math.round(p.efficiency.value * 100)}%`)
  }
  if (before.mult !== p.technique.multiplier) {
    notes.push(`术式倍率 ×${before.mult} → ×${p.technique.multiplier}`)
  }
  if (before.cd2 !== p.technique.cooldown) {
    notes.push(`术式冷却 ${before.cd2} → ${p.technique.cooldown} 回合`)
  }
  if (before.grade !== p.grade) {
    notes.push(`等级 ${before.grade} → ${p.grade}`)
    if (isTier(p.grade)) notes.push(`跨进特级：领域「${p.domain.name}」已觉醒`)
  }
  return notes
}
