import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as tables from '../server/engine/tables.js'
import * as state from '../server/engine/state.js'
import * as formula from '../server/engine/formula.js'
import * as rolls from '../server/engine/rolls.js'
import * as llm from '../server/llm.js'
import * as prompts from '../server/prompts.js'

/**
 * 常量体检 + 模块可加载性。
 *
 * 这些数字是从设定原文抄进代码的，抄错一个就是隐形 bug
 * （比如 6 月写成 7 月，整条时间线都不对）。所以钉住它们。
 */

test('开局日期是 2018-06-05（虎杖吞手指前后）', () => {
  assert.equal(state.GAME_START_DATE, '2018-06-05')
})

test('消耗比例在合理区间', () => {
  assert.ok(state.TECH_COST_RATIO > 0 && state.TECH_COST_RATIO < 0.2,
    `术式基础消耗占比 ${state.TECH_COST_RATIO} 不合理`)
  assert.ok(state.DOMAIN_COST_RATIO > state.TECH_COST_RATIO && state.DOMAIN_COST_RATIO < 0.3,
    `领域维持消耗 ${state.DOMAIN_COST_RATIO} 应当高于术式但不失控`)
})

test('初始不可获得等级只有准一级与龙级', () => {
  assert.deepEqual(tables.CREATION_LOCKED, ['准一级', '龙级'])
})

test('属性等级偏移概率之和为 1（70/20/10）', () => {
  const sum = tables.ATTR_SHIFT.reduce((s, x) => s + x.p, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `概率和为 ${sum}`)
  const shift0 = tables.ATTR_SHIFT.find((x) => x.value === 0)
  assert.ok(Math.abs(shift0.p - 0.7) < 1e-9, '同级概率应为 70%')
})

test('领域加成符合第五节（输出 +50% / 消耗 -20%）', () => {
  assert.ok(Math.abs(tables.DOMAIN_BUFF.atkBonus - 0.5) < 1e-9)
  assert.ok(Math.abs(tables.DOMAIN_BUFF.costReduction - 0.2) < 1e-9)
})

test('咒力效率是否作伤害乘数的开关是布尔值', () => {
  assert.equal(typeof formula.USE_EFFICIENCY_AS_MULTIPLIER, 'boolean')
})

test('身份背景类型常量正确', () => {
  assert.deepEqual(rolls.IDENTITY_KINDS, ['反派向', '自由派'])
})

test('九级数值表单调递增（高等级不会比低等级弱）', () => {
  const grades = tables.GRADES
  for (let i = 1; i < grades.length; i++) {
    const prev = tables.RANGES[grades[i - 1]]
    const cur = tables.RANGES[grades[i]]
    for (const k of ['ce', 'hp', 'cd', 'pd']) {
      assert.ok(cur[k][0] >= prev[k][1],
        `${grades[i]} 的 ${k} 下限 ${cur[k][0]} 低于 ${grades[i - 1]} 的上限 ${prev[k][1]}，等级间出现重叠`)
    }
    assert.ok(tables.TECH_MULT[grades[i]] >= tables.TECH_MULT[grades[i - 1]], '术式倍率应当单调')
  }
})

test('每个等级在数值表与倍率表里都有条目', () => {
  for (const g of tables.GRADES) {
    assert.ok(tables.RANGES[g], `RANGES 缺少 ${g}`)
    assert.ok(tables.TECH_MULT[g] !== undefined, `TECH_MULT 缺少 ${g}`)
    assert.ok(tables.INITIAL_WEIGHTS[g] !== undefined, `INITIAL_WEIGHTS 缺少 ${g}`)
  }
})

test('shiftGrade 在两端都被夹住', () => {
  assert.equal(tables.shiftGrade('四级', -5), '四级')
  assert.equal(tables.shiftGrade('龙级', +5), tables.ATTR_GRADE_CAP)
  assert.equal(tables.shiftGrade('一级', 0), '一级')
})

test('支撑本局的两家模型名都非空', () => {
  assert.ok(llm.models.fast, '缺少 fast 模型')
  assert.ok(llm.models.pro, '缺少 pro 模型')
  // 该端点只认这两个名字，别让配置漂走
  for (const m of [llm.models.fast, llm.models.pro]) {
    assert.ok(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'].includes(m),
      `模型名 ${m} 不在该端点支持列表内`)
  }
})

test('提示词模块导出的都是非空字符串', () => {
  assert.ok(prompts.CORE_RULES.length > 0)
  assert.ok(prompts.CONTRACT.length > 0)
  assert.equal(typeof prompts.attributeFlavorPrompt([]), 'string')
  assert.equal(typeof prompts.identityFlavorPrompt([]), 'string')
})

test('所有服务端模块都能加载（无循环依赖 / 无语法错误）', async () => {
  const files = [
    'tables', 'dice', 'formula', 'rolls', 'state', 'schemas', 'guard',
    'visibility', 'commands', 'combat', 'opening',
  ]
  for (const f of files) {
    const m = await import(`../server/engine/${f}.js`)
    assert.ok(Object.keys(m).length > 0, `${f}.js 没有任何导出`)
  }
})

test('三条线的节点排期自洽：每个节点都有那一天，快照不会漏掉过去的节点', async () => {
  const { STORYLINE_LIST } = await import('../server/engine/storylines.js')

  for (const line of STORYLINE_LIST) {
    const rows = line.nodeSchedule
    assert.ok(rows?.length, `${line.name} 没有节点排期`)
    assert.deepEqual(rows.map((r) => r.node), line.nodes,
      `${line.name} 的节点表与排期对不上 —— 两者必须同源`)

    const dates = rows.map((r) => r.date)
    assert.deepEqual(dates, [...dates].sort(), `${line.name} 的排期不是按时间先后写的`)

    for (const r of rows) {
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${line.name}「${r.node}」日期格式不对：${r.date}`)
      assert.ok(r.date >= line.dateRange[0] && r.date <= line.dateRange[1],
        `${line.name}「${r.node}」排到了本篇之外：${r.date}`)
      assert.ok(r.danger >= 1 && r.danger <= 5, `${line.name}「${r.node}」危险度越界：${r.danger}`)
      assert.ok(r.dangerLabel, `${line.name}「${r.node}」没有危险度标签`)
    }

    // 穿越时间点是一张"那天之前发生了什么"的快照，必须和排期严格对齐：
    //   它标成已发生的节点，日期得早于它；
    //   反过来，日期早于它的节点也必须都在里面 —— 否则选它开场就会留下一个
    //   "日期已经过去、却还挂着未发生"的节点，而轮盘永远不会为它停下
    const byNode = new Map(rows.map((r) => [r.node, r.date]))
    for (const pt of line.timePoints) {
      for (const n of pt.nodesDone) {
        assert.ok(byNode.has(n), `${line.name}：时间点 ${pt.id} 写了一个不存在的节点「${n}」`)
        assert.ok(byNode.get(n) < pt.date,
          `${line.name}：${pt.id}(${pt.date}) 把「${n}」当成已发生，但排期是 ${byNode.get(n)}`)
      }
      for (const [n, d] of byNode) {
        if (d < pt.date) {
          assert.ok(pt.nodesDone.includes(n),
            `${line.name}：在 ${pt.id}(${pt.date}) 开场，「${n}」(${d}) 已经过去，却还挂着未发生`)
        }
      }
    }
  }
})
