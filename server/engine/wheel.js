import { TRAINING_TABLE, TALENT_BONUS, rollTraining, applyTraining } from './commands.js'
import { nextMilestone, missedNodes, TODO, DONE, CHANGED, REWRITTEN } from './timeline.js'
import { GENERIC_TECHNIQUES } from './canon.js'
import { advanceTime, promoteGrade } from './state.js'
import { weightedPick, rint } from './dice.js'
import { GRADES, RANGES, gradeIndex, isTier } from './tables.js'
import { rollEnemy } from './rolls.js'
import { hpStatus } from './formula.js'

/**
 * 战斗向的核心循环 —— 日常轮盘。
 *
 * 剧情向是"一轮一场戏"；战斗向改成**两段剧情之间的空闲时间**：
 *
 *     转到剧情节点之前：每天转一次轮盘，随机落在一个方向上，涨一点属性
 *     剧情节点当天：     介入那场战斗，打完接着过下一段空闲时间
 *
 * 这么做是为了解决战斗向原来的毛病：它只是把剧情向的叙事配比调高了，
 * 玩家还是在"读一轮、点一个选项"，一天一天地挪。而《咒术回战》原作里
 * 那些空档（六月到十月）本来就是靠修炼堆上去的 —— 这里让玩家真的去堆。
 *
 * 数值上的两条闸门，避免"一个月练成特级"：
 *   1. 一天的收益按 DAY_SCALE 折算进修炼表（见下）
 *   2. 连续修炼会疲劳，收益逐日衰减到 45% 打底（FATIGUE_*），静养一天清零
 *
 * 关于 DAY_SCALE 的取值：修炼表的进度条是 100 一点，而轮盘每天随机落在
 * 六个方向之一，所以进度会被摊薄 —— 一天只涨几个点的话，19 天的空档
 * 一个数值都不会动（试过 0.35，实测 19 天和 72 天都是 0 次跳变，玩家只会
 * 看到"练了半天什么都没变"）。1.6 是实测调出来的：
 *     19 天的空档  ≈ 2~3 次数值跳变（血条或体术 +10%）
 *     72 天的空档  ≈ 10~14 次（属性大约 +30%~+50%）
 *     168 天的空档 ≈ 27 次（属性翻倍上下，够得上一次跨级）
 * 上限交给疲劳和等级区间去卡 —— 想更苦就把这个数调小。
 */

export const DAY_SCALE = 1.6
export const FATIGUE_STEP = 0.012
export const FATIGUE_FLOOR = 0.45
export const REST_HEAL_RATIO = 0.18
/** 一次"推进到节点"最多走这么多天，防止极端情况下卡死 */
export const MAX_DAYS_PER_CALL = 200

/** 轮盘上的六个方向 —— 就是"跳过当天·修炼"那六项，换成一天一转 */
export const WHEEL_SECTORS = [
  { id: '体能训练', short: '体能', effect: '血条上限 · 体术伤害' },
  { id: '咒力冥想', short: '冥想', effect: '咒力上限 · 咒力效率' },
  { id: '术式演练', short: '术式', effect: '咒术伤害 · 术式熟练' },
  { id: '体术实战', short: '实战', effect: '体术伤害（有受伤风险）' },
  { id: '反转术式修习', short: '反转', effect: '反转术式熟练度' },
  { id: '领域雏形冥想', short: '领域', effect: '领域雏形进度' },
]

/** 基础权重：肉体与术式是主线，反转与领域稀有（落到了就是大赚） */
const BASE_WEIGHT = {
  体能训练: 1.3, 咒力冥想: 1.2, 术式演练: 1.2, 体术实战: 1.1,
  反转术式修习: 0.7, 领域雏形冥想: 0.5,
}
const TALENT_MUL = 1.8

export const ensureWheel = (state) => {
  state.wheel ||= { days: 0, sectors: {}, lastItem: null, lastUps: [], fatigue: 1, interventions: [] }
  state.wheel.sectors ||= {}
  state.wheel.fatigue ??= 1
  return state.wheel
}

export function sectorWeight(state, id) {
  const talents = state.player?.talents || []
  const favored = talents.some((t) => (TALENT_BONUS[t] || []).includes(id))
  return (BASE_WEIGHT[id] || 1) * (favored ? TALENT_MUL : 1)
}

export function pickSector(state, rng) {
  const w = {}
  for (const s of WHEEL_SECTORS) w[s.id] = sectorWeight(state, s.id)
  return weightedPick(rng, w)
}

const sectorOf = (id) => WHEEL_SECTORS.find((s) => s.id === id) || WHEEL_SECTORS[0]

// ---------------------------------------------------------------- 一天

function attrsOf(p) {
  return {
    hp: p.hp.max, ce: p.ce.max,
    cd: p.cursedDamage.value, pd: p.physicalDamage.value,
    eff: p.efficiency.value, grade: p.grade,
  }
}

/** 重伤/濒死的那一天只能躺着 —— 硬练会把命练没 */
function restDay(state) {
  const p = state.player
  const before = p.hp.cur
  p.hp.cur = Math.min(p.hp.max, p.hp.cur + Math.round(p.hp.max * REST_HEAL_RATIO))
  const healed = p.hp.cur - before
  const w = ensureWheel(state)
  w.fatigue = 1 // 歇过来了
  advanceTime(state, '1d')
  p.status = hpStatus(p.hp)
  return {
    day: state.time.day, date: state.time.date, kind: 'rest',
    sector: null, progress: 0, healed, ups: [], notes: ['伤势压着，这一天只能躺着'],
    hpDelta: 0, gradeUp: null,
  }
}

/**
 * 转一天。返回当天发生了什么 —— 全部由引擎算，不调模型。
 * 这样"连推三十天"是零成本的，玩家可以痛快地跳过空档。
 */
export function spinWheel(state, rng) {
  const w = ensureWheel(state)
  const p = state.player

  // 剧情节点当天不许再往后转：再转一天，这一天就过去了，节点会被记成"错过"，
  // 玩家再也等不到那一场 —— 这正是"到剧情节点了还在让我接着转轮盘"的病根。
  // 接口层的闸门已经拦了一道，但引擎自己也该守住：轮盘是这套玩法唯一的时钟来源，
  // 谁绕过闸门直接调它都不该把节点转没了。
  const due = nextMilestone(state)
  if (due && due.daysLeft <= 0) {
    return {
      day: state.time.day, date: state.time.date, kind: 'blocked',
      sector: null, progress: 0, progressNow: 0, healed: 0, ups: [], hpDelta: 0, gradeUp: null,
      notes: [`「${due.node}」就是今天 —— 先打完这一场，再往下走`],
    }
  }

  if (p.status === '濒死' || p.status === '重伤') {
    const r = restDay(state)
    w.days += 1
    w.lastItem = null
    w.lastUps = []
    return r
  }

  const id = pickSector(state, rng)
  const sector = sectorOf(id)
  const fatigue = w.fatigue

  const rolled = rollTraining(state, id, rng)
  rolled.progress = Number((rolled.progress * DAY_SCALE * fatigue).toFixed(4))
  const ups = applyTraining(state, rolled)

  w.days += 1
  w.fatigue = Math.max(FATIGUE_FLOOR, w.fatigue - FATIGUE_STEP)
  w.sectors[id] = (w.sectors[id] || 0) + 1
  w.lastItem = id
  w.lastUps = ups

  // 本模式的天数推进本身就是修炼，不该算"连续跳过剧情"
  state.time.skipStreak = 0
  p.status = hpStatus(p.hp)

  // 四项属性都堆到了下一级的门槛就升级 —— "升级是积累的结果，不是剧情恩赐"
  const gradeUp = promoteGrade(state)

  return {
    day: state.time.day,
    date: state.time.date,
    kind: 'train',
    sector: { id: sector.id, short: sector.short, effect: sector.effect },
    progress: Number((rolled.progress * 100).toFixed(1)),
    // 这个方向的进度条现在到哪儿了（0~100）。日志要显示"38% → 44%"：
    // 只说"进度 +6%"的话，玩家会去右边找那条属性，找不到就以为没生效
    progressNow: Math.round(p.training[id] || 0),
    healed: 0,
    ups,
    notes: rolled.notes,
    hpDelta: rolled.hpDelta || 0,
    gradeUp,
  }
}

/**
 * 一路转到剧情当天。返回合并后的日报，不逐天返回 ——
 * 界面上"19 天：体能 ×5、术式 ×4……"比十九行流水账好读。
 */
export function advanceToMilestone(state, rng) {
  const start = state.time.date
  const days = []
  let guard = 0

  while (guard++ < MAX_DAYS_PER_CALL) {
    const ms = nextMilestone(state)
    if (!ms || ms.daysLeft <= 0) break
    days.push(spinWheel(state, rng))
    // 练出事了就停下来让玩家接手
    if (state.player.status === '濒死') break
  }

  const sectors = {}
  const ups = []
  const notes = []
  let rest = 0
  let heal = 0
  let damage = 0
  const gradeUps = []
  for (const d of days) {
    if (d.kind === 'rest') rest += 1
    else sectors[d.sector.short] = (sectors[d.sector.short] || 0) + 1
    heal += d.healed || 0
    damage += Math.abs(d.hpDelta || 0)
    if (d.gradeUp) gradeUps.push(d.gradeUp)
    for (const u of d.ups) if (!ups.includes(u)) ups.push(u)
    for (const n of d.notes) if (!notes.includes(n)) notes.push(n)
  }

  return {
    kind: 'advance',
    from: start,
    to: state.time.date,
    days: days.length,
    rest,
    sectors,
    ups,
    notes,
    healed: heal,
    damage,
    gradeUps,
    // 这一趟走完，六条进度条各自到哪儿了 —— 合并日报只能给汇总，
    // 不给这个的话玩家看完日报还是不知道"我到底练出来了什么"
    progress: progressBars(state),
    status: state.player.status,
  }
}

/** 六条进度条：方向短名 → 0~100 的进度 */
export function progressBars(state) {
  const t = state.player?.training || {}
  const out = {}
  for (const s of WHEEL_SECTORS) out[s.short] = Math.round(t[s.id] || 0)
  return out
}

// ---------------------------------------------------------------- 介入战斗

/** 介入战的对手：按节点危险度比玩家高一到两级，但要留在"两级以内"的设计红线里 */
const ENEMY_NAMES = { 咒灵: 3, 咒胎: 1, 诅咒师: 2, 受咒物侵蚀者: 1 }

export function interventionGrade(state, danger) {
  const offset = danger >= 5 ? 2 : danger >= 4 ? 1 : 0
  const gi = gradeIndex(state.player.grade)
  return GRADES[Math.max(0, Math.min(GRADES.length - 1, gi + offset))]
}

export function planIntervention(state, rng, ms) {
  const grade = interventionGrade(state, ms.danger)
  const enemy = rollEnemy(rng, grade)
  enemy.name = weightedPick(rng, ENEMY_NAMES)
  enemy.technique.name = GENERIC_TECHNIQUES[rint(rng, 0, GENERIC_TECHNIQUES.length - 1)]
  if (enemy.domain?.unlocked) enemy.domain.name = `${ms.node}的领域`
  return enemy
}

/**
 * 剧情当天：把这场仗挂成待结算的遭遇。
 * 之后走的是既有的"要不要打 → 选战斗模式"流程，不另起一套。
 */
export function startIntervention(state, rng) {
  if (state.pendingCombat || (state.combat && !state.combat.over)) return null
  const ms = nextMilestone(state)
  if (!ms || ms.daysLeft > 0 || ms.daysLeft < 0) return null

  const trained = ensureWheel(state).days
  const enemy = planIntervention(state, rng, ms)
  state.pendingCombat = {
    enemy,
    // 「就在今天」这句话得说清是哪一天、哪种份量 —— 一个节点一场仗之后，
    // 玩家会在同一天连着撞上两场（少年院任务与宿傩夺舍），理由要能分辨
    reason: `「${ms.node}」就在今天（${ms.dangerLabel}）—— ${
      trained > 0 ? `你练了 ${trained} 天，等的就是这一刻` : '你正好在场，躲不掉了'}`,
    mode: null,
    sinceTurn: state.turn,
    intervention: ms.node,
    /*
     * 介入战不是玩家点名要谁的命 —— 他只是点了"这一场我上"。
     * 所以默认只是打倒，不记击杀。真要杀人得在剧情里说出来
     * （见 guard.js 的 hasLethalIntent），那时走的是另一条路。
     */
    lethalIntent: false,
  }
  return state.pendingCombat
}

/** 介入结束后：把这一天记进时间线，疲劳清零（新的空档重新开始） */
export function completeIntervention(state, node, outcome) {
  const w = ensureWheel(state)
  w.fatigue = 1
  if (!w.interventions.includes(node)) w.interventions.push(node)

  const won = outcome?.winner === 'player'
  const fled = outcome?.winner === 'fled'
  const before = state.timeline.nodes[node]
  if (!fled && before === TODO) {
    // 玩家真的插手了：赢了算改写，没赢也是"发生了，只是没改成"
    state.timeline.nodes[node] = won ? CHANGED : DONE
  }
  /*
   * 已经被改写过的节点（撑起它的那个人提前死了），这一仗打赢也变不回原著。
   * 所以只能记成"介入了那一天"，不能覆盖掉「已改写」—— 那是更上游的事实。
   */
  const line = before === REWRITTEN
    ? `${won ? '赢下了' : fled ? '避开了' : '卷入了'}已经改写的「${node}」`
    : `${won ? '改写了' : fled ? '避开了' : '卷入了'}「${node}」`
  state.timeline.newEvents.push(line)
  if (state.timeline.newEvents.length > 40) state.timeline.newEvents.shift()
  return line
}

/** 给界面和提示词用的轮盘快照 */
export function wheelSnapshot(state) {
  const w = ensureWheel(state)
  // 先对账：日期已经过去还挂着"未发生"的节点补成"已发生"。
  // 快照是每次刷新都会走的路径，放这里就不会漏（幂等）
  missedNodes(state)
  const ms = nextMilestone(state)
  return {
    days: w.days,
    sectors: w.sectors,
    lastItem: w.lastItem,
    lastUps: w.lastUps,
    fatigue: Number(w.fatigue.toFixed(3)),
    interventions: w.interventions,
    milestone: ms,
    ready: !!ms && ms.daysLeft <= 0,
    // 六条进度条 —— 属性是"攒满 100% 才跳一次"的，不把进度摆出来，
    // 玩家转完一天回到右边状态栏会发现数字没动，以为轮盘白转了
    progress: progressBars(state),
    sectorsTable: WHEEL_SECTORS.map((s) => ({
      ...s,
      count: w.sectors[s.id] || 0,
      weight: Number(sectorWeight(state, s.id).toFixed(2)),
      progress: Math.round(state.player?.training?.[s.id] || 0),
    })),
  }
}

export { nextMilestone, TRAINING_TABLE, RANGES, isTier }
