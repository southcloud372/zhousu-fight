import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NARRATION_MIN, visibleLength, overflowBy, clampNarration,
} from '../server/engine/narration.js'

/**
 * 正文预算。
 *
 * 这几条纯函数是"战斗向每次输出不超过 400 字"的执行层：提示词负责让模型
 * 少写，它们负责在模型不听的时候把账算清楚、把多余的截掉。
 * 所以测试盯的是两件事：**算得准**（正文和台词一起算），
 * **截得干净**（断在句号上，不留半句话）。
 */

test('字数算的是"剧情框里真正显示的那些字"：正文 + 台词', () => {
  assert.equal(visibleLength({ narration: '一二三' }), 3)
  assert.equal(visibleLength({ narration: '一二三', dialogue: [{ speaker: '宿傩', text: '四个字' }] }), 6)
  // speaker 不算 —— 那是标签，不是叙事
  assert.equal(visibleLength({ narration: '一', dialogue: [{ speaker: '很长的名字', text: '二' }] }), 2)
  // 残缺数据不能炸
  assert.equal(visibleLength(null), 0)
  assert.equal(visibleLength({}), 0)
  assert.equal(visibleLength({ narration: '一', dialogue: [null, { speaker: 'x' }] }), 1)
})

test('正文两端的空白不算字', () => {
  assert.equal(visibleLength({ narration: '  \n 三个字 \n ' }), 3)
})

test('超出的部分算得出来，没超就是 0', () => {
  assert.equal(overflowBy({ narration: '一'.repeat(400) }, 400), 0)
  assert.equal(overflowBy({ narration: '一'.repeat(401) }, 400), 1)
  assert.equal(overflowBy({ narration: '一'.repeat(100) }, 400), 0)
  // 台词会把正文挤出去
  assert.equal(overflowBy({ narration: '一'.repeat(390), dialogue: [{ text: '二'.repeat(30) }] }, 400), 20)
})

test('没有预算的模式（剧情向）永远不判超', () => {
  assert.equal(overflowBy({ narration: '一'.repeat(5000) }, null), 0)
  assert.equal(overflowBy({ narration: '一'.repeat(5000) }, 0), 0)
})

test('截断断在句号上，不留半句话', () => {
  const text = '他抬手。刀锋到了。血溅在墙上。'
  // 预算落在第二个句号之后、"墙"字之前
  const cut = clampNarration(text, 13)
  assert.equal(cut, '他抬手。刀锋到了。')
  assert.ok(!cut.endsWith('血'), '不该把最后一个词切一半')
})

test('预算范围内原样返回，一个字都不动', () => {
  const text = '他抬手。刀锋到了。'
  assert.equal(clampNarration(text, 100), text)
  assert.equal(clampNarration(text, text.length), text)
})

test('前半段找不到句号时退回逗号，再不行才硬截', () => {
  // 只有逗号可用
  const long = '他抬手挥刀劈下，' + '血'.repeat(60)
  assert.equal(clampNarration(long, 10), '他抬手挥刀劈下，')
  // 连标点都没有：只能硬截，但也不能超出预算
  const bare = '血'.repeat(100)
  const hard = clampNarration(bare, 30)
  assert.equal(hard.length, 30)
  assert.equal([...hard].every((c) => c === '血'), true)
})

test('断点不能落在预算的前半段 —— 那等于把整段砍没了', () => {
  // 句号出现在第 2 个字，之后全是长句：不能只留 2 个字交差
  const text = '好。' + '血'.repeat(200)
  const cut = clampNarration(text, 100)
  assert.ok(cut.length > 50, `截得太狠了：${cut.length}`)
  assert.ok(cut.length <= 100)
})

test('空正文 / 没有预算时的边界', () => {
  assert.equal(clampNarration('', 100), '')
  assert.equal(clampNarration(null, 100), '')
  assert.equal(clampNarration('一'.repeat(500), null), '一'.repeat(500))
})

test('空壳判定的门槛是 60 字，且比战斗向的预算小得多', () => {
  assert.equal(NARRATION_MIN, 60)
  assert.ok(NARRATION_MIN < 400, '空壳门槛不能高过字数预算，否则短正文会被当成"没写"')
})
