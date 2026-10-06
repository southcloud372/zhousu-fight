import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DAY_SCALE, FATIGUE_STEP, FATIGUE_FLOOR, WHEEL_SECTORS,
  ensureWheel, sectorWeight, pickSector, spinWheel, advanceToMilestone,
  interventionGrade, startIntervention, completeIntervention, wheelSnapshot,
} from '../server/engine/wheel.js'
import { nextMilestone, daysBetween, pointsFor, nodesFor, scheduleFor, missedNodes, applyTimeline } from '../server/engine/timeline.js'
import { blankState, buildPlayer, panelSnapshot } from '../server/engine/state.js'
import { rollAttributeProfile, rollIdentity, rollIdentityKind } from '../server/engine/rolls.js'
import { makeRng } from '../server/engine/dice.js'
import { TRAINING_TABLE } from '../server/engine/commands.js'
import { GRADES, gradeIndex } from '../server/engine/tables.js'

/**
 * 战斗向的日常轮盘。
 *
 * 这个模式的核心承诺是：
 *   两段剧情之间的空闲时间 = 一天一转，随机一个方向涨属性；
 *   转到剧情当天 → 介入那场战斗。
 * 所以测试盯三件事：
 *   1. 一天确实只走一天，落点确实是随机的六个方向之一
 *   2. 转得到"剧情发生当天"（daysLeft 能到 0，而不是永远差一天）
 *   3. 空档再长也练不成怪物（DAY_SCALE + 疲劳两道闸门）
 */

function combatState(seed = 7, point = 'start') {
  const s = blankState(makeRng(seed), 'sukuna', 'combat')
  const a = rollAttributeProfile(makeRng(seed + 1), 'A')
  Object.assign(a, {
    techniqueName: '测试术式', techniqueEffect: 'e', techniqueCooldown: 2,
    talents: ['战斗直觉'], playstyle: '', domain: { unlocked: false },
  })
  const it = rollIdentity(makeRng(seed + 2), '甲', rollIdentityKind(makeRng(seed + 3), 0), 'sukuna')
  Object.assign(it, {
    name: '测试者', background: 'b', mainlineRelation: 'm', openingSituation: 'o', hook: 'h',
  })
  s.player = buildPlayer(a, a, it, it)
  s.relations = it.initialRelations
  s.phase = 'playing'
  if (point !== 'start') applyTimeline(s, pointsFor('sukuna').find((p) => p.id === point))
  return s
}

/**
 * 一个"没有排期"的状态：所有节点都当成已经发生。
 * 用来单独验轮盘本身（落点、疲劳、收益），不让"到节点当天就停下"的规则插进来 ——
 * 那 60 天里必然要过好几个节点，不排掉的话测的就不是轮盘了。
 */
function freeSpinState(seed = 7) {
  const s = combatState(seed)
  for (const n of nodesFor('sukuna')) s.timeline.nodes[n] = '已发生'
  return s
}

// ------------------------------------------------------------------ 排期

test('按节点排期，不是按穿越时间点 —— 第一个停的是「虎杖吞手指」', () => {
  const s = combatState()
  const ms = nextMilestone(s)
  assert.ok(ms, '开局就该有下一个剧情节点')
  // 早先这里走的是 timePoints，第一个停的是「少年院任务」——
  // 虎杖吞手指 / 死刑缓期 / 高专入学 三个节点永远排不上，追踪器上一直"未发生"
  assert.equal(ms.id, '虎杖吞手指')
  assert.equal(ms.node, '虎杖吞手指')
  assert.equal(ms.date, '2018-06-08')
  assert.equal(ms.daysLeft, daysBetween('2018-06-05', '2018-06-08'))
  assert.ok(ms.danger > 0 && ms.dangerLabel, '危险度要跟着节点走，介入战靠它定对手等级')

  // 走到当天：daysLeft 必须归零，而不是"那天不见了"
  s.time.date = ms.date
  const onDay = nextMilestone(s)
  assert.ok(onDay, '节点当天必须仍然被认作下一个节点')
  assert.equal(onDay.daysLeft, 0, 'daysLeft 到不了 0 的话，轮盘永远推不到剧情当天')
})

test('选涩谷开场：涩谷事变当天就是第一站，不在既有事实里', () => {
  const s = combatState(11, 'shibuya')
  const ms = nextMilestone(s)
  assert.equal(ms.node, '涩谷事变', '穿到涩谷事变当天，这一场就该当场打')
  assert.equal(ms.daysLeft, 0)
  // 往前推一天，后面接着排死灭回游
  s.time.date = '2018-11-01'
  assert.equal(nextMilestone(s).node, '死灭回游')
})

test('每个节点都排在它自己那一天：10 站一个不少，日期不倒着走', () => {
  const s = combatState()
  const seen = []
  for (const row of scheduleFor('sukuna')) {
    const ms = nextMilestone(s)
    assert.ok(ms, `排期走到「${row.node}」就断了`)
    assert.equal(ms.node, row.node)
    seen.push(ms.node)
    s.timeline.nodes[row.node] = '已发生' // 假装打完了，看下一站
    s.time.date = row.date
  }
  assert.deepEqual(seen, nodesFor('sukuna'))
  assert.equal(nextMilestone(s), null, '全部打完就该没有排期了')

  // 同一天可以有两个节点（少年院任务与宿傩夺舍是同一晚），日期因此允许相等
  const dates = scheduleFor('sukuna').map((r) => r.date)
  assert.deepEqual(dates, [...dates].sort(), '排期不是按时间先后写的')
})

test('错过的节点会被补登记，不会永远挂着"未发生"', () => {
  const s = combatState()
  // 剧情向里被模型把日期推过去了，再切回战斗向
  s.time.date = '2018-06-20' // 虎杖吞手指(06-08)、死刑缓期(06-12)、高专入学(06-15) 都过去了
  const missed = missedNodes(s)
  assert.deepEqual(missed, ['虎杖吞手指', '死刑缓期', '高专入学'])
  assert.equal(s.timeline.nodes['虎杖吞手指'], '已发生')
  assert.equal(nextMilestone(s).node, '少年院任务', '没赶上的翻篇，接着排下一站')
  assert.equal(missedNodes(s).length, 0, '补登记是幂等的')
})

// ------------------------------------------------------------------ 一天

test('转一天只走一天，落在六个方向之一', () => {
  const s = combatState()
  const rng = makeRng(99)
  const before = s.time.date
  const r = spinWheel(s, rng)

  assert.equal(daysBetween(before, s.time.date), 1, '一天应当只推进一天')
  assert.equal(ensureWheel(s).days, 1)
  assert.ok(WHEEL_SECTORS.some((x) => x.id === r.sector.id), '落点必须是轮盘上的方向')
  assert.ok(TRAINING_TABLE[r.sector.id], `${r.sector.id} 不在修炼表里，涨不了属性`)
  assert.ok(r.progress > 0, '没有进度就等于白过一天')
})

test('落点是随机的：连转 60 天不会只落一个方向', () => {
  const s = freeSpinState()
  const rng = makeRng(2024)
  const seen = new Set()
  for (let i = 0; i < 60; i++) seen.add(spinWheel(s, rng).sector?.id)
  assert.ok(seen.size >= 3, `60 天只落到 ${seen.size} 个方向，轮盘名不副实`)
})

test('剧情节点当天不许再往后转 —— 转过去这一天就没了', () => {
  const s = combatState()
  s.time.date = '2018-06-08' // 虎杖吞手指就在今天
  const rng = makeRng(66)
  const before = s.time.date
  const r = spinWheel(s, rng)

  assert.equal(r.kind, 'blocked', '当天必须挡住，而不是照转不误')
  assert.equal(s.time.date, before, '日期一点都不该动')
  assert.equal(s.player.training[r.sector?.id] ?? 0, 0, '挡住的那天不该偷偷长进度')
  assert.match(r.notes.join(''), /虎杖吞手指/)
  // 挡住的只是"再往后练" —— 这一场本身照样打得成
  assert.ok(startIntervention(s, rng), '节点当天必须能开打')
})

test('属性是练出来的：一天的收益落在进度条上，数值不会当场跳两次', () => {
  const s = combatState()
  const rng = makeRng(5)
  const p = s.player
  const before = { hp: p.hp.max, ce: p.ce.max, cd: p.cursedDamage.value, pd: p.physicalDamage.value }
  const r = spinWheel(s, rng)

  assert.equal(ensureWheel(s).days, 1)
  assert.ok(p.training[r.sector.id] > 0, '进度应当记在落点那个方向上')
  assert.ok(r.progress < 100, '一天的收益不可能直接填满一条进度条')
  assert.ok(r.ups.length <= 1, `一天之内跳变了 ${r.ups.length} 次数值`)

  const changed = [p.hp.max !== before.hp, p.ce.max !== before.ce,
    p.cursedDamage.value !== before.cd, p.physicalDamage.value !== before.pd].filter(Boolean).length
  assert.ok(changed <= 1, `一天之内有 ${changed} 项属性变了`)
})

test('连续修炼会疲劳，静养和介入都能清零', () => {
  const s = freeSpinState()
  const rng = makeRng(31)
  const w = ensureWheel(s)
  const start = w.fatigue
  for (let i = 0; i < 20; i++) spinWheel(s, rng)
  assert.ok(w.fatigue < start, `连练 20 天疲劳系数没动：${w.fatigue}`)
  assert.ok(w.fatigue >= FATIGUE_FLOOR, '疲劳不能跌破下限')
  assert.equal(Number((start - 20 * FATIGUE_STEP).toFixed(3)) >= FATIGUE_FLOOR, true)

  completeIntervention(s, '少年院任务', { winner: 'player' })
  assert.equal(ensureWheel(s).fatigue, 1, '打完一场该缓过来')
})

test('重伤/濒死那一天只能躺着，但确实在回血', () => {
  const s = combatState()
  const rng = makeRng(77)
  s.player.hp.cur = 0
  s.player.status = '濒死'

  const before = s.player.hp.cur
  const r = spinWheel(s, rng)
  assert.equal(r.kind, 'rest')
  assert.equal(r.sector, null, '躺着的那天不该落方向')
  assert.ok(s.player.hp.cur > before, '静养必须真的回血')
  assert.equal(ensureWheel(s).fatigue, 1)
  assert.equal(daysBetween(r.date, s.time.date), 0, '静养也要占掉这一天')
})

// ------------------------------------------------------------------ 空档

test('一路练到剧情当天：正好停在节点那一天，不会冲过头', () => {
  const s = combatState()
  const rng = makeRng(1234)
  const target = nextMilestone(s)
  const rep = advanceToMilestone(s, rng)

  assert.equal(s.time.date, target.date, `应当正好停在 ${target.date}，实际 ${s.time.date}`)
  assert.equal(rep.days, target.daysLeft, '走过的天数应当等于原本的 daysLeft')
  assert.equal(rep.kind, 'advance')
  // 日报里的方向分布要跟累计落点对得上
  const sum = Object.values(rep.sectors).reduce((a, b) => a + b, 0)
  assert.equal(sum + rep.rest, rep.days)

  // 到了当天，系统就能把这场仗挂出来
  const pending = startIntervention(s, rng)
  assert.ok(pending, '剧情当天必须能介入')
  assert.equal(pending.intervention, target.node)
  assert.equal(s.pendingCombat, pending)
})

test('一路打到底：每个小节点都停一次、都打得成', () => {
  const s = combatState()
  const rng = makeRng(2024)
  const stops = []

  for (let guard = 0; guard < 40; guard++) {
    const ms = nextMilestone(s)
    if (!ms) break
    // 这条测的是"排期一站不落"，不是"能不能活下来"：每一段开打前先回满血，
    // 免得某天对练掉到濒死、advanceToMilestone 提前收手，把断言带偏
    s.player.hp.cur = s.player.hp.max
    s.player.status = '正常'

    const rep = advanceToMilestone(s, rng)
    assert.equal(s.time.date, ms.date, `「${ms.node}」该停在 ${ms.date}，实际 ${s.time.date}`)
    assert.equal(rep.days, ms.daysLeft, `「${ms.node}」这一段走过的天数不对`)

    const pc = startIntervention(s, rng)
    assert.ok(pc, `「${ms.node}」当天必须能开打`)
    assert.equal(pc.intervention, ms.node)
    stops.push(pc.intervention)
    completeIntervention(s, pc.intervention, { winner: 'player' })
    s.pendingCombat = null
  }

  assert.deepEqual(stops, nodesFor('sukuna'), '每个小节点都要停一次，顺序也不能乱')
  assert.equal(nextMilestone(s), null, '打完最后一站就该没有排期了')
  // 追踪器上不该再挂着"未发生" —— 早先那四个夹在两个时间点中间的节点永远挂在那儿
  assert.equal(Object.values(s.timeline.nodes).filter((v) => v === '未发生').length, 0)
})

test('同一晚的两个节点会连着停（少年院任务 → 宿傩夺舍）', () => {
  const s = combatState()
  const rng = makeRng(31)
  for (const n of ['虎杖吞手指', '死刑缓期', '高专入学']) completeIntervention(s, n, { winner: 'player' })
  s.time.date = '2018-06-24'

  const first = startIntervention(s, rng)
  assert.equal(first.intervention, '少年院任务')
  completeIntervention(s, '少年院任务', { winner: 'player' })
  s.pendingCombat = null

  // 第一场刚打完，第二场还挂着 —— 不能因为"这个时间点已经处理过"就放行轮盘
  const second = nextMilestone(s)
  assert.equal(second.node, '宿傩夺舍', '同一晚的第二场不能被吞掉')
  assert.equal(second.daysLeft, 0)
  const pc2 = startIntervention(s, rng)
  assert.ok(pc2, '同一天的第二场也要能开打')
  assert.equal(pc2.intervention, '宿傩夺舍')
  assert.notEqual(pc2.enemy.name, first.enemy.name)
})

test('还没到当天不许开打', () => {
  const s = combatState()
  assert.equal(nextMilestone(s).daysLeft > 0, true)
  assert.equal(startIntervention(s, makeRng(1)), null, '空档期不该冒出战斗')
})

test('一个 18 天的空档（少年院打完到京都交流）：看得见长进，但练不成怪物', () => {
  const s = combatState()
  const rng = makeRng(88)
  for (const n of ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍']) {
    completeIntervention(s, n, { winner: 'player' })
  }
  s.time.date = '2018-06-24'

  const p = s.player
  const before = {
    hp: p.hp.max, ce: p.ce.max, cd: p.cursedDamage.value, pd: p.physicalDamage.value, grade: p.grade,
  }
  const ms = nextMilestone(s)
  assert.equal(ms.node, '京都姊妹校交流')
  assert.equal(ms.daysLeft, 18)
  const rep = advanceToMilestone(s, rng)
  assert.equal(rep.days, 18, '这一段的空档长度没变，收益的手感就不能变')

  // 六个方向摊薄之后，18 天大约 2~3 次数值跳变 —— 至少得动一项，
  // 否则玩家第一次过空档就会觉得"练了半天什么都没变"（这是实测踩过的坑）
  const moved = [p.hp.max !== before.hp, p.ce.max !== before.ce,
    p.cursedDamage.value !== before.cd, p.physicalDamage.value !== before.pd].filter(Boolean)
  assert.ok(moved.length >= 1, '18 天下来属性一点没动，轮盘等于摆设')

  // 进度条本身必须在动 —— 这就是右侧"成长"面板显示的那几个数
  assert.ok(Object.values(rep.progress).some((v) => v > 0), '日报没带出各方向的进度')
  assert.ok(Object.values(rep.progress).every((v) => v >= 0 && v < 100), '进度该是 0~99 之间的余数')

  // 但也不能一次空档就翻倍
  assert.ok(p.hp.max < before.hp * 1.5, `18 天血条涨太多：${before.hp} → ${p.hp.max}`)
  assert.ok(p.physicalDamage.value < before.pd * 1.6, `体术伤害涨太多：${before.pd} → ${p.physicalDamage.value}`)
  assert.ok(gradeIndex(p.grade) - gradeIndex(before.grade) <= 1, '一个 18 天的空档不该连着跨级')
})

// ------------------------------------------------------------------ 介入

test('介入的对手留在"两级以内"的设计红线里', () => {
  const s = combatState()
  const gi = gradeIndex(s.player.grade)
  for (const danger of [1, 2, 3, 4, 5]) {
    const g = interventionGrade(s, danger)
    const off = gradeIndex(g) - gi
    assert.ok(off >= 0 && off <= 2, `危险度 ${danger} 掷出了越级 ${off} 级的对手`)
    assert.ok(GRADES.includes(g))
  }
  // 越危险的节点，对手越硬 —— 不能出现"涩谷比序章还好打"
  assert.ok(gradeIndex(interventionGrade(s, 5)) >= gradeIndex(interventionGrade(s, 1)))
  assert.ok(gradeIndex(interventionGrade(s, 4)) >= gradeIndex(interventionGrade(s, 2)))
})

test('打完这一场：赢了算改写，没赢算发生，跑了不算', () => {
  const won = combatState()
  completeIntervention(won, '少年院任务', { winner: 'player' })
  assert.equal(won.timeline.nodes['少年院任务'], '已改变')
  assert.match(won.timeline.newEvents.at(-1), /改写了「少年院任务」/)

  const lost = combatState()
  completeIntervention(lost, '少年院任务', { winner: 'enemy' })
  assert.equal(lost.timeline.nodes['少年院任务'], '已发生')

  const fled = combatState()
  completeIntervention(fled, '少年院任务', { winner: 'fled' })
  assert.equal(fled.timeline.nodes['少年院任务'], '未发生', '临阵脱逃不算改过剧情')
  assert.match(fled.timeline.newEvents.at(-1), /避开了「少年院任务」/)
})

test('已经改写过的那一天，赢了也变不回原著', () => {
  // 「已改写」的理由是"撑起那一天的人已经死了"——玩家在那天再赢一次，
  // 也不可能把那个人赢回来，所以这个状态不许被覆盖
  const s = combatState()
  s.timeline.nodes['少年院任务'] = '已改写'
  completeIntervention(s, '少年院任务', { winner: 'player' })
  assert.equal(s.timeline.nodes['少年院任务'], '已改写')
  assert.match(s.timeline.newEvents.at(-1), /赢下了已经改写的「少年院任务」/)
})

test('已改写的节点照旧让轮盘停下 —— 那天还是会来', () => {
  // 玩家的选择是"节点改写，仍然发生"：不能被跳过，也不能被无视
  const s = combatState()
  const first = nextMilestone(s)
  s.timeline.nodes[first.node] = '已改写'
  s.time.date = first.date
  const day = spinWheel(s, makeRng(2))
  assert.equal(day.kind, 'blocked', '已改写的那一天不该还能继续转轮盘')
  assert.match(day.notes[0], new RegExp(first.node))

  // 而它仍然是"下一个节点"，轮盘不会越过去等后面那个
  assert.equal(nextMilestone(s).node, first.node)
})

test('介入过的节点不再排期 —— 否则会无限重打同一场', () => {
  const s = combatState()
  const rng = makeRng(4)
  const first = nextMilestone(s)
  completeIntervention(s, first.node, { winner: 'player' })
  s.time.date = first.date // 假装人就在那天

  const after = nextMilestone(s)
  assert.notEqual(after?.node, first.node)
  assert.equal(after.node, '死刑缓期')
})

// ------------------------------------------------------------------ 快照

test('轮盘快照能给界面画盘：六个扇区、权重、落点计数、进度条', () => {
  const s = combatState()
  const rng = makeRng(9)
  spinWheel(s, rng)
  spinWheel(s, rng)
  const snap = wheelSnapshot(s)

  assert.equal(snap.days, 2)
  assert.equal(snap.sectorsTable.length, WHEEL_SECTORS.length)
  assert.equal(snap.sectorsTable.reduce((n, x) => n + x.count, 0), 2)
  assert.equal(snap.sectorsTable.reduce((n, x) => n + x.weight, 0) > 0, true)
  assert.ok(snap.milestone && snap.milestone.daysLeft > 0)
  assert.equal(snap.ready, false)
  assert.equal(typeof snap.fatigue, 'number')

  // 每条扇区都得带着"这条进度到哪儿了" —— 右侧成长面板靠它画进度条。
  // 属性攒满 100% 才跳一次，不给进度的话玩家会以为转完一天什么都没发生
  for (const sec of snap.sectorsTable) {
    assert.equal(typeof sec.progress, 'number', `${sec.id} 没带进度`)
    assert.ok(sec.progress >= 0 && sec.progress < 100)
  }
  const trained = snap.sectorsTable.find((x) => x.id === snap.lastItem)
  assert.ok(trained.progress > 0, '刚练过的方向，进度条必须是动的')
  assert.equal(snap.progress[trained.short], trained.progress)
})

test('天赋会把轮盘往对应的方向拽', () => {
  const s = combatState()
  s.player.talents = ['反转适性']
  const plain = sectorWeight(s, '反转术式修习')
  s.player.talents = []
  assert.ok(plain > sectorWeight(s, '反转术式修习'), '天赋没有加权')
  // 权重为正才有机会被抽到
  for (const sec of WHEEL_SECTORS) assert.ok(sectorWeight(s, sec.id) > 0, sec.id)
  const rng = makeRng(3)
  assert.ok(WHEEL_SECTORS.some((x) => x.id === pickSector(combatState(2), rng)))
})

test('面板快照带得动战斗向的状态，刷新页面不丢进度', () => {
  const s = combatState()
  spinWheel(s, makeRng(15))
  const panel = panelSnapshot(s)
  assert.equal(panel.time.point, 'start')
  assert.ok(panel.player === undefined) // 面板字段是散开的，不该整包塞
  assert.equal(panel.name, '测试者')
})

test('两道闸门的参数没有被改坏', () => {
  // DAY_SCALE 单独看可以大于 1（六个方向会把进度摊薄，见 wheel.js 注释），
  // 但它必须是个有限的正常倍数，不能是 0 或爆炸值
  assert.ok(DAY_SCALE > 0.5 && DAY_SCALE < 5, `DAY_SCALE 跑偏了：${DAY_SCALE}`)
  assert.ok(FATIGUE_STEP > 0 && FATIGUE_FLOOR > 0 && FATIGUE_FLOOR < 1)
  // 疲劳得在合理的天数内真的压到下限，否则"连续修炼递减"只是摆设
  const daysToFloor = (1 - FATIGUE_FLOOR) / FATIGUE_STEP
  assert.ok(daysToFloor > 10 && daysToFloor < 200, `疲劳到下限要 ${daysToFloor} 天，太长或太短`)
})
