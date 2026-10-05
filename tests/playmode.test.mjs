import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLAY_MODES, DEFAULT_PLAY_MODE, playModeOf, playModeBriefs,
} from '../server/engine/playmodes.js'
import { blankState, modelStateView } from '../server/engine/state.js'
import { makeRng } from '../server/engine/dice.js'

/**
 * 游玩模式。
 *
 * 它不改变任何数值规则（等级压制、伤害公式照旧），
 * 改的是**叙事配比** —— 所以测试的重点是：
 *   1. 两种模式确实产出了不同的指令
 *   2. 战斗向的要求足够硬（"节点当天必须打起来"这种不能写得含糊）
 *   3. 它不会串到数值层去
 */

test('恰好两种模式，且默认是剧情向', () => {
  assert.deepEqual(Object.keys(PLAY_MODES).sort(), ['combat', 'story'])
  assert.equal(DEFAULT_PLAY_MODE, 'story')
  assert.equal(playModeOf(undefined).id, 'story')
  assert.equal(playModeOf('不存在').id, 'story', '未知模式应当兜回默认')
})

test('两种模式的指令内容确实不同', () => {
  const a = PLAY_MODES.story.rules
  const b = PLAY_MODES.combat.rules
  assert.notEqual(a, b, '两种模式给出了同一套指令，等于没做')
  // 各自都要点明自己是哪种模式，避免模型混淆
  assert.match(a, /剧情向/)
  assert.match(b, /战斗向/)
})

test('战斗向的配比要求比剧情向更硬', () => {
  const c = PLAY_MODES.combat.rules
  // 比例要写死，不能含糊
  assert.match(c, /90%/, '战斗向没有给出明确占比')
  // 空闲时间由轮盘结算，模型不许回头补写过程
  assert.match(c, /空闲时间不写剧情/, '没有说清空档由引擎结算')
  assert.match(c, /随机一个方向/, '没有点明轮盘是随机一个方向')
  // 节点当天必须开打，否则玩家练了这么久白练
  assert.match(c, /剧情节点当天必须打起来/, '没有强制节点当天开打')
  // 要堵住模型偷懒的退路
  assert.match(c, /一句话带过/, '没有要求压缩转场')
  // 选项必须是排他的：不能只写"倾向于战斗"，要让模型没法塞进非战斗选项
  assert.match(c, /四个选项必须全部是战斗动作/, '没有把选项限定成全部战斗')
  assert.match(c, /交涉|打听|观察/, '没有点名禁止哪些非战斗选项')
  assert.match(c, /允许连战|不安排休息/, '没有说明连战规则')

  // 剧情向要允许非战斗内容
  assert.match(PLAY_MODES.story.rules, /70%/, '剧情向没有给出占比')
  assert.match(PLAY_MODES.story.rules, /交涉|调查|探索/, '剧情向没有允许非战斗选项')
})

test('游玩模式不碰数值：两种模式掷出的属性完全一致', () => {
  // 模式只影响叙事，不该改变任何随机结果
  const a = blankState(makeRng(42), 'sukuna', 'story')
  const b = blankState(makeRng(42), 'sukuna', 'combat')
  assert.equal(a.playMode, 'story')
  assert.equal(b.playMode, 'combat')
  // 除 playMode 外，其余初始状态必须一模一样
  delete a.playMode
  delete b.playMode
  assert.deepEqual(a, b, '切换模式不该改变初始状态')
})

test('模式会写进喂给模型的状态视图', () => {
  const s = blankState(makeRng(1), 'sukuna', 'combat')
  assert.equal(modelStateView(s).游玩模式, '战斗向')
  s.playMode = 'story'
  assert.equal(modelStateView(s).游玩模式, '剧情向')
})

test('给前端的精简信息不含长篇规则文本', () => {
  const briefs = playModeBriefs()
  assert.equal(briefs.length, 2)
  for (const b of briefs) {
    assert.ok(b.id && b.name && b.tagline && b.desc, `${b.id} 字段不全`)
    assert.equal(b.rules, undefined, '不该把 prompt 正文发给前端')
  }
  assert.deepEqual(briefs.map((b) => b.id), ['story', 'combat'])
})
