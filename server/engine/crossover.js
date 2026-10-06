import { RANGES, TECH_MULT, GRADES, gradeIndex, isTier } from './tables.js'
import { rfloat } from './dice.js'
import { storylineOf } from './storylines.js'
import { initialNodes, pointsFor, isSettled } from './timeline.js'
import { initialFingers } from './state.js'
import { hpStatus } from './formula.js'

/**
 * 跨篇衔接。
 *
 * 怀玉篇结束在 2007，宿傩篇开始于 2018 —— 中间隔着十一年。
 * 直接用"十年后"一句话带过，角色却一点没长，会很割裂：
 * 2006 年的新人和 2018 年的新人撞上同一批敌人，战力却一样。
 *
 * 所以把这段空白做成**三段可选的历练**：玩家决定这些年怎么过，
 * 引擎按方向结算成长，走完三段正好落在 2018 年 6 月。
 *
 * 等级不设突破门槛：三段历练加起来的成长可以直接把人推上一个等级，
 * 包括踏进特级。只是越往上，跨级需要的积累越多（见 STAGE 的涨幅与跨度）。
 */

/**
 * 三段历练。跨度按篇章取 —— 怀玉篇是 2007→2018，宿傩篇是 2019→2029，
 * 写死一套会让其中一条线对不上年份。
 */
export const stagesFor = (storylineId) =>
  storylineOf(storylineId).crossoverGap?.stages || []

/**
 * 历练方向。每个方向主攻 2 项、兼顾 1 项 ——
 * 主攻给大进度，兼顾给小进度，逼玩家做取舍而不是全都要。
 */
export const FOCUSES = [
  {
    id: 'ascetic',
    name: '苦修',
    desc: '把时间全砸在身体上。挨打、负重、重复一万次同一个动作。',
    primary: ['physicalDamage', 'hp'],
    secondary: ['efficiency'],
  },
  {
    id: 'meditation',
    name: '冥想',
    desc: '向内。扩张咒力的容量，磨细每一丝咒力的用法。',
    primary: ['ce', 'efficiency'],
    secondary: ['cursedDamage'],
  },
  {
    id: 'research',
    name: '术式钻研',
    desc: '把生得术式拆开再装回去，逼它长出本来没有的用法。',
    primary: ['cursedDamage'],
    secondary: ['efficiency', 'ce'],
  },
  {
    id: 'wander',
    name: '游历',
    desc: '离开高专，在咒术界的灰色地带走动。见得多，活得久。',
    primary: ['hp', 'ce'],
    secondary: ['physicalDamage', 'cursedDamage'],
  },
]

export const focusById = (id) => FOCUSES.find((f) => f.id === id)

const LABEL = {
  hp: '血条总量', ce: '咒力总量', cursedDamage: '咒术伤害',
  physicalDamage: '体术伤害', efficiency: '咒力效率',
}

/** 数值成长：效率按百分比加，其余按比例加 */
function bumpValue(key, value, pct) {
  if (key === 'efficiency') return Number(Math.min(2.0, value * (1 + pct / 200)).toFixed(3))
  return Math.round(value * (1 + pct / 100))
}

/**
 * 结算一段历练。返回这一段涨了什么 —— 不直接改角色，
 * 由 applyStage 落地，保持"先算后改"的一致性。
 */
export function rollStage(state, focusId, stageIndex, rng) {
  const focus = focusById(focusId) || FOCUSES[0]
  const p = state.player
  const gains = []

  const add = (key, lo, hi) => {
    const pct = rfloat(rng, lo, hi)
    gains.push({ key, label: LABEL[key], pct: Number(pct.toFixed(1)) })
  }

  // 主攻：涨幅明显；兼顾：聊胜于无。年数越长涨得越多
  const stages = stagesFor(state.storyline)
  const years = stages[stageIndex]?.years ?? 4
  const scale = years / 4 // 以四年为基准
  for (const k of focus.primary) add(k, 6 * scale, 13 * scale)
  for (const k of focus.secondary) add(k, 2 * scale, 5 * scale)

  return {
    stage: stageIndex,
    focusId: focus.id,
    focusName: focus.name,
    range: stages[stageIndex],
    gains,
    notes: [],
  }
}

/**
 * 取/写属性值。
 * 注意 hp 和 ce 没有 value 字段（它们是 {cur, max, grade}），
 * 直接按 p[key].value 取会拿到 undefined —— 这里统一收口。
 */
const readValue = (p, key) =>
  key === 'hp' ? p.hp.max : key === 'ce' ? p.ce.max : p[key].value

function writeValue(p, key, v) {
  if (key === 'hp') { p.hp.max = v; p.hp.cur = v; return }
  if (key === 'ce') { p.ce.max = v; p.ce.cur = v; return }
  p[key].value = v
}

/** 把一段历练的成长写进角色 */
export function applyStage(state, result) {
  const p = state.player
  const ups = []
  for (const g of result.gains) {
    const before = readValue(p, g.key)
    const after = bumpValue(g.key, before, g.pct)
    writeValue(p, g.key, after)

    if (g.key === 'efficiency') ups.push(`${g.label} +${g.pct}%`)
    else ups.push(`${g.label} ${before.toLocaleString()} → ${after.toLocaleString()}`)
  }
  // 这些年一直在养，不是带伤上路
  p.status = hpStatus(p.hp)
  return ups
}

/**
 * 三段走完，跨到下一篇。
 *
 * 保留：姓名、生得术式、领域、天赋、咒具 —— 这些是角色之所以是他的东西。
 * 重掷：原作节点表换成新篇的；起始日期对齐新篇。
 * 关系：只保留两篇都登场的人（比如五条悟），并记一句"十一年没见"。
 */
export function completeCrossover(state, rng) {
  const from = storylineOf(state.storyline)
  const to = storylineOf(from.next)
  if (!to) return null

  const before = { grade: state.player.grade, relations: { ...state.relations } }

  // 只保留新篇里也存在的角色；其余的人在十一年里散了
  const keep = new Set(to.characters)
  const carried = {}
  for (const [name, v] of Object.entries(state.relations)) {
    if (keep.has(name) && v !== 0) carried[name] = v
  }
  const next = {}
  for (const name of to.characters) next[name] = carried[name] ?? 0
  state.relations = next

  state.storyline = to.id
  state.timeline.nodes = initialNodes(to.id)
  state.timeline.changed = []
  // 改写理由跟着节点表一起换 —— 上一篇「谁死了导致哪一天变了」在新篇里没有意义
  state.timeline.rewrites = {}
  state.timeline.newEvents = []
  /*
   * 手指也跟着新篇重置。怀玉篇（2006）从头到尾一根都没有 —— 那时候虎杖还没出生；
   * 跨进宿傩篇就是"虎杖刚吞下第一根"那一天，所以这里读的是新篇的起点，
   * 而不是把上一篇的数带过来。
   */
  state.sukuna = initialFingers(to.id)
  state.time.date = to.startDate
  state.time.day = 1
  state.time.point = pointsFor(to.id)[0].id // 新篇从第一章重新算起
  state.crossover = null

  // 这些年不是白过的：等级提一级（没有突破门槛，能一路提到龙级）
  // 注意 hp / ce 用的是 max 不是 value，直接用 readValue 统一口径（之前在这里栽过）
  const p = state.player
  const pct = (key, ratio) => writeValue(p, key, Math.round(readValue(p, key) * ratio))
  const floor = (key, v) => writeValue(p, key, Math.max(readValue(p, key), v))

  let gradeUp = null
  const gi = gradeIndex(p.grade)
  if (gi >= 0 && gi < GRADES.length - 1) {
    // 等级没有"必须靠专属突破剧情"的上限，一路堆到龙级也可以
    gradeUp = GRADES[gi + 1]
    const r = RANGES[gradeUp]
    p.grade = gradeUp
    floor('hp', r.hp[0])
    floor('ce', r.ce[0])
    floor('cursedDamage', r.cd[0])
    floor('physicalDamage', r.pd[0])
    p.hp.grade = p.ce.grade = p.cursedDamage.grade = p.physicalDamage.grade = gradeUp
    p.technique.multiplier = TECH_MULT[gradeUp]
    p.technique.grade = gradeUp
  } else {
    // 已经到顶（龙级）：只把数值往上顶
    pct('hp', 1.2); pct('ce', 1.2); pct('cursedDamage', 1.15); pct('physicalDamage', 1.15)
  }
  // 踏入特级但还没有领域 —— 按第五节的四种方式自行领悟，这里把进度顶到临界做提示
  if (isTier(p.grade) && !p.domain?.unlocked && !p.domain?.progress) {
    p.domain = { unlocked: false, progress: 90, active: false }
  }
  p.status = hpStatus(p.hp)

  // 年数按两篇的实际跨度算，别写死 —— 怀玉篇是 11 年，宿傩篇是 10 年
  const gapYears = Math.max(
    1,
    Number(to.startDate.slice(0, 4)) - Number(from.crossoverGap?.from || to.startDate.slice(0, 4) - 1),
  )
  const span = gapYears === 1 ? '一年' : `${gapYears} 年`
  const names = Object.keys(carried)

  return {
    from: from.name,
    to: to.name,
    toId: to.id,
    startDate: to.startDate,
    gapYears,
    gradeUp,
    carriedRelations: names.map((n) => ({ name: n, value: carried[n] })),
    note: names.length
      ? `${span}过去，${names.join('、')}还记得你`
      : `${span}过去，当年认识你的人已经不在了`,
    before,
  }
}

/** 当前是否可以跨篇（走完了本线的衔接节点） */
export function crossoverReady(state) {
  const line = storylineOf(state.storyline)
  if (!line.next || !line.crossoverNode) return { ok: false, reason: '本篇没有后续篇章' }
  if (state.crossover) return { ok: true, inProgress: true, stages: stagesFor(state.storyline).length, done: state.crossover.done }
  /*
   * 「已改变」和「已改写」都算走完了这一篇。
   * 早先这里只认"已发生"，于是玩家把那一天打成了另一个样子、或者提前杀了
   * 撑起那个节点的人，跨篇的门反而锁死了 —— 明明这一篇已经翻过去了，
   * 界面却告诉他"走完「最终决战」之后才能跨篇"，而那个节点永远不会再变成"已发生"。
   */
  if (!isSettled(state.timeline.nodes[line.crossoverNode])) {
    return { ok: false, reason: `走完「${line.crossoverNode}」之后才能跨篇` }
  }
  return { ok: true, inProgress: false, stages: stagesFor(state.storyline).length, done: 0 }
}
