import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRng, rfloat, pick, rint } from '../server/engine/dice.js'
import {
  techniqueCost, domainModifier, physicalStrike, hpStatus, defenseOf,
  techniqueDamage, applyDamageFloor, MIN_DAMAGE_RATIO,
} from '../server/engine/formula.js'
import {
  chooseEnemyAction, buildPanel, renderPanelText, summarizeRounds,
  initCombat, runRound, simulateCombat, unitSpeed,
} from '../server/engine/combat.js'
import {
  blankState, buildPlayer, applyProposal, advanceTime, panelSnapshot, modelStateView,
} from '../server/engine/state.js'
import { npcAttitude, sukunaAttitude, npcView } from '../server/engine/visibility.js'
import { rollAttributeProfile, rollIdentity, rollIdentityKind, rollInitialRelations, rollEnemy } from '../server/engine/rolls.js'
import { GRADES, RANGES, TECH_MULT } from '../server/engine/tables.js'
import { attributeFlavorPrompt, identityFlavorPrompt, turnStatePrompt } from '../server/prompts.js'
import { TRAINING_TABLE } from '../server/engine/commands.js'
import { charactersFor } from '../server/engine/timeline.js'
import { DEFAULT_STORYLINE } from '../server/engine/storylines.js'

// ------------------------------------------------------------------ 夹具

function makeUnit(over = {}) {
  return {
    name: '测试', grade: '一级',
    hp: { cur: 1000, max: 1000, grade: '一级' },
    ce: { cur: 1000, max: 1000, grade: '一级' },
    cursedDamage: { value: 200, grade: '一级' },
    physicalDamage: { value: 100, grade: '一级' },
    efficiency: { value: 0.9, grade: '一级' },
    technique: { name: '测试术式', effect: '', multiplier: 2.5, cost: 50, cooldown: 2, cdLeft: 0 },
    domain: { unlocked: false, active: false },
    reverseCursedTechnique: { level: '未掌握', progress: 0 },
    ...over,
  }
}

function makeTestState(seed = 1) {
  const s = blankState(makeRng(seed))
  const a = rollAttributeProfile(makeRng(seed + 1), 'A')
  Object.assign(a, {
    techniqueName: '测试术式', techniqueEffect: 'e', techniqueCooldown: 2,
    talents: ['战斗直觉'], playstyle: '', domain: { unlocked: false },
  })
  const id = rollIdentity(makeRng(seed + 2), '甲', rollIdentityKind(makeRng(seed + 3), 0))
  Object.assign(id, { name: '测试者', background: 'b', mainlineRelation: 'm', openingSituation: 'o', hook: 'h' })
  s.player = buildPlayer(a, a, id, id)
  s.relations = id.initialRelations
  return s
}

// ------------------------------------------------------------------ 骰子

test('rfloat 落在区间内且能取到两端附近', () => {
  const rng = makeRng(5)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < 5000; i++) {
    const v = rfloat(rng, 2, 5)
    assert.ok(v >= 2 && v < 5, `rfloat 越界：${v}`)
    lo = Math.min(lo, v); hi = Math.max(hi, v)
  }
  assert.ok(lo < 2.1 && hi > 4.9, `rfloat 覆盖不足：${lo} ~ ${hi}`)
})

test('pick 只返回数组里的元素', () => {
  const rng = makeRng(6)
  const arr = ['a', 'b', 'c']
  for (let i = 0; i < 500; i++) assert.ok(arr.includes(pick(rng, arr)))
})

test('同一个种子给出同一串随机数（可复现）', () => {
  const a = Array.from({ length: 20 }, () => rint(makeRng(42), 0, 1e6))
  // 注意：每次新建 rng 都会重置，所以这里全是同一个值
  assert.equal(new Set(a).size, 1)
  const seq1 = [], seq2 = []
  const r1 = makeRng(7), r2 = makeRng(7)
  for (let i = 0; i < 50; i++) { seq1.push(r1()); seq2.push(r2()) }
  assert.deepEqual(seq1, seq2, '同种子必须给出同序列')
  const r3 = makeRng(8)
  assert.notDeepEqual(seq1, Array.from({ length: 50 }, () => r3()), '不同种子不该同序列')
})

// ------------------------------------------------------------------ 公式补充

test('术式消耗 = 基础消耗 ÷ 效率，领域展开时再减免', () => {
  const u = makeUnit({ efficiency: { value: 0.5, grade: '一级' } })
  assert.equal(techniqueCost(u, 100), 200, '效率 50% 时消耗翻倍')

  const u2 = makeUnit({ efficiency: { value: 1.0, grade: '一级' }, domain: { unlocked: true, active: true, cost: 10 } })
  assert.equal(techniqueCost(u2, 100), 80, '领域展开应减免 20% 消耗')

  // 消耗永远不会是 0 或负
  assert.ok(techniqueCost(makeUnit({ efficiency: { value: 5, grade: 'x' } }), 1) >= 1)
})

test('domainModifier 只在领域展开时给加成', () => {
  const off = domainModifier(makeUnit())
  assert.deepEqual(off, { atk: 1, cost: 1 })
  const on = domainModifier(makeUnit({ domain: { unlocked: true, active: true, cost: 10 } }))
  assert.ok(on.atk > 1, '展开后应有输出加成')
  assert.ok(on.cost < 1, '展开后应有消耗减免')
})

test('体术伤害不吃术式倍率', () => {
  const rng = makeRng(11)
  const atk = makeUnit({ cursedDamage: { value: 200, grade: '一级' }, physicalDamage: { value: 100, grade: '一级' } })
  const def = makeUnit({ hp: { cur: 1e6, max: 1e6 }, physicalDamage: { value: 0 }, efficiency: { value: 0 } })
  const r = physicalStrike(atk, def, { rng })
  // 体术 = 100 × 相性1 × 压制 × 随机，不会乘上 2.5
  assert.ok(r.damage < 200, `体术伤害 ${r.damage} 疑似乘了术式倍率`)
  assert.ok(r.damage > 0)
  assert.equal(r.breakdown.术式倍率, undefined, '体术不该有术式倍率')
})

test('hpStatus 的四档阈值', () => {
  const mk = (cur, max) => hpStatus({ cur, max })
  assert.equal(mk(0, 100), '濒死')
  assert.equal(mk(1, 100), '重伤')
  assert.equal(mk(19, 100), '重伤')
  assert.equal(mk(20, 100), '轻伤')
  assert.equal(mk(59, 100), '轻伤')
  assert.equal(mk(60, 100), '正常')
  assert.equal(mk(100, 100), '正常')
})

// ------------------------------------------------------------------ 平衡

test('同级战斗在每个等级都能分出胜负（不会被防御力吃光伤害）', () => {
  // 曾经的真 bug：防御里的「效率 × 20」是固定加法，低级时吞掉全部攻击力，
  // 四级同级互殴双方恒打 1 点、需 75 回合，而回合上限是 30 → 必然强制平局。
  const rng = makeRng(101)
  const mid = ([lo, hi]) => (lo + hi) / 2
  const MAX_ROUNDS = 30

  for (const g of GRADES) {
    const r = RANGES[g]
    const mk = () => ({
      grade: g,
      hp: { cur: mid(r.hp), max: mid(r.hp) }, ce: { cur: mid(r.ce), max: mid(r.ce) },
      cursedDamage: { value: mid(r.cd) }, physicalDamage: { value: mid(r.pd) },
      efficiency: { value: r.eff },
      technique: { name: 't', multiplier: TECH_MULT[g], cost: 1 },
      domain: { active: false },
    })
    const a = mk(), d = mk()

    // 术式：算上冷却，两回合一次
    const techHits = Math.ceil(mid(r.hp) / techniqueDamage(a, d, { rng }).damage)
    assert.ok(techHits + 1 <= MAX_ROUNDS,
      `${g} 同级术式需要 ${techHits} 击（含冷却约 ${techHits * 2} 回合），超过 ${MAX_ROUNDS} 回合上限`)

    // 体术不吃冷却，但也不能被压到地板
    const phys = physicalStrike(a, d, { rng }).damage
    assert.ok(phys > 1, `${g} 同级体术伤害被压到 ${phys}，体术形同虚设`)
  }
})

test('跨大级压制没有被伤害地板破坏', () => {
  const rng = makeRng(103)
  const strong = {
    grade: '超特级', hp: { cur: 500000, max: 500000 }, ce: { cur: 3e6, max: 3e6 },
    cursedDamage: { value: 80000 }, physicalDamage: { value: 35000 }, efficiency: { value: 1.3 },
    technique: { name: 't', multiplier: 4.5, cost: 1 }, domain: { active: false },
  }
  const weak = {
    grade: '四级', hp: { cur: 75, max: 75 }, ce: { cur: 200, max: 200 },
    cursedDamage: { value: 15 }, physicalDamage: { value: 8 }, efficiency: { value: 0.5 },
    technique: { name: 't', multiplier: 1.0, cost: 1 }, domain: { active: false },
  }
  // 弱的打强的：应当几乎造不成伤害（相对强者的血量）
  const chip = techniqueDamage(weak, strong, { rng }).damage
  assert.ok(chip < strong.hp.max * 0.001, `四级打超特级造成 ${chip} 伤害，地板让它破防了`)

  // 强的打弱的：应当是碾压
  const crush = techniqueDamage(strong, weak, { rng }).damage
  assert.ok(crush >= weak.hp.max, `超特级打四级只有 ${crush} 伤害，碾压感不足`)
})

// ------------------------------------------------------------------ 敌方 AI

test('敌方 AI 永远不会选择它做不到的行动', () => {
  const rng = makeRng(13)
  for (let i = 0; i < 400; i++) {
    const s = makeTestState(100 + i)
    const enemy = rollEnemy(rng, '二级')
    initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })

    // 造一个"什么都没得用"的敌人：没领域、没反转、术式冷却中
    enemy.domain = { unlocked: false, active: false }
    enemy.reverseCursedTechnique = { level: '未掌握', progress: 0 }
    enemy.technique.cdLeft = 3
    enemy.ce.cur = 0

    const a = chooseEnemyAction(s, rng)
    assert.notEqual(a.type, 'domain', '没有领域却选择开领域')
    assert.notEqual(a.type, 'reverse', '没掌握反转术式却选择治疗')
    assert.notEqual(a.type, 'technique', '术式冷却中/没蓝却选择放术式')
    assert.ok(['physical', 'defend'].includes(a.type), `意外行动 ${a.type}`)
  }
})

test('敌方 AI 在残血且有反转术式时会治疗', () => {
  const rng = makeRng(17)
  const s = makeTestState(200)
  const enemy = rollEnemy(rng, '二级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  enemy.hp.cur = Math.round(enemy.hp.max * 0.2)
  enemy.reverseCursedTechnique = { level: '初步', progress: 0 }
  enemy.ce.cur = enemy.ce.max
  // 概率性行为，多试几次至少要出一次
  let healed = 0
  for (let i = 0; i < 50; i++) if (chooseEnemyAction(s, rng).type === 'reverse') healed++
  assert.ok(healed > 0, '残血且会治疗时，AI 从不选择治疗')
})

// ------------------------------------------------------------------ 面板

test('buildPanel 提供 renderPanelText 需要的全部字段', () => {
  const rng = makeRng(19)
  const s = makeTestState(300)
  const enemy = rollEnemy(rng, '二级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  runRound(s, rng, { type: 'technique' })
  const panel = s.combat.log.at(-1)

  for (const k of ['turn', 'player', 'enemy', 'actionText', 'enemyActionText', 'breakdown', 'damage', 'notes']) {
    assert.ok(k in panel, `buildPanel 缺少 ${k}`)
  }
  for (const k of ['hp', 'hpMax', 'ce', 'ceMax', 'status', 'technique', 'cdLeft', 'domain']) {
    assert.ok(k in panel.player, `panel.player 缺少 ${k}`)
  }
  for (const k of ['name', 'grade', 'hp', 'hpMax', 'ceEstimate', 'status', 'domain']) {
    assert.ok(k in panel.enemy, `panel.enemy 缺少 ${k}`)
  }
})

test('renderPanelText 输出第六节规定的六行格式', () => {
  const rng = makeRng(23)
  const s = makeTestState(400)
  const enemy = rollEnemy(rng, '二级')
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  runRound(s, rng, { type: 'technique' })
  const text = renderPanelText(s.combat.log.at(-1))

  assert.match(text, /^【实时战况·第\d+回合】/, '缺少标题行')
  assert.match(text, /玩家：HP \d+\/\d+ \| 咒力 \d+\/\d+ \| 状态：\S+ \| 术式：.+（冷却\d+） \| 领域：/,
    '玩家行格式与第六节不符')
  assert.match(text, /敌方：.+ \| .+ \| HP \d+\/\d+ \| 咒力估算 \d+ \| 状态：/, '敌方行格式与第六节不符')
  assert.match(text, /本回合行动：/, '缺少本回合行动')
  assert.match(text, /伤害计算：/, '缺少伤害计算')
})

test('战斗面板给玩家显示真实等级，不做 NPC 过滤', () => {
  const rng = makeRng(29)
  const s = makeTestState(500)
  const enemy = rollEnemy(rng, '弱特级')
  enemy.name = '特级咒灵'
  initCombat(s, rng, { mode: 'manual', enemy, reason: 't' })
  runRound(s, rng, { type: 'physical' })
  const text = renderPanelText(s.combat.log.at(-1))
  // 面板是玩家可见的，应当出现细分刻度；NPC 视角才需要过滤
  assert.match(text, /弱特级/, '面板应当显示特级内部细分')
})

test('summarizeRounds 不会把几十回合原样丢给模型', () => {
  const rng = makeRng(31)
  const s = makeTestState(600)
  const enemy = rollEnemy(rng, '弱特级')
  initCombat(s, rng, { mode: 'skip', enemy, reason: 't' })
  const { rounds } = simulateCombat(s, rng)
  const brief = summarizeRounds(rounds)

  assert.ok(brief.length <= rounds.length, '摘要不该比原文更长')
  assert.ok(brief.length <= 12, `30 回合的战斗摘要仍有 ${brief.length} 条，太长`)
  // 回合数少时摘要本来就短（1 回合就只有 1 条），只在多回合时要求首尾都在
  if (rounds.length >= 2) assert.ok(brief.length >= 2, '多回合战斗的摘要应当保留首尾')
  assert.equal(brief[0].回合, rounds[0].turn, '摘要应当从第一回合开始')
  assert.equal(brief.at(-1).回合, rounds.at(-1).turn, '摘要应当包含最后一回合')
  for (const row of brief) {
    assert.ok(row.回合 && row.玩家HP && row.敌方HP, '摘要条目字段不全')
  }
})

test('长战斗的摘要规模受控', () => {
  // 直接构造 30 个面板，验证筛选规则不会退化成全量
  const fake = Array.from({ length: 30 }, (_, i) => ({
    turn: i + 1, damage: 100,
    player: { hp: 100, hpMax: 100 }, enemy: { hp: 100, hpMax: 100 },
    actionText: 'a', enemyActionText: 'b',
  }))
  const brief = summarizeRounds(fake)
  assert.ok(brief.length < 30, `30 回合仍然产出 ${brief.length} 条`)
  assert.ok(brief.length <= 12, `摘要 ${brief.length} 条，超出预期上限`)
})

// ------------------------------------------------------------------ 状态

test('panelSnapshot 覆盖界面需要的全部字段', () => {
  const s = makeTestState(700)
  const p = panelSnapshot(s)
  for (const k of [
    'name', 'age', 'grade', 'backgroundType', 'hp', 'ce', 'status', 'technique', 'domain',
    'reverseCursedTechnique', 'tools', 'talents', 'cursedDamage', 'physicalDamage', 'efficiency',
    'relations', 'sukuna', 'timeline', 'time', 'training',
  ]) {
    assert.ok(k in p, `panelSnapshot 缺少 ${k}`)
  }
  assert.equal(p.hp.cur, s.player.hp.cur)
  assert.equal(p.relations, s.relations)
})

test('advanceTime 跨月跨年都正确', () => {
  const cases = [
    ['2018-06-28', '1w', '2018-07-05'],
    ['2018-12-30', '3d', '2019-01-02'],
    ['2018-06-05', '1d', '2018-06-06'],
    ['2019-02-28', '1d', '2019-03-01'],
    ['2020-02-28', '1d', '2020-02-29'], // 闰年
  ]
  for (const [from, amount, expected] of cases) {
    const s = makeTestState(800)
    s.time.date = from
    advanceTime(s, amount)
    assert.equal(s.time.date, expected, `${from} 推进 ${amount} 应为 ${expected}`)
  }
})

test('关系值被夹在 -100 ~ +100', () => {
  const s = makeTestState(900)
  s.relations['虎杖悠仁'] = 98
  applyProposal(s, { hpDelta: 0, ceDelta: 0, relationDelta: { 虎杖悠仁: 15 }, sukunaAwakeningDelta: 0, flags: [], timeAdvance: '0' })
  assert.equal(s.relations['虎杖悠仁'], 100)

  s.relations['宿傩'] = -98
  applyProposal(s, { hpDelta: 0, ceDelta: 0, relationDelta: { 宿傩: -15 }, sukunaAwakeningDelta: 0, flags: [], timeAdvance: '0' })
  assert.equal(s.relations['宿傩'], -100)
})

test('血条和咒力永远不会变成负数', () => {
  const s = makeTestState(1000)
  for (let i = 0; i < 20; i++) {
    applyProposal(s, { hpDelta: -99999, ceDelta: -99999, relationDelta: {}, sukunaAwakeningDelta: 0, flags: [], timeAdvance: '0' })
  }
  assert.ok(s.player.hp.cur >= 0, `HP 变成 ${s.player.hp.cur}`)
  assert.ok(s.player.ce.cur >= 0, `咒力变成 ${s.player.ce.cur}`)
  assert.ok(s.player.hp.cur <= s.player.hp.max)
  assert.ok(s.player.ce.cur <= s.player.ce.max)
})

test('宿傩觉醒度被夹在 0~100，态度自动更新', () => {
  const s = makeTestState(1100)
  applyProposal(s, { hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaAwakeningDelta: 10, flags: [], timeAdvance: '0' })
  assert.equal(s.sukuna.awakening, 15) // 初始 5 + 10
  applyProposal(s, { hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaAwakeningDelta: 10, flags: [], timeAdvance: '0' })
  assert.ok(s.sukuna.awakening <= 100)
  assert.ok(s.sukuna.attitude, '态度应当同步更新')
})

// ------------------------------------------------------------------ 态度映射

test('好感度到态度的映射是单调的', () => {
  const seq = [-100, -70, -50, -20, 0, 10, 30, 60, 90].map(npcAttitude)
  const order = ['敌意', '戒备', '疏远', '客气', '友善', '信任', '推心置腹']
  const idx = seq.map((s) => order.indexOf(s))
  assert.ok(idx.every((i) => i >= 0), `出现未知态度：${seq.join(',')}`)
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] >= idx[i - 1], `态度不单调：${seq.join(' → ')}`)
  }
  assert.equal(npcAttitude(100), '推心置腹')
  assert.equal(npcAttitude(-100), '敌意')
})

test('宿傩觉醒度到态度的门槛', () => {
  assert.equal(sukunaAttitude(0), '无视')
  assert.equal(sukunaAttitude(19), '无视')
  assert.equal(sukunaAttitude(20), '好奇')
  assert.equal(sukunaAttitude(40), '感兴趣')
  assert.equal(sukunaAttitude(60), '警惕')
  assert.equal(sukunaAttitude(80), '敌意')
  assert.equal(sukunaAttitude(100), '敌意')
})

// ------------------------------------------------------------------ 敌方生成

test('每个等级的敌人都能生成且数值合法', () => {
  const rng = makeRng(37)
  for (const grade of ['四级', '三级', '二级', '准一级', '一级', '弱特级', '标特级', '超特级', '龙级']) {
    const e = rollEnemy(rng, grade)
    assert.equal(e.grade, grade)
    assert.ok(e.hp.cur > 0 && e.hp.cur === e.hp.max)
    assert.ok(e.ce.cur === e.ce.max && e.ce.cur > 0)
    assert.ok(e.technique.cost > 0)
    assert.ok(e.technique.multiplier > 0)
    assert.ok(e.archetype, `${grade} 敌人没有性格`)
    // 非特级不该有领域（第五节）
    const tier = ['弱特级', '标特级', '超特级', '龙级'].includes(grade)
    assert.equal(e.domain.unlocked, tier, `${grade} 的领域持有状态不对`)
  }
})

test('身份关系初值随背景类型变化', () => {
  const rng = makeRng(41)
  const villain = rollInitialRelations(rng, '反派向')
  assert.ok(villain.宿傩 >= 0, '反派向对宿傩应当非负')
  assert.ok(villain.五条悟 <= 0, '反派向对五条应当非正')

  const original = rollInitialRelations(rng, '原作关联')
  assert.ok(original.虎杖悠仁 > 0, '原作关联应当认识虎杖')

  // 覆盖范围按故事线的名单算，别写死人数 —— 名单增删时这条不该跟着红
  for (const kind of ['反派向', '自由派', '原作关联']) {
    const r = rollInitialRelations(rng, kind)
    assert.deepEqual(Object.keys(r).sort(), [...charactersFor(DEFAULT_STORYLINE)].sort(),
      '关系表应当覆盖本线全部登场角色')
  }
})

// ------------------------------------------------------------------ 提示词拼装

test('提示词把引擎掷的结果带给了模型', () => {
  const profiles = [rollAttributeProfile(makeRng(43), 'A')].map((p) => ({ ...p, techniqueName: 'X' }))
  const txt = attributeFlavorPrompt(profiles)
  assert.ok(txt.includes('不可改动'), '应当明确告诉模型数值不可改')
  assert.ok(txt.includes('"slot"') || txt.includes('slot'), '应当包含掷骰结果')
  assert.ok(txt.includes('domainUnlocked'), '应当包含领域觉醒标记')

  const id = rollIdentity(makeRng(44), '甲', '反派向')
  const itxt = identityFlavorPrompt([id])
  assert.ok(itxt.includes('反派向'), '应当带上背景类型')
  assert.ok(itxt.includes('钩子'), '应当要求写钩子')

  const s = makeTestState(1200)
  const stxt = turnStatePrompt(modelStateView(s))
  assert.ok(stxt.includes(s.player.name), '状态提示里应当有角色名')
})

// ------------------------------------------------------------------ 修炼表

test('修炼表每项的进度区间与消耗都合法', () => {
  for (const [name, row] of Object.entries(TRAINING_TABLE)) {
    assert.ok(row.range[0] > 0 && row.range[0] < row.range[1], `${name} 区间不合法`)
    assert.ok(row.range[1] <= 0.5, `${name} 单轮进度上限过高：${row.range[1]}`)
    assert.ok(row.cost, `${name} 缺少消耗说明`)
    assert.ok(Array.isArray(row.targets) && row.targets.length > 0, `${name} 没有提升目标`)
  }
})

// ------------------------------------------------------------------ NPC 视角

test('npcView 的伤势描述随血量变化且不含数字', () => {
  const mk = (ratio) => {
    const u = makeUnit({ domain: { unlocked: false, active: false } })
    u.hp.cur = Math.round(u.hp.max * ratio)
    return npcView(u)
  }
  const full = mk(1), hurt = mk(0.5), dying = mk(0.1), down = mk(0)
  assert.equal(full.状态, '尚有余力')
  assert.equal(hurt.状态, '负伤')
  assert.equal(dying.状态, '摇摇欲坠')
  assert.equal(down.状态, '倒下')
  assert.notEqual(full.伤势, dying.伤势)
  for (const v of [full, hurt, dying]) {
    assert.ok(!/\d/.test(JSON.stringify(v)), 'NPC 视角不该出现数字')
  }
})
