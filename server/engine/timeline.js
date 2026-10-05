import { storylineOf, DEFAULT_STORYLINE } from './storylines.js'

/**
 * 时间线操作。
 *
 * 原来这里是两张写死的全局表（TIME_POINTS / NODE_ORDER），
 * 加了怀玉篇之后必须按故事线取 —— 否则选怀玉篇却拿到宿傩篇的节点，
 * 时间线追踪器会列出一堆 2018 年才发生的事。
 */

/** 某条故事线的全部可选时间点 */
export const pointsFor = (storylineId) => storylineOf(storylineId).timePoints

/** 某条故事线的原作节点（按先后） */
export const nodesFor = (storylineId) => storylineOf(storylineId).nodes

/** 某条故事线的节点排期（每个节点自己那一天） */
export const scheduleFor = (storylineId) => storylineOf(storylineId).nodeSchedule

/** 某条故事线的登场角色 */
export const charactersFor = (storylineId) => storylineOf(storylineId).characters

export const mentorsFor = (storylineId) => storylineOf(storylineId).mentors

/** 在指定故事线里按 id 找时间点 */
export function byId(id, storylineId = DEFAULT_STORYLINE) {
  return pointsFor(storylineId).find((t) => t.id === id)
}

/** 兜底：找不到就返回该线的第一个时间点（即"最开篇"） */
export const firstPoint = (storylineId) => pointsFor(storylineId)[0]

/**
 * 把某个时间点的进度写进 timeline.nodes。
 * 节点的键来自当前故事线 —— 换线时旧的节点名不会残留。
 */
export function applyTimeline(state, point) {
  const nodes = nodesFor(state.storyline)
  const done = new Set(point.nodesDone)

  // 重建整张表，而不是逐个改 —— 换线或重开时不会留下上一条线的节点
  const next = {}
  for (const node of nodes) {
    const prev = state.timeline.nodes[node]
    // 已经写成"已发生"的保持不动（玩家可能改过剧情），其余按时间点定
    next[node] = prev === '已发生' || prev === '已改变' ? prev : (done.has(node) ? '已发生' : '未发生')
  }
  state.timeline.nodes = next

  state.time.date = point.date
  state.time.day = 1
  state.time.point = point.id // 当前章节，只给界面看 —— 排期另有一张 nodeSchedule
}

/** 新建一条故事线的初始节点表 */
export function initialNodes(storylineId) {
  const out = {}
  for (const node of nodesFor(storylineId)) out[node] = '未发生'
  return out
}

// ---------------------------------------------------------------- 排期

const toDate = (s) => new Date(`${s}T00:00:00Z`).getTime()
export const daysBetween = (from, to) => Math.round((toDate(to) - toDate(from)) / 86400000)

/**
 * 下一个"剧情发生当天"。
 *
 * 走的是**节点排期**（storylines.js 的 nodeSchedule），不是穿越时间点表。
 * 这两张表以前是一张 —— 轮盘只在七个穿越时间点上停，于是夹在两个时间点
 * 中间的节点（虎杖吞手指 / 死刑缓期 / 高专入学 / 宿傩夺舍）无论练多久都不会
 * 触发，追踪器上永远挂着"未发生"。玩家看到的就是"轮盘只到大节点就到头了"。
 *
 * 要停的是**每个小节点**：排期里每一个还没发生的节点都是它自己那一天的一场仗，
 * 同一天可以有两个（少年院任务与宿傩夺舍就是同一晚），所以循环里不能去重。
 *
 * 日期已经过去的节点不再补算 —— 玩家（或模型）把时间推过去了，那件事
 * 就当没赶上。missedNodes() 会把它登记成"已发生"，免得追踪器一直骗人。
 *
 * 放在这里而不是 wheel.js，是因为 state.js 也要用它 ——
 * wheel.js 依赖 state.js，反过来引会成环。
 */
export function nextMilestone(state) {
  const today = state.time?.date
  if (!today) return null

  for (const s of scheduleFor(state.storyline)) {
    const st = state.timeline?.nodes?.[s.node]
    if (st === '已发生' || st === '已改变') continue // 这天已经走过，看下一个
    if (s.date < today) continue // 已经过去了，不再补算
    return {
      id: s.node,
      label: `${s.date} · ${s.node}`,
      date: s.date,
      node: s.node,
      danger: s.danger,
      dangerLabel: s.dangerLabel,
      daysLeft: Math.max(0, daysBetween(today, s.date)),
    }
  }
  return null
}

/**
 * 补登错过的节点：日期已经过去、还挂着"未发生"的，改成"已发生"。
 *
 * 玩家能错过的只有一种情况 —— 在剧情向里让模型把日期推过去了，再切回战斗向。
 * 不补的话，那些节点会永远卡在"未发生"，而轮盘又永远不会为它们停下，
 * 界面和引擎对不上账。错过的就是没赶上，写成"已发生"最诚实。
 */
export function missedNodes(state) {
  const today = state.time?.date
  if (!today) return []
  const out = []
  for (const s of scheduleFor(state.storyline)) {
    const st = state.timeline?.nodes?.[s.node]
    if (st !== '未发生') continue
    if (s.date >= today) continue
    state.timeline.nodes[s.node] = '已发生'
    out.push(s.node)
  }
  return out
}
