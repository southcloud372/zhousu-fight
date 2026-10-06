import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRng, weightedPick, rint, pickByProb } from '../server/engine/dice.js'
import {
  GRADES, RANGES, TECH_MULT, INITIAL_WEIGHTS, SUPPRESSION, TIER_SUPPRESSION,
  gradeIndex, shiftGrade, isTier, ATTR_GRADE_CAP,
} from '../server/engine/tables.js'
import { rollAttributeProfile, rollIdentity, rollIdentityKind, rollEnemy, TALENT_POOL } from '../server/engine/rolls.js'
import { suppression, techniqueDamage, defenseOf, hpStatus } from '../server/engine/formula.js'
import { blankState, buildPlayer, applyProposal, modelStateView } from '../server/engine/state.js'
import { scrubDialogue, scrubTurn, clampProposal, noteNarrationLeak, hasLethalIntent } from '../server/engine/guard.js'
import {
  applyCanon, canonFor, resolveCanonGrade, GENERIC_TECHNIQUES, canonTechniqueNames,
} from '../server/engine/canon.js'
import { noteDeath, plotAnchorFor } from '../server/engine/plotdeps.js'
import { nextMilestone, missedNodes, REWRITTEN } from '../server/engine/timeline.js'
import { npcGrade, npcView, npcAttitude, sukunaView, enemyProfile } from '../server/engine/visibility.js'
import { canTrain, rollTraining, applyTraining, TRAINING_TABLE } from '../server/engine/commands.js'
import { acceptable, allFilled, IDENTITY_FIELDS, ATTRIBUTE_FIELDS } from '../server/engine/opening.js'
import { CONTRACT } from '../server/prompts.js'
import {
  initCombat, runRound, simulateCombat, computeRewards, applyRewards, finishCombat, unitSpeed,
  COMBO_CAP,
} from '../server/engine/combat.js'

// ------------------------------------------------------------------ 工具

function makeTestState(seed = 1, attrSeed = 2, grade) {
  const s = blankState(makeRng(seed))
  const a = rollAttributeProfile(makeRng(attrSeed), 'A')
  if (grade) a.overallGrade = grade
  Object.assign(a, {
    techniqueName: '测试术式',
    techniqueEffect: '测试',
    techniqueCooldown: 2,
    talents: ['战斗直觉'],
    playstyle: '',
    domain: a.domainUnlocked || isTier(a.overallGrade)
      ? { unlocked: true, name: '测试领域', sureHit: '必中', cost: '', tierName: '完整领域' }
      : { unlocked: false },
  })
  const id = rollIdentity(makeRng(seed + 5), '甲', rollIdentityKind(makeRng(seed + 6), 0))
  Object.assign(id, { name: '测试者', background: 'b', mainlineRelation: 'm', openingSituation: 'o', hook: 'h' })
  s.player = buildPlayer(a, a, id, id)
  s.relations = id.initialRelations
  return s
}

// ------------------------------------------------------------------ 数值表

test('初始等级分布符合设定权重', () => {
  const rng = makeRng(7)
  const N = 40000
  const tally = {}
  for (let i = 0; i < N; i++) {
    const g = rollAttributeProfile(rng, 'X').overallGrade
    tally[g] = (tally[g] || 0) + 1
  }
  const total = Object.values(INITIAL_WEIGHTS).reduce((a, b) => a + b, 0) // 101，按比例归一化
  for (const [g, w] of Object.entries(INITIAL_WEIGHTS)) {
    const expected = w / total
    const actual = (tally[g] || 0) / N
    assert.ok(Math.abs(actual - expected) < 0.012, `${g}: 期望 ${expected.toFixed(3)} 实际 ${actual.toFixed(3)}`)
  }
  // 准一级与龙级初始不可获得
  assert.equal(tally['准一级'] || 0, 0)
  assert.equal(tally['龙级'] || 0, 0)
})

test('所有属性数值落在设定区间内', () => {
  const rng = makeRng(21)
  for (let i = 0; i < 600; i++) {
    const p = rollAttributeProfile(rng, 'A')
    for (const [key, rangeKey] of [['ce', 'ce'], ['hp', 'hp'], ['cursedDamage', 'cd'], ['physicalDamage', 'pd']]) {
      const [lo, hi] = RANGES[p[key].grade][rangeKey]
      assert.ok(p[key].value >= lo && p[key].value <= hi,
        `${key} ${p[key].value} 超出 ${p[key].grade} 的 [${lo}, ${hi}]`)
    }
    assert.ok(p.efficiency.value >= 0.4 && p.efficiency.value <= 1.6, `效率异常 ${p.efficiency.value}`)
  }
})

test('属性等级偏移不超过创角上限', () => {
  const rng = makeRng(31)
  for (let i = 0; i < 400; i++) {
    const p = rollAttributeProfile(rng, 'A')
    for (const k of ['ce', 'hp', 'cursedDamage', 'physicalDamage', 'efficiency']) {
      assert.ok(gradeIndex(p[k].grade) <= gradeIndex(ATTR_GRADE_CAP), `${k} 等级 ${p[k].grade} 越界`)
    }
  }
})

test('术式倍率表与等级一一对应', () => {
  for (const g of GRADES) assert.equal(typeof TECH_MULT[g], 'number')
  assert.equal(TECH_MULT['四级'], 1.0)
  assert.equal(TECH_MULT['龙级'], 6.0)
})

// ------------------------------------------------------------------ 领域觉醒

test('特级开局直接觉醒领域，非特级不觉醒', () => {
  const rng = makeRng(41)
  for (let i = 0; i < 300; i++) {
    const p = rollAttributeProfile(rng, 'A')
    assert.equal(p.domainUnlocked, isTier(p.overallGrade),
      `${p.overallGrade} 的领域觉醒状态不对（应为 ${isTier(p.overallGrade)}）`)
  }
})

// ------------------------------------------------------------------ 压制

test('普通跨级压制系数与原文一致', () => {
  // 一级(4) vs 二级(2) → 差 2
  const s2 = suppression('一级', '二级')
  assert.equal(s2.atkMul, SUPPRESSION[2].high)
  assert.equal(s2.defMul, SUPPRESSION[2].low)
  assert.equal(s2.nullify, 0, '攻方是高的一方，不受无效化')
  assert.equal(s2.domainLock, false)

  // 反过来：低等级方施术应可能被无效化
  const s2r = suppression('二级', '一级')
  assert.equal(s2r.atkMul, SUPPRESSION[2].low)
  assert.equal(s2r.defMul, SUPPRESSION[2].high)
  assert.equal(s2r.nullify, SUPPRESSION[2].nullify, '低等级方术式应有 30% 概率被无效化')

  // 一级(4) vs 三级(1) → 差 3
  const s3 = suppression('一级', '三级')
  assert.equal(s3.diff, 3)
  assert.equal(s3.atkMul, SUPPRESSION[3].high)
  assert.equal(s3.domainLock, false, '攻方是高的一方，自己的领域不受影响')

  // domainLock 的语义是"攻方的领域能否展开"，所以劣势方才被锁
  const s3r = suppression('三级', '一级')
  assert.equal(s3r.domainLock, true, '攻方低三级，领域应被锁')

  // 差 4 也应被夹到表里的最重一档
  const s9 = suppression('超特级', '四级')
  assert.equal(s9.atkMul, SUPPRESSION[3].high)
  assert.equal(s9.domainLock, false)
})

test('龙级对下位特级连带封锁领域', () => {
  const s = suppression('超特级', '龙级')
  assert.equal(s.domainLock, true, '超特打龙级，攻方领域应被锁')
  const s2 = suppression('龙级', '超特级')
  assert.equal(s2.domainLock, false, '反过来龙级自己不受影响')
  assert.ok(Math.abs(s2.atkMul - 3.0) < 1e-9)
})

test('特级内部压制按细分档位索引（三对相邻下标差都是 1，不能按等级差查表）', () => {
  // 弱特(5) vs 标特(6)：标特 +40% / 弱特 -35%
  const a = suppression('标特级', '弱特级')
  assert.ok(Math.abs(a.atkMul - 1.4) < 1e-9, `标特打弱特应为 1.4，实际 ${a.atkMul}`)
  assert.ok(Math.abs(a.defMul - 0.65) < 1e-9)

  // 标特(6) vs 超特(7)：超特 +60% / 标特 -50%
  const b = suppression('超特级', '标特级')
  assert.ok(Math.abs(b.atkMul - 1.6) < 1e-9, `超特打标特应为 1.6，实际 ${b.atkMul}`)
  assert.ok(Math.abs(b.defMul - 0.5) < 1e-9)

  // 超特(7) vs 龙级(8)：龙级近乎碾压
  const c = suppression('龙级', '超特级')
  assert.ok(Math.abs(c.atkMul - 3.0) < 1e-9, `龙级打超特应为 3.0，实际 ${c.atkMul}`)
  assert.ok(Math.abs(c.defMul - 0.2) < 1e-9)

  // 三对必须互不相同 —— 这正是按等级差查表会踩的坑
  assert.notEqual(a.atkMul, b.atkMul)
  assert.notEqual(b.atkMul, c.atkMul)
})

test('特级跨两档压制逐级复合', () => {
  const s = suppression('超特级', '弱特级')
  const expected = TIER_SUPPRESSION[0].high * TIER_SUPPRESSION[1].high
  assert.ok(Math.abs(s.atkMul - expected) < 1e-9, `期望 ${expected}，实际 ${s.atkMul}`)
})

test('跨大级战斗不能靠数值硬拼', () => {
  const rng = makeRng(51)
  const mk = (g, hp, cd) => ({
    grade: g, hp: { cur: hp, max: hp }, ce: { cur: 1e9, max: 1e9 },
    cursedDamage: { value: cd }, physicalDamage: { value: 100 }, efficiency: { value: 0.9 },
    technique: { multiplier: TECH_MULT[g], cost: 1 }, domain: { active: false },
  })
  // 弱特级打一级：应当接近秒杀
  const weak = mk('弱特级', 5000, 800)
  const low = mk('一级', 1200, 240)
  const d = techniqueDamage(weak, low, { rng })
  assert.ok(d.damage > low.hp.max * 0.8, `弱特级应能重创一级，实际伤害 ${d.damage} / HP ${low.hp.max}`)
})

// ------------------------------------------------------------------ 公式

test('防御力公式与原文一致', () => {
  const u = { physicalDamage: { value: 100 }, efficiency: { value: 0.9 } }
  assert.ok(Math.abs(defenseOf(u) - (100 * 0.3 + 0.9 * 20)) < 1e-9)
})

test('伤害下限为 1，不会出现负伤害治疗敌人', () => {
  const rng = makeRng(61)
  const weak = {
    grade: '四级', hp: { cur: 100, max: 100 }, ce: { cur: 100, max: 100 },
    cursedDamage: { value: 10 }, physicalDamage: { value: 5 }, efficiency: { value: 0.5 },
    technique: { multiplier: 1.0, cost: 1 }, domain: { active: false },
  }
  const tank = {
    grade: '超特级', hp: { cur: 500000, max: 500000 }, ce: { cur: 1e6, max: 1e6 },
    cursedDamage: { value: 80000 }, physicalDamage: { value: 40000 }, efficiency: { value: 1.3 },
    technique: { multiplier: 4.5, cost: 1 }, domain: { active: false },
  }
  for (let i = 0; i < 50; i++) {
    const r = techniqueDamage(weak, tank, { rng })
    assert.ok(r.damage >= 1, `伤害应 >= 1，实际 ${r.damage}`)
  }
})

// ------------------------------------------------------------------ 护栏

test('NPC 台词里的特级细分会被改写成"特级"', () => {
  const turn = {
    dialogue: [
      { speaker: '五条悟', text: '那家伙是弱特级。' },
      { speaker: '宿傩', text: '标特级？超特级在我眼里也是玩具。' },
      { speaker: '虎杖悠仁', text: '一级咒术师？' },
    ],
  }
  assert.equal(scrubTurn(turn), true)
  assert.equal(turn.dialogue[0].text, '那家伙是特级。')
  assert.equal(turn.dialogue[1].text, '特级？特级在我眼里也是玩具。')
  assert.equal(turn.dialogue[2].text, '一级咒术师？', '非特级词汇不该被动')
})

test('旁白允许使用细分刻度，只做记录', () => {
  const leaks = noteNarrationLeak('面板显示：综合等级 超特级，对方 弱特级。')
  assert.deepEqual(leaks.sort(), ['weak', 'weak'].length ? ['weak'].filter(() => false).concat(['超特级', '弱特级']).sort() : [])
})

test('数值提议会被夹紧，模型改不动真值', () => {
  const state = { player: { hp: { cur: 1000, max: 1000 }, ce: { cur: 500, max: 500 } } }
  const p = clampProposal({
    hpDelta: -999999, ceDelta: -999999,
    relationDelta: { 虎杖悠仁: 999, 宿傩: -3 },
    sukunaFingersCollectedDelta: 99, sukunaFingersEatenDelta: 99,
    sukunaFingersPlayerEatenDelta: 99,
    flags: ['x'], timeAdvance: '99d',
  }, state)
  assert.equal(p.hpDelta, -600, '单回合掉血不超过上限 60%')
  assert.equal(p.ceDelta, -300, '单回合耗蓝不超过上限 60%')
  assert.equal(p.relationDelta['虎杖悠仁'], 15, '单回合好感度变动上限 ±15')
  assert.equal(p.relationDelta['宿傩'], -3)
  assert.equal(p.sukunaFingersCollectedDelta, 3, '一回合到手的手指不超过三根 —— 全篇只有二十根')
  assert.equal(p.sukunaFingersEatenDelta, 1, '一回合吞下的手指不超过一根')
  assert.equal(p.sukunaFingersPlayerEatenDelta, 1, '一回合玩家自己吞下的也不超过一根')
  assert.equal(p.timeAdvance, '0', '非法时间推进应回退为 0')
})

/**
 * 只搭 clampProposal 用得到的部分：角色血蓝、剧情线、当天日期、节点状态。
 * 时间闸门要读 nextMilestone，所以 time.date 和 timeline.nodes 都得给。
 */
function timeState(date, nodes = {}) {
  return {
    storyline: 'sukuna',
    time: { date },
    timeline: { nodes },
    player: { hp: { cur: 1000, max: 1000 }, ce: { cur: 500, max: 500 } },
  }
}

test('剧情回合推不动里程碑：快到节点时时间推进被压到节点当天为止', () => {
  /*
   * 模型在一回合里说"三天后"，玩家就会直接跳过一场介入战 ——
   * 战斗向的整条轮盘（练到节点当天再打）会被这一步踩过去。
   * 日期该由引擎守住：能往前推，但推不过下一个原作节点。
   */
  // 2018-06-05，下一个节点是 06-08，还剩 3 天
  const near = timeState('2018-06-05')
  assert.equal(clampProposal({ timeAdvance: '1w' }, near).timeAdvance, '3d',
    '还剩三天时，一周该被压成三天')
  assert.equal(clampProposal({ timeAdvance: '3d' }, near).timeAdvance, '3d',
    '正好能走完的三天不该被动')
  assert.equal(clampProposal({ timeAdvance: '1d' }, near).timeAdvance, '1d')

  // 还剩两天：连三天都不给了
  assert.equal(clampProposal({ timeAdvance: '3d' }, timeState('2018-06-06')).timeAdvance, '1d')

  // 已经在节点当天：不许再往前推
  const onDay = timeState('2018-06-08')
  assert.equal(clampProposal({ timeAdvance: '1d' }, onDay).timeAdvance, '0',
    '节点当天不该再往前推')
  assert.equal(clampProposal({ timeAdvance: '1w' }, onDay).timeAdvance, '0')

  // 挪了 1d 之后正好踩在节点上：这时 1d 是允许的，3d 不行
  assert.equal(clampProposal({ timeAdvance: '1d' }, timeState('2018-06-07')).timeAdvance, '1d')
  assert.equal(clampProposal({ timeAdvance: '3d' }, timeState('2018-06-07')).timeAdvance, '1d')
})

test('节点都走完了就不再拦时间推进', () => {
  // 全都已发生 → nextMilestone 返回 null → 没有闸门可守
  const done = timeState('2018-06-05', {
    虎杖吞手指: '已发生', 死刑缓期: '已发生', 高专入学: '已发生',
    少年院任务: '已发生', 宿傩夺舍: '已发生', 京都姊妹校交流: '已发生',
    涩谷事变前夜: '已发生', 涩谷事变: '已发生', 死灭回游: '已发生', 最终决战: '已发生',
  })
  assert.equal(clampProposal({ timeAdvance: '1w' }, done).timeAdvance, '1w')

  // 日期早就越过全部节点（自由发挥的后期）也一样
  assert.equal(clampProposal({ timeAdvance: '1w' }, timeState('2030-01-01')).timeAdvance, '1w')
})

test('时间闸门会把"被谁挡住了"写进 notes，不闷声改数', () => {
  const r = clampProposal({ timeAdvance: '1w' }, timeState('2018-06-05'))
  assert.ok(
    r.notes.some((n) => n.includes('虎杖吞手指')),
    '夹紧了却不说是哪个节点挡的，调 prompt 时会找不到原因',
  )
  // 没夹的时候不该多嘴
  const clean = clampProposal({ timeAdvance: '1d' }, timeState('2018-06-05'))
  assert.equal(clean.notes.filter((n) => n.includes('时间推进')).length, 0)
})

test('开局的手指数跟着故事线走，不是每条线都硬塞一根', () => {
  /*
   * 虎杖吞下第一根是**宿傩篇的**起点。怀玉篇在 2006 年、未来篇在 2029 年，
   * 那两条线上虎杖要么还没出生、要么早就不是容器了 ——
   * 从前这里无条件写死"已吞下一根"，等于让时间线自相矛盾。
   */
  const sukuna = sukunaView(blankState(makeRng(1), 'sukuna').sukuna)
  assert.deepEqual(
    [sukuna.fingersCollected, sukuna.fingersEaten, sukuna.fingersPlayerEaten],
    [1, 1, 0],
    '宿傩篇开局应当是"虎杖刚吞下第一根"',
  )

  for (const line of ['kaigyoku', 'future']) {
    const v = sukunaView(blankState(makeRng(1), line).sukuna)
    assert.deepEqual(
      [v.fingersCollected, v.fingersEaten, v.fingersPlayerEaten],
      [0, 0, 0],
      `${line} 这条线上不该凭空冒出一根手指`,
    )
  }
})

test('原作人物按原作表校正，等级不听模型的', () => {
  // 越界限制取消之后，"打五条悟"必须真的是打五条悟 ——
  // 模型就算给一个二级的壳，校正之后也得是超特级、无下限术式、无量空处
  const gojo = rollEnemy(makeRng(9), '二级')
  const r = applyCanon(gojo, '五条悟', { storyline: 'sukuna', date: '2018-06-05' })
  assert.ok(r, '五条悟应当在原作表里')
  assert.equal(gojo.grade, '超特级')
  assert.equal(gojo.technique.name, '无下限术式')
  assert.equal(gojo.domain.name, '无量空处')
  assert.equal(gojo.domain.type, '规则型')
  assert.equal(gojo.canon, true)

  // 表外的人一点都不动
  const mob = rollEnemy(makeRng(9), '二级')
  const before = JSON.stringify(mob)
  assert.equal(applyCanon(mob, '腐骨咒灵', { storyline: 'sukuna' }), null)
  assert.equal(JSON.stringify(mob), before, '无名咒灵不该被改动')
})

test('同一个原著角色每次校正出来的数值都一样', () => {
  // 数值用名字散列取点，不用掷骰 —— 刷新页面五条悟的血条不该变，
  // 而且不能多消耗 rollEnemy 的随机数（种子里程碑测试盯着那条序列）
  const a = rollEnemy(makeRng(3), '一级')
  const b = rollEnemy(makeRng(4), '一级')
  applyCanon(a, '宿傩', { storyline: 'sukuna' })
  applyCanon(b, '宿傩', { storyline: 'sukuna' })
  assert.equal(a.hp.max, b.hp.max)
  assert.equal(a.ce.max, b.ce.max)
  assert.equal(a.cursedDamage.value, b.cursedDamage.value)
  assert.equal(a.physicalDamage.value, b.physicalDamage.value)
  const r = RANGES['龙级'].hp
  assert.ok(a.hp.max >= r[0] && a.hp.max <= r[1], '数值应当落在龙级区间内，而不是模型掷的那个等级')
})

test('等级随篇章推进的角色按日期取档', () => {
  const at = (date) => {
    const u = rollEnemy(makeRng(5), '三级')
    applyCanon(u, '虎杖悠仁', { storyline: 'sukuna', date })
    return u
  }
  assert.equal(at('2018-06-05').grade, '三级')
  assert.equal(at('2018-08-01').grade, '二级')
  assert.equal(at('2018-12-01').grade, '一级')

  // 原著里他没有领域 —— 模型给了也要拆掉
  const forced = rollEnemy(makeRng(5), '一级')
  forced.domain = { unlocked: true, name: '编的领域', active: false }
  applyCanon(forced, '虎杖悠仁', { storyline: 'sukuna', date: '2018-12-01' })
  assert.equal(forced.domain.unlocked, false, '虎杖不该有领域')
})

test('别名、简称与带后缀的写法都能对上原作表', () => {
  assert.equal(canonFor('五条', 'sukuna')?.name, '五条悟')
  assert.equal(canonFor('五条悟（六眼）', 'sukuna')?.name, '五条悟')
  assert.equal(canonFor('宿傩借面', 'sukuna')?.name, '宿傩')
  assert.equal(canonFor('娜娜明', 'sukuna')?.name, '七海建人')
  assert.equal(canonFor('腐骨咒灵', 'sukuna'), null)
  // 怀玉篇是另一张表：那年五条还没长起来
  assert.equal(resolveCanonGrade(canonFor('五条悟', 'kaigyoku').entry, '2006-06-05'), '一级')
  assert.equal(resolveCanonGrade(canonFor('五条悟', 'kaigyoku').entry, '2006-09-01'), '弱特级')
  // 坐实"当代最强"是 2007 年的事，不是甚尔那一晚
  assert.equal(resolveCanonGrade(canonFor('五条悟', 'kaigyoku').entry, '2007-06-01'), '超特级')
  // 未来篇是推演，没有原作数值可依
  assert.equal(canonFor('五条悟', 'future'), null)
})

test('无名敌人不会拿到原著里有主的术式', () => {
  // 从前轮盘给无名咒灵发的是「无为转变」「十划咒法」「刍灵咒法」——
  // 打一只腐骨咒灵，面板上写着真人的术式，那是设定事故，不是彩蛋
  const owned = canonTechniqueNames()
  for (const t of GENERIC_TECHNIQUES) {
    assert.ok(!owned.has(t), `「${t}」是原著里有主的术式，不该发给无名敌人`)
  }
  assert.ok(GENERIC_TECHNIQUES.length >= 6, '池子太小会让无名敌人反复撞名')
})


// ------------------------------------------------------------------ 可见性

test('NPC 眼中的特级一律只说"特级"', () => {
  for (const g of ['弱特级', '标特级', '超特级', '龙级']) assert.equal(npcGrade(g), '特级')
  for (const g of ['四级', '三级', '二级', '准一级', '一级']) assert.equal(npcGrade(g), g)
})

test('NPC 视角不含任何数值', () => {
  const unit = {
    grade: '超特级', hp: { cur: 400000, max: 800000 }, ce: { cur: 3000000, max: 3000000 },
    domain: { active: true, name: '秘密领域' },
  }
  const view = npcView(unit)
  const flat = JSON.stringify(view)
  assert.ok(!flat.includes('800000'), '不该泄露血量上限')
  assert.ok(!flat.includes('秘密领域'), 'NPC 不该知道领域名')
  assert.equal(view.等级, '特级')
})

// ------------------------------------------------------------------ 敌方档案

test('敌方档案：两条伤害、防御、术式、性格都翻得出来', () => {
  /*
   * 和上面那条正好相反 —— npcView 是滤镜，enemyProfile 是底牌。
   * 玩家点「属性」想看的就是这些数，少一项那一页就白开了。
   */
  const enemy = rollEnemy(makeRng(31), '二级')
  enemy.name = '腐骨咒灵'
  enemy.technique.name = '蚀骨'
  enemy.technique.effect = '碰到的骨头会从里面自己碎开'
  enemy.archetype = '狡诈'

  const p = enemyProfile(enemy)
  assert.equal(p.name, '腐骨咒灵')
  assert.equal(p.grade, '二级')
  assert.equal(p.technique.name, '蚀骨')
  assert.equal(p.technique.effect, '碰到的骨头会从里面自己碎开')
  assert.equal(p.technique.multiplier, enemy.technique.multiplier)
  assert.equal(p.cursedDamage, enemy.cursedDamage.value)
  assert.equal(p.physicalDamage, enemy.physicalDamage.value)
  assert.ok(p.defense > 0, '防御应当按公式算出来，不是 0')
  assert.equal(p.archetype, '狡诈')
  assert.match(p.archetypeNote, /破绽/, '性格要带一句人话，不是一个词')
  // 二级够不到领域 —— 这一栏该是 null，不是空对象
  assert.equal(p.domain, null)
  assert.equal(p.canon, false, '无名咒灵不该带原作标记')
})

test('敌方档案标出"这个是按原作校正过的"', () => {
  // 玩家撞上超特级的五条悟，得看得出那是"打原作最强的人"应有的样子，
  // 而不是引擎在乱给数值
  const gojo = rollEnemy(makeRng(33), '四级')
  applyCanon(gojo, '五条悟', { storyline: 'sukuna', date: '2018-06-05' })
  const p = enemyProfile(gojo)
  assert.equal(p.canon, true)
  assert.match(p.canonNote, /五条悟（原作）/)
  assert.equal(p.grade, '超特级')
  assert.equal(p.technique.name, '无下限术式')
})

test('敌方档案：特级敌人的领域带着类型和必中效果', () => {
  const enemy = rollEnemy(makeRng(32), '标特级')
  enemy.domain.name = '胎藏曼荼罗'
  enemy.domain.type = '规则型'

  const p = enemyProfile(enemy)
  assert.equal(p.domain.name, '胎藏曼荼罗')
  assert.equal(p.domain.type, '规则型')
  assert.equal(p.domain.tierName, enemy.domain.tierName)
  assert.match(p.domain.brief, /封住/, '领域类型对应的机制说明要跟着一起给')
  assert.equal(p.domain.active, false)
})

test('敌方档案：字段缺失时给得出默认值，不会把界面带崩', () => {
  const p = enemyProfile({ name: '无名咒灵', grade: '四级', hp: { cur: 10, max: 20 } })
  assert.equal(p.ce.cur, 0)
  assert.equal(p.cursedDamage, 0)
  assert.equal(p.reverse, '未掌握')
  assert.equal(p.domain, null)
  assert.equal(enemyProfile(null), null)
})

// ------------------------------------------------------------------ 修炼

test('修炼推进时间，连续跳过 3 天后失效', () => {
  const s = makeTestState(71, 72)
  const rng = makeRng(73)
  assert.equal(canTrain(s).ok, true)

  for (let i = 0; i < 3; i++) {
    const r = rollTraining(s, '体能训练', rng)
    applyTraining(s, r)
  }
  assert.equal(s.time.skipStreak, 3)
  assert.equal(s.time.date, '2018-06-08', `第 3 天后应是 6-08，实际 ${s.time.date}`)

  const gate = canTrain(s)
  assert.equal(gate.ok, false, '连续跳过 3 天后第 4 天应失效')
  assert.match(gate.reason, /连续跳过 3 天/)
})

test('濒死与重伤状态无法修炼', () => {
  const s = makeTestState(81, 82)
  s.player.status = '重伤'
  assert.equal(canTrain(s).ok, false)
  s.player.status = '濒死'
  assert.equal(canTrain(s).ok, false)
})

test('修炼进度累计满 100% 提升数值', () => {
  const s = makeTestState(91, 92)
  s.player.training['体能训练'] = 95
  const before = s.player.hp.max
  applyTraining(s, { item: '体能训练', progress: 0.2, hpDelta: 0, notes: [], targets: ['hp', 'physicalDamage'] })
  assert.ok(s.player.hp.max > before, `血条上限应提升，${before} → ${s.player.hp.max}`)
  assert.ok(s.player.training['体能训练'] < 100, '满 100 后应扣除而不是无限累积')
})

// ------------------------------------------------------------------ 战斗

test('手动模式能逐回合推进并分出胜负', () => {
  const s = makeTestState(101, 102)
  const rng = makeRng(103)
  const enemy = rollEnemy(rng, '三级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })

  const script = ['domain', 'technique', 'physical', 'technique', 'physical', 'technique', 'physical', 'technique', 'physical', 'technique']
  let i = 0
  while (!s.combat.over && i < script.length) runRound(s, rng, { type: script[i++] })

  assert.ok(s.combat.over, '战斗应该结束')
  assert.ok(['player', 'enemy', 'draw', 'fled'].includes(s.combat.outcome.winner))
  assert.ok(s.combat.log.length > 0, '应留下战况面板')
})

test('自动结算在跨大级时判定弱方失败', () => {
  const s = makeTestState(111, 112, '三级')
  const rng = makeRng(113)
  const enemy = rollEnemy(rng, '弱特级')
  initCombat(s, rng, { mode: 'skip', enemy, reason: 't' })
  simulateCombat(s, rng)
  assert.equal(s.combat.outcome.winner, 'enemy', `三级不该打赢弱特级，实际 ${JSON.stringify(s.combat.outcome)}`)
})

/**
 * 手动战斗的"爽感"机制：暴击 / 连击 / 打断 / 领域必中爆发。
 *
 * 它们全是随机的，所以不能指望某一次跑出某个结果 —— 这里跑几十场，
 * 验的是**规则**而不是某一次的具体数字：
 *   · 连击只在压着打的时候涨，挨了一下就归零，且封顶
 *   · 暴击写进面板，并把对方的下一手吃掉
 *   · 领域展开当回合就掉血，而且不吃防御减免（必中就是无视防御）
 */
function fightOnce(seed, { grade = '一级', enemyGrade = '一级', script = [] } = {}) {
  const s = makeTestState(seed, seed + 1, grade)
  const rng = makeRng(seed * 7919)
  initCombat(s, rng, { mode: 'manual', enemy: rollEnemy(rng, enemyGrade), reason: 't' })
  // 面板是引擎从事件里提炼出来的（只有结论，没有过程），
  // 所以事件要自己收着 —— 想验"面板说暴击了，日志里是不是真有那一击"就得两边都有
  const rounds = []
  let i = 0
  while (!s.combat.over && i < 24) {
    const r = runRound(s, rng, { type: script[i % script.length] || 'technique' })
    rounds.push({ panel: r.panel, events: r.events })
    i++
  }
  return { s, rounds }
}

test('战斗演出：暴击、连击、打断、领域爆发都真的会发生', () => {
  // 领域必须排进脚本 —— 自动出招只在攒够咒力时才开，六十场里未必撞得上
  const SCRIPT = ['domain', 'technique', 'physical', 'technique', 'physical']
  let crits = 0, sawCombo = 0, sawStagger = 0, sawSureHit = 0, sawDomainOpen = 0

  for (let seed = 1; seed <= 60; seed++) {
    for (const { panel } of fightOnce(seed, { script: SCRIPT }).rounds) {
      if (panel.crit) crits++
      if (panel.combo > 0) sawCombo++
      if (panel.staggered) sawStagger++
      if (panel.sureHit) sawSureHit++
      if (panel.domainOpened) sawDomainOpen++
    }
  }

  assert.ok(crits > 0, '六十场里一次暴击都没有，暴击率大概被改坏了')
  assert.ok(sawCombo > 0, '一次连击都没出现')
  assert.ok(sawStagger > 0, '暴击之后对方从来没被打断过')
  assert.ok(sawSureHit > 0, '领域展开的必中爆发一次都没触发')
  assert.ok(sawDomainOpen > 0, '面板上没有领域展开的记录，演出层就无从播起')
})

test('连击封顶，而且挨了一下就归零', () => {
  const SCRIPT = ['domain', 'technique', 'physical', 'technique', 'physical']
  let maxSeen = 0
  for (let seed = 1; seed <= 60; seed++) {
    for (const { panel, events } of fightOnce(seed, { script: SCRIPT }).rounds) {
      maxSeen = Math.max(maxSeen, panel.combo || 0)
      const tookHit = events.some((e) => e.side === 'enemy' && e.damage > 0)
      if (tookHit) assert.equal(panel.combo, 0, '自己挨了一下，连击却还挂着')
    }
  }
  assert.ok(maxSeen > 0, '连击从来没涨起来过')
  assert.ok(maxSeen <= COMBO_CAP, `连击涨到了 ${maxSeen}，超过上限 ${COMBO_CAP}`)
})

test('暴击之后，对方的下一个动作是被压回去而不是照常出手', () => {
  const SCRIPT = ['domain', 'technique', 'physical', 'technique', 'physical']
  let checked = 0
  for (let seed = 1; seed <= 60 && checked < 12; seed++) {
    const { rounds } = fightOnce(seed, { script: SCRIPT })
    for (let i = 0; i < rounds.length; i++) {
      if (rounds[i].panel.crit !== 'player') continue

      // 面板说暴击了，这一回合的事件里就得真有那么一击，而且带上了旁白
      const ev = rounds[i].events.find((e) => e.crit)
      assert.ok(ev, '面板说暴击了，事件里却找不到那一击')
      assert.ok(ev.lines.some((l) => /暴击/.test(l)), '暴击没有对应的旁白')
      assert.ok(ev.lines.some((l) => /踉跄/.test(l)), '没有把"对方被打得踉跄"写出来')

      /*
       * "下一手递不出来"落在哪一回合，取决于谁先手：
       * 我方先动时对方这一回合还没出手，那就是本回合被吃掉；
       * 对方已经动过了，才轮到下一回合。两种都对，规则只有一条 ——
       * 挨了暴击之后，对方的下一个动作必须是"被压回去"。
       */
      const stream = [...rounds[i].events, ...(rounds[i + 1]?.events || [])]
      const after = stream.slice(stream.findIndex((e) => e.crit) + 1)
      const nextEnemy = after.find((e) => e.side === 'enemy')
      if (!nextEnemy) continue // 对方在这一手之后就没机会动了（死了或打完了）

      checked++
      assert.equal(nextEnemy.type, 'stagger',
        `暴击之后对方照常出了手（${nextEnemy.type}），打断没生效`)
      if (checked >= 12) break
    }
  }
  assert.ok(checked > 0, '六十场里没抓到一次"暴击后对方还有动作"的情况，这条规则等于没测')
})

test('领域展开当回合就掉血，而且无视防御', () => {
  /*
   * 设定里领域是"必中"的。原来只在旁白里写一句就完了 ——
   * 玩家花掉一大截咒力铺开领域，血条纹丝不动，看不出必中在哪儿。
   */
  const mk = (seed) => {
    const s = makeTestState(seed, seed + 1, '一级')
    const rng = makeRng(seed * 13)
    initCombat(s, rng, { mode: 'manual', enemy: rollEnemy(rng, '一级'), reason: 't' })
    return { s, rng }
  }

  let found = null
  for (let seed = 151; seed <= 200 && !found; seed++) {
    const { s, rng } = mk(seed)
    const r = runRound(s, rng, { type: 'domain' })
    const ev = r.events.find((e) => e.type === 'domain' && e.domainOpened)
    if (ev) found = { seed, ev }
  }
  assert.ok(found, '两百个种子里领域一次都没开成，检查咒力消耗或解锁条件')

  const { ev } = found
  assert.equal(ev.sureHitBurst, true, '领域展开没有带必中爆发')
  assert.ok(ev.damage > 0, '铺开领域之后血条纹丝不动')
  assert.ok(ev.domainName, '必中爆发没有记下领域名，过场就没东西可写')

  // 必中 = 无视防御：对方摆出防御也不该把它削掉
  const { s, rng } = mk(found.seed)
  s.combat.enemy._defending = true
  const r2 = runRound(s, rng, { type: 'domain' })
  const ev2 = r2.events.find((e) => e.type === 'domain' && e.domainOpened)
  if (ev2) assert.equal(ev2.damage, ev.damage, '对方一防御必中就不见了，那不叫必中')
})

test('速度决定先手，高等级更快', () => {
  const mk = (pd, eff) => ({ physicalDamage: { value: pd }, efficiency: { value: eff } })
  assert.ok(unitSpeed(mk(400, 1.0)) > unitSpeed(mk(120, 0.9)))
})

test('领域展开消耗咒力并受等级压制限制', () => {
  const s = makeTestState(121, 122, '弱特级')
  const rng = makeRng(123)
  const enemy = rollEnemy(rng, '龙级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  const r = runRound(s, rng, { type: 'domain' })
  const opened = r.events.some((e) => e.domainOpened)
  assert.equal(opened, false, '被龙级压制时领域不应展开成功')
})

test('战果写入训练进度，跨级击杀可能直接升级', () => {
  const s = makeTestState(131, 132, '三级')
  const rng = makeRng(133)
  const enemy = rollEnemy(rng, '二级')
  initWith(s, enemy, rng)
  s.combat.stats.usedTechnique = true
  s.combat.stats.usedMelee = true
  const rw = computeRewards(s, rng, { won: true, crossLevel: true })
  assert.ok(Object.keys(rw.gains).length > 0)
  const ups = applyRewards(s, rw)
  assert.ok(ups.length >= 0)
})

function initWith(s, enemy, rng) {
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
}

test('败北且血条归零时，战报明确点出濒死', () => {
  const s = makeTestState(201, 202)
  const rng = makeRng(203)
  const enemy = rollEnemy(rng, '四级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  s.player.hp.cur = 0
  s.player.status = '濒死'
  const summary = finishCombat(s, { winner: 'enemy', loser: 'player' })
  assert.match(summary, /濒死/)
  assert.match(summary, /死亡/)
})

test('低血量取胜时战报点出只剩一口气', () => {
  const s = makeTestState(211, 212)
  const rng = makeRng(213)
  const enemy = rollEnemy(rng, '四级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  s.player.hp.cur = Math.round(s.player.hp.max * 0.1)
  const summary = finishCombat(s, { winner: 'player', loser: 'enemy' })
  assert.match(summary, /只剩一口气/)
})

test('战斗收尾会清空战斗态并复位冷却', () => {
  const s = makeTestState(141, 142)
  const rng = makeRng(143)
  const enemy = rollEnemy(rng, '四级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  s.player.technique.cdLeft = 3
  s.player.domain.active = true
  const summary = finishCombat(s, { winner: 'player', loser: 'enemy' })
  assert.equal(s.combat, null)
  assert.equal(s.player.technique.cdLeft, 0)
  assert.equal(s.player.domain.active, false)
  assert.match(summary, /击退/)
})

test('说了要命并且打赢：记成击杀，并改写他撑起的那一天', () => {
  const s = makeTestState(221, 222)
  const rng = makeRng(223)
  const enemy = rollEnemy(rng, '四级')
  enemy.name = '五条悟'
  applyCanon(enemy, enemy.name, { storyline: 'sukuna', date: s.time.date })
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't', lethalIntent: true })
  const summary = finishCombat(s, { winner: 'player', loser: 'enemy' })

  assert.match(summary, /杀死了/)
  // 人没了 → 他撑起的那一天（涩谷事变）被改写成另一个样子
  assert.equal(s.timeline.nodes['涩谷事变'], REWRITTEN)

  const last = s.battles.at(-1)
  assert.equal(last.result, '击杀')
  assert.equal(last.killed, true)
  assert.equal(last.enemy.canon, true)
  assert.match(last.rewrite, /涩谷事变/)

  // 战果要喂给模型，否则"他杀过谁"下一回合就没人记得了
  const view = modelStateView(s)
  assert.ok(view.战果.at(-1).结果.startsWith('击杀'))
  assert.equal(view.节点改写理由['涩谷事变'].length > 10, true)
})

test('只是打赢不算杀人 —— 没说要命就是击退', () => {
  const s = makeTestState(231, 232)
  const rng = makeRng(233)
  const enemy = rollEnemy(rng, '四级')
  enemy.name = '五条悟'
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  finishCombat(s, { winner: 'player', loser: 'enemy' })

  assert.equal(s.battles.at(-1).result, '击退')
  assert.equal(s.battles.at(-1).killed, false)
  assert.equal(s.timeline.nodes['涩谷事变'], '未发生', '打晕不等于杀掉，那天还没变')
})

test('战败与逃脱也记账，五种收场一个不少', () => {
  const lose = makeTestState(241, 242)
  const r1 = makeRng(243)
  initCombat(lose, r1, { mode: 'manual', enemy: rollEnemy(r1, '四级'), reason: 't' })
  finishCombat(lose, { winner: 'enemy', loser: 'player' })
  assert.equal(lose.battles.at(-1).result, '战败')

  const flee = makeTestState(251, 252)
  const r2 = makeRng(253)
  initCombat(flee, r2, { mode: 'manual', enemy: rollEnemy(r2, '四级'), reason: 't' })
  finishCombat(flee, { winner: 'fled' })
  assert.equal(flee.battles.at(-1).result, '逃脱')
  assert.equal(flee.battles.at(-1).killed, false)
})

// ------------------------------------------------------------------ 状态

test('modelStateView 不携带历史正文（防止上下文爆炸）', () => {
  const s = makeTestState(151, 152)
  for (let i = 0; i < 40; i++) s.log.push({ type: 'turn', narration: '很长的正文'.repeat(300) })
  s.history = Array.from({ length: 40 }, () => ({ role: 'assistant', content: '历史'.repeat(400) }))

  const view = JSON.stringify(modelStateView(s))
  assert.ok(!view.includes('很长的正文'), 'modelStateView 不该包含历史正文')
  assert.ok(!view.includes('历史历史'), 'modelStateView 不该包含对话历史')
  assert.ok(view.length < 3000, `紧凑视图应保持精简，实际 ${view.length} 字符`)
})

test('宿傩对话门槛：手指吞得不够时不可对话', () => {
  const s = makeTestState(161, 162)
  // 到手的总得先够，才能谈吞了几根 —— 状态视图按"到手"往下夹
  s.sukuna.fingersCollected = 7
  s.sukuna.fingersEaten = 1
  assert.equal(modelStateView(s).宿傩.可在意识中对话, false)

  s.sukuna.fingersEaten = 7
  assert.equal(modelStateView(s).宿傩.可在意识中对话, true)

  // 只报"手指数"，不再报一个原著里没有的百分比
  const view = modelStateView(s).宿傩
  assert.ok(!('觉醒度' in view), '状态里不该再有觉醒度')
  assert.ok(view.容器吞下.includes('7'), '状态里要报容器吞下的根数')
  assert.ok(view.已收集手指.includes('7'), '状态里要报已收集的根数')
})

test('时间推进跨月正确', () => {
  const s = makeTestState(171, 172)
  s.time.date = '2018-06-28'
  applyProposal(s, { hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0, flags: [], timeAdvance: '1w' })
  assert.equal(s.time.date, '2018-07-05')
})

test('死亡不可逆：已死亡角色不会被重复写入', () => {
  const s = makeTestState(181, 182)
  applyProposal(s, { hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0, flags: ['少年院任务_开始'], timeAdvance: '0' })
  assert.equal(s.timeline.nodes['少年院任务'], '已发生')
  const before = s.timeline.newEvents.length
  applyProposal(s, { hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0, flags: ['少年院任务_开始'], timeAdvance: '0' })
  assert.equal(s.timeline.newEvents.length, before, '重复 flag 不该重复记录')
})

// ------------------------------------------------------------------ 模型空壳

test('空壳输出会被判定为不合格并触发重试', () => {
  const good = { narration: '正文'.repeat(60), choices: ['一', '二', '三'] }
  assert.equal(acceptable(good), true)

  // 实测端到端自检时真的撞到过：正文 0 字、选项 0 个
  assert.equal(acceptable({ narration: '', choices: [] }), false, '空正文空选项必须判不合格')
  assert.equal(acceptable({ narration: '太短', choices: ['一', '二', '三'] }), false, '正文过短要重试')
  assert.equal(acceptable({ narration: '正文'.repeat(60), choices: ['一', '二'] }), false, '选项不足 3 个要重试')
  assert.equal(acceptable({ narration: '正文'.repeat(60), choices: ['一', '', '  ', '四'] }), false, '空白选项不计入')
  assert.equal(acceptable(null), false)
  assert.equal(acceptable({}), false)

  // 选项里混了空白但实际够数，应当放过
  assert.equal(acceptable({ narration: '正文'.repeat(60), choices: ['一', '', '二', '三'] }), true)
})

test('三份档案字段残缺会被判不合格（实测 flash 会漏钩子）', () => {
  const ok = ['甲', '乙', '丙'].map((slot) => ({
    slot, name: `名字${slot}`, background: '一段足够长的背景描述文字',
    mainlineRelation: '与主线的关系描述', openingSituation: '此刻正在某处的开局处境描述', hook: '一个足够具体能牵动后续剧情的钩子',
  }))
  assert.equal(allFilled(ok, IDENTITY_FIELDS), true)

  // 钩子为空
  const noHook = ok.map((x, i) => (i === 1 ? { ...x, hook: '' } : x))
  assert.equal(allFilled(noHook, IDENTITY_FIELDS), false, '有档案漏钩子应判不合格')

  // 钩子过短
  const shortHook = ok.map((x, i) => (i === 2 ? { ...x, hook: '短' } : x))
  assert.equal(allFilled(shortHook, IDENTITY_FIELDS), false, '钩子过短应判不合格')

  // 份数不足
  assert.equal(allFilled(ok.slice(0, 2), IDENTITY_FIELDS), false, '只交回两份应判不合格')
  assert.equal(allFilled([], IDENTITY_FIELDS), false)
  assert.equal(allFilled(null, IDENTITY_FIELDS), false)

  // 属性档案同理
  const attrs = ['A', 'B', 'C'].map((slot) => ({
    slot, techniqueName: `术式${slot}`, techniqueEffect: '一句话说清机制的效果描述', playstyle: '玩法风格提示',
  }))
  assert.equal(allFilled(attrs, ATTRIBUTE_FIELDS), true)
  assert.equal(allFilled(attrs.map((x, i) => (i === 0 ? { ...x, techniqueEffect: '' } : x)), ATTRIBUTE_FIELDS), false)
})

// ------------------------------------------------------------------ 身份

test('三份身份必须含反派向与自由派各一种', () => {
  for (let seed = 0; seed < 30; seed++) {
    const rng = makeRng(seed)
    const kinds = [0, 1, 2].map((i) => rollIdentity(rng, ['甲', '乙', '丙'][i], rollIdentityKind(rng, i)).kind)
    assert.ok(kinds.includes('反派向'), `seed ${seed} 缺少反派向：${kinds}`)
    assert.ok(kinds.includes('自由派'), `seed ${seed} 缺少自由派：${kinds}`)
  }
})

test('天赋池无重复项且拼写正确', () => {
  assert.equal(new Set(TALENT_POOL).size, TALENT_POOL.length, '天赋池有重复')
  assert.ok(TALENT_POOL.includes('术式理解快'), '术式理解快 拼写错误')
})

test('杀意判定：说了要命才算击杀', () => {
  // 打赢和杀掉是两件事。这场判定只决定战报上写"击杀"还是"击退"，
  // 不参与掷骰 —— 判错顶多措辞不准，不会改写胜负
  assert.equal(hasLethalIntent('我要杀了虎杖'), true)
  assert.equal(hasLethalIntent('先干掉他再说'), true)
  assert.equal(hasLethalIntent('趁他落单，把他宰了'), true)

  // 打倒不算杀 —— 人还活着，后面还会出现
  assert.equal(hasLethalIntent('打晕他，把咒具抢走'), false)
  assert.equal(hasLethalIntent('迎战'), false)
  assert.equal(hasLethalIntent(''), false)

  // 求饶的话里也有"杀"字，不能被读成杀令 ——
  // 否则战报上会写着他杀了人，而那是引擎替他编的
  assert.equal(hasLethalIntent('别杀他，我还有话要问'), false)
  assert.equal(hasLethalIntent('留他一命'), false)
})

test('杀掉关键人物会把那一天标成已改写', () => {
  const s = blankState(makeRng(1))
  const r = noteDeath(s, '五条悟')
  assert.equal(r.node, '涩谷事变')
  assert.equal(s.timeline.nodes['涩谷事变'], REWRITTEN)
  // 理由要留下来 —— 光一个"已改写"，玩家和模型都不知道那天变成了什么样
  assert.match(s.timeline.rewrites['涩谷事变'], /五条悟/)
  assert.ok(s.timeline.newEvents.some((e) => e.includes('已改写')))

  // 无名咒灵死了什么都不会发生
  assert.equal(noteDeath(s, '腐骨咒灵'), null)
  // 表里没有、也不是本线登场角色的人，查不出锚点
  assert.equal(plotAnchorFor('sukuna', '腐骨咒灵'), null)
})

test('已改写的节点照旧占着那一天', () => {
  // 玩家的选择是「节点改写，仍然发生」：
  // 那一天照旧会来（轮盘照旧为它停下），只是内容已经不是原著那件事了。
  // 所以它不能被跳过，也不能被补登成"已发生"。
  const s = blankState(makeRng(1))
  s.time.date = '2018-10-01'
  noteDeath(s, '五条悟') // 涩谷事变在 2018-10-31

  const ms = nextMilestone(s)
  assert.equal(ms?.node, '涩谷事变', '已改写的节点仍然要占着排期')
  assert.equal(ms.daysLeft, 30)

  // 日期过去之后补账，也不能把它冲成"已发生"
  s.time.date = '2018-11-10'
  missedNodes(s)
  assert.equal(s.timeline.nodes['涩谷事变'], REWRITTEN)

  // 已经走过的那一天改不动了：人确实没了，但那一天早就过去了
  const s2 = blankState(makeRng(1))
  s2.timeline.nodes['涩谷事变'] = '已发生'
  const r2 = noteDeath(s2, '五条悟')
  assert.equal(r2.already, true)
  assert.equal(r2.line, null)
  assert.equal(s2.timeline.nodes['涩谷事变'], '已发生')
})

test('契约里写明了"玩家的行动必须真的执行"', () => {
  for (const kw of ['玩家的行动必须真的执行', '让攻击落空', '有人及时赶到',
                    '玩家可以改变任何人的命运', '死亡不可逆']) {
    assert.ok(CONTRACT.includes(kw), `契约里缺少「${kw}」`)
  }
  // 要明确点名原作主角也可以被杀
  assert.match(CONTRACT, /玩家要杀虎杖，\*\*就让他杀成\*\*/)
})

test('死亡会被永久登记，且不重复、不越界', () => {
  const s = makeTestState(1300)
  const prop = (deaths) => ({
    hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0,
    deaths, flags: [], timeAdvance: '0',
  })

  applyProposal(s, prop(['虎杖悠仁']))
  assert.deepEqual(s.timeline.deaths, ['虎杖悠仁'], '死亡没有入库')

  // 同一个名字重复登记不该重复
  applyProposal(s, prop(['虎杖悠仁']))
  assert.equal(s.timeline.deaths.length, 1, '重复登记了')

  // 空数组是常态，不该报错
  applyProposal(s, prop([]))
  assert.equal(s.timeline.deaths.length, 1)

  // 模型偶尔会塞垃圾进来，要过滤掉
  const r = clampProposal(prop(['x', '老虎杖悠仁老虎杖悠仁老虎杖悠仁老虎杖悠仁', '伏黑惠', 123, '']), s)
  applyProposal(s, r)
  assert.ok(s.timeline.deaths.includes('伏黑惠'), '正常名字被误过滤')
  assert.ok(!s.timeline.deaths.includes('x'), '一个字的名字不该入库')
  assert.ok(!s.timeline.deaths.some((d) => d.length > 12), '超长串不该入库')
})

test('已死亡角色会写进状态视图，模型每回合都能看到', () => {
  const s = makeTestState(1400)
  applyProposal(s, {
    hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0,
    deaths: ['虎杖悠仁'], flags: [], timeAdvance: '0',
  })
  assert.deepEqual(modelStateView(s).已死亡角色, ['虎杖悠仁'])
})

test('契约要求把死亡写进 deaths 字段', () => {
  assert.match(CONTRACT, /proposal\.deaths/, '没有告诉模型往哪写')
  assert.match(CONTRACT, /没有死亡就填空数组/, '没有说明无死亡时该填什么')
})
