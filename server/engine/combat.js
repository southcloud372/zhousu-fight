import {
  techniqueDamage, physicalStrike, techniqueCost, hpStatus, suppression, REVERSE_TABLE, domainModifier,
} from './formula.js'
import {
  DOMAIN_TYPE_DEFAULT, domainTypeOf, domainKit, domainOpenEffects, domainOpenLines,
  domainTickEffects, sealOf, DOMAIN_KIT,
} from './domains.js'
import { ENEMY_ARCHETYPES } from './rolls.js'
import { GRADES, gradeIndex } from './tables.js'
import { enemyProfile } from './visibility.js'
import { applyGradeUp } from './state.js'
import { completeIntervention } from './wheel.js'
import { noteDeath } from './plotdeps.js'
import { rint } from './dice.js'

/**
 * 战斗引擎（第六节）。
 * 三种模式共用同一套数值判定，区别只在"谁来喊行动"：
 *   manual    —— 玩家每回合选行动，引擎判定，模型写演出
 *   skip      —— 引擎自动跑完整场，模型写一两段简述
 *   narrative —— 引擎自动跑完整场，模型写长篇分镜
 *
 * 跳过/剧情模式的胜负同样由引擎算，不交给模型：原文说"根据双方等级、属性、
 * 术式、领域、相性、地形、先手等条件直接计算胜负"，引擎算就是"计算"；
 * 交给模型算则会破坏等级压制表。
 */

export const COMBAT_MODES = ['manual', 'skip', 'narrative']

export const MODE_LABELS = {
  manual: '手动模式（回合制）',
  skip: '跳过模式（快速结算）',
  narrative: '剧情描述式（自动演出）',
}

const BASE_CE_REGEN_RATIO = 0.03 // 自然恢复 = 基础恢复 × 效率（第一节）
const MAX_ROUNDS = 30
const DEFEND_REDUCTION = 0.35
/** 领域可持续回合数，档位越高越久 */
const DOMAIN_DURATION = { 弱特级: 5, 标特级: 6, 超特级: 7, 龙级: 8 }

/**
 * 战斗的"手感"三件套：暴击、连击、失衡。
 *
 * 加这三个不是为了改平衡 —— 同级同级的胜负关系由等级表决定，不能动 ——
 * 而是因为原来的手动战斗在**读起来**是平的：每回合都是"造成 N 点伤害"，
 * N 只在 ±10% 里晃，打到第十回合和第1回合没有任何区别，玩家感觉不到
 * 自己在推进什么。暴击给的是"这一下不一样"，连击给的是"我占了上风"，
 * 失衡给的是"我把它打崩了"。三者都不改期望值太多，但把曲线撑起来了。
 *
 * ⚠️ 它们只活在 act() 这一层，**绝不能下沉到 formula.js**：
 *    tests/runtime.test.mjs 的平衡回归（"四级打超特级必须几乎不掉血"、
 *    "同级术式不能超过回合上限"）直接对 techniqueDamage / physicalStrike
 *    断言。那里必须保持纯函数，掺进随机项就没法回归了。
 */
/** 暴击倍率 */
export const CRIT_MUL = 1.8
/** 暴击率 = 基础 + 咒力效率 × 这个系数（效率越高越容易打出破绽） */
const CRIT_BASE = 0.06
const CRIT_EFF_COEF = 0.08
const CRIT_CAP = 0.28
/** 每层连击的加成，以及最多叠几层 */
export const COMBO_STEP = 0.05
export const COMBO_CAP = 6
// 领域展开当回合打多少、之后每回合咬多少，按领域的三型分开了 ——
// 见 engine/domains.js 的 DOMAIN_KIT。这里不再留一个全局比例。

// 反转术式的档位表来自 formula.js —— 战斗外的疗伤（recovery.js）用的是同一张表，
// 免得同一招在战斗里外回血不一样

/**
 * 反转术式一回合能用几次。
 *
 * 它**不占回合数** —— 用完之后照常出招，这是它和普通行动的区别。
 * 唯一的闸门是咒力，所以再给一道次数限制，免得"奶满再打"变成唯一解。
 * 想放开就把这个数调大（设成 99 约等于无限）。
 */
export const FREE_REVERSE_PER_ROUND = 1

export function unitSpeed(u) {
  return u.physicalDamage.value * 0.5 + u.efficiency.value * 100
}

/** 玩家看到的敌方咒力只是估算值，不是真值（第二节） */
function estimateCe(unit, rng) {
  const v = unit.ce.cur * (0.85 + rng() * 0.3)
  const mag = Math.pow(10, Math.max(0, String(Math.floor(v)).length - 2))
  return Math.max(0, Math.round(v / mag) * mag)
}

export function initCombat(state, rng, { mode, enemy, reason, intervention = null, lethalIntent = false }) {
  state.player.domain.active = false // 每场战斗重新展开
  // 连击与失衡是"这一场"里的东西，不能跨场带进来
  state.player._combo = 0
  state.player._stagger = 0
  state.combat = {
    mode,
    reason,
    turn: 1,
    enemy,
    // 战斗向的介入战：打完之后要把「这一天」记进时间线（见 finishCombat）
    intervention,
    // 玩家这一手是不是奔着要命去的 —— 赢了才算击杀，否则只是击退
    lethalIntent: !!lethalIntent,
    playerFirst: unitSpeed(state.player) >= unitSpeed(enemy),
    over: false,
    outcome: null,
    freeUsed: 0, // 本回合已用的不占回合行动（反转术式）
    freeLog: [],
    log: [],
    stats: {
      usedTechnique: false,
      usedMelee: false,
      usedReverse: false,
      usedDomain: false,
      lowestHpRatio: 1,
    },
  }
  state.pendingCombat = null
  return state.combat
}

// ---------------------------------------------------------------- 行动执行

function spendCe(unit, amount) {
  if (unit.ce.cur >= amount) {
    unit.ce.cur -= amount
    return { overdraft: 0 }
  }
  // 咒力不足强行施术：扣等量血条（第一节）
  const overdraft = amount - unit.ce.cur
  unit.ce.cur = 0
  unit.hp.cur = Math.max(0, unit.hp.cur - overdraft)
  return { overdraft }
}

/** 一次反转术式要烧多少咒力、回多少血 —— 面板和按钮提示都要显示，所以单独给出来 */
export function reversePreview(unit) {
  const row = REVERSE_TABLE[unit?.reverseCursedTechnique?.level]
  if (!row) return null
  return {
    cost: Math.round(unit.ce.max * row.cost),
    heal: Math.round(unit.hp.max * row.heal),
    level: unit.reverseCursedTechnique.level,
  }
}

function reverseHeal(unit) {
  const pv = reversePreview(unit)
  if (!pv) return null
  if (unit.ce.cur < pv.cost) return null
  unit.ce.cur -= pv.cost
  const before = unit.hp.cur
  unit.hp.cur = Math.min(unit.hp.max, unit.hp.cur + pv.heal)
  return { healed: unit.hp.cur - before, cost: pv.cost }
}

/**
 * 反转术式（不占回合的自由行动）。
 *
 * 玩家在出招前后都能按，按完照样出手 —— 这是它和普通行动唯一的区别，
 * 也是它值得单独走一条接口的原因：它不能推进回合，也就不能触发敌方行动。
 * 失败时一定给理由（咒力不够 / 本回合用过了 / 血是满的），
 * 不能再出现"点了没反应、还以为状态栏坏了"的情况。
 */
export function freeReverse(state) {
  const c = state.combat
  const p = state.player
  if (!c || c.over) return { ok: false, reason: '当前不在战斗中' }

  const pv = reversePreview(p)
  if (!pv) return { ok: false, reason: '尚未掌握反转术式' }
  if ((c.freeUsed || 0) >= FREE_REVERSE_PER_ROUND) {
    return { ok: false, reason: `本回合已经用过一次（每回合 ${FREE_REVERSE_PER_ROUND} 次）` }
  }
  if (p.hp.cur >= p.hp.max) return { ok: false, reason: '血条已经满了' }
  if (p.ce.cur < pv.cost) return { ok: false, reason: `咒力不足（需 ${pv.cost}，现有 ${p.ce.cur}）` }

  const before = p.hp.cur
  p.ce.cur -= pv.cost
  p.hp.cur = Math.min(p.hp.max, p.hp.cur + pv.heal)
  const healed = p.hp.cur - before

  c.freeUsed = (c.freeUsed || 0) + 1
  c.freeLog.push({ turn: c.turn, healed, cost: pv.cost })
  c.stats.usedReverse = true
  c.stats.lowestHpRatio = Math.min(c.stats.lowestHpRatio, p.hp.cur / p.hp.max)
  p.status = hpStatus(p.hp)

  return {
    ok: true,
    healed,
    cost: pv.cost,
    lines: [`反转术式发动（不占回合），回复 ${healed} 点生命，消耗 ${pv.cost} 点咒力`],
  }
}

/** 当前连击加成（0 层 = ×1，6 层 = ×1.3） */
function comboMul(unit) {
  return 1 + Math.min(unit._combo || 0, COMBO_CAP) * COMBO_STEP
}

/**
 * 结算一次伤害；防御姿态减伤，连击加成在这里统一乘上去。
 *
 * 打完记一笔：攻方连击 +1，守方清零 —— 连击是"我连着打中，没被打断"，
 * 一旦挨了一下就断了。这条规则让"压制"变成一个玩家能看见、也能被夺走的东西。
 *
 * 规则型领域另外压一手：领域里的人出手打不实（见 domains.js 的 seal.damageMul）。
 */
function dealDamage(attacker, target, raw) {
  const seal = sealOf(attacker, target)
  let dmg = Math.round(raw * comboMul(attacker) * (seal?.damageMul ?? 1))
  if (target._defending) dmg = Math.round(dmg * (1 - DEFEND_REDUCTION))
  target.hp.cur = Math.max(0, target.hp.cur - dmg)
  attacker._combo = (attacker._combo || 0) + 1
  target._combo = 0
  return dmg
}

/**
 * 暴击判定。效率越高越容易在交手里抓到破绽 —— 这也让"咒力效率"
 * 这个原本只在公式里当乘数的属性，在手动战斗里有了手感上的存在感。
 *
 * 增益型领域展开期间额外加成：领域把对手的破绽放大了。
 */
function critRoll(actor, rng) {
  const eff = actor.efficiency?.value ?? 0.7
  const bonus = actor.domain?.active ? (domainKit(actor.domain).critBonus || 0) : 0
  const cap = CRIT_CAP + bonus
  return rng() < Math.min(cap, CRIT_BASE + eff * CRIT_EFF_COEF + bonus)
}

/**
 * 暴击的后果：除了那 1.8 倍，还打断对方下一手。
 *
 * "打断"而不是"这一回合直接少打一下"，是因为先手顺序会变：如果出手方是后手，
 * 对方这一回合已经动过了，当场结算就白暴击了。记成"下一手作废"，
 * 谁先谁后都一样公平。
 */
function markCrit(actor, target, ev) {
  ev.crit = true
  ev.lines.push('—— 抓住破绽，这一击是暴击')
  target._stagger = 1
  ev.lines.push('对方被打得踉跄，下一手递不出来')
}

function act(actor, target, action, rng) {
  const ev = { type: action.type, lines: [] }
  // 对方铺开的规则型领域：这一手能不能递出去，先看规则
  const seal = sealOf(actor, target) || {}

  // 上一回合的防御姿态在自己再次行动时失效
  const wasDefending = !!actor._defending
  actor._defending = false
  if (wasDefending) ev.lines.push('（防御姿态解除）')

  switch (action.type) {
    case 'technique': {
      if (seal.technique) { ev.lines.push('术式被领域规则封住，这一手递不出去'); return ev }
      if (actor.technique.cdLeft > 0) {
        ev.lines.push(`术式仍在冷却（剩 ${actor.technique.cdLeft} 回合），动作落空`)
        return ev
      }
      const cost = techniqueCost(actor, actor.technique.cost)
      const { overdraft } = spendCe(actor, cost)
      actor.technique.cdLeft = actor.technique.cooldown

      const r = techniqueDamage(actor, target, { rng })
      const crit = critRoll(actor, rng)
      const dmg = dealDamage(actor, target, crit ? Math.round(r.damage * CRIT_MUL) : r.damage)
      ev.damage = dmg
      ev.breakdown = r.breakdown
      ev.nullified = r.nullified
      ev.lines.push(`${actor.technique.name}轰出，造成 ${dmg} 点伤害`)
      if (crit) markCrit(actor, target, ev)
      if (r.nullified) ev.lines.push('等级差距过大，术式被部分无效化')
      if (overdraft > 0) ev.lines.push(`咒力见底仍强行施术，反噬 ${overdraft} 点生命`)
      break
    }

    case 'physical': {
      const r = physicalStrike(actor, target, { rng })
      const crit = critRoll(actor, rng)
      const dmg = dealDamage(actor, target, crit ? Math.round(r.damage * CRIT_MUL) : r.damage)
      ev.damage = dmg
      ev.breakdown = r.breakdown
      ev.lines.push(`欺身而入，体术命中，造成 ${dmg} 点伤害`)
      if (crit) markCrit(actor, target, ev)
      break
    }

    case 'defend': {
      // 规则之内防御姿态不成立：咒力照收，减伤没有
      if (seal.defense) {
        const regen = Math.round(actor.ce.max * BASE_CE_REGEN_RATIO * actor.efficiency.value * 2)
        actor.ce.cur = Math.min(actor.ce.max, actor.ce.cur + regen)
        ev.lines.push(`收势卸力，回复 ${regen} 点咒力；领域规则之下，防御不成立`)
        break
      }
      actor._defending = true
      const regen = Math.round(actor.ce.max * BASE_CE_REGEN_RATIO * actor.efficiency.value * 2)
      actor.ce.cur = Math.min(actor.ce.max, actor.ce.cur + regen)
      ev.lines.push(`收势防御，回复 ${regen} 点咒力`)
      break
    }

    case 'domain': {
      const d = actor.domain
      if (!d?.unlocked) { ev.lines.push('尚未领悟领域，动作落空'); return ev }
      if (d.active) { ev.lines.push('领域已在展开中'); return ev }
      // 高三级及以上压制时，低等级方的领域无法展开（第三节）
      if (suppression(actor.grade, target.grade).domainLock) {
        ev.lines.push('对方的压制太强，领域展不开')
        return ev
      }
      // 对方已经铺开规则型领域：规则之内你的领域不成立
      if (sealOf(actor, target)?.domain) {
        ev.lines.push('对方的领域规则压着，你的领域展不开')
        return ev
      }
      const cost = techniqueCost(actor, d.cost)
      if (actor.ce.cur < cost) { ev.lines.push('咒力不足以展开领域，动作落空'); return ev }
      actor.ce.cur -= cost
      d.active = true
      d.turnsLeft = DOMAIN_DURATION[d.grade] || 5
      ev.domainOpened = true
      ev.domainName = d.name
      ev.sureHit = d.sureHit || ''
      ev.domainType = domainTypeOf(d)

      /*
       * 展开当回合的效果按型走（见 domains.js）：
       * 伤害型是一次无视防御的重击，规则型开始改写规则，增益型把自己顶起来。
       * 这一下都不进 dealDamage —— 它不是"打中一拳"，是"规则开始生效"，
       * 所以不吃连击、也不触发连击。
       */
      const out = domainOpenEffects(actor)
      if (out.burst > 0) {
        target.hp.cur = Math.max(0, target.hp.cur - out.burst)
        ev.damage = out.burst
        ev.sureHitBurst = true
      }
      if (out.heal > 0) actor.hp.cur = Math.min(actor.hp.max, actor.hp.cur + out.heal)
      if (out.ce > 0) actor.ce.cur = Math.min(actor.ce.max, actor.ce.cur + out.ce)
      ev.healed = out.heal
      ev.recovered = out.ce

      ev.lines.push(`领域展开——${d.name}${d.sureHit ? `。${d.sureHit}` : ''}`)
      ev.lines.push(...domainOpenLines(out))
      break
    }

    case 'reverse': {
      /*
       * 先判封禁再算治疗 —— reverseHeal 会真的扣咒力、加血，
       * 反过来写的话"被封住"那一下血已经加上去了，只是没报出来。
       */
      if (seal.reverse) { ev.lines.push('领域内禁止治疗，反转术式用不出来'); return ev }
      const r = reverseHeal(actor)
      if (!r) { ev.lines.push('反转术式未掌握或咒力不足，动作落空'); return ev }
      ev.healed = r.healed
      ev.lines.push(`反转术式发动，回复 ${r.healed} 点生命`)
      break
    }

    case 'flee': {
      const a = unitSpeed(actor)
      const b = unitSpeed(target)
      const chance = Math.max(0.1, Math.min(0.85, a / (a + b)))
      if (rng() < chance) { ev.fled = true; ev.lines.push('成功脱离战斗') }
      else ev.lines.push('脱离失败，被逼回原地')
      break
    }
  }
  return ev
}

/** 敌方 AI：按性格与局势出手，不降智也不站桩（第七节） */
export function chooseEnemyAction(state, rng) {
  const e = state.combat.enemy
  const arch = ENEMY_ARCHETYPES[e.archetype] || ENEMY_ARCHETYPES.均衡
  const hpRatio = e.hp.cur / e.hp.max
  // 被我方的规则型领域锁住的招不再往外递 —— 否则面板上会一直出现
  // "对方又试了一次被封住的术式"，看起来像 AI 坏了
  const seal = sealOf(e, state.player) || {}

  if (!seal.reverse && hpRatio < 0.35 && e.reverseCursedTechnique?.level !== '未掌握' && e.ce.cur > e.ce.max * 0.3) {
    return { type: 'reverse' }
  }
  if (!seal.domain && e.domain?.unlocked && !e.domain.active && e.ce.cur > e.domain.cost * 2 && rng() < 0.45 * arch.aggression) {
    return { type: 'domain' }
  }
  const canTech = !seal.technique && e.technique.cdLeft === 0 && e.ce.cur >= e.technique.cost
  if (canTech && rng() < 0.55 + 0.4 * arch.aggression) return { type: 'technique' }
  if (!seal.defense && hpRatio < arch.defendBelow && rng() < arch.cunning) return { type: 'defend' }
  if (canTech) return { type: 'technique' }
  return { type: 'physical' }
}

/** 自动模式下玩家侧也走一套 AI，但用的是玩家自己的术式与领域 */
function choosePlayerAutoAction(state, rng) {
  const p = state.player
  const hpRatio = p.hp.cur / p.hp.max
  const seal = sealOf(p, state.combat.enemy) || {}

  if (!seal.reverse && hpRatio < 0.3 && p.reverseCursedTechnique.level !== '未掌握' && p.ce.cur > p.ce.max * 0.3) {
    return { type: 'reverse' }
  }
  if (!seal.domain && p.domain.unlocked && !p.domain.active && p.ce.cur > p.domain.cost * 2 && rng() < 0.6) {
    return { type: 'domain' }
  }
  if (!seal.technique && p.technique.cdLeft === 0 && p.ce.cur >= p.technique.cost) return { type: 'technique' }
  if (!seal.defense && hpRatio < 0.4 && rng() < 0.3) return { type: 'defend' }
  return { type: 'physical' }
}

/**
 * 领域在展开期间的持续效果。
 *
 * 放在双方都动完之后 —— 领域是"环境"，不是某一方的一手，谁先手都该在
 * 这一回合结束时落下。只对还活着的对手生效：对手已经倒了还继续咬，
 * 面板上会出现"尸体又掉了 88 点血"。
 */
function applyDomainTicks(state, events) {
  const p = state.player
  const e = state.combat.enemy
  for (const [owner, foe, side] of [[p, e, 'player'], [e, p, 'enemy']]) {
    if (!owner.domain?.active) continue
    if (owner.hp.cur <= 0 || foe.hp.cur <= 0) continue
    const tick = domainTickEffects(owner, foe)
    if (!tick) continue

    if (tick.damage) {
      foe.hp.cur = Math.max(0, foe.hp.cur - tick.damage)
      // 领域里躲不开的这一下同样算"挨打"：压制的节奏被它打断
      foe._combo = 0
    }
    if (tick.heal) owner.hp.cur = Math.min(owner.hp.max, owner.hp.cur + tick.heal)
    if (tick.ce) owner.ce.cur = Math.min(owner.ce.max, owner.ce.cur + tick.ce)

    events.push({
      side,
      type: 'domain-tick',
      domainTick: true,
      domainType: tick.type,
      damage: tick.damage,
      healed: tick.heal,
      recovered: tick.ce,
      lines: tick.lines,
    })
  }
}

// ---------------------------------------------------------------- 回合

function endOfRound(unit) {
  const regen = Math.round(unit.ce.max * BASE_CE_REGEN_RATIO * unit.efficiency.value)
  unit.ce.cur = Math.min(unit.ce.max, unit.ce.cur + regen)
  if (unit.technique.cdLeft > 0) unit.technique.cdLeft--

  if (unit.domain?.active) {
    unit.domain.turnsLeft = (unit.domain.turnsLeft ?? 0) - 1
    if (unit.ce.cur >= unit.domain.cost) {
      unit.ce.cur -= unit.domain.cost
    } else {
      unit.ce.cur = 0
      unit.domain.active = false
      return '领域因咒力耗尽而崩解'
    }
    if (unit.domain.turnsLeft <= 0) {
      unit.domain.active = false
      return '领域维持到极限，自行闭合'
    }
  }
  return null
}

function checkOver(state) {
  if (state.combat.enemy.hp.cur <= 0) return { winner: 'player', loser: 'enemy' }
  if (state.player.hp.cur <= 0) return { winner: 'enemy', loser: 'player' }
  return null
}

/** 被暴击打散的这一手：本回合动不了。返回 true 表示这一手被吃掉了 */
function consumeStagger(unit, events, side, label) {
  if (!unit._stagger) return false
  unit._stagger = 0
  events.push({
    side,
    type: 'stagger',
    staggered: true,
    lines: [`${label}还没站稳，这一手被压了回去`],
  })
  return true
}

/**
 * 推进一个回合。manual 模式下玩家传 action；autoPlayer 为 true 时玩家侧走 AI。
 */
export function runRound(state, rng, playerAction, { autoPlayer = false } = {}) {
  const c = state.combat
  const p = state.player
  const e = c.enemy
  const events = []

  if (c.over) return { events, over: true, outcome: c.outcome }

  c.freeUsed = 0 // 新回合，不占回合的行动次数恢复
  c.freeLog ||= []

  const playerPick = autoPlayer || !playerAction ? choosePlayerAutoAction(state, rng) : playerAction

  const doPlayer = () => {
    if (consumeStagger(p, events, 'player', '你')) return
    const ev = act(p, e, playerPick, rng)
    ev.side = 'player'
    events.push(ev)
    if (ev.type === 'technique') c.stats.usedTechnique = true
    if (ev.type === 'physical') c.stats.usedMelee = true
    if (ev.type === 'reverse' && ev.healed) c.stats.usedReverse = true
    if (ev.type === 'domain' && ev.domainOpened) c.stats.usedDomain = true
  }
  const doEnemy = () => {
    if (consumeStagger(e, events, 'enemy', e.name)) return
    const ev = act(e, p, chooseEnemyAction(state, rng), rng)
    ev.side = 'enemy'
    events.push(ev)
  }

  if (c.playerFirst) {
    doPlayer()
    if (!checkOver(state) && !events.some((x) => x.fled)) doEnemy()
  } else {
    doEnemy()
    if (!checkOver(state) && !events.some((x) => x.fled)) doPlayer()
  }

  // 领域是"环境"，在双方都动完之后落下（见 applyDomainTicks）
  if (!events.some((x) => x.fled)) applyDomainTicks(state, events)

  const notes = [endOfRound(p), endOfRound(e)].filter(Boolean)
  p.status = hpStatus(p.hp)

  c.stats.lowestHpRatio = Math.min(c.stats.lowestHpRatio, p.hp.cur / p.hp.max)

  if (events.some((x) => x.fled)) {
    c.over = true
    c.outcome = { winner: 'fled', loser: null }
  } else {
    const over = checkOver(state)
    if (over) { c.over = true; c.outcome = over }
    else if (c.turn >= MAX_ROUNDS) { c.over = true; c.outcome = { winner: 'draw', loser: null } }
  }

  const panel = buildPanel(state, events, notes)
  c.log.push(panel)
  c.turn++

  return { events, panel, over: c.over, outcome: c.outcome }
}

/** 面板上那一行交手用的招式名 */
const ACTION_LABELS = {
  technique: '生得术式',
  physical: '体术',
  defend: '防御',
  domain: '领域展开',
  reverse: '反转术式',
  flee: '脱离',
  stagger: '被压制',
  'domain-tick': '领域',
}

/**
 * 本回合双方各自做了什么 —— 一行交手机读。
 *
 * 这是给"按下按钮之后那几秒"用的：模型写演出要好几秒，而这一行是引擎
 * 算完就有的。玩家按下体术，立刻能看到"体术 −247"，而不是对着一片
 * 空气等模型把这段演出来。数字是事实，描写仍然归模型。
 */
function beatOf(events, side) {
  const evs = events.filter((x) => x.side === side)
  if (!evs.length) return null

  /*
   * 领域追斩单算一笔。
   *
   * 它和"这一手打出去的伤害"是两件事：一个是玩家按下去的结果，
   * 一个是环境自己在咬。混成一个数的话，玩家看到"体术 −330"会以为
   * 自己这一拳忽然变猛了，实际里面有一半是领域在替他补刀。
   */
  const direct = evs.filter((x) => x.type !== 'domain-tick')
  const ticks = evs.filter((x) => x.type === 'domain-tick')
  const sum = (list, k) => list.reduce((n, x) => n + (x[k] || 0), 0)
  const hit = direct.find((x) => x.type !== 'stagger') || ticks[0] || direct[0]

  return {
    // 招式名按出手顺序拼，去掉重复（一次只该有一个"体术"）
    label: direct.length
      ? [...new Set(direct.map((x) => ACTION_LABELS[x.type] || x.type))].join(' + ')
      : '领域',
    kind: hit.type,
    damage: sum(direct, 'damage'),
    // 领域在这一回合替owner咬下来的那一口，界面单独摆一行
    tickDamage: sum(ticks, 'damage'),
    tickHealed: sum(ticks, 'healed'),
    tickCe: sum(ticks, 'recovered'),
    healed: sum(direct, 'healed'),
    recovered: sum(direct, 'recovered') || sum(direct, 'recoveredCe'),
    crit: evs.some((x) => x.crit),
    staggered: evs.some((x) => x.staggered),
    // 这一手什么都没发生：被封住、冷却中、咒力见底
    fizzled: !direct.some((x) => x.damage || x.healed || x.recovered),
  }
}

/** 按第六节规定的字段生成实时战况面板 */
export function buildPanel(state, events, notes = []) {
  const c = state.combat
  const p = state.player
  const e = c.enemy

  const txt = (side) => events.filter((x) => x.side === side).flatMap((x) => x.lines).join('；') || '——'
  const dmgEvent = events.find((x) => x.side === 'player' && x.damage)
  // 这一回合的"高光"：谁暴击了、谁被打断了、谁开了领域。界面拿它做演出
  const critEvent = events.find((x) => x.crit)
  const staggerEvent = events.find((x) => x.staggered)
  const domEvent = events.find((x) => x.domainOpened)
  // 本回合里玩家按过的"不占回合"行动（反转术式）
  const freeText = (c.freeLog || [])
    .filter((f) => f.turn === c.turn)
    .map((f) => `反转术式（不占回合）回复 ${f.healed} 点生命，消耗 ${f.cost} 点咒力`)
    .join('；')

  return {
    turn: c.turn,
    player: {
      hp: p.hp.cur, hpMax: p.hp.max,
      ce: p.ce.cur, ceMax: p.ce.max,
      status: p.status,
      technique: p.technique.name,
      cdLeft: p.technique.cdLeft,
      domain: p.domain.unlocked
        ? (p.domain.active ? `展开中（${p.domain.name}）剩余${p.domain.turnsLeft}回合` : '未展开')
        : '未领悟',
    },
    enemy: {
      name: e.name,
      grade: e.grade,
      hp: e.hp.cur, hpMax: e.hp.max,
      ceEstimate: estimateCe(e, Math.random),
      status: hpStatus(e.hp),
      domain: e.domain?.active ? `展开中（${e.domain.name}）` : '未展开',
      // 点"属性"弹出来的那一份完整档案
      profile: enemyProfile(e),
    },
    actionText: txt('player'),
    enemyActionText: txt('enemy'),
    freeActionText: freeText,
    breakdown: dmgEvent?.breakdown || null,
    damage: dmgEvent?.damage || 0,
    sureHit: !!dmgEvent?.sureHitBurst,
    // ---- 演出用（界面拿它决定闪什么、震什么；不影响任何数值）----
    crit: critEvent ? critEvent.side : null,
    critTarget: critEvent ? (critEvent.side === 'player' ? 'enemy' : 'player') : null,
    staggered: staggerEvent ? staggerEvent.side : null,
    // 连击层数：玩家一侧是"我压着它打"，敌方一侧是压迫感
    combo: Math.max(0, (p._combo || 0) - 1),
    enemyCombo: Math.max(0, (e._combo || 0) - 1),
    domainOpened: domEvent ? {
      side: domEvent.side,
      name: domEvent.domainName,
      sureHit: domEvent.sureHit,
      type: domEvent.domainType || DOMAIN_TYPE_DEFAULT,
      /*
       * 这一型的机制说明由引擎给（见 domains.js 的 DOMAIN_KIT）。
       * 界面自己写一份的话，数值一改两处就对不上了 ——
       * 而且"伤害型到底做什么"是设定，不是排版。
       */
      brief: DOMAIN_KIT[domEvent.domainType || DOMAIN_TYPE_DEFAULT].brief,
      burst: domEvent.sureHitBurst ? domEvent.damage : 0,
      healed: domEvent.healed || 0,
      recovered: domEvent.recovered || 0,
    } : null,
    // 还在展开中的领域：界面拿它挂"剩余 N 回合"的光环。
    // 上面那两条 domain 字段是给人读的字符串，这里给的是能直接渲染的结构
    domainState: {
      player: {
        active: !!p.domain?.active,
        name: p.domain?.name || '',
        type: p.domain?.active ? domainTypeOf(p.domain) : '',
        turnsLeft: p.domain?.turnsLeft ?? 0,
      },
      enemy: {
        active: !!e.domain?.active,
        name: e.domain?.name || '',
        type: e.domain?.active ? domainTypeOf(e.domain) : '',
        turnsLeft: e.domain?.turnsLeft ?? 0,
      },
    },
    /*
     * 规则型领域正压着谁。界面拿它把被封住的招灰掉并写明原因 ——
     * 玩家点了才知道"术式被规则封住"太晚了，那一回合已经过去了。
     * 规则是双向的：我方开规则型，对方的招被锁；对方开，我方被锁。
     */
    seal: {
      player: !!sealOf(p, e),
      enemy: !!sealOf(e, p),
      rules: sealOf(p, e) || sealOf(e, p) || null,
    },
    // 领域展开期间的每回合效果（伤害型的追斩、增益型的续航）
    domainTicks: events.filter((x) => x.domainTick).map((x) => ({
      side: x.side, type: x.domainType, name: x.side === 'player' ? p.domain.name : e.domain?.name,
      damage: x.damage || 0, healed: x.healed || 0, recovered: x.recovered || 0,
    })),
    // 一行交手机读：按下招之后立刻能看的东西（见 beatOf）
    beat: {
      player: beatOf(events, 'player'),
      enemy: beatOf(events, 'enemy'),
    },
    notes,
  }
}

/** 渲染成原文第六节规定的那段文本 */
export function renderPanelText(panel) {
  const p = panel.player
  const e = panel.enemy
  const b = panel.breakdown
  const formula = b
    ? `${b.咒术伤害} × ${b.术式倍率} × ${b.咒力效率} × ${b.相性} × ${b.等级压制} × ${b.随机} - ${b.敌方防御} = ${panel.damage}`
    : '——'
  return [
    `【实时战况·第${panel.turn}回合】`,
    `玩家：HP ${p.hp}/${p.hpMax} | 咒力 ${p.ce}/${p.ceMax} | 状态：${p.status} | 术式：${p.technique}（冷却${p.cdLeft}） | 领域：${p.domain}`,
    `敌方：${e.name} | ${e.grade} | HP ${e.hp}/${e.hpMax} | 咒力估算 ${e.ceEstimate} | 状态：${e.status}`,
    `本回合行动：${panel.actionText}`,
    `敌方行动：${panel.enemyActionText}`,
    `伤害计算：${formula}`,
    panel.domainOpened ? `领域：${panel.domainOpened.side === 'player' ? '我方' : '敌方'}展开「${panel.domainOpened.name}」` : null,
    panel.crit ? `本回合高光：${panel.crit === 'player' ? '我方' : '敌方'}打出暴击` : null,
    panel.combo > 0 ? `我方连击 ${panel.combo} 层` : null,
    panel.notes.length ? `战后更新：${panel.notes.join('；')}` : null,
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------- 自动结算

/** 跳过 / 剧情模式：引擎把整场打完，返回战报交给模型改写 */
export function simulateCombat(state, rng) {
  const rounds = []
  let guard = 0
  while (!state.combat.over && guard++ < MAX_ROUNDS) {
    const r = runRound(state, rng, null, { autoPlayer: true })
    rounds.push(r.panel)
    if (r.over) break
  }
  if (!state.combat.over) {
    state.combat.over = true
    state.combat.outcome = { winner: 'draw', loser: null }
  }
  return { rounds, outcome: state.combat.outcome }
}

/** 压缩战报，喂给模型写叙事时用（不能把 30 回合面板原样丢过去） */
export function summarizeRounds(rounds) {
  const key = rounds.filter((r, i) =>
    i === 0 || i === rounds.length - 1 || r.damage > 0 && (r.turn % 3 === 0),
  )
  return key.map((r) => ({
    回合: r.turn,
    玩家HP: `${r.player.hp}/${r.player.hpMax}`,
    敌方HP: `${r.enemy.hp}/${r.enemy.hpMax}`,
    玩家行动: r.actionText,
    敌方行动: r.enemyActionText,
  }))
}

// ---------------------------------------------------------------- 战果

/** 实战磨砺（第八节第 3 小节） */
export function computeRewards(state, rng, { won, crossLevel }) {
  const s = state.combat.stats
  const gains = {}
  const notes = []
  const rnd = (lo, hi) => Math.round((lo + rng() * (hi - lo)) * 10) / 10

  if (won) {
    if (s.usedTechnique) { gains.术式演练 = rnd(3, 10); notes.push('术式实战运用') }
    if (s.usedMelee) { gains.体术实战 = rnd(5, 12); gains.体能训练 = rnd(3, 8); notes.push('近身搏杀') }
    if (s.usedReverse) { gains.反转术式修习 = rnd(10, 20); notes.push('战场上施展反转术式') }
    if (s.usedDomain) { gains.领域雏形冥想 = rnd(10, 25); notes.push('战斗中展开领域') }

    if (s.lowestHpRatio < 0.2) {
      for (const k of Object.keys(gains)) gains[k] = Math.round((gains[k] + rnd(5, 15)) * 10) / 10
      notes.push('极限状态下取胜')
    }
    if (crossLevel) {
      for (const k of Object.keys(gains)) gains[k] = Math.round((gains[k] + rnd(8, 20)) * 10) / 10
      notes.push('跨级击杀')
    }
  } else {
    gains.体术实战 = rnd(2, 5)
    notes.push('败战中的经验')
  }

  // 跨级击杀有概率直接升一级。等级没有"必须靠专属突破剧情"的上限，
  // 一路打到龙级也可以 —— 只是越往上越难触发。
  let gradeUp = null
  if (won && crossLevel && rng() < 0.25) {
    const gi = gradeIndex(state.player.grade)
    if (gi >= 0 && gi < GRADES.length - 1) gradeUp = GRADES[gi + 1]
  }

  return { gains, notes, gradeUp }
}

/** 把战果写进角色数值 */
export function applyRewards(state, rewards) {
  const p = state.player
  const ups = []

  for (const [item, amount] of Object.entries(rewards.gains)) {
    if (p.training[item] === undefined) continue
    p.training[item] = Math.round((p.training[item] + amount) * 10) / 10
  }

  if (rewards.gradeUp) {
    // 直接升一级：数值抬到新等级的区间起点，避免越级虚高
    ups.push(`综合等级提升至 ${applyGradeUp(p, rewards.gradeUp)}`)
  }

  return ups
}

/** 战斗结束后的收尾：清空战斗态、按胜负写剧情标记、记一条战果 */
export function finishCombat(state, outcome) {
  const won = outcome?.winner === 'player'
  const enemy = state.combat?.enemy
  const enemyName = enemy?.name || '敌人'
  const enemyGrade = enemy?.grade || ''
  const canon = !!enemy?.canon
  /*
   * 杀意是玩家自己带进来的（他说了"杀了他"这种话，见 guard.js 的 hasLethalIntent）。
   * 赢了、并且本来就奔着要命去，才算真的杀了这个人 —— 打晕和打死是两件事，
   * 后者会往后改写剧情，前者不会。
   */
  const lethalIntent = !!state.combat?.lethalIntent
  const killed = won && lethalIntent
  // 介入战要留个记号：战斗态马上就被清空了，之后再想问"这场是不是节点战"就晚了
  const intervention = state.combat?.intervention || null
  state.combat = null
  state.player.domain.active = false
  state.player._defending = false
  state.player.technique.cdLeft = 0

  const who = `${enemyGrade ? `${enemyGrade}的` : ''}${enemyName}`
  let summary
  if (won) {
    summary = killed ? `杀死了${who}` : `击退了${who}`
    state.timeline.newEvents.push(summary)
  } else if (outcome?.winner === 'fled') {
    summary = `从${enemyName}手中脱离`
  } else if (outcome?.winner === 'enemy') {
    summary = `被${enemyName}击倒`
  } else {
    summary = `与${enemyName}的战斗未分胜负`
  }

  /*
   * 杀的是撑起某个原作节点的人 → 那一天被标成「已改写」。
   * 注意判定用的是**名字**：表里查不到（无名咒灵）就什么都不会发生。
   * 节点已经走过的话 noteDeath 会返回 line: null —— 人确实没了，
   * 但那一天早就过去了，改不动了，也不必假装改得动。
   */
  let rewrite = null
  if (killed) {
    const hit = noteDeath(state, enemyName)
    if (hit?.line) {
      rewrite = hit.line
      summary += `。${hit.line}`
    } else if (hit?.already) {
      rewrite = `「${hit.node}」已经过去，这一死改变不了那一天`
    }
  }
  if (state.timeline.newEvents.length > 40) state.timeline.newEvents.shift()

  // 战斗向的介入战：把「这一天」记进时间线，并清掉修炼疲劳（新的空档重新开始）
  if (intervention) {
    summary += `。${completeIntervention(state, intervention, outcome)}`
  }

  // 濒死必须显式告诉模型，否则它会照着"无事发生"往下写。
  // 设定：血条归零为濒死，未及时治疗则死亡（第一节）。
  const p = state.player
  if (p.hp.cur <= 0) {
    summary += `。玩家血条归零，处于濒死状态——若不立刻得到反转术式治疗或家入硝子的救治，就会死亡`
  } else if (p.hp.cur / p.hp.max < 0.2) {
    summary += `。玩家重伤，只剩一口气`
  }

  /*
   * 战果入库。玩家的要求是"每次对战结果加入到之后剧情的影响"，
   * 所以这份记录一份喂模型（modelStateView 的「战果」段）、一份上右栏面板。
   * 只留最近 30 场 —— 七十场以前的仗对当下的剧情已经没什么约束力了。
   */
  state.battles ||= []
  state.battles.push({
    turn: state.turn,
    date: state.time?.date || '',
    enemy: { name: enemyName, grade: enemyGrade, canon },
    // 击杀 / 击退 / 逃脱 / 战败 / 未分胜负 —— 战场上的五种收场
    result: won ? (killed ? '击杀' : '击退')
      : outcome?.winner === 'fled' ? '逃脱'
        : outcome?.winner === 'enemy' ? '战败' : '未分胜负',
    killed,
    ground: intervention ? '介入战' : '遭遇战',
    node: intervention,
    rewrite,
    hpLeft: p.hp.cur,
    hpMax: p.hp.max,
    note: summary,
  })
  if (state.battles.length > 30) state.battles.shift()

  return summary
}

export { MAX_ROUNDS }
