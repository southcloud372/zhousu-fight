import {
  RANGES, TECH_MULT, INITIAL_WEIGHTS, ATTR_SHIFT, DOMAIN_TIER, GRADES,
  gradeIndex, shiftGrade, isTier,
  gradeForValue, gradeForEfficiency, gradeForMultiplier, overallFromGrades,
  valueBounds, effBounds, multBounds, numeric, ATTR_GRADE_CAP,
} from './tables.js'
import { rint, pickByProb, weightedPick, rfloat } from './dice.js'
import { defenseOf } from './formula.js'
import { rollDomainType } from './domains.js'
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

/**
 * 玩家自己填数值：把一份已掷出的档案按玩家给的数字改写。
 *
 * 和 rollAttributeProfile 的分工：那个是"掷"，这个是"改"。
 * 引擎掷出来的那份仍然有用 —— 它是每一个输入框的默认值，
 * 玩家想改哪一项就改哪一项，没改的保持掷出来的结果。
 *
 * 三条规则：
 *   1. 数值夹在合法区间里（最低一级的下限 → 开局上限那一级的上限，即超特级）。
 *      龙级不让在开局出现 —— 那是"靠成长走到那儿"的目标，不是起手牌。
 *   2. 等级一律由最终数字反推（见 tables.js 的反向查表）。玩家能定的是数字，
 *      等级只是它的标签；不允许数字是一级、标签写超特级。
 *   3. 术式倍率会吸附到表里那一档的定值。倍率是 TECH_MULT 的一部分，
 *      不是自由变量，否则"标特级 ×3.6"这种组合会到处对不上表。
 *
 * 综合等级、领域觉醒、防御力都是从上面几项推导出来的，必须一起重算 ——
 * 少算一个，玩家就会顶着一个和数值不匹配的等级进游戏。
 */
export function tuneAttributeProfile(profile, numbers = {}, { cap = ATTR_GRADE_CAP } = {}) {
  const pick = (key, raw, dflt) => {
    const [lo, hi] = valueBounds(key, cap)
    const v = numeric(raw)
    return Number.isNaN(v) ? dflt : Math.max(lo, Math.min(hi, Math.round(v)))
  }

  // 效率在界面上是百分数（130 而不是 1.3），进来先除回去
  const [effLo, effHi] = effBounds(cap)
  const effRaw = numeric(numbers.efficiency)
  const eff = Number.isNaN(effRaw)
    ? profile.efficiency.value
    : Math.max(effLo, Math.min(effHi, effRaw / 100))

  const [multLo, multHi] = multBounds(cap)
  const multRaw = numeric(numbers.techniqueMultiplier)
  const multGrade = Number.isNaN(multRaw)
    ? profile.techniqueGrade
    : gradeForMultiplier(Math.max(multLo, Math.min(multHi, multRaw)))

  const cdRaw = numeric(numbers.techniqueCooldown)
  const cooldown = Number.isNaN(cdRaw)
    ? (profile.techniqueCooldown ?? 1)
    : Math.max(0, Math.min(5, Math.round(cdRaw)))

  const out = {
    ...profile,
    ce: { ...profile.ce, value: pick('ce', numbers.ce, profile.ce.value) },
    hp: { ...profile.hp, value: pick('hp', numbers.hp, profile.hp.value) },
    cursedDamage: { ...profile.cursedDamage, value: pick('cd', numbers.cursedDamage, profile.cursedDamage.value) },
    physicalDamage: { ...profile.physicalDamage, value: pick('pd', numbers.physicalDamage, profile.physicalDamage.value) },
    efficiency: { ...profile.efficiency, value: Number(eff.toFixed(2)) },
    techniqueGrade: multGrade,
    techniqueMultiplier: TECH_MULT[multGrade],
    techniqueCooldown: cooldown,
  }

  out.ce.grade = gradeForValue('ce', out.ce.value)
  out.hp.grade = gradeForValue('hp', out.hp.value)
  out.cursedDamage.grade = gradeForValue('cd', out.cursedDamage.value)
  out.physicalDamage.grade = gradeForValue('pd', out.physicalDamage.value)
  out.efficiency.grade = gradeForEfficiency(out.efficiency.value, profile.efficiency.grade)

  out.overallGrade = overallFromGrades([
    out.ce.grade, out.hp.grade, out.cursedDamage.grade, out.physicalDamage.grade, out.efficiency.grade,
  ])
  // 领域只看综合等级（第五节例外条款）—— 玩家把数值顶到特级，就该觉醒
  out.domainUnlocked = isTier(out.overallGrade)
  out.domainTierName = DOMAIN_TIER[out.overallGrade] || null

  /*
   * 领域数据跟着走。
   *
   * 掉到特级以下时**不清空** name / sureHit / cost，只把 unlocked 关掉 ——
   * 玩家把血条拖回去又拖上来，领域就不该变成"未命名领域"，
   * 更不该为此再打一次模型（重命名一个已经写好名字的领域纯属浪费）。
   * 但强度档位必须跟着新等级更新：弱特级的"半成品"到了超特级就是"规则级领域"。
   */
  if (out.domainUnlocked) {
    out.domain = { ...(out.domain || {}), unlocked: true, tierName: out.domainTierName }
  } else {
    out.domain = { ...(out.domain || {}), unlocked: false }
  }

  out.defense = Math.round(defenseOf(out))
  return out
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

/**
 * 第五个身份：「突然出现的人」。
 *
 * 不是掷出来的，是玩家点名要的 —— 所以它不是 IDENTITY_KINDS 的一员，
 * 也不会被 rollIdentityKind 抽到（那三份预设档案必须保持原来的分布）。
 *
 * 它和另外四份的根本区别是**没有交集**：关系值全 0，没有来历，没有立场。
 * 世界对他一无所知，他也对世界一无所知 —— 这是"想干嘛就干嘛"的前提，
 * 因为任何一种预设身份都会自带"你不能做那件事"的隐含约束。
 */
export const SUDDEN_ARRIVAL_KIND = '穿越者'
export const SUDDEN_ARRIVAL_SLOT = '穿越者'

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

  // 穿越者谁都不认识、谁也不认识他 —— 关系表必须整张留 0
  if (kind === SUDDEN_ARRIVAL_KIND) return rel

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

/**
 * 「突然出现的人」的档案。
 *
 * **故意不掷、也不问模型**：这个身份的全部价值就在于它是空白。
 * 让模型写一段背景，它一定会写出"你其实是XX的亲戚""你身上带着宿傩的另一根手指"
 * 这类设定 —— 那就又变回一个预设身份了，玩家要的"没有身份"当场作废。
 * 所以这里只有玩家自己填的东西，填不填都行：
 * 什么都不填，就是一个连名字都没有、凭空站在那儿的人。
 */
export function suddenArrivalIdentity({ name, age, brief } = {}, storylineId = DEFAULT_STORYLINE) {
  const n = String(name || '').trim()
  const a = numeric(age)
  return {
    slot: SUDDEN_ARRIVAL_SLOT,
    kind: SUDDEN_ARRIVAL_KIND,
    age: Number.isNaN(a) ? 17 : Math.max(10, Math.min(80, Math.round(a))),
    name: n || '无名之客',
    background: String(brief || '').trim(),
    // 这三条是身份本身的定义，不是模型发挥的地方
    mainlineRelation: '没有任何关系。这条线上没有人认识你，你也不认识任何人 —— 你不在任何人的名单上。',
    openingSituation: '上一秒还在自己的地方，下一秒就站在了这里。身上没有这个世界的钱、证件或咒具，只有你原本带着的东西。',
    hook: '你的出现本身就是一个异数：没有咒力记录、没有户籍、没有任何人见过你。这会让你既无人可信，也无人能预判。',
    initialRelations: rollInitialRelations(null, SUDDEN_ARRIVAL_KIND, storylineId),
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
  /*
   * 敌人的领域类型放在**最后**掷：这一句会多消耗一次随机数，
   * 排在前面会把后面所有 roll 的序列整体挪一位 —— 那些位子上的数值
   * 已经被 seeded 测试盯住了（同一颗种子掷出的敌人必须一模一样）。
   */
  if (e.domain.unlocked) e.domain.type = rollDomainType(rng, e.domain.tierName)
  e.hp.cur = e.hp.max = e.hp.value
  e.ce.cur = e.ce.max = e.ce.value
  return e
}

export { GRADES }
