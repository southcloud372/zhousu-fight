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
