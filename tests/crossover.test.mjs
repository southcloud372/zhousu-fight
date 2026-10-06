import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  stagesFor, FOCUSES, focusById, rollStage, applyStage, completeCrossover, crossoverReady,
} from '../server/engine/crossover.js'
import { blankState, buildPlayer } from '../server/engine/state.js'
import { rollAttributeProfile, rollIdentity, rollIdentityKind } from '../server/engine/rolls.js'
import { makeRng } from '../server/engine/dice.js'
import { GRADES, gradeIndex, isTier, RANGES } from '../server/engine/tables.js'
import { pointsFor, applyTimeline } from '../server/engine/timeline.js'
import { STORYLINE_LIST, storylineOf } from '../server/engine/storylines.js'

/** 造一个"已经走到本线衔接节点"的角色 */
function readyState(lineId = 'kaigyoku', grade = '三级') {
  const s = blankState(makeRng(1234), lineId)
  const a = rollAttributeProfile(makeRng(77), 'A')
  a.overallGrade = grade
  Object.assign(a, {
    techniqueName: '测试术式', techniqueEffect: '测', techniqueCooldown: 2,
    talents: ['战斗直觉'], playstyle: '', domain: { unlocked: false },
  })
  const it = rollIdentity(makeRng(88), '甲', rollIdentityKind(makeRng(99), 0), lineId)
  Object.assign(it, { name: '测试者', background: 'b', mainlineRelation: 'm', openingSituation: 'o', hook: 'h' })
  s.player = buildPlayer(a, a, it, it)
  s.relations = it.initialRelations
  s.phase = 'playing'
  applyTimeline(s, pointsFor(lineId).at(-1))
  const line = storylineOf(lineId)
  if (line.crossoverNode) s.timeline.nodes[line.crossoverNode] = '已发生'
  return s
}

// ------------------------------------------------------------------ 跨度

test('每个篇章的历练跨度与自己的年份相符', () => {
  for (const line of STORYLINE_LIST) {
    if (!line.next) continue
    const stages = stagesFor(line.id)
    assert.ok(stages.length > 0, `${line.name} 有后续篇章却没有配跨度`)
    // 起止年份必须落在本篇结束到下一篇开始之间
    const nextLine = storylineOf(line.next)
    assert.equal(stages.at(-1).to, nextLine.startDate.slice(0, 4),
      `${line.name} 的跨度终点 ${stages.at(-1).to} 对不上下篇起始年 ${nextLine.startDate.slice(0, 4)}`)
  }
})

test('怀玉篇 11 年、宿傩篇 10 年，各段之和等于总跨度', () => {
  const sum = (id) => stagesFor(id).reduce((n, s) => n + s.years, 0)
  assert.equal(sum('kaigyoku'), 11)
  assert.equal(sum('sukuna'), 10)
})

// ------------------------------------------------------------------ 历练

test('每个历练方向都会涨它该涨的那几项', () => {
  const rng = makeRng(11)
  for (const f of FOCUSES) {
    const s = readyState()
    const r = rollStage(s, f.id, 0, rng)
    const keys = r.gains.map((g) => g.key)
    for (const k of f.primary) assert.ok(keys.includes(k), `${f.name} 没有涨主攻项 ${k}`)
    for (const g of r.gains) {
      assert.ok(g.pct > 0, `${f.name} 的 ${g.key} 涨幅为 0`)
      assert.ok(g.pct < 30, `${f.name} 的 ${g.key} 涨幅 ${g.pct}% 过大，会让三段历练失控`)
    }
  }
})

test('历练只涨不跌，且血条/咒力的当前值跟着上限走', () => {
  const s = readyState()
  const before = {
    hp: s.player.hp.max, ce: s.player.ce.max,
    cd: s.player.cursedDamage.value, pd: s.player.physicalDamage.value,
  }
  for (let i = 0; i < 3; i++) applyStage(s, rollStage(s, 'ascetic', i, makeRng(100 + i)))

  assert.ok(s.player.hp.max >= before.hp, '血条上限不该下降')
  assert.ok(s.player.ce.max >= before.ce, '咒力上限不该下降')
  assert.ok(s.player.cursedDamage.value >= before.cd)
  assert.ok(s.player.physicalDamage.value >= before.pd)
  // hp/ce 用的是 max 而不是 value —— 之前在这里写出过 NaN
  assert.ok(Number.isFinite(s.player.hp.max), '血条上限算成了 NaN')
  assert.ok(Number.isFinite(s.player.ce.max), '咒力上限算成了 NaN')
  assert.equal(s.player.hp.cur, s.player.hp.max, '当前血量应当跟着上限')
  assert.equal(s.player.ce.cur, s.player.ce.max, '当前咒力应当跟着上限')
})

// ------------------------------------------------------------------ 门槛

test('等级没有突破门槛：一级可以直接升到特级', () => {
  // 这条规则原先要求"从一级迈向特级需专属突破剧情"，已废止
  const s = readyState('kaigyoku', '一级')
  assert.equal(s.player.grade, '一级')
  const r = completeCrossover(s, makeRng(5))
  assert.equal(r.gradeUp, '弱特级', '一级应当可以靠积累直接升到弱特级')
  assert.equal(s.player.grade, '弱特级')
  assert.ok(isTier(s.player.grade), '应当已经算特级了')
  // 数值要抬到新等级的区间下限
  assert.ok(s.player.hp.max >= RANGES['弱特级'].hp[0], '血条没有抬到弱特级的下限')
  assert.ok(s.player.ce.max >= RANGES['弱特级'].ce[0], '咒力没有抬到弱特级的下限')
})

test('特级之间也能继续往上升（弱特 → 标特）', () => {
  const s = readyState('kaigyoku', '弱特级')
  const r = completeCrossover(s, makeRng(6))
  assert.equal(r.gradeUp, '标特级', '特级内部不该有门槛')
})

test('升到龙级后不再越级，改为纯数值提升', () => {
  const s = readyState('kaigyoku', '龙级')
  const before = s.player.hp.max
  const r = completeCrossover(s, makeRng(7))
  assert.equal(r.gradeUp, null, '龙级已经是顶，不该再升')
  assert.equal(s.player.grade, '龙级')
  assert.ok(s.player.hp.max > before, '到顶之后应当改为数值提升')
})

test('每一级都能一路升到龙级，没有卡住的地方', () => {
  for (let i = 0; i < GRADES.length - 1; i++) {
    const s = readyState('kaigyoku', GRADES[i])
    const r = completeCrossover(s, makeRng(20 + i))
    assert.equal(r.gradeUp, GRADES[i + 1], `${GRADES[i]} 应当能升到 ${GRADES[i + 1]}`)
  }
})

// ------------------------------------------------------------------ 换篇

test('换篇保留该保留的、换掉该换掉的', () => {
  const s = readyState('kaigyoku')
  s.relations['五条悟'] = 45
  s.relations['夏油杰'] = -20
  const tech = s.player.technique.name
  const talents = [...s.player.talents]

  completeCrossover(s, makeRng(9))

  assert.equal(s.storyline, 'sukuna', '应当换到宿傩篇')
  assert.equal(s.player.name, '测试者', '姓名应当保留')
  assert.equal(s.player.technique.name, tech, '生得术式应当保留')
  assert.deepEqual(s.player.talents, talents, '天赋应当保留')
  // 节点表换成新篇的，不能残留怀玉篇的节点
  assert.ok('虎杖吞手指' in s.timeline.nodes, '节点表没换成宿傩篇的')
  assert.ok(!('玉折' in s.timeline.nodes), '怀玉篇的节点残留在新篇里了')
  assert.equal(s.time.date, '2018-06-05', '起始日期没对齐新篇')
})

test('只保留两篇都登场的人，其余的人在时间里散了', () => {
  const s = readyState('kaigyoku')
  s.relations['五条悟'] = 45     // 两篇都有
  s.relations['夏油杰'] = -20    // 只在怀玉篇
  s.relations['天内理子'] = 30   // 只在怀玉篇

  const r = completeCrossover(s, makeRng(10))

  assert.equal(s.relations['五条悟'], 45, '两篇都登场的人应当记得你')
  assert.ok(!('夏油杰' in s.relations) || s.relations['夏油杰'] === 0, '只在前篇的人不该带过来')
  const carried = r.carriedRelations.map((x) => x.name)
  assert.ok(carried.includes('五条悟'))
  assert.ok(!carried.includes('天内理子'))
  assert.match(r.note, /五条悟/)
})

test('换篇后关系表按新篇名单重建，不多不少', () => {
  const s = readyState('kaigyoku')
  completeCrossover(s, makeRng(12))
  const names = Object.keys(s.relations).sort()
  assert.deepEqual(names, [...storylineOf('sukuna').characters].sort())
})

test('换篇后手指也跟着新篇重置', () => {
  /*
   * 怀玉篇在 2006 年，虎杖还没出生，全程一根手指都不该有。
   * 跨进宿傩篇就是"虎杖刚吞下第一根"那一天 —— 所以这里要的是新篇的起点，
   * 而不是把上一篇的计数原样带过来：那样恰好也是 0，数字对得上，
   * 理由却完全不对，下一段（宿傩篇救回八根再跨未来篇）就会露馅。
   */
  const s = readyState('kaigyoku')
  assert.deepEqual(
    [s.sukuna.fingersCollected, s.sukuna.fingersEaten],
    [0, 0],
    '怀玉篇本就不该有手指',
  )
  completeCrossover(s, makeRng(12))
  assert.equal(s.sukuna.fingersCollected, 1, '跨进宿傩篇应当回到"虎杖刚吞下第一根"')
  assert.equal(s.sukuna.fingersEaten, 1)
  assert.equal(s.sukuna.fingersPlayerEaten, 0)

  // 反过来 宿傩篇 → 未来篇 也要重置：那条线的宿傩进度由它自己从零推
  const fut = readyState('sukuna')
  fut.sukuna.fingersCollected = 9
  fut.sukuna.fingersEaten = 8
  completeCrossover(fut, makeRng(13))
  assert.equal(fut.storyline, 'future')
  assert.equal(fut.sukuna.fingersCollected, 0, '未来篇从零起算，不继承上一篇的进度')
  assert.equal(fut.sukuna.fingersEaten, 0)
})

// ------------------------------------------------------------------ 可用性

test('走完衔接节点前不能跨篇，终篇也不能跨', () => {
  const early = readyState('kaigyoku')
  early.timeline.nodes['玉折'] = '未发生'
  assert.equal(crossoverReady(early).ok, false, '没走完衔接节点不该允许跨篇')
  assert.match(crossoverReady(early).reason, /玉折/)

  const mid = readyState('kaigyoku')
  assert.equal(crossoverReady(mid).ok, true)

  const last = readyState('sukuna')
  completeCrossover(last, makeRng(13)) // → 未来篇
  assert.equal(crossoverReady(last).ok, false, '未来篇是终篇，不该还能跨')
})

test('跨篇年数按两篇实际跨度算，不是写死的', () => {
  const a = readyState('kaigyoku')
  assert.equal(completeCrossover(a, makeRng(14)).gapYears, 11)

  const b = readyState('sukuna')
  assert.equal(completeCrossover(b, makeRng(15)).gapYears, 10)
})

test('未知的历练方向会被兜住', () => {
  assert.equal(focusById('nonsense'), undefined)
  const s = readyState()
  const r = rollStage(s, 'nonsense', 0, makeRng(16))
  assert.ok(r, '未知方向不该抛错')
  assert.ok(r.gains.length > 0, '应当走默认方向')
})
