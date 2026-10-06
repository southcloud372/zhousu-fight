import { RANGES, TECH_MULT, isTier } from './tables.js'
import { DEFAULT_STORYLINE } from './storylines.js'

/**
 * 原作表。
 *
 * 缘由：玩家现在可以打任何人 —— 包括五条悟、宿傩、虎杖。既然放开了，
 * 就不能再让模型每次现编对手的数值：模型给五条悟掷一个"二级、术式：火焰弹"，
 * 整场仗就从"打最强的人"变成了"打一个叫五条悟的路人"。
 *
 * 所以这里内置一张原作表：**原著里出现过的角色，等级、生得术式、领域
 * 一律按原著来，不听模型的**。表里没有的人（无名咒灵、路人诅咒师）
 * 才交给模型自由发挥。
 *
 * 数值怎么落：
 *   等级从表里取，数值按该等级在 RANGES 里的区间**确定性地**取一个点 ——
 *   用名字做散列，不用掷骰。两个原因：
 *     1. 同一颗种子重放，同一个角色必须一模一样（种子里程碑测试盯着 rng 序列）；
 *     2. 五条悟的血条不该每次刷新都变。
 *   rollEnemy 里一次的随机数都不能多消耗 —— 那会把后面所有 roll 整体挪位。
 */

// ---------------------------------------------------------------- 散列取点

/**
 * 名字 → 0~1 的确定性散列（FNV-1a）。
 * salt 让同一角色的不同属性取到区间里的不同位置，
 * 否则五条悟会正好落在每一条区间的同一个百分比上，读起来像复制粘贴。
 */
function hash01(name, salt) {
  const s = `${salt}:${name}`
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h / 4294967296
}

const inRange = (name, salt, [lo, hi]) => Math.round(lo + (hi - lo) * hash01(name, salt))

// ---------------------------------------------------------------- 原作表

/**
 * 每条线一张表。
 *
 * 字段：
 *   grade / eras —— eras 是"等级随篇章推进"的做法（虎杖、伏黑、真希都会长），
 *                   没写 eras 就是全程一个等级。日期用 ISO 串直接比大小。
 *   technique     —— 生得术式。没有术式的写清楚为什么（天与咒缚、星浆体、容器）。
 *   domain        —— null 就是"原著里他没有领域"，不是"忘了填"。
 *   reverse       —— 反转术式的档位，取值同 formula.js 的 REVERSE_TABLE。
 *   archetype     —— 战斗性格，取值同 rolls.js 的 ENEMY_ARCHETYPES。
 *   aliases       —— 模型/玩家可能写出的别的叫法（含简称）。
 *
 * 未来篇没有这张表：那是原作完结之后的推演，本来就没有"原著数值"可言。
 */
export const CANON = {
  sukuna: {
    宿傩: {
      grade: '龙级', archetype: '狂攻', reverse: '熟练',
      technique: { name: '御厨子', effect: '斩击「解」与「捌」，以及火焰「竈」——对活物与物体各有一把刀' },
      domain: { name: '伏魔御厨子', type: '伤害型', sureHit: '无差别斩击，领域之内不存在躲开这回事' },
      aliases: ['两面宿傩', '诅咒之王', '宿傩借面'],
    },
    五条悟: {
      // 设定原文那张等级表的「超特级」一栏写的就是他和完整宿傩（龙级留给全盛宿傩、
      // 68 虎杖、融合天元那一档规格外的东西）
      grade: '超特级', archetype: '均衡', reverse: '熟练',
      technique: { name: '无下限术式', effect: '把"无限"叠在攻击路径上：触碰不到他，而他的攻击没有距离' },
      domain: { name: '无量空处', type: '规则型', sureHit: '强制灌输无限信息，对方的大脑当场停摆' },
      aliases: ['五条', '最强'],
    },
    虎杖悠仁: {
      eras: [
        { from: '2018-06-05', grade: '三级' },
        { from: '2018-07-20', grade: '二级' },
        { from: '2018-11-05', grade: '一级' },
      ],
      archetype: '狂攻', reverse: '未掌握',
      technique: { name: '宿傩的术式', effect: '身为容器借用诅咒之王的斩击；本人没有生得术式，靠的是身体' },
      domain: null,
      aliases: ['虎杖'],
    },
    伏黑惠: {
      eras: [
        { from: '2018-06-05', grade: '二级' },
        { from: '2018-11-05', grade: '一级' },
      ],
      archetype: '均衡', reverse: '未掌握',
      technique: { name: '十种影法术', effect: '以影子为媒介召唤十种式神，式神两两可融合成更强的一只' },
      domain: { name: '嵌合暗翳庭', type: '规则型', sureHit: '影子铺满之地皆是他出手的地方' },
      aliases: ['伏黑'],
    },
    钉崎野蔷薇: {
      eras: [
        { from: '2018-06-05', grade: '三级' },
        { from: '2018-11-05', grade: '二级' },
      ],
      archetype: '狂攻', reverse: '未掌握',
      technique: { name: '刍灵咒法', effect: '以稻草人偶与钉子为媒介，取到对方的一部分就能隔空共鸣' },
      domain: null,
      aliases: ['钉崎'],
    },
    七海建人: {
      grade: '一级', archetype: '均衡', reverse: '初步',
      technique: { name: '十划咒法', effect: '把目标任意长度按 7:3 切开，那个点上必定制造出弱点' },
      domain: null,
      aliases: ['七海', '娜娜明'],
    },
    禅院真希: {
      eras: [
        { from: '2018-06-05', grade: '四级' },
        { from: '2018-10-31', grade: '三级' },
      ],
      archetype: '狂攻', reverse: '未掌握',
      technique: { name: '天与咒缚', effect: '生来没有咒力，代价换来的是远超常人的肉体与五感' },
      domain: null,
      aliases: ['真希'],
    },
    狗卷棘: {
      grade: '二级', archetype: '均衡', reverse: '未掌握',
      technique: { name: '咒言', effect: '说出口的话会成为强制执行的命令，代价是喉咙' },
      domain: null,
      aliases: ['狗卷'],
    },
    熊猫: {
      grade: '二级', archetype: '死守', reverse: '未掌握',
      technique: { name: '突然变异咒骸', effect: '夜蛾亲手造的咒骸，三核驱动，换核心就换一套形体与打法' },
      domain: null,
      aliases: [],
    },
    夜蛾正道: {
      grade: '一级', archetype: '均衡', reverse: '初步',
      technique: { name: '傀儡咒法', effect: '制造并操纵咒骸，最强的那个叫"熊猫"' },
      domain: null,
      aliases: ['夜蛾'],
    },
    家入硝子: {
      grade: '一级', archetype: '死守', reverse: '熟练',
      technique: { name: '反转术式', effect: '咒术界唯一能给别人治疗的人 —— 她治的是人，不是仗' },
      domain: null,
      aliases: ['硝子'],
    },
  },

  kaigyoku: {
    五条悟: {
      eras: [
        { from: '2006-06-01', grade: '一级' },
        // 甚尔那一晚他从血里爬起来，自己学会了反转术式 —— 一夜之间跨过两个档
        { from: '2006-08-20', grade: '弱特级' },
        // 刚爬起来那一晚还不是最强的他。坐实"当代最强"是之后那一年的事
        { from: '2007-01-01', grade: '超特级' },
      ],
      archetype: '均衡', reverse: '熟练',
      technique: { name: '无下限术式', effect: '把"无限"叠在攻击路径上：触碰不到他，而他的攻击没有距离' },
      domain: { name: '无量空处', type: '规则型', sureHit: '强制灌输无限信息，对方的大脑当场停摆' },
      aliases: ['五条'],
    },
    夏油杰: {
      eras: [
        { from: '2006-06-01', grade: '一级' },
        { from: '2007-06-15', grade: '弱特级' },
      ],
      archetype: '狡诈', reverse: '未掌握',
      technique: { name: '咒灵操术', effect: '吞下咒灵并驱使它们，收得越多手里的牌越多' },
      domain: null,
      aliases: ['夏油'],
    },
    家入硝子: {
      grade: '一级', archetype: '死守', reverse: '熟练',
      technique: { name: '反转术式', effect: '咒术界唯一能给别人治疗的人 —— 她治的是人，不是仗' },
      domain: null,
      aliases: ['硝子'],
    },
    天内理子: {
      grade: '四级', archetype: '死守', reverse: '未掌握',
      technique: { name: '星浆体', effect: '没有术式。她的价值只在于这具身体能与天元同化' },
      domain: null,
      aliases: ['理子'],
    },
    伏黑甚尔: {
      grade: '一级', archetype: '狂攻', reverse: '未掌握',
      technique: { name: '天与咒缚', effect: '咒力为零，换来的是能徒手拧断特级的肉体，和一身杀人的本事' },
      domain: null,
      aliases: ['甚尔', '术师杀手'],
    },
    七海建人: {
      eras: [
        { from: '2006-06-01', grade: '三级' },
        { from: '2007-01-01', grade: '二级' },
      ],
      archetype: '均衡', reverse: '未掌握',
      technique: { name: '十划咒法', effect: '把目标任意长度按 7:3 切开，那个点上必定制造出弱点' },
      domain: null,
      aliases: ['七海'],
    },
    灰原雄: {
      grade: '三级', archetype: '均衡', reverse: '未掌握',
      technique: { name: '未详', effect: '原作里没来得及展开就被咒灵杀死的那个同期' },
      domain: null,
      aliases: ['灰原'],
    },
    夜蛾正道: {
      grade: '一级', archetype: '均衡', reverse: '初步',
      technique: { name: '傀儡咒法', effect: '制造并操纵咒骸' },
      domain: null,
      aliases: ['夜蛾'],
    },
    黑井美里: {
      grade: '三级', archetype: '死守', reverse: '未掌握',
      technique: { name: '未详', effect: '理子的随从，一手枪法比术式可靠' },
      domain: null,
      aliases: ['黑井'],
    },
    天元: {
      grade: '龙级', archetype: '死守', reverse: '精通',
      technique: { name: '不死术式', effect: '每五百年与一名星浆体同化以重写肉体，结界术的顶点' },
      domain: null,
      aliases: [],
    },
  },
  // 未来篇不在表里 —— 原作停在 2019，往后是推演，没有"原著数值"可依
}

/**
 * 无名敌人的术式池。
 *
 * 这一条是补一个漏洞：轮盘原来给无名咒灵发的是「无为转变」「刍灵咒法」
 * 「十划咒法」「赤血操术」—— 全是原著里有主的术式。玩家打一只腐骨咒灵，
 * 面板上写着真人的术式，那是设定事故，不是彩蛋。
 * 所以无名敌人只从下面的池子里挑，一个都不能和原作表撞名（有测试守着）。
 */
export const GENERIC_TECHNIQUES = [
  '腐触', '咒力弹', '骨针', '缠丝', '噬咬', '脓血', '碎骨', '暗蠕',
]

/** 原作表里出现过的全部术式名 —— 无名敌人不该用 */
export function canonTechniqueNames() {
  const out = new Set()
  for (const line of Object.values(CANON)) {
    for (const e of Object.values(line)) if (e.technique?.name) out.add(e.technique.name)
  }
  return out
}

// ---------------------------------------------------------------- 查表

/** 把「虎杖悠仁（宿傩借面）」这类带后缀的写法削成「虎杖悠仁」 */
const normalize = (name) => String(name || '').replace(/[（(【\[].*?[）)】\]]/g, '').trim()

/**
 * 按名字找人。三级匹配，从严到宽：
 *   1. 正名全等
 *   2. 别名全等
 *   3. 名字里含正名/别名（模型爱写「宿傩借面」「五条悟·六眼」这种）
 * 第 3 步按长度从长到短试，免得「五条」先撞上「五条悟」的别名又被人抢走。
 */
export function canonFor(name, storylineId = DEFAULT_STORYLINE) {
  const table = CANON[storylineId]
  const n = normalize(name)
  if (!table || !n) return null

  if (table[n]) return { name: n, entry: table[n] }

  for (const [key, entry] of Object.entries(table)) {
    if ((entry.aliases || []).includes(n)) return { name: key, entry }
  }

  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    const entry = table[key]
    const forms = [key, ...(entry.aliases || [])].sort((a, b) => b.length - a.length)
    if (forms.some((f) => f.length >= 2 && n.includes(f))) return { name: key, entry }
  }
  return null
}

export const isCanonName = (name, storylineId = DEFAULT_STORYLINE) => !!canonFor(name, storylineId)

/** 名字在某个日期应该是什么等级（eras 里最后一条已生效的） */
export function resolveCanonGrade(entry, date) {
  if (!entry) return null
  if (!entry.eras?.length) return entry.grade || null
  let grade = entry.eras[0].grade
  for (const step of entry.eras) {
    if (String(step.from) <= String(date || '')) grade = step.grade
  }
  return grade
}

// ---------------------------------------------------------------- 落到敌人身上

/** 术式基础消耗 / 领域维持消耗，比例与 rollEnemy 一致 */
const TECH_COST_RATIO = 0.08
const DOMAIN_COST_RATIO = 0.08

/**
 * 按原作表校正一个敌人。
 *
 * 数值从 RANGES 现取 —— 表才是平衡的唯一出处，原作表管的是"这个人是谁、
 * 该站哪一档"，不管具体数字。两者分工明确：改平衡只动 tables.js。
 *
 * 已经掉过血的单位按比例保留伤情（中途重开一场仗时会再走一次这里）。
 */
export function applyCanon(unit, name, { storyline = DEFAULT_STORYLINE, date = '' } = {}) {
  const hit = canonFor(name, storyline)
  if (!hit || !unit) return null

  const { name: who, entry } = hit
  const grade = resolveCanonGrade(entry, date)
  const notes = []

  if (grade && unit.grade !== grade) {
    const r = RANGES[grade]
    const ratio = (o) => (o.max > 0 ? o.cur / o.max : 1)

    const hpRatio = ratio(unit.hp)
    const ceRatio = ratio(unit.ce)
    unit.grade = grade
    unit.hp.max = inRange(who, 'hp', r.hp)
    unit.hp.cur = Math.round(unit.hp.max * hpRatio)
    unit.ce.max = inRange(who, 'ce', r.ce)
    unit.ce.cur = Math.round(unit.ce.max * ceRatio)
    unit.cursedDamage = { value: inRange(who, 'cd', r.cd), grade }
    unit.physicalDamage = { value: inRange(who, 'pd', r.pd), grade }
    unit.efficiency = { value: r.eff, grade }
    unit.hp.grade = unit.ce.grade = grade

    unit.technique.multiplier = TECH_MULT[grade]
    unit.technique.grade = grade
    unit.technique.cost = Math.max(1, Math.round(unit.ce.max * TECH_COST_RATIO))
    notes.push(`${who}：${grade}`)
  }

  if (entry.technique) {
    unit.technique.name = entry.technique.name
    unit.technique.effect = entry.technique.effect
  }
  if (entry.archetype) unit.archetype = entry.archetype
  if (entry.reverse) unit.reverseCursedTechnique = { level: entry.reverse, progress: 0 }

  /*
   * 领域按表来，两种方向都要认：
   *   表里有 → 建（哪怕 rollEnemy 因为等级没到特级而没给）
   *   表里没有 → **拆掉**。模型给非特级敌人编领域原来就拦过一道，
   *   现在是同一条规则换了个源头：原著里他没有，就不能有。
   */
  const wantDomain = !!entry.domain && isTier(unit.grade)
  if (wantDomain) {
    unit.domain = {
      ...(unit.domain || {}),
      unlocked: true,
      name: entry.domain.name,
      sureHit: entry.domain.sureHit,
      type: entry.domain.type,
      grade: unit.grade,
      cost: Math.max(1, Math.round(unit.ce.max * DOMAIN_COST_RATIO)),
      active: false,
      turnsLeft: 0,
    }
  } else {
    unit.domain = { unlocked: false, active: false }
  }

  // 记录用：面板与战报都要能一眼看出"这个是按原作校正过的"
  unit.canon = true
  unit.canonNote = [
    `${who}（原作）`,
    unit.grade,
    entry.technique?.name,
    wantDomain ? entry.domain.name : null,
  ].filter(Boolean).join(' · ')

  return { name: who, entry, grade, domain: wantDomain ? entry.domain : null, notes }
}
