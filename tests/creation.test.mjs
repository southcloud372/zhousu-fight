/**
 * 开局的两处自由度：
 *   1. 自定义属性 —— 玩家能直接定数值，等级由数字反推；
 *   2. 第五个身份「突然出现的人」—— 没有身份、没有交集，玩法上给最大自由度。
 *
 * 这个文件只测纯函数，不打模型、不碰文件系统，所以是免费的、可重复的。
 * 接口形状由 tests/routes.test.mjs 那几条覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GRADES, RANGES, TECH_MULT, ATTR_GRADE_CAP, ATTR_KEYS,
  gradeForValue, gradeForEfficiency, gradeForMultiplier, overallFromGrades,
  valueBounds, EFF_BOUNDS, MULT_BOUNDS, isTier, numeric,
} from '../server/engine/tables.js'
import {
  rollAttributeProfile, tuneAttributeProfile,
  rollInitialRelations, rollIdentityKind,
  SUDDEN_ARRIVAL_KIND, SUDDEN_ARRIVAL_SLOT, suddenArrivalIdentity, IDENTITY_KINDS,
} from '../server/engine/rolls.js'
import { makeRng } from '../server/engine/dice.js'
import { defenseOf } from '../server/engine/formula.js'
import { buildPlayer } from '../server/engine/state.js'
import { suddenArrivalRulesFor, SUDDEN_ARRIVAL_RULES } from '../server/prompts.js'
import { charactersFor } from '../server/engine/timeline.js'

// ------------------------------------------------------------ 数值 → 等级

test('反向查表：每一档区间的中点都映回它自己', () => {
  for (const g of GRADES) {
    for (const k of ATTR_KEYS) {
      const [lo, hi] = RANGES[g][k]
      assert.equal(gradeForValue(k, Math.round((lo + hi) / 2)), g,
        `${g} 的 ${k} 中点没能映回自己`)
    }
  }
})

test('越界值夹到两端，永远拿不到龙级', () => {
  // 开局上限就是超特级：龙级是"靠成长走到那儿"的目标，不是起手牌
  assert.equal(gradeForValue('ce', 0), GRADES[0], '低于最低档应当夹到四级')
  assert.equal(gradeForValue('ce', 1e12), ATTR_GRADE_CAP, '高于上限应当夹到超特级')
  assert.notEqual(gradeForValue('ce', 1e12), '龙级', '开局不可出现龙级')
  assert.equal(gradeForValue('hp', -5), GRADES[0])
})

test('区间边界归属是确定的（相邻两档共用一个端点）', () => {
  // constants.test.mjs 断言过区间相邻不重叠，所以 300 同时是四级上限和三级下限。
  // 必须定死归谁 —— 不然同一个数字两次可以判出两个等级。
  const a = gradeForValue('ce', 300)
  const b = gradeForValue('ce', 300)
  assert.equal(a, b)
  assert.ok(a === '四级' || a === '三级', `300 落在四级/三级的交界上，实得 ${a}`)
})

test('非法输入不产生垃圾等级（Number(null) 是 0，不能就这么用）', () => {
  for (const bad of [NaN, undefined, null, 'abc', '', '   ', [], {}, Infinity, -Infinity]) {
    assert.equal(gradeForValue('ce', bad), null, `${JSON.stringify(bad)} 应当返回 null，由调用方兜底`)
  }
})

test('numeric 把"没填"和"填了 0"分开', () => {
  assert.ok(Number.isNaN(numeric(null)))
  assert.ok(Number.isNaN(numeric(undefined)))
  assert.ok(Number.isNaN(numeric('')))
  assert.ok(Number.isNaN(numeric('  ')))
  assert.ok(Number.isNaN(numeric([])), '空数组 Number() 出来也是 0，同样要拦掉')
  assert.ok(Number.isNaN(numeric({})))
  assert.ok(Number.isNaN(numeric(true)), '布尔值不是数值')
  assert.equal(numeric(0), 0, '真的填了 0 就是 0')
  assert.equal(numeric('300'), 300, '字符串数字照收（表单里全是字符串）')
})

test('效率与倍率按最接近的一档取', () => {
  assert.equal(gradeForEfficiency(0.5), '四级')
  assert.equal(gradeForEfficiency(1.3), '超特级')
  assert.equal(gradeForMultiplier(6.0), '龙级')
  assert.equal(gradeForMultiplier(1.05), '四级', '1.05 离 1.0 最近')
})

test('综合等级取中位数：一项拉满不会把整个人抬成超特级', () => {
  // 五项里只有一项顶格，中位数还是四级
  assert.equal(overallFromGrades(['四级', '四级', '四级', '四级', '超特级']), '四级')
  // 三项以上顶格才算数
  assert.equal(overallFromGrades(['四级', '四级', '超特级', '超特级', '超特级']), '超特级')
  // 五项全顶格：玩家真的全填满了，就认
  assert.equal(overallFromGrades(['超特级', '超特级', '超特级', '超特级', '超特级']), '超特级')
})

test('数值上下限覆盖最低一档到开局上限那一档', () => {
  for (const k of ATTR_KEYS) {
    const [lo, hi] = valueBounds(k)
    assert.equal(lo, RANGES[GRADES[0]][k][0], `${k} 的下限应当是四级的下限`)
    assert.equal(hi, RANGES[ATTR_GRADE_CAP][k][1], `${k} 的上限应当是超特级的上限`)
  }
  assert.equal(EFF_BOUNDS[1], RANGES[ATTR_GRADE_CAP].eff)
  assert.equal(MULT_BOUNDS[1], TECH_MULT[ATTR_GRADE_CAP])
})

// ------------------------------------------------------------ 玩家填数值

const rolled = () => rollAttributeProfile(makeRng(2025), '自定义')

/** 五项全压到最低一级 —— 一份确定落在普通等级（非特级）的输入 */
const PLAIN = {
  ce: RANGES['四级'].ce[0], hp: RANGES['四级'].hp[0],
  cursedDamage: RANGES['四级'].cd[0], physicalDamage: RANGES['四级'].pd[0],
  efficiency: Math.round(RANGES['四级'].eff * 100),
}

/** 五项全顶格 —— 也就是玩家在界面上把每一项都拉到最大 */
const MAXED = {
  ce: RANGES[ATTR_GRADE_CAP].ce[1], hp: RANGES[ATTR_GRADE_CAP].hp[1],
  cursedDamage: RANGES[ATTR_GRADE_CAP].cd[1], physicalDamage: RANGES[ATTR_GRADE_CAP].pd[1],
  efficiency: Math.round(RANGES[ATTR_GRADE_CAP].eff * 100),
}

/**
 * 一份确定不是特级的档案，用作"从零调起"的起点。
 *
 * 不靠"某个种子掷出来恰好不是特级"—— 掷骰的权重改过一次，测试就不该跟着红。
 * 五项一起压到底，综合等级的中位数必然是四级。
 */
const plainStart = () => tuneAttributeProfile(rolled(), PLAIN)

test('没填的项保持引擎掷出来的结果', () => {
  const p = rolled()
  const t = tuneAttributeProfile(p, { ce: p.ce.value + 12345 })
  assert.equal(t.ce.value, p.ce.value + 12345, '填了的那项要变')
  assert.equal(t.hp.value, p.hp.value, '没填的项不该被动')
  assert.equal(t.cursedDamage.value, p.cursedDamage.value)
  assert.equal(t.physicalDamage.value, p.physicalDamage.value)
})

test('玩家填的数值会被夹进合法区间', () => {
  const p = rolled()
  const hi = tuneAttributeProfile(p, { ce: 1e15, hp: 1e15 })
  assert.equal(hi.ce.value, RANGES[ATTR_GRADE_CAP].ce[1])
  assert.equal(hi.hp.value, RANGES[ATTR_GRADE_CAP].hp[1])

  const lo = tuneAttributeProfile(p, { ce: -999, hp: 0 })
  assert.equal(lo.ce.value, RANGES[GRADES[0]].ce[0])
  assert.equal(lo.hp.value, RANGES[GRADES[0]].hp[0])
})

test('填了脏数据当作没填，不会把数值打成 0 或 NaN', () => {
  const p = rolled()
  const t = tuneAttributeProfile(p, {
    ce: 'abc', hp: NaN, cursedDamage: null, physicalDamage: undefined, efficiency: Infinity,
  })
  assert.equal(t.ce.value, p.ce.value)
  assert.equal(t.hp.value, p.hp.value)
  assert.equal(t.cursedDamage.value, p.cursedDamage.value)
  assert.equal(t.physicalDamage.value, p.physicalDamage.value)
  assert.equal(t.efficiency.value, p.efficiency.value)
  for (const k of ATTR_KEYS) assert.ok(Number.isFinite(t[k === 'cd' ? 'cursedDamage' : k === 'pd' ? 'physicalDamage' : k].value))
})

test('等级由数字反推，不是玩家点单的', () => {
  const p = rolled()
  const t = tuneAttributeProfile(p, {
    ce: 5000000, hp: 800000, cursedDamage: 120000, physicalDamage: 50000, efficiency: 130,
  })
  assert.equal(t.ce.value, 5000000)
  assert.equal(t.ce.grade, '超特级', '数值顶格了，等级就该跟着顶格')
  assert.equal(t.hp.grade, '超特级')
  assert.equal(t.cursedDamage.grade, '超特级')
  assert.equal(t.physicalDamage.grade, '超特级')
  assert.equal(t.efficiency.grade, '超特级')
  assert.equal(t.overallGrade, '超特级')
})

test('效率界面用百分数，内部存小数', () => {
  const p = rolled()
  const t = tuneAttributeProfile(p, { efficiency: 130 })
  assert.equal(t.efficiency.value, 1.3)
  assert.equal(t.efficiency.grade, '超特级')
  // 越界的百分数同样夹住
  assert.equal(tuneAttributeProfile(p, { efficiency: 9999 }).efficiency.value, EFF_BOUNDS[1])
  assert.equal(tuneAttributeProfile(p, { efficiency: 1 }).efficiency.value, EFF_BOUNDS[0])
})

test('术式倍率吸附到表里的定值 —— 中档不能自造', () => {
  const p = rolled()
  // 表里没有 3.6，最接近的是 3.5（标特级）
  const t = tuneAttributeProfile(p, { techniqueMultiplier: 3.6 })
  assert.equal(t.techniqueMultiplier, TECH_MULT['标特级'])
  assert.equal(t.techniqueGrade, '标特级')
  assert.equal(t.techniqueMultiplier, 3.5)
})

test('术式冷却夹在 0~5 回合（buildPlayer 会再夹一次）', () => {
  const p = rolled()
  assert.equal(tuneAttributeProfile(p, { techniqueCooldown: 99 }).techniqueCooldown, 5)
  assert.equal(tuneAttributeProfile(p, { techniqueCooldown: -3 }).techniqueCooldown, 0)
})

test('防御力跟着重算 —— 体能改了防御不能还停在旧值', () => {
  const p = rolled()
  const before = p.defense
  const t = tuneAttributeProfile(p, {
    physicalDamage: RANGES[ATTR_GRADE_CAP].pd[1], efficiency: 130,
  })
  assert.notEqual(t.defense, before)
  assert.ok(t.defense > before, '体能和效率都拉满，防御必须高于原来')
})

test('数值顶到特级就当场觉醒领域，掉下来就关掉', () => {
  const p = plainStart()
  assert.equal(p.overallGrade, '四级')
  assert.equal(p.domainUnlocked, false, '起点是普通等级，不该有领域')

  const up = tuneAttributeProfile(p, MAXED)
  assert.equal(up.domainUnlocked, true)
  assert.equal(up.domainTierName, '规则级领域')

  // 掉下去要五项一起掉：只压低一两项的话，中位数还留在特级里
  const down = tuneAttributeProfile(up, PLAIN)
  assert.equal(down.overallGrade, '四级')
  assert.equal(down.domainUnlocked, false)
  assert.equal(down.domain.unlocked, false)
})

test('掉回普通等级时不清空领域文案 —— 拖回去不该变成"未命名领域"', () => {
  // 玩家先在特级生成了一份有名字的领域，把数值拉下去再拉上来，
  // 名字必须还在。否则服务端会认为"领域还没写过"，为一次拖动白打一次模型。
  const withDomain = {
    ...plainStart(),
    domainUnlocked: true,
    domainTierName: '完整领域',
    domain: { unlocked: true, name: '伏魔御厨子·残', sureHit: '必中斩击', cost: '咒力见底', tierName: '完整领域', type: '伤害型' },
  }
  const down = tuneAttributeProfile(withDomain, PLAIN)
  assert.equal(down.domainUnlocked, false)
  assert.equal(down.domain.name, '伏魔御厨子·残', '名字不该被抹掉')

  const back = tuneAttributeProfile(down, MAXED)
  assert.equal(back.domainUnlocked, true)
  assert.equal(back.domain.name, '伏魔御厨子·残')
  assert.equal(back.domain.tierName, '规则级领域', '档位要跟着新等级走')
})

test('调到特级时档位名跟着综合等级变', () => {
  const p = rolled()
  const weak = tuneAttributeProfile(p, {
    ce: 20000, hp: 5000, cursedDamage: 800, physicalDamage: 400, efficiency: 100,
  })
  assert.equal(weak.overallGrade, '弱特级')
  assert.equal(weak.domainTierName, '半成品')
  assert.equal(weak.domain.unlocked, true)
  assert.ok(isTier(weak.overallGrade))
})

test('调过的档案能直接被 buildPlayer 吃下去（等级、领域、防御都要对得上）', () => {
  const p = rolled()
  const t = tuneAttributeProfile(p, {
    ce: 5000000, hp: 800000, cursedDamage: 120000, physicalDamage: 50000,
    efficiency: 130, techniqueMultiplier: 4.5, techniqueCooldown: 2,
  })
  const flavor = {
    ...t, techniqueName: '测试术式', techniqueEffect: '测试效果足够长', playstyle: '测试玩法',
    talents: [], tool: null,
    domain: { unlocked: true, name: '测试领域', sureHit: '必中', cost: '代价', tierName: t.domainTierName, type: '伤害型' },
  }
  const unit = buildPlayer(t, flavor, { kind: '穿越者', age: 17 }, flavor)
  assert.equal(unit.grade, '超特级')
  assert.equal(unit.ce.max, 5000000)
  assert.equal(unit.hp.max, 800000)
  assert.equal(unit.efficiency.value, 1.3)
  assert.equal(unit.technique.multiplier, 4.5)
  assert.equal(unit.technique.cooldown, 2)
  assert.equal(unit.domain.unlocked, true)
  assert.equal(unit.domain.tierName, '规则级领域')
  /*
   * 防御力断言的是"战斗时真正会用的那一份"。
   * 档案里那个 defense 字段只是给人看的存档快照 —— player.defense 全项目没有任何地方读它，
   * 战斗走的是 defenseOf(unit) 现算。所以要断言的是现算的结果和档案对得上，
   * 而不是"buildPlayer 原样搬运了那个字段"（它没有，也不该有）。
   */
  // defenseOf 不取整，档案里那份是 Math.round 过的快照，所以这里也取整再比
  assert.equal(Math.round(defenseOf(unit)), t.defense, '档案算好的防御力和战斗现算的那份必须一致')
})

// ------------------------------------------------------------ 突然出现的人

test('这个身份不进预设名单 —— 三份档案的分布不能被它改掉', () => {
  assert.ok(!IDENTITY_KINDS.includes(SUDDEN_ARRIVAL_KIND), '它不是掷出来的类型之一')
  const rng = makeRng(5)
  for (let i = 0; i < 200; i++) {
    assert.notEqual(rollIdentityKind(rng, i), SUDDEN_ARRIVAL_KIND)
  }
})

test('关系值整张留 0 —— 没有任何角色交集', () => {
  const rel = rollInitialRelations(makeRng(9), SUDDEN_ARRIVAL_KIND, 'sunuo')
  assert.deepEqual(Object.keys(rel).sort(), [...charactersFor('sunuo')].sort(), '名单要和故事线一致')
  assert.ok(Object.values(rel).every((v) => v === 0), `有非 0 的关系值：${JSON.stringify(rel)}`)
})

test('关系值全 0 是刻意的，不是忘了掷 —— 别的身份会掷出非 0', () => {
  // 反向对照：同一颗种子下，反派向必须掷出至少一个非 0
  const rel = rollInitialRelations(makeRng(9), '反派向', 'sunuo')
  assert.ok(Object.values(rel).some((v) => v !== 0))
})

test('档案里的名字留空就是「无名之客」，不是空字符串', () => {
  const a = suddenArrivalIdentity({}, 'sunuo')
  assert.equal(a.name, '无名之客')
  assert.equal(a.slot, SUDDEN_ARRIVAL_SLOT)
  assert.equal(a.kind, SUDDEN_ARRIVAL_KIND)
  assert.equal(suddenArrivalIdentity({ name: '   ' }, 'sunuo').name, '无名之客')
  assert.equal(suddenArrivalIdentity({ name: ' 张三 ' }, 'sunuo').name, '张三', '填了就用填的，并去掉首尾空白')
})

test('年龄夹在 10~80，没填就用 17', () => {
  assert.equal(suddenArrivalIdentity({}, 'sunuo').age, 17)
  assert.equal(suddenArrivalIdentity({ age: 5 }, 'sunuo').age, 10)
  assert.equal(suddenArrivalIdentity({ age: 200 }, 'sunuo').age, 80)
  assert.equal(suddenArrivalIdentity({ age: 'abc' }, 'sunuo').age, 17)
})

test('它照样是一份普通档案：buildPlayer 只认 kind，不需要开分支', () => {
  const attr = rollAttributeProfile(makeRng(31), 'A')
  Object.assign(attr, { techniqueName: 't', techniqueEffect: 'e', techniqueCooldown: 1, talents: [], playstyle: '' })
  const ident = suddenArrivalIdentity({ name: '穿越者甲', age: 22, brief: '普通大学生' }, 'sunuo')
  const p = buildPlayer(attr, attr, ident, ident)
  assert.equal(p.backgroundType, SUDDEN_ARRIVAL_KIND)
  assert.equal(p.name, '穿越者甲')
  assert.equal(p.background, '普通大学生')
})

// ------------------------------------------------------------ 玩法自由度

test('只有「突然出现的人」才吃那套自由度规则', () => {
  assert.equal(suddenArrivalRulesFor({ backgroundType: SUDDEN_ARRIVAL_KIND }), SUDDEN_ARRIVAL_RULES)
  for (const other of ['反派向', '自由派', '原作关联', undefined, null]) {
    assert.equal(suddenArrivalRulesFor({ backgroundType: other }), null,
      `${String(other)} 不该拿到穿越者规则`)
  }
  assert.equal(suddenArrivalRulesFor(null), null)
  assert.equal(suddenArrivalRulesFor(undefined), null)
})

test('规则里写死了三件非做不可的事：不给身份、放开跨度、代价照写', () => {
  // 这三条是这一局玩法成立的支点，逐条钉住 —— 以后改文案时别把哪条删了
  assert.match(SUDDEN_ARRIVAL_RULES, /不要给他安身份/, '必须禁止模型替玩家补来历')
  assert.match(SUDDEN_ARRIVAL_RULES, /4~5 个跨度极大的选项/, '选项数量与跨度是这一局的核心')
  assert.match(SUDDEN_ARRIVAL_RULES, /【我的行动】/, '自定义行动的优先级不能被这套规则盖掉')
  assert.match(SUDDEN_ARRIVAL_RULES, /措辞/, '必须禁止出现假设他有身份的措辞')
})

test('穿越者这份档案喂给模型时，背景类型就是「穿越者」', () => {
  // 规则块靠 backgroundType 挂载。这条守着"身份类型一路传到模型"这条链
  const ident = suddenArrivalIdentity({ name: '甲' }, 'sunuo')
  const attr = rollAttributeProfile(makeRng(41), 'A')
  Object.assign(attr, { techniqueName: 't', techniqueEffect: 'e', techniqueCooldown: 1, talents: [], playstyle: '' })
  const p = buildPlayer(attr, attr, ident, ident)
  assert.equal(suddenArrivalRulesFor(p), SUDDEN_ARRIVAL_RULES)
})
