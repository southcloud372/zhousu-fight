import { hpStatus } from './formula.js'
import { sukunaAttitude, npcAttitude } from './visibility.js'
import { DOMAIN_TIER, GRADES, RANGES, TECH_MULT, gradeIndex, isTier } from './tables.js'
import { emptyUsage } from '../pricing.js'
import { DEFAULT_STORYLINE, storylineOf } from './storylines.js'
import { DEFAULT_PLAY_MODE, playModeOf } from './playmodes.js'
import { initialNodes, nextMilestone, firstPoint } from './timeline.js'
import { normalizeDomainType, defaultDomainTypeFor, domainTypeOf, domainKit } from './domains.js'

export const GAME_START_DATE = '2018-06-05'

/** 术式基础消耗 = 咒力上限的比例；领域每回合维持消耗另算 */
export const TECH_COST_RATIO = 0.05
export const DOMAIN_COST_RATIO = 0.08

const TRAINING_ITEMS = ['体能训练', '咒力冥想', '术式演练', '反转术式修习', '领域雏形冥想', '体术实战']

export function blankState(rng, storylineId = DEFAULT_STORYLINE, playMode = DEFAULT_PLAY_MODE) {
  const line = storylineOf(storylineId)
  return {
    version: 1,
    storyline: line.id,
    playMode: playModeOf(playMode).id,
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
      // 节点表按故事线生成 —— 宿傩篇和怀玉篇的原作节点完全不同
      nodes: initialNodes(line.id),
      changed: [], deaths: [], newEvents: [],
    },
    // point = 当前章节，只给界面看；战斗向"还差几天到下一个节点"走的是
    // storylines.nodeSchedule（见 timeline.nextMilestone）
    time: { date: line.startDate, day: 1, skipStreak: 0, point: firstPoint(line.id).id },
    // 战斗向的日常轮盘：累计训练天数、各方向落点、疲劳系数（见 wheel.js）
    wheel: { days: 0, sectors: {}, lastItem: null, lastUps: [], fatigue: 1, interventions: [] },
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
      ? (() => {
          const tierName = DOMAIN_TIER[attr.overallGrade] || '半成品'
          return {
            unlocked: true,
            name: flavor.domain?.name || '未命名领域',
            sureHit: flavor.domain?.sureHit || '',
            cost: domainCost,
            grade: attr.overallGrade,
            tierName,
            /*
             * 领域类型由模型挑（那是设定），但必须有值 —— 没有类型就等于
             * "开了领域什么都不发生"，那是分型之前的老毛病。模型没填或填了
             * 不认识的词，就按等级名兜一个（规则级领域 → 规则型）。
             */
            type: normalizeDomainType(flavor.domain?.type) || defaultDomainTypeFor(tierName),
            active: false,
            completeness: 1,
          }
        })()
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

  // 死亡永久入库：模型每回合都会在状态里看到已死亡角色，就很难让人复活
  for (const who of prop.deaths || []) {
    if (!state.timeline.deaths.includes(who)) state.timeline.deaths.push(who)
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

/**
 * 把角色抬到指定等级：数值抬到新等级区间的起点，避免越级虚高。
 * 从 combat.js 的 applyRewards 里抽出来，好让轮盘也能用同一条升级路径。
 */
export function applyGradeUp(p, g) {
  const r = RANGES[g]
  p.grade = g
  p.hp.max = Math.max(p.hp.max, r.hp[0])
  p.ce.max = Math.max(p.ce.max, r.ce[0])
  p.cursedDamage.value = Math.max(p.cursedDamage.value, r.cd[0])
  p.physicalDamage.value = Math.max(p.physicalDamage.value, r.pd[0])
  p.hp.grade = p.ce.grade = p.cursedDamage.grade = p.physicalDamage.grade = g
  p.technique.multiplier = TECH_MULT[g]
  p.technique.grade = g
  if (isTier(g) && !p.domain.unlocked) {
    // 领域仍按第五节自己的四种方式领悟；这里只把进度顶到临界，算个提示
    p.domain = { unlocked: false, progress: 90, active: false }
  }
  return g
}

/**
 * 靠积累升级：四项属性的上限都够到了下一级的区间起点，就升。
 * 这是"堆够了就直接升级、没有专属突破剧情"的落地方式 ——
 * 等级是练出来的，不是等剧情发下来的。
 */
export function promoteGrade(state) {
  const p = state.player
  if (!p) return null
  const gi = gradeIndex(p.grade)
  if (gi < 0 || gi >= GRADES.length - 1) return null
  const next = GRADES[gi + 1]
  const r = RANGES[next]
  const ready = p.hp.max >= r.hp[0] && p.ce.max >= r.ce[0]
    && p.cursedDamage.value >= r.cd[0] && p.physicalDamage.value >= r.pd[0]
  if (!ready) return null
  return applyGradeUp(p, next)
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

  const line = storylineOf(state.storyline)

  // 战斗向多一层"修炼循环"的真值：模型得知道玩家刚练了多久、
  // 不然它会把一个练了三个月的角色写成昨天才起床。
  let wheelView = null
  if (state.playMode === 'combat' && p) {
    const w = state.wheel || {}
    const ms = nextMilestone(state)
    wheelView = {
      累计训练天数: w.days || 0,
      各方向落点: w.sectors || {},
      最近一次落点: w.lastItem || '无',
      疲劳系数: Number((w.fatigue ?? 1).toFixed(2)),
      距下一剧情节点: ms ? `${ms.daysLeft} 天（${ms.date}「${ms.node}」）` : '已无排期节点',
    }
  }

  return {
    故事线: `${line.name}（${line.era}）`,
    游玩模式: playModeOf(state.playMode).name,
    ...(wheelView ? { 修炼循环: wheelView } : {}),
    本线登场角色: line.characters,
    本线原作节点: line.nodes,
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
            /*
             * 类型写进模型看得见的状态里，是让旁白跟得上机制：
             * 伤害型展开该写"重击落下"，规则型该写"对方的术式哑了"，
             * 增益型该写"伤在往回退"。类型不写，模型只会照着名字瞎猜。
             */
            类型: domainTypeOf(p.domain),
            机制: domainKit(p.domain).brief,
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
            domainType: state.combat.enemy.domain?.unlocked
              ? domainTypeOf(state.combat.enemy.domain) : null,
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
