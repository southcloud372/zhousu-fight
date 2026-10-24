import { gradeIndex, isTier } from './tables.js'

/**
 * 成就系统。
 *
 * 一个没有里程碑的长线游戏留不住「还想再打一局」的念头。这里补上
 * **本局内的成就**：全部从既有事实（battles / 黒闪计数 / 时间线 / 等级）
 * 现算判定，不另记账本 —— 和 career 战绩同一哲学，存档里只存「已达成
 * 哪些 id」，达成与否任何时候都能重建。
 *
 * 判定幂等且便宜，所以在每个结算点（战斗收尾、处置、回合落地、谢幕）
 * 都可以放心跑一遍；新达成的塞进 state.pendingAchievements，由响应层
 * 取走（takeAchievements）交给前端弹提示。
 */

export const ACHIEVEMENTS = [
  { id: 'first-win', name: '初阵', desc: '赢下第一场战斗', test: (f) => f.wins >= 1 },
  { id: 'first-kill', name: '初次杀戮', desc: '第一次亲手终结一个人', test: (f) => f.kills >= 1 },
  { id: 'elite-slayer', name: '讨伐精英', desc: '击倒一个词缀精英', test: (f) => f.eliteKills >= 1 },
  { id: 'veteran', name: '百战', desc: '经历 10 场战斗', test: (f) => f.battles >= 10 },
  { id: 'perfect', name: '完胜', desc: '一伤未受地赢下一场战斗', test: (f) => f.perfects >= 1 },
  { id: 'bf-first', name: '黒閃初閃', desc: '打出第一颗黒闪', test: (f) => f.blackFlash >= 1 },
  { id: 'bf-three', name: '黒閃連閃', desc: '累计打出 3 颗黒闪', test: (f) => f.blackFlash >= 3 },
  { id: 'rewriter', name: '改写者', desc: '改写 3 个原作节点', test: (f) => f.changedNodes >= 3 },
  { id: 'ever-present', name: '常在场上', desc: '介入 5 个原作正日子', test: (f) => f.interventions >= 5 },
  { id: 'confidant', name: '挚友', desc: '与某人的关系可以托付后背（≥60）', test: (f) => f.maxRelation >= 60 },
  { id: 'nemesis', name: '宿敌', desc: '与某人结下不死不休的深仇（≤-60）', test: (f) => f.minRelation <= -60 },
  { id: 'crossover', name: '跨篇者', desc: '走完篇章之间的三段历练', test: (f) => f.crossed },
  { id: 'grade-tier', name: '特级之路', desc: '踏入特级的门槛', test: (f) => f.isTierGrade },
  { id: 'finale', name: '終劇', desc: '给一局画上正式的句点', test: (f) => f.ended },
]

/** 成就判定的事实层：全部由 state 现算，不另记账 */
export function achievementFacts(state) {
  const battles = state.battles || []
  return {
    battles: battles.length,
    wins: battles.filter((b) => b.result === '击倒' || b.result === '击杀').length,
    kills: battles.filter((b) => b.killed).length,
    eliteKills: battles.filter((b) => b.killed && b.elite).length,
    perfects: battles.filter((b) => b.perfect).length,
    blackFlash: state.player?._blackFlash || 0,
    changedNodes: (state.timeline.changed || []).length,
    interventions: battles.filter((b) => b.ground === '介入战').length,
    isTierGrade: isTier(state.player?.grade) || gradeIndex(state.player?.grade) >= 5,
    // 关系的两极：挚友与宿敌都从这张表里读
    maxRelation: Math.max(0, ...Object.values(state.relations || {})),
    minRelation: Math.min(0, ...Object.values(state.relations || {})),
    // 跨篇：三段历练走满（两条线的衔接都是三段，见 crossover.js）
    crossed: (state.crossover?.done || 0) >= 3,
    ended: !!state.ended,
  }
}

/**
 * 跑一遍判定，新达成的记进 pendingAchievements。
 * 返回本次新达成的成就（无新达成返回空数组）。
 */
export function checkAchievements(state) {
  if (!state.player) return []
  const facts = achievementFacts(state)
  state.achievements ||= []
  state.pendingAchievements ||= []
  const newly = []
  for (const a of ACHIEVEMENTS) {
    if (state.achievements.includes(a.id)) continue
    if (a.test(facts)) {
      state.achievements.push(a.id)
      state.pendingAchievements.push(a)
      newly.push(a)
    }
  }
  return newly
}

/** 响应层取走新达成的成就（取走即清空，避免重复下发） */
export function takeAchievements(state) {
  const out = state.pendingAchievements || []
  state.pendingAchievements = []
  return out
}

/** 面板用：全量成就 + 达成状态（按表序，已达成的排前面由前端处理） */
export function achievementView(state) {
  const done = new Set(state.achievements || [])
  return ACHIEVEMENTS.map((a) => ({
    id: a.id,
    name: a.name,
    desc: a.desc,
    done: done.has(a.id),
  }))
}
