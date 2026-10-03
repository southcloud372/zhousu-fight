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
}

/** 新建一条故事线的初始节点表 */
export function initialNodes(storylineId) {
  const out = {}
  for (const node of nodesFor(storylineId)) out[node] = '未发生'
  return out
}
