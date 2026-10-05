import {
  techniqueDamage, physicalStrike, techniqueCost, hpStatus, suppression, REVERSE_TABLE,
} from './formula.js'
import { ENEMY_ARCHETYPES } from './rolls.js'
import { GRADES, gradeIndex } from './tables.js'
import { applyGradeUp } from './state.js'
import { completeIntervention } from './wheel.js'
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

export function initCombat(state, rng, { mode, enemy, reason, intervention = null }) {
  state.player.domain.active = false // 每场战斗重新展开
  state.combat = {
    mode,
    reason,
    turn: 1,
    enemy,
    // 战斗向的介入战：打完之后要把「这一天」记进时间线（见 finishCombat）
    intervention,
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

/** 结算一次伤害；防御姿态减伤，领域展开时防御减半（必中） */
function dealDamage(attacker, target, raw) {
  let dmg = raw
  if (attacker.domain?.active) dmg = Math.round(dmg * 1.0) // 必中：已在 formula 里由领域加成体现
  if (target._defending) dmg = Math.round(dmg * (1 - DEFEND_REDUCTION))
  target.hp.cur = Math.max(0, target.hp.cur - dmg)
  return dmg
}

function act(actor, target, action, rng) {
  const ev = { type: action.type, lines: [] }

  // 上一回合的防御姿态在自己再次行动时失效
  const wasDefending = !!actor._defending
  actor._defending = false
  if (wasDefending) ev.lines.push('（防御姿态解除）')

  switch (action.type) {
    case 'technique': {
      if (actor.technique.cdLeft > 0) {
        ev.lines.push(`术式仍在冷却（剩 ${actor.technique.cdLeft} 回合），动作落空`)
        return ev
      }
      const cost = techniqueCost(actor, actor.technique.cost)
      const { overdraft } = spendCe(actor, cost)
      actor.technique.cdLeft = actor.technique.cooldown

      const r = techniqueDamage(actor, target, { rng })
      const dmg = dealDamage(actor, target, r.damage)
      ev.damage = dmg
      ev.breakdown = r.breakdown
      ev.nullified = r.nullified
      ev.lines.push(`${actor.technique.name}轰出，造成 ${dmg} 点伤害`)
      if (r.nullified) ev.lines.push('等级差距过大，术式被部分无效化')
      if (overdraft > 0) ev.lines.push(`咒力见底仍强行施术，反噬 ${overdraft} 点生命`)
      break
    }

    case 'physical': {
      const r = physicalStrike(actor, target, { rng })
      const dmg = dealDamage(actor, target, r.damage)
      ev.damage = dmg
      ev.breakdown = r.breakdown
      ev.lines.push(`欺身而入，体术命中，造成 ${dmg} 点伤害`)
      break
    }

    case 'defend': {
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
      const cost = techniqueCost(actor, d.cost)
      if (actor.ce.cur < cost) { ev.lines.push('咒力不足以展开领域，动作落空'); return ev }
      actor.ce.cur -= cost
      d.active = true
      d.turnsLeft = DOMAIN_DURATION[d.grade] || 5
      ev.domainOpened = true
      ev.lines.push(`领域展开——${d.name}${d.sureHit ? `。${d.sureHit}` : ''}`)
      break
    }

    case 'reverse': {
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

  if (hpRatio < 0.35 && e.reverseCursedTechnique?.level !== '未掌握' && e.ce.cur > e.ce.max * 0.3) {
    return { type: 'reverse' }
  }
  if (e.domain?.unlocked && !e.domain.active && e.ce.cur > e.domain.cost * 2 && rng() < 0.45 * arch.aggression) {
    return { type: 'domain' }
  }
  const canTech = e.technique.cdLeft === 0 && e.ce.cur >= e.technique.cost
  if (canTech && rng() < 0.55 + 0.4 * arch.aggression) return { type: 'technique' }
  if (hpRatio < arch.defendBelow && rng() < arch.cunning) return { type: 'defend' }
  if (canTech) return { type: 'technique' }
  return { type: 'physical' }
}

/** 自动模式下玩家侧也走一套 AI，但用的是玩家自己的术式与领域 */
function choosePlayerAutoAction(state, rng) {
  const p = state.player
  const hpRatio = p.hp.cur / p.hp.max

  if (hpRatio < 0.3 && p.reverseCursedTechnique.level !== '未掌握' && p.ce.cur > p.ce.max * 0.3) {
    return { type: 'reverse' }
  }
  if (p.domain.unlocked && !p.domain.active && p.ce.cur > p.domain.cost * 2 && rng() < 0.6) {
    return { type: 'domain' }
  }
  if (p.technique.cdLeft === 0 && p.ce.cur >= p.technique.cost) return { type: 'technique' }
  if (hpRatio < 0.4 && rng() < 0.3) return { type: 'defend' }
  return { type: 'physical' }
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
    const ev = act(p, e, playerPick, rng)
    ev.side = 'player'
    events.push(ev)
    if (ev.type === 'technique') c.stats.usedTechnique = true
    if (ev.type === 'physical') c.stats.usedMelee = true
    if (ev.type === 'reverse' && ev.healed) c.stats.usedReverse = true
    if (ev.type === 'domain' && ev.domainOpened) c.stats.usedDomain = true
  }
  const doEnemy = () => {
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

/** 按第六节规定的字段生成实时战况面板 */
export function buildPanel(state, events, notes = []) {
  const c = state.combat
  const p = state.player
  const e = c.enemy

  const txt = (side) => events.filter((x) => x.side === side).flatMap((x) => x.lines).join('；') || '——'
  const dmgEvent = events.find((x) => x.side === 'player' && x.damage)
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
    },
    actionText: txt('player'),
    enemyActionText: txt('enemy'),
    freeActionText: freeText,
    breakdown: dmgEvent?.breakdown || null,
    damage: dmgEvent?.damage || 0,
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

/** 战斗结束后的收尾：清空战斗态、按胜负写剧情标记 */
export function finishCombat(state, outcome) {
  const won = outcome?.winner === 'player'
  const enemyName = state.combat?.enemy?.name || '敌人'
  const enemyGrade = state.combat?.enemy?.grade || ''
  // 介入战要留个记号：战斗态马上就被清空了，之后再想问"这场是不是节点战"就晚了
  const intervention = state.combat?.intervention || null
  state.combat = null
  state.player.domain.active = false
  state.player._defending = false
  state.player.technique.cdLeft = 0

  let summary
  if (won) {
    summary = `击退了${enemyGrade ? `${enemyGrade}的` : ''}${enemyName}`
    state.timeline.newEvents.push(summary)
  } else if (outcome?.winner === 'fled') {
    summary = `从${enemyName}手中脱离`
  } else if (outcome?.winner === 'enemy') {
    summary = `被${enemyName}击倒`
  } else {
    summary = `与${enemyName}的战斗未分胜负`
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
  return summary
}

export { MAX_ROUNDS }
