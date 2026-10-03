import {
  RANGES, TECH_MULT, INITIAL_WEIGHTS, ATTR_SHIFT, DOMAIN_TIER, GRADES,
  gradeIndex, shiftGrade, isTier,
} from './tables.js'
import { rint, pickByProb, weightedPick, rfloat } from './dice.js'
import { defenseOf } from './formula.js'
import { charactersFor } from './timeline.js'
import { DEFAULT_STORYLINE } from './storylines.js'

/** 领域每回合维持消耗 = 咒力上限的比例，与 state.js 保持一致 */
const DOMAIN_COST_RATIO = 0.08

/**
 * 开局属性档案由引擎掷骰，模型只负责"术式叫什么、天赋标签叫什么"。
 * 这样能保证数值永远落在设定表区间内，模型不会掷出 999999 的咒力。
 */
export function rollAttributeProfile(rng, slot) {
  const overall = weightedPick(rng, INITIAL_WEIGHTS)

  const attr = (key) => {
    const g = shiftGrade(overall, pickByProb(rng, ATTR_SHIFT))
    const [lo, hi] = RANGES[g][key]
    return { value: rint(rng, lo, hi), grade: g }
  }

  const techGrade = shiftGrade(overall, pickByProb(rng, ATTR_SHIFT))

  const profile = {
    slot,
    overallGrade: overall,
    ce: { ...attr('ce'), label: '咒力总量' },
    hp: { ...attr('hp'), label: '血条总量' },
    cursedDamage: { ...attr('cd'), label: '咒术伤害' },
    physicalDamage: { ...attr('pd'), label: '体术伤害' },
    efficiency: (() => {
      const g = shiftGrade(overall, pickByProb(rng, ATTR_SHIFT))
      // 效率在设定表里是固定值，围绕它做 ±5% 浮动保留随机感
      return { value: Number((RANGES[g].eff * rfloat(rng, 0.95, 1.05)).toFixed(2)), grade: g, label: '咒力效率' }
    })(),
    techniqueGrade: techGrade,
    techniqueMultiplier: TECH_MULT[techGrade],
    // 特级开局直接觉醒领域（第五节例外条款）
    domainUnlocked: isTier(overall),
    domainTierName: DOMAIN_TIER[overall] || null,
    reverseCursedTechnique: rollReverse(rng, overall),
    toolCount: rng() < 0.5 ? 1 : 0,
  }
  profile.defense = Math.round(defenseOf(profile))
  return profile
}

function rollReverse(rng, grade) {
  const i = gradeIndex(grade)
  // 等级越高越可能已经接触过反转术式
  const r = rng()
  if (i >= 6) return r < 0.15 ? '熟练' : r < 0.45 ? '初步' : '未掌握'
  if (i >= 4) return r < 0.05 ? '熟练' : r < 0.25 ? '初步' : '未掌握'
  return r < 0.1 ? '初步' : '未掌握'
}

/** 天赋标签池：模型从中挑选，避免自由发挥出破坏平衡的能力 */
export const TALENT_POOL = [
  '战斗直觉', '咒力感知异常', '命硬', '咒力操作精细', '体术天赋', '术式理解快',
  '抗痛性强', '临战冷静', '爆发型', '续航型', '咒具亲和', '领域感知',
  '宿傩气息', '咒灵亲和', '反转适性',
]

/** 身份档案的三类槽位：必须含反派向与自由派各一（第十节） */
export const IDENTITY_KINDS = ['反派向', '自由派']

const BACKGROUNDS = {
  反派向: [
    '诅咒师卧底：伪装成高专学生，实际为某诅咒师组织收集宿傩手指情报。',
    '咒灵侧使者：被特级咒灵派遣，目的是接触宿傩或虎杖。',
    '复仇者：家人被咒术师所害，加入咒灵侧以摧毁咒术界。',
    '宿傩崇拜者：主动追寻宿傩手指，企图复活诅咒之王。',
    '契约者：与某咒灵签订契约，以身体或灵魂为代价换取力量。',
  ],
  自由派: [
    '独立咒术师：不属于高专，靠接私活为生，偶然卷入宿傩手指事件。',
    '咒具商人：游走于咒术界与咒灵之间的灰色地带，收集贩卖咒具。',
    '无记忆穿越者：不知自己为何出现在这个世界，拥有力量但无立场。',
    '被诅咒缠身者：身上有不明咒力残留，被高专和咒灵同时盯上。',
    '赏金猎人：接受咒术界或诅咒师的委托，按报酬行动。',
  ],
  原作关联: [
    '虎杖悠仁的同班同学，被卷入少年院事件。',
    '东京咒术高专的观察员，奉命记录宿傩容器的一切。',
    '五条悟临时招募的外部协助者。',
  ],
}

export function rollIdentityKind(rng, index) {
  if (index < 2) return IDENTITY_KINDS[index] // 保证两类各出现一次
  return weightedPick(rng, { 原作关联: 1, 反派向: 1, 自由派: 1 })
}

/** 关系初值由身份类型决定，模型不参与 */
/**
 * 关系初值。名单按故事线取 —— 怀玉篇里没有虎杖、钉崎，
 * 硬套宿傩篇的名单会生成一堆"对这个 2006 年还不存在的人有好感"。
 */
export function rollInitialRelations(rng, kind, storylineId = DEFAULT_STORYLINE) {
  const rel = {}
  for (const name of charactersFor(storylineId)) rel[name] = 0

  const pick = (names) => names.filter((n) => n in rel)
  const bump = (name, lo, hi) => { if (name in rel) rel[name] = rint(rng, lo, hi) }

  if (kind === '原作关联') {
    // 各线的"主角位"不同：宿傩篇是虎杖，怀玉篇是五条与夏油
    if (storylineId === 'kaigyoku') {
      bump('五条悟', 5, 15); bump('夏油杰', 3, 12); bump('家入硝子', 0, 8)
    } else {
      bump('虎杖悠仁', 5, 15); bump('五条悟', 0, 10); bump('伏黑惠', 0, 8)
    }
  } else if (kind === '反派向') {
    if (storylineId === 'kaigyoku') {
      // 2006 年的"反派侧"是诅咒师与盘星教，不是宿傩
      bump('伏黑甚尔', 0, 12); bump('五条悟', -rint(rng, 0, 10), -1); bump('夜蛾正道', -rint(rng, 0, 5), -1)
    } else {
      bump('宿傩', 0, 12); bump('五条悟', -rint(rng, 0, 10), -1); bump('夜蛾正道', -rint(rng, 0, 5), -1)
    }
  } else {
    for (const n of pick(storylineId === 'kaigyoku' ? ['五条悟', '夏油杰'] : ['宿傩', '五条悟'])) {
      rel[n] = rint(rng, -5, 5)
    }
  }
  return rel
}

export function rollIdentity(rng, slot, kind, storylineId = DEFAULT_STORYLINE) {
  return {
    slot,
    kind,
    age: rint(rng, 16, 18),
    backgroundTemplate: pickByProb(rng, BACKGROUNDS[kind].map((b) => ({ value: b, p: 1 / BACKGROUNDS[kind].length }))),
    initialRelations: rollInitialRelations(rng, kind, storylineId),
  }
}

/** 敌方性格：影响 AI 的出手倾向，避免所有敌人一个打法 */
export const ENEMY_ARCHETYPES = {
  狂攻: { aggression: 1.0, cunning: 0.1, defendBelow: 0 },
  均衡: { aggression: 0.6, cunning: 0.4, defendBelow: 0.35 },
  狡诈: { aggression: 0.5, cunning: 0.85, defendBelow: 0.5 },
  死守: { aggression: 0.35, cunning: 0.3, defendBelow: 0.6 },
}

/** 敌方档案：按等级掷，和玩家用同一套表 */
export function rollEnemy(rng, grade) {
  const attr = (key) => {
    const [lo, hi] = RANGES[grade][key]
    return { value: rint(rng, lo, hi), grade }
  }
  const ceVal = attr('ce').value
  const tier = isTier(grade)

  const e = {
    name: '咒灵',
    grade,
    hp: attr('hp'),
    ce: attr('ce'),
    cursedDamage: attr('cd'),
    physicalDamage: attr('pd'),
    efficiency: { value: RANGES[grade].eff, grade },
    technique: {
      name: '未知术式',
      effect: '',
      multiplier: TECH_MULT[grade],
      cost: Math.round(ceVal * 0.08),
      cooldown: rint(rng, 1, 3),
      cdLeft: 0,
      grade,
    },
    // 特级及以上的敌人按第五节持有领域
    domain: tier
      ? {
          unlocked: true,
          name: '未命名领域',
          sureHit: '',
          cost: Math.round(ceVal * DOMAIN_COST_RATIO),
          grade,
          tierName: DOMAIN_TIER[grade],
          active: false,
          turnsLeft: 0,
        }
      : { unlocked: false, active: false },
    archetype: null,
    // 反转术式：高等级敌人更可能有
    reverseCursedTechnique: { level: tier && rng() < 0.4 ? '初步' : '未掌握', progress: 0 },
  }
  e.archetype = Object.keys(ENEMY_ARCHETYPES)[rint(rng, 0, 3)]
  e.hp.cur = e.hp.max = e.hp.value
  e.ce.cur = e.ce.max = e.ce.value
  return e
}

export { GRADES }
