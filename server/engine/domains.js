import { domainModifier } from './formula.js'

/**
 * 领域三型。
 *
 * 设定里"领域展开"是必中的，但必中的**后果**差别极大：
 *   伤害型 —— 领域本身就是武器。展开当回合一次无视防御的重击，之后每回合继续追斩
 *   规则型 —— 领域里"我说了算"。对方的术式、反转术式、领域全被封住，防御也不成立
 *   增益型 —— 领域是把自己顶起来。当场回血回咒力，之后每回合续着，还更容易抓到破绽
 *
 * 为什么要分型：原来三种领域共用同一套数值（展开当回合一下爆发），
 * 于是"必中"在读起来和打法上是同一件事 —— 抽到哪个领域都一样，
 * 玩家也没有"这个领域该怎么用"的想法。分型之后，伤害型要想"什么时候开最赚"，
 * 规则型要想"赶在它开领域之前打断"，增益型要想"先扛过这一波"。
 *
 * ⚠️ 模型只负责起名字和挑类型（那是设定与风格），数值全在这张表里 ——
 * 和"引擎管数值，AI 管叙事"是同一条线。
 *
 * ⚠️ 所有伤害/回复都基于 `咒术伤害 × 领域加成`，也就是展开期间的自身强度。
 * 想调整手感就改下面这几个比例，别散到 combat.js 里去。
 */
export const DOMAIN_TYPES = ['伤害型', '规则型', '增益型']

/**
 * 老存档、以及所有没写类型的场合都按伤害型走。
 *
 * 这一条同时是"领域开了必须掉血"的兜底：分型之前存下来的进度、
 * 或者模型没按要求填类型时，领域至少是最直观的那一种，不会变成开了没反应。
 */
export const DOMAIN_TYPE_DEFAULT = '伤害型'

/** 每一型的数值。burst/tick 都是"占自身咒术伤害的比例" */
export const DOMAIN_KIT = {
  伤害型: {
    tag: '伤害',
    brief: '必中重击，之后每回合追斩',
    burst: 2.0,   // 展开当回合：一次无视防御的重击，≈ 两发术式
    tick: 0.55,   // 展开期间每回合：继续咬
  },
  规则型: {
    tag: '规则',
    brief: '封住对方的术式、反转术式与领域',
    burst: 0.5,
    tick: 0.15,
    // 领域内对方身上生效的规则。改这里等于改规则型领域的强度
    seal: { technique: true, reverse: true, domain: true, defense: true, damageMul: 0.7 },
  },
  增益型: {
    tag: '增益',
    brief: '当场回血回咒力，之后每回合续着，出手更容易暴击',
    burst: 0,
    tick: 0,
    openHealRatio: 0.18, // 展开当回合：回复最大生命
    openCeRatio: 0.25,   // 展开当回合：回复最大咒力（刚好把展开消耗补回来一截）
    tickHealRatio: 0.05, // 展开期间每回合：回血
    tickCeRatio: 0.04,
    critBonus: 0.18,     // 展开期间暴击率加成
  },
}

/**
 * 按等级掷领域类型。
 *
 * 和 DOMAIN_TIER 的命名对齐：超特级的领域叫「规则级领域」，
 * 那它就多半真的是规则型 —— 名字和打法对不上是最别扭的事。
 */
const TYPE_WEIGHTS = {
  半成品: [['伤害型', 6], ['增益型', 3], ['规则型', 1]],
  完整领域: [['伤害型', 4], ['规则型', 3], ['增益型', 3]],
  规则级领域: [['规则型', 5], ['伤害型', 3], ['增益型', 2]],
  概念级领域: [['规则型', 4], ['伤害型', 4], ['增益型', 2]],
}
const DEFAULT_WEIGHTS = [['伤害型', 4], ['规则型', 3], ['增益型', 3]]

export function rollDomainType(rng, tierName = '') {
  const table = TYPE_WEIGHTS[tierName] || DEFAULT_WEIGHTS
  const total = table.reduce((n, [, w]) => n + w, 0)
  let r = rng() * total
  for (const [type, w] of table) {
    r -= w
    if (r < 0) return type
  }
  return table[0][0]
}

/** 归一化：只认三种，其余（含老存档的 undefined）都当伤害型 */
export function domainTypeOf(domain) {
  const t = domain?.type
  return DOMAIN_TYPES.includes(t) ? t : DOMAIN_TYPE_DEFAULT
}

/**
 * 生成时用：模型给的类型合不合法。
 * 不合法返回空串，由调用方按等级掷一个 —— 这里不兜默认值，
 * 否则"模型没填"和"模型填了伤害型"就分不出来了。
 */
export function normalizeDomainType(v) {
  return DOMAIN_TYPES.includes(v) ? v : ''
}

/**
 * 玩家侧兜底用的类型（生成流程里没有随机数可用）。
 *
 * 和 DOMAIN_TIER 的命名对齐：叫「规则级领域」的就按规则型算。
 */
export function defaultDomainTypeFor(tierName) {
  return tierName === '规则级领域' || tierName === '概念级领域'
    ? '规则型'
    : DOMAIN_TYPE_DEFAULT
}

export function domainKit(domain) {
  return DOMAIN_KIT[domainTypeOf(domain)]
}

/** 界面上挂一个类型标签用 */
export function domainBrief(domain) {
  if (!domain?.unlocked && !domain?.active) return ''
  const kit = domainKit(domain)
  return `${domainTypeOf(domain)}· ${kit.brief}`
}

/**
 * 规则型领域套在对方身上的限制。
 *
 * 判据是"对方的领域正开着" —— 领域是环境，只要还在展开就一直在生效，
 * 不需要每次都重新施加一遍。
 */
export function sealOf(unit, opponent) {
  const d = opponent?.domain
  if (!d?.active) return null
  return domainKit(d).seal || null
}

/** 领域展开当回合的结算。返回的字段全部由调用方写进事件 */
export function domainOpenEffects(actor) {
  const type = domainTypeOf(actor.domain)
  const kit = DOMAIN_KIT[type]
  // 领域加成（+50% 输出）在展开的那一刻就已经生效，所以重击吃得到这一层
  const power = (actor.cursedDamage?.value || 0) * domainModifier(actor).atk
  const out = { type, kit, burst: 0, heal: 0, ce: 0, sureHit: false, lines: [] }

  if (kit.burst > 0) {
    out.burst = Math.max(1, Math.round(power * kit.burst))
    out.sureHit = true
  }
  if (kit.openHealRatio) {
    out.heal = Math.max(0, Math.min(
      actor.hp.max - actor.hp.cur,
      Math.round(actor.hp.max * kit.openHealRatio),
    ))
    out.ce = Math.max(0, Math.min(
      actor.ce.max - actor.ce.cur,
      Math.round(actor.ce.max * kit.openCeRatio),
    ))
  }
  return out
}

/**
 * 展开期间每回合的持续效果。
 *
 * 返回 null 表示这一型没有每回合效果（增益型只有展开当回合那一口），
 * 调用方据此决定要不要往事件流里塞一条。
 */
export function domainTickEffects(actor, target) {
  const type = domainTypeOf(actor.domain)
  const kit = DOMAIN_KIT[type]
  const power = (actor.cursedDamage?.value || 0) * domainModifier(actor).atk
  const out = { type, damage: 0, heal: 0, ce: 0, lines: [] }

  if (kit.tick > 0) {
    out.damage = Math.max(1, Math.round(power * kit.tick))
  }
  if (kit.tickHealRatio) {
    out.heal = Math.max(0, Math.min(
      actor.hp.max - actor.hp.cur,
      Math.round(actor.hp.max * kit.tickHealRatio),
    ))
    out.ce = Math.max(0, Math.min(
      actor.ce.max - actor.ce.cur,
      Math.round(actor.ce.max * kit.tickCeRatio),
    ))
  }
  if (!out.damage && !out.heal && !out.ce) return null

  if (out.damage) out.lines.push(`领域内无处可躲，${out.damage} 点伤害自行落下`)
  if (out.heal) out.lines.push(`领域续着你的伤，回复 ${out.heal} 点生命`)
  if (out.ce) out.lines.push(`领域替你收拢咒力，回复 ${out.ce} 点咒力`)
  return out
}

/**
 * 展开当回合那几行旁白。
 *
 * 不带主语写成 —— 这几行会分别落在"我方/敌方"两栏里，
 * 自带人称反而会和外面的标签打架。
 */
export function domainOpenLines(out) {
  const lines = []
  if (out.sureHit) {
    lines.push(`必中效果当场落下，无视防御造成 ${out.burst} 点伤害`)
  }
  if (out.type === '规则型') {
    lines.push('规则开始改写：术式、反转术式、领域展开在这里都不成立')
  }
  if (out.type === '增益型') {
    if (out.heal) lines.push(`领域把伤往回推，回复 ${out.heal} 点生命`)
    if (out.ce) lines.push(`咒力被重新收拢，回复 ${out.ce} 点咒力`)
    if (!out.heal && !out.ce) lines.push('状态已经满溢，领域只把出手的破绽放大了')
  }
  return lines
}
