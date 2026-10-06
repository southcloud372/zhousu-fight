import { GRADES, isTier } from './tables.js'
import { DOMAIN_TYPE_DEFAULT, domainKit, domainTypeOf } from './domains.js'
import { defenseOf } from './formula.js'

/**
 * NPC 视角滤镜。
 * 设定第二节：NPC 只能感知"等级"，看不到数值，也分不清特级内部的强弱。
 * 凡是喂给模型扮演 NPC 的信息，都要先过这里。
 */

/** NPC 眼中的等级：特级一律只显示"特级" */
export function npcGrade(grade) {
  if (isTier(grade)) return '特级'
  return GRADES.includes(grade) ? grade : '不明'
}

/** NPC 眼中的一个战斗单位：只有等级和肉眼可见的状态 */
export function npcView(unit) {
  return {
    等级: npcGrade(unit.grade),
    状态: visibleCondition(unit),
    伤势: visibleWounds(unit),
    领域: unit.domain?.active ? '展开中' : '未展开',
  }
}

function visibleCondition(unit) {
  const r = unit.hp.cur / unit.hp.max
  if (unit.hp.cur <= 0) return '倒下'
  if (r < 0.2) return '摇摇欲坠'
  if (r < 0.6) return '负伤'
  return '尚有余力'
}

function visibleWounds(unit) {
  const r = unit.hp.cur / unit.hp.max
  if (r > 0.9) return '无明显外伤'
  if (r > 0.6) return '身上有几道口子'
  if (r > 0.3) return '血流不止'
  return '重伤，站都站不稳'
}

/**
 * 敌方性格读起来是什么样。
 *
 * 数值（aggression / cunning / defendBelow）在 rolls.js 的 ENEMY_ARCHETYPES 里，
 * 这里只写"所以它打起来会怎样" —— 玩家点开档案想看的是这个，
 * 而不是三个 0~1 的小数。
 */
const ARCHETYPE_NOTE = {
  狂攻: '一味抢攻，几乎不留手防守',
  均衡: '攻守各半，看自己的血量决定进退',
  狡诈: '平时收着打，专挑破绽和术式下手',
  死守: '血一少就缩起来，先保命再谈输出',
}

/**
 * 敌方档案 —— 玩家点开的那一份。
 *
 * 和 npcView 正好相反：那个是**滤镜**（NPC 只看得见等级），这个是**底牌**。
 * 等级、血、咒力、两条伤害、防御、性格，加术式和领域的全部细节。
 *
 * 服务端快照（state.js 的 panelSnapshot）和实时战况面板（combat.js 的 buildPanel）
 * 都从这里取 —— 两处各写一份的话，刷新一次页面就会看到两套不一样的敌人数据。
 */
export function enemyProfile(unit) {
  if (!unit) return null
  const t = unit.technique || {}
  const d = unit.domain || {}
  const kit = d.unlocked ? domainKit(d) : null

  return {
    name: unit.name || '咒灵',
    grade: unit.grade || '',
    /*
     * 是不是按原作表校正过的。要摆出来给玩家看 ——
     * 否则他撞上超特级的五条悟只会觉得引擎在乱给数值，
     * 而实际上那正是"打原作最强的人"应有的样子。
     */
    canon: !!unit.canon,
    canonNote: unit.canonNote || '',
    archetype: unit.archetype || '',
    archetypeNote: ARCHETYPE_NOTE[unit.archetype] || '',
    hp: { cur: unit.hp?.cur ?? 0, max: unit.hp?.max ?? 0 },
    ce: { cur: unit.ce?.cur ?? 0, max: unit.ce?.max ?? 0 },
    cursedDamage: unit.cursedDamage?.value ?? 0,
    physicalDamage: unit.physicalDamage?.value ?? 0,
    efficiency: unit.efficiency?.value ?? 0,
    // 和伤害公式里用的同一个函数，不是另算一套；缺了那两项就算不出来
    defense: (unit.physicalDamage && unit.efficiency) ? Math.round(defenseOf(unit)) : 0,
    reverse: unit.reverseCursedTechnique?.level || '未掌握',
    technique: {
      name: t.name || '未知术式',
      effect: t.effect || '',
      multiplier: t.multiplier ?? 0,
      cost: t.cost ?? 0,
      cooldown: t.cooldown ?? 0,
      cdLeft: t.cdLeft ?? 0,
    },
    domain: d.unlocked ? {
      name: d.name || '未命名领域',
      // 领域类型是"这一型到底做什么"的唯一依据，缺了就按默认的伤害型读
      type: domainTypeOf(d) || DOMAIN_TYPE_DEFAULT,
      tierName: d.tierName || '',
      sureHit: d.sureHit || '',
      brief: kit?.brief || '',
      cost: d.cost ?? 0,
      active: !!d.active,
      turnsLeft: d.turnsLeft ?? 0,
    } : null,
  }
}

/** 关系值 → NPC 表现出的态度（第九节：NPC 只体现态度，不见数值） */
export function npcAttitude(value) {
  if (value >= 80) return '推心置腹'
  if (value >= 50) return '信任'
  if (value >= 20) return '友善'
  if (value >= 0) return '客气'
  if (value >= -30) return '疏远'
  if (value >= -60) return '戒备'
  return '敌意'
}

/** 宿傩的手指一共二十根 —— 原著里他回来的唯一度量，也是本作唯一一条宿傩进度轴 */
export const SUKUNA_FINGERS = 20

/**
 * 宿傩的复苏程度 → 他对玩家的态度。
 *
 * 这里原先是一个自造的「觉醒度」：0~100 的百分比，和手指数说的是同一件事，
 * 却是原著里不存在的东西。原著里宿傩回来的度量只有一样 —— 被吞下去的手指，
 * 二十根，一根一根地回来。所以进度轴就是手指数，态度是它的函数：
 * 前两根他连眼睛都懒得睁，吞到能谈条件的时候，他才会主动开口。
 *
 * 阈值按二十根切：三根才注意到你，七根愿意谈，十二根开始把你当变量，
 * 十七根以上你就是他回来的障碍了。
 */
const SUKUNA_ATTITUDE_STEPS = [
  [17, '敌意'],
  [12, '警惕'],
  [7, '感兴趣'],
  [3, '好奇'],
]

export function sukunaAttitude(fingersEaten) {
  const n = Math.max(0, Math.min(SUKUNA_FINGERS, Number(fingersEaten) || 0))
  for (const [at, label] of SUKUNA_ATTITUDE_STEPS) {
    if (n >= at) return label
  }
  return '无视'
}

/**
 * 玩家自己吞下手指之后的侵蚀程度。
 *
 * 原著里只有虎杖能当容器：同一根手指，进了容器就是宿傩回来一分，
 * 进了别人肚子里就是一味毒药 —— 力量是真的，代价也是真的。
 * 阈值按"吞了几根"读，和态度一样是现算的，不再单独存一个数。
 */
const CORRUPTION_STEPS = [
  [4, '随时可能被夺舍'],
  [3, '精神正在被侵蚀'],
  [2, '咒力开始反噬'],
  [1, '隐隐作呕'],
]

export function playerFingerCorruption(fingersPlayerEaten) {
  const n = Math.max(0, Number(fingersPlayerEaten) || 0)
  for (const [at, label] of CORRUPTION_STEPS) {
    if (n >= at) return label
  }
  return '无'
}

/**
 * 宿傩的进度快照。
 *
 * 只落盘三个数（到手几根、容器吞下几根、玩家自己吞下几根），态度和侵蚀都是
 * **读的时候现算**的 —— 和等级一样，能从数字推出来的东西就不另存一份，
 * 否则旧存档里会留着一个跟手指数对不上的态度。
 *
 * 复苏只看"容器吞下"那一份：这是原著里宿傩回来的唯一途径。
 * 玩家自己吞下的不推进复苏，只换来咒力和一身侵蚀。
 */
export function sukunaView(sukuna) {
  /*
   * 到手的才是真值，吞下的两份是它的两个**不相交子集**。
   * 所以这里一律往下夹，不往上凑 —— 一份对不上的存档应该在面板上
   * 显示得比它自称的少，而不是凭空多出来几根手指。
   */
  const collected = Math.max(0, Math.min(SUKUNA_FINGERS, Number(sukuna?.fingersCollected) || 0))
  const eaten = Math.max(0, Math.min(collected, Number(sukuna?.fingersEaten) || 0))
  const mine = Math.max(
    0,
    Math.min(collected - eaten, Number(sukuna?.fingersPlayerEaten) || 0),
  )
  const attitude = sukunaAttitude(eaten)
  return {
    fingersCollected: collected,
    fingersEaten: eaten,
    fingersPlayerEaten: mine,
    attitude,
    canSpeak: sukunaSpeaks(attitude),
    corruption: playerFingerCorruption(mine),
  }
}

/**
 * 宿傩会不会在玩家意识里开口。
 *
 * 原著里他只跟"有点意思"的人讲话 —— 无视你的时候一个字都没有。
 * 所以这道闸门是态度的函数，不再另设一个百分比门槛。
 */
export function sukunaSpeaks(attitude) {
  return attitude !== '无视'
}
