import { hpStatus } from './formula.js'
import { sukunaAttitude, npcAttitude } from './visibility.js'
import { DOMAIN_TIER } from './tables.js'
import { emptyUsage } from '../pricing.js'

export const GAME_START_DATE = '2018-06-05'

/** 术式基础消耗 = 咒力上限的比例；领域每回合维持消耗另算 */
export const TECH_COST_RATIO = 0.05
export const DOMAIN_COST_RATIO = 0.08

const TRAINING_ITEMS = ['体能训练', '咒力冥想', '术式演练', '反转术式修习', '领域雏形冥想', '体术实战']

export function blankState(rng) {
  return {
    version: 1,
    seed: Math.floor(rng() * 1e9),
    phase: 'attributes', // attributes → identities → playing
    attributeProfiles: [],
    identityProfiles: [],
    chosenAttributeSlot: null,
    chosenIdentitySlot: null,
    player: null,
    relations: {},
    sukuna: { fingersCollected: 1, fingersEaten: 1, awakening: 5, attitude: '无视' },
    timeline: {
      nodes: {
        虎杖吞手指: '已发生', 死刑缓期: '未发生', 高专入学: '未发生', 少年院任务: '未发生',
        宿傩夺舍: '未发生', 京都姊妹校交流: '未发生', 涩谷事变: '未发生', 死灭回游: '未发生', 最终决战: '未发生',
      },
      changed: [], deaths: [], newEvents: [],
    },
    time: { date: GAME_START_DATE, day: 1, skipStreak: 0 },
    log: [],       // 界面渲染用
    history: [],   // 喂给模型的对话历史
    chronicle: '', // 更早剧情的压缩摘要
    pendingCombat: null,
    storyLock: null, // 关键剧情节点当天会锁定"跳过修炼"
    turn: 0,
    usage: emptyUsage(), // 本局累计的 token 消耗与费用
  }
}

/** 把引擎掷的属性 + 模型写的创意字段合成最终角色 */
export function buildPlayer(attr, flavor, identity, identityFlavor) {
  const techCost = Math.max(1, Math.round(attr.ce.value * TECH_COST_RATIO))
  const domainCost = Math.max(1, Math.round(attr.ce.value * DOMAIN_COST_RATIO))

  return {
    name: identityFlavor.name,
    age: identity.age,
    grade: attr.overallGrade,
    backgroundType: identity.kind,
    background: identityFlavor.background,
    mainlineRelation: identityFlavor.mainlineRelation,
    openingSituation: identityFlavor.openingSituation,
    hook: identityFlavor.hook,

    hp: { cur: attr.hp.value, max: attr.hp.value, grade: attr.hp.grade },
    ce: { cur: attr.ce.value, max: attr.ce.value, grade: attr.ce.grade },
    cursedDamage: { value: attr.cursedDamage.value, grade: attr.cursedDamage.grade },
    physicalDamage: { value: attr.physicalDamage.value, grade: attr.physicalDamage.grade },
    efficiency: { value: attr.efficiency.value, grade: attr.efficiency.grade },

    technique: {
      name: flavor.techniqueName,
      effect: flavor.techniqueEffect,
      grade: attr.techniqueGrade,
      multiplier: attr.techniqueMultiplier,
      cost: techCost,
      cooldown: Math.max(0, Math.min(5, flavor.techniqueCooldown | 0)),
      cdLeft: 0,
      mastery: 0,
    },

    domain: attr.domainUnlocked
      ? {
          unlocked: true,
          name: flavor.domain?.name || '未命名领域',
          sureHit: flavor.domain?.sureHit || '',
          cost: domainCost,
          grade: attr.overallGrade,
          tierName: DOMAIN_TIER[attr.overallGrade] || '半成品',
          active: false,
          completeness: 1,
        }
      : { unlocked: false, progress: 0, active: false },

    reverseCursedTechnique: { level: attr.reverseCursedTechnique, progress: 0 },
    tools: flavor.tool ? [{ name: flavor.tool, note: '' }] : [],
    talents: flavor.talents || [],
    status: '正常',
    training: Object.fromEntries(TRAINING_ITEMS.map((k) => [k, 0])),
  }
}

/**
 * 应用模型的提议。所有数值在这里落地，模型碰不到真值。
 * 咒力归零后强行施术要扣血（第一节）。
 */
export function applyProposal(state, prop) {
  const p = state.player
  const notes = [...(prop.notes || [])]

  p.ce.cur = Math.max(0, Math.min(p.ce.max, p.ce.cur + prop.ceDelta))
  p.hp.cur = Math.max(0, Math.min(p.hp.max, p.hp.cur + prop.hpDelta))

  // 咒力见底还硬撑 → 按缺口折算成血量损伤
  if (p.ce.cur === 0 && prop.ceDelta < 0) {
    const overspend = Math.abs(prop.ceDelta) - (p.ce.max - Math.max(0, p.ce.cur - prop.ceDelta))
    if (overspend > 0) {
      p.hp.cur = Math.max(0, p.hp.cur - overspend)
      notes.push(`咒力透支，反噬 ${overspend} 点生命`)
    }
  }

  for (const [k, v] of Object.entries(prop.relationDelta || {})) {
    const cur = state.relations[k] ?? 0
    state.relations[k] = Math.max(-100, Math.min(100, cur + v))
  }

  if (prop.sukunaAwakeningDelta) {
    state.sukuna.awakening = Math.max(0, Math.min(100, state.sukuna.awakening + prop.sukunaAwakeningDelta))
    state.sukuna.attitude = sukunaAttitude(state.sukuna.awakening)
  }

  for (const f of prop.flags || []) {
    // 约定：进入关键节点的 flag 形如「少年院任务_开始」。
    // 去掉后缀再匹配原作节点表，否则时间线永远推不动。
    const nodeKey = f.endsWith('_开始') ? f.slice(0, -3) : f
    if (state.timeline.nodes[nodeKey] !== undefined) {
      // 已发生过的节点不倒退，也不重复记
      if (state.timeline.nodes[nodeKey] === '未发生') state.timeline.nodes[nodeKey] = '已发生'
    } else if (!state.timeline.newEvents.includes(f)) {
      state.timeline.newEvents.push(f)
    }
  }

  // 注意：这里**不**处理「战斗结束」对 pendingCombat 的影响。
  // 待结算的遭遇是"玩家还没决定打不打"，只能由玩家经由
  // /combat/start（迎战）或 /combat/evade（脱离）来结清。
  // 早先允许模型用 flag 直接清掉它，结果模型一叙述"冲突化解了"，
  // 玩家那边的迎战/脱离询问就凭空消失了 —— 等于绕过了战斗系统。

  if (prop.timeAdvance && prop.timeAdvance !== '0') {
    advanceTime(state, prop.timeAdvance)
  }

  p.status = hpStatus(p.hp)
  if (p.technique.cdLeft > 0) p.technique.cdLeft--

  return notes
}

export function advanceTime(state, amount) {
  const days = { '1d': 1, '3d': 3, '1w': 7 }[amount] ?? 0
  if (!days) return
  state.time.day += days
  const [y, m, d] = state.time.date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  state.time.date = dt.toISOString().slice(0, 10)
}

/**
 * 喂给模型的紧凑状态视图。
 * 注意：绝不能把 state.log / state.history 直接塞进去 ——
 * 那会把每回合的完整正文重复计费一遍，上下文几轮就爆了。
 * 对话历史走 messages 通道，这里只放"当前真值"。
 */
export function modelStateView(state) {
  const p = state.player
  const relationsForModel = Object.fromEntries(
    Object.entries(state.relations)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => [k, { 数值: v, 表现出的态度: npcAttitude(v) }]),
  )

  return {
    日期: state.time.date,
    第几天: state.time.day,
    连续跳过天数: state.time.skipStreak,
    玩家: p && {
      姓名: p.name,
      年龄: p.age,
      综合等级: p.grade,
      背景类型: p.backgroundType,
      背景: p.background,
      与主线关系: p.mainlineRelation,
      特殊钩子: p.hook,
      血条: `${p.hp.cur} / ${p.hp.max}`,
      咒力: `${p.ce.cur} / ${p.ce.max}`,
      咒术伤害: p.cursedDamage.value,
      体术伤害: p.physicalDamage.value,
      咒力效率: `${Math.round(p.efficiency.value * 100)}%`,
      身体状态: p.status,
      生得术式: {
        名称: p.technique.name,
        效果: p.technique.effect,
        倍率: p.technique.multiplier,
        冷却: p.technique.cooldown,
        剩余冷却: p.technique.cdLeft,
      },
      领域: p.domain.unlocked
        ? {
            名称: p.domain.name,
            强度: p.domain.tierName,
            必中效果: p.domain.sureHit,
            代价: p.domain.cost,
            是否展开: !!p.domain.active,
          }
        : '未领悟',
      反转术式: p.reverseCursedTechnique.level,
      咒具: p.tools.map((t) => t.name),
      天赋标签: p.talents,
    },
    关系值: relationsForModel,
    宿傩: {
      已收集手指: `${state.sukuna.fingersCollected} / 20`,
      虎杖已吞下: `${state.sukuna.fingersEaten} 根`,
      觉醒度: `${state.sukuna.awakening}%`,
      对玩家的态度: state.sukuna.attitude,
      // 第九节第 9 小节：觉醒度 ≥ 30% 且态度"感兴趣"以上，宿傩才能在意识中对话
      可在意识中对话:
        state.sukuna.awakening >= 30 &&
        ['感兴趣', '警惕', '敌意', '玩物'].includes(state.sukuna.attitude),
    },
    原作节点: state.timeline.nodes,
    因玩家介入产生的新事件: state.timeline.newEvents,
    已死亡角色: state.timeline.deaths,
    待结算战斗: state.pendingCombat
      ? { 敌方: `${state.pendingCombat.enemy.name}（${state.pendingCombat.enemy.grade}）`, 起因: state.pendingCombat.reason }
      : null,
    进行中的战斗: state.combat
      ? {
          模式: state.combat.mode,
          回合: state.combat.turn,
          敌方: `${state.combat.enemy.name}（${state.combat.enemy.grade}）`,
          敌方剩血: `${Math.round((state.combat.enemy.hp.cur / state.combat.enemy.hp.max) * 100)}%`,
        }
      : null,
  }
}

/** 面板给前端渲染的公开数据 */
export function panelSnapshot(state) {
  const p = state.player
  if (!p) return null
  return {
    name: p.name,
    age: p.age,
    grade: p.grade,
    backgroundType: p.backgroundType,
    background: p.background,
    hp: p.hp,
    ce: p.ce,
    status: p.status,
    technique: p.technique,
    domain: p.domain,
    reverseCursedTechnique: p.reverseCursedTechnique,
    tools: p.tools,
    talents: p.talents,
    cursedDamage: p.cursedDamage,
    physicalDamage: p.physicalDamage,
    efficiency: p.efficiency,
    relations: state.relations,
    sukuna: state.sukuna,
    timeline: state.timeline,
    time: state.time,
    training: p.training,
    // 战斗相关的现场状态，刷新页面后要靠它恢复
    combat: state.combat
      ? {
          mode: state.combat.mode,
          turn: state.combat.turn,
          enemy: {
            name: state.combat.enemy.name,
            grade: state.combat.enemy.grade,
            hp: state.combat.enemy.hp.cur,
            hpMax: state.combat.enemy.hp.max,
            ceEstimate: state.combat.enemy.ce.cur,
            technique: state.combat.enemy.technique.name,
            domain: state.combat.enemy.domain?.name || null,
            domainActive: !!state.combat.enemy.domain?.active,
          },
          over: state.combat.over,
        }
      : null,
    pendingCombat: state.pendingCombat
      ? {
          enemyName: state.pendingCombat.enemy.name,
          enemyGrade: state.pendingCombat.enemy.grade,
          enemyTechnique: state.pendingCombat.enemy.technique.name,
          reason: state.pendingCombat.reason,
        }
      : null,
    combatLog: state.combat?.log || [],
  }
}

export { TRAINING_ITEMS }
