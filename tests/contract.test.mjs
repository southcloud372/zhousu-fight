import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  submitTurn, submitOpeningScene, submitAttributeFlavor, submitIdentityFlavor,
} from '../server/engine/schemas.js'
import { clampProposal } from '../server/engine/guard.js'
import { COMBAT_MODES, MODE_LABELS } from '../server/engine/combat.js'
import { TRAINING_TABLE } from '../server/engine/commands.js'
import { GRADES, TIER_GRADES, DOMAIN_TIER } from '../server/engine/tables.js'
import { CORE_RULES, CONTRACT } from '../server/prompts.js'
import { ENEMY_ARCHETYPES } from '../server/engine/rolls.js'
import { PROTECTED_CHARACTERS } from '../server/engine/guard.js'
import { blankState } from '../server/engine/state.js'
import { makeRng } from '../server/engine/dice.js'

/**
 * 跨模块契约测试。
 *
 * 这一类 bug 最难发现：schema 里声明了字段 X，代码却读 Y，
 * 运行时既不报错也不缺字段，只是悄悄拿到 undefined。
 * 之前"少年院任务_开始"这个 flag 对不上节点名就是这么漏掉的。
 */

const props = (tool) => Object.keys(tool.input_schema.properties)
const required = (tool) => tool.input_schema.required || []

// ------------------------------------------------------------------ schema ↔ 代码

test('submit_turn 声明了代码会读的每一个字段', () => {
  const p = props(submitTurn)
  for (const k of ['narration', 'dialogue', 'choices', 'proposal', 'combatRequest']) {
    assert.ok(p.includes(k), `submit_turn 缺少 ${k}`)
    assert.ok(required(submitTurn).includes(k), `${k} 应当 required`)
  }
})

test('proposal 的字段必须覆盖 clampProposal 读取的全部字段', () => {
  const proposalProps = Object.keys(submitTurn.input_schema.properties.proposal.properties)
  // clampProposal 实际读取的字段（见 guard.js）
  const read = ['hpDelta', 'ceDelta', 'relationDelta', 'sukunaAwakeningDelta', 'flags', 'timeAdvance']
  for (const k of read) {
    assert.ok(proposalProps.includes(k), `proposal 声明里缺少 ${k}，clampProposal 会读到 undefined`)
  }
  const req = submitTurn.input_schema.properties.proposal.required || []
  assert.deepEqual([...req].sort(), [...read].sort(), 'proposal.required 与代码读取的字段不一致')
})

test('combatRequest 的字段必须覆盖 postProcess 读取的全部字段', () => {
  const cr = submitTurn.input_schema.properties.combatRequest
  const read = ['enemyName', 'enemyGrade', 'enemyTechniqueName', 'enemyTechniqueEffect', 'enemyDomainName', 'reason']
  for (const k of read) {
    assert.ok(Object.keys(cr.properties).includes(k), `combatRequest 缺少 ${k}`)
  }
  assert.deepEqual([...(cr.required || [])].sort(), [...read].sort())
})

test('combatRequest.enemyGrade 的枚举必须和等级表完全一致', () => {
  const enumVals = submitTurn.input_schema.properties.combatRequest.properties.enemyGrade.enum
  assert.deepEqual(enumVals, GRADES, 'enemyGrade 枚举与 GRADES 不一致')
  // 开局 schema 也要一致
  const openEnum = submitOpeningScene.input_schema.properties.combatRequest.properties.enemyGrade.enum
  assert.deepEqual(openEnum, GRADES)
})

test('开头 schema 声明的字段必须覆盖 opening.js 读取的字段', () => {
  const ap = submitAttributeFlavor.input_schema.properties.profiles.items
  for (const k of ['slot', 'techniqueName', 'techniqueEffect', 'techniqueCooldown', 'domain', 'talents', 'playstyle', 'tool']) {
    assert.ok(Object.keys(ap.properties).includes(k), `属性档案 schema 缺少 ${k}`)
    assert.ok((ap.required || []).includes(k), `${k} 应当 required`)
  }
  const ip = submitIdentityFlavor.input_schema.properties.identities.items
  for (const k of ['slot', 'name', 'background', 'mainlineRelation', 'openingSituation', 'hook']) {
    assert.ok(Object.keys(ip.properties).includes(k), `身份档案 schema 缺少 ${k}`)
    assert.ok((ip.required || []).includes(k), `${k} 应当 required`)
  }
})

test('narration 必须是 schema 的第一个属性', () => {
  // 流式打字机依赖这个顺序：字段排后面就得等整个 JSON 生成完才出字
  for (const tool of [submitTurn, submitOpeningScene]) {
    assert.equal(props(tool)[0], 'narration',
      `${tool.name} 的 narration 不在第一位，流式输出会退化成"全生成完才显示"`)
  }
})

test('slot 枚举与开局流程用的编号一致', () => {
  assert.deepEqual(submitAttributeFlavor.input_schema.properties.profiles.items.properties.slot.enum, ['A', 'B', 'C'])
  assert.deepEqual(submitIdentityFlavor.input_schema.properties.identities.items.properties.slot.enum, ['甲', '乙', '丙'])
})

// ------------------------------------------------------------------ 常量 ↔ 代码

test('三种战斗模式与模式名一一对应', () => {
  assert.deepEqual(COMBAT_MODES, ['manual', 'skip', 'narrative'])
  for (const m of COMBAT_MODES) assert.ok(MODE_LABELS[m], `模式 ${m} 缺少显示名`)
  assert.equal(Object.keys(MODE_LABELS).length, COMBAT_MODES.length)
})

test('敌方性格表覆盖 AI 会查的全部键', () => {
  // chooseEnemyAction 读取 aggression / cunning / defendBelow
  for (const [name, arch] of Object.entries(ENEMY_ARCHETYPES)) {
    for (const k of ['aggression', 'cunning', 'defendBelow']) {
      assert.equal(typeof arch[k], 'number', `性格 ${name} 缺少 ${k}`)
    }
    assert.ok(arch.aggression >= 0 && arch.aggression <= 1, `${name}.aggression 越界`)
    assert.ok(arch.cunning >= 0 && arch.cunning <= 1, `${name}.cunning 越界`)
  }
})

test('修炼表的 target 键必须在角色的 training 字段里存在', () => {
  const state = blankState(makeRng(1))
  // buildPlayer 里初始化 training 的键
  const trainingKeys = ['体能训练', '咒力冥想', '术式演练', '反转术式修习', '领域雏形冥想', '体术实战']
  assert.deepEqual(Object.keys(TRAINING_TABLE).sort(), [...trainingKeys].sort(),
    'TRAINING_TABLE 的条目与角色 training 字段不一致')
})

test('领域强度表覆盖全部特级档位', () => {
  for (const g of TIER_GRADES) {
    assert.ok(DOMAIN_TIER[g], `特级档位 ${g} 没有对应的领域强度名`)
  }
})

test('受保护角色引用的原作节点都存在于时间线里', () => {
  const nodes = Object.keys(blankState(makeRng(1)).timeline.nodes)
  for (const [who, node] of Object.entries(PROTECTED_CHARACTERS)) {
    assert.ok(nodes.includes(node), `「${who}」要求的节点「${node}」不在时间线节点表里，拦截永远不会生效`)
  }
})

// ------------------------------------------------------------------ 提示词

test('设定原文被真的读进来了', () => {
  assert.ok(CORE_RULES.length > 10000, `设定原文只有 ${CORE_RULES.length} 字，可能没读到文件`)
  for (const kw of ['咒术师等级', '宿傩', '领域展开', '生得术式']) {
    assert.ok(CORE_RULES.includes(kw), `设定原文里缺少关键词 ${kw}`)
  }
})

test('引擎契约包含四条硬性规则', () => {
  for (const kw of [
    '只能通过调用工具提交结果',
    '不要自己播报数值变化',
    '弱特级',
    '跳过当天，进行修炼',
  ]) {
    assert.ok(CONTRACT.includes(kw), `契约里缺少关键约束：${kw}`)
  }
})

test('clampProposal 对缺字段的提议不炸', () => {
  const state = { player: { hp: { cur: 100, max: 100 }, ce: { cur: 100, max: 100 } } }
  // 模型偶尔会漏字段，这里必须能兜住
  for (const bad of [undefined, null, {}, { hpDelta: null }, { flags: 'not-an-array' }, { relationDelta: null }]) {
    const r = clampProposal(bad, state)
    assert.equal(typeof r.hpDelta, 'number', `${JSON.stringify(bad)} 没兜住`)
    assert.ok(Array.isArray(r.flags))
    assert.equal(typeof r.relationDelta, 'object')
  }
})
