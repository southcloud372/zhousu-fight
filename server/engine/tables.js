/**
 * 设定数值表 —— 全部照抄《模拟回战-宿傩.txt》第一/三/五节。
 * 所有平衡性调整都集中在这个文件，别散落到别处。
 */

export const GRADES = ['四级', '三级', '二级', '准一级', '一级', '弱特级', '标特级', '超特级', '龙级']

/** 特级及以上的细分刻度。NPC 永远看不到这些词（见 guard.js）。 */
export const TIER_GRADES = ['弱特级', '标特级', '超特级', '龙级']
export const isTier = (g) => TIER_GRADES.includes(g)

/** 初始不可获得：准一级靠成长，龙级靠终极剧情。 */
export const CREATION_LOCKED = ['准一级', '龙级']

/** 属性随机时允许落到哪一级（龙级属性不允许开局出现） */
export const ATTR_GRADE_CAP = '超特级'

/** 咒力/血条/咒术伤害/体术伤害 的数值区间，效率为百分比小数 */
export const RANGES = {
  四级:   { ce: [100, 300],           hp: [50, 100],          cd: [10, 20],        pd: [5, 10],        eff: 0.5 },
  三级:   { ce: [300, 800],           hp: [100, 200],         cd: [20, 40],        pd: [10, 20],       eff: 0.6 },
  二级:   { ce: [800, 1500],          hp: [200, 400],         cd: [40, 80],        pd: [20, 40],       eff: 0.7 },
  准一级: { ce: [1500, 3000],         hp: [400, 800],         cd: [80, 150],       pd: [40, 80],       eff: 0.8 },
  一级:   { ce: [3000, 6000],         hp: [800, 1500],        cd: [150, 300],      pd: [80, 150],      eff: 0.9 },
  弱特级: { ce: [10000, 30000],       hp: [2000, 8000],       cd: [400, 1200],     pd: [200, 600],     eff: 1.0 },
  标特级: { ce: [150000, 400000],     hp: [30000, 80000],     cd: [5000, 12000],   pd: [2000, 5000],   eff: 1.1 },
  超特级: { ce: [1500000, 5000000],   hp: [300000, 800000],   cd: [50000, 120000], pd: [20000, 50000], eff: 1.3 },
  龙级:   { ce: [20000000, 100000000], hp: [3000000, 15000000], cd: [500000, 1500000], pd: [200000, 600000], eff: 1.5 },
}

/** 术式伤害倍率（第五节） */
export const TECH_MULT = {
  四级: 1.0, 三级: 1.2, 二级: 1.5, 准一级: 2.0, 一级: 2.5,
  弱特级: 3.0, 标特级: 3.5, 超特级: 4.5, 龙级: 6.0,
}

/**
 * 初始综合等级权重（第一节）。
 * 原文九项相加为 101%，这里按"按比例归一化"处理，避免实现时踩坑。
 */
export const INITIAL_WEIGHTS = {
  四级: 1, 三级: 10, 二级: 15, 准一级: 0, 一级: 50,
  弱特级: 10, 标特级: 10, 超特级: 5, 龙级: 0,
}

/** 单属性的等级偏移概率：70% 同综合等级 / 20% 高一级 / 10% 低一级（value 供 pickByProb 使用） */
export const ATTR_SHIFT = [
  { value: 0, p: 0.7 },
  { value: 1, p: 0.2 },
  { value: -1, p: 0.1 },
]

/**
 * 跨级压制（第三节）。key 为等级差的绝对值。
 *   high = 高等级方全属性判定加成，low = 低等级方全属性判定惩罚。
 * 高于两级时低等级方术式有 30% 概率被部分无效化，高于三级时领域被压制。
 */
export const SUPPRESSION = {
  0: { high: 1.0, low: 1.0, nullify: 0, domainLock: false },
  1: { high: 1.15, low: 0.9, nullify: 0, domainLock: false },
  2: { high: 1.3, low: 0.75, nullify: 0.3, domainLock: false },
  3: { high: 1.5, low: 0.6, nullify: 0.3, domainLock: true },
}

/**
 * 特级内部压制（第三节 · 仅玩家可见）。
 * 规则：特级之间用这张表，"取代"普通压制表而不是叠加。
 *
 * 注意索引方式：三对相邻特级在 GRADES 里的下标差都是 1，
 * 所以必须按"较低一方的细分档位"索引，不能按等级差索引。
 *   0 = 弱特 vs 标特   1 = 标特 vs 超特   2 = 超特 vs 龙级
 * 跨多档时逐级复合（如弱特打超特 = 0 档 × 1 档）。
 */
export const TIER_SUPPRESSION = {
  0: { high: 1.4, low: 0.65 },  // 标特 +40% / 弱特 -35%
  1: { high: 1.6, low: 0.5 },   // 超特 +60% / 标特 -50%
  2: { high: 3.0, low: 0.2 },   // 龙级近乎碾压超特
}

/** 领域强度命名（第五节 + 特级开局觉醒例外） */
export const DOMAIN_TIER = {
  弱特级: '半成品',
  标特级: '完整领域',
  超特级: '规则级领域',
  龙级: '概念级领域',
}

/** 领域展开后的每回合加成（第五节） */
export const DOMAIN_BUFF = { atkBonus: 0.5, costReduction: 0.2 }

export function gradeIndex(g) {
  return GRADES.indexOf(g)
}

export function shiftGrade(g, delta) {
  const i = gradeIndex(g)
  if (i < 0) return g
  const cap = gradeIndex(ATTR_GRADE_CAP)
  return GRADES[Math.max(0, Math.min(cap, i + delta))]
}
