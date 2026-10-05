import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REVERSE_HEAL,
  reverseCeCost, reverseHealAmount, recoveryById, needsRecovery, recoveryOptions, applyRecovery,
} from '../server/engine/recovery.js'
import { REVERSE_TABLE, OUT_OF_COMBAT_HEAL_MULT } from '../server/engine/formula.js'
import {
  initCombat, runRound, freeReverse, reversePreview, FREE_REVERSE_PER_ROUND,
} from '../server/engine/combat.js'
import { blankState, buildPlayer } from '../server/engine/state.js'
import { rollAttributeProfile, rollIdentity, rollIdentityKind, rollEnemy } from '../server/engine/rolls.js'
import { makeRng } from '../server/engine/dice.js'
import { daysBetween } from '../server/engine/timeline.js'
import { advanceTime } from '../server/engine/state.js'

/**
 * 疗伤与"不占回合的反转术式"。
 *
 * 玩家的原话是"使用反转术式但状态栏没有加血" —— 根因有两个：
 *   1. 血条只有等模型写完旁白才刷新
 *   2. 咒力不够时反转术式静默失败，白占一个回合
 * 所以测试盯的是"每一步都有明确结果和明确理由"，
 * 以及反转术式**确实不占回合**。
 */

function mk(seed = 21) {
  const s = blankState(makeRng(seed), 'sukuna', 'combat')
  const a = rollAttributeProfile(makeRng(seed + 1), 'A')
  Object.assign(a, {
    techniqueName: '测试术式', techniqueEffect: 'e', techniqueCooldown: 2,
    talents: [], playstyle: '', domain: { unlocked: false },
  })
  const it = rollIdentity(makeRng(seed + 2), '甲', rollIdentityKind(makeRng(seed + 3), 0), 'sukuna')
  Object.assign(it, {
    name: '测试者', background: 'b', mainlineRelation: 'm', openingSituation: 'o', hook: 'h',
  })
  s.player = buildPlayer(a, a, it, it)
  s.relations = it.initialRelations
  s.phase = 'playing'
  return s
}

const hurt = (s, ratio) => { s.player.hp.cur = Math.max(1, Math.round(s.player.hp.max * ratio)); s.player.status = ratio < 0.2 ? '重伤' : '轻伤' }

// ------------------------------------------------------------------ 什么时候该出现

test('只有身上有伤才给恢复选项', () => {
  const s = mk()
  assert.equal(needsRecovery(s), false, '满血正常不该冒恢复选项')

  hurt(s, 0.5)
  assert.equal(needsRecovery(s), true, '血掉到六成以下就该能疗伤')

  s.player.hp.cur = s.player.hp.max
  s.player.status = '轻伤'
  assert.equal(needsRecovery(s), true, '状态不正常也该能疗伤')

  s.player.status = '正常'
  assert.equal(needsRecovery(s), false)
})

// ------------------------------------------------------------------ 反转术式

test('反转术式的治疗量与咒力消耗都按上限算，档位越高越省', () => {
  const s = mk()
  const p = s.player
  let prevCost = Infinity
  for (const level of ['初步', '熟练', '精通']) {
    p.reverseCursedTechnique.level = level
    assert.equal(reverseHealAmount(p), Math.round(p.hp.max * REVERSE_HEAL[level]))
    assert.equal(reverseCeCost(p), Math.round(p.ce.max * REVERSE_TABLE[level].cost))
    assert.ok(reverseCeCost(p) < prevCost, `${level} 的咒力消耗没有比上一档低`)
    prevCost = reverseCeCost(p)
  }
  p.reverseCursedTechnique.level = '未掌握'
  assert.equal(reverseHealAmount(p), 0)
  assert.equal(recoveryById('reverse').available(s).ok, false)
  assert.match(recoveryById('reverse').available(s).reason, /尚未掌握/)
})

test('战斗外疗伤用的是同一张档位表（回血更多、咒力不变）', () => {
  const s = mk()
  const p = s.player
  for (const level of ['初步', '熟练', '精通']) {
    p.reverseCursedTechnique.level = level
    // 回血 = 战斗内 × 战斗外倍数；咒力消耗与战斗内一致
    assert.equal(REVERSE_HEAL[level], Number((REVERSE_TABLE[level].heal * OUT_OF_COMBAT_HEAL_MULT).toFixed(3)))
    assert.equal(reverseCeCost(p), Math.round(p.ce.max * REVERSE_TABLE[level].cost))
  }
})

test('反转术式自愈：烧咒力回血，不占时间', () => {
  const s = mk()
  const p = s.player
  p.reverseCursedTechnique.level = '熟练'
  hurt(s, 0.3)
  const hp0 = p.hp.cur
  const ce0 = p.ce.cur
  const date0 = s.time.date

  const r = applyRecovery(s, 'reverse')
  assert.ok(r.healed > 0)
  assert.equal(r.healed, Math.min(reverseHealAmount(p), p.hp.max - hp0))
  assert.equal(p.ce.cur, ce0 - reverseCeCost(p))
  assert.equal(r.days, 0, '反转术式不该花掉一整天')
  assert.equal(s.time.date, date0)
  assert.equal(r.hp.cur, p.hp.cur, '返回值必须带最新血条，界面靠它实时刷新')
})

test('咒力不够时反转术式给理由，而不是静默失败', () => {
  const s = mk()
  const p = s.player
  p.reverseCursedTechnique.level = '熟练'
  hurt(s, 0.3)
  p.ce.cur = reverseCeCost(p) - 1

  const gate = recoveryById('reverse').available(s)
  assert.equal(gate.ok, false)
  assert.match(gate.reason, /咒力不足/)

  const hp0 = p.hp.cur
  assert.equal(applyRecovery(s, 'reverse'), null, '不可用就不该有任何副作用')
  assert.equal(p.hp.cur, hp0)
})

test('静养：回一截血，代价是一整天', () => {
  const s = mk()
  const p = s.player
  hurt(s, 0.3)
  const hp0 = p.hp.cur
  const date0 = s.time.date

  const r = applyRecovery(s, 'rest')
  assert.ok(r.healed > 0 && r.healed < p.hp.max, '静养治不满，不然反转术式就没意义了')
  assert.equal(r.days, 1)
  assert.equal(daysBetween(date0, s.time.date), 1)
  assert.equal(p.hp.cur, hp0 + r.healed)
})

test('濒死不能靠静养硬扛', () => {
  const s = mk()
  s.player.hp.cur = 0
  s.player.status = '濒死'
  const gate = recoveryById('rest').available(s)
  assert.equal(gate.ok, false)
  assert.match(gate.reason, /濒死/)
  assert.equal(applyRecovery(s, 'rest'), null)
})

test('找家入硝子：治满，但要还人情', () => {
  const s = mk()
  const p = s.player
  hurt(s, 0.2)
  s.relations['家入硝子'] = 10
  const date0 = s.time.date

  const r = applyRecovery(s, 'shoko')
  assert.equal(p.hp.cur, p.hp.max, '当代最强反转术式，应当治满')
  assert.equal(r.healed, p.hp.max - Math.max(1, Math.round(p.hp.max * 0.2)))
  assert.equal(daysBetween(date0, s.time.date), 1)
  assert.equal(s.relations['家入硝子'], 8, '欠了人情，态度该掉')

  s.relations['家入硝子'] = -30
  assert.equal(recoveryById('shoko').available(s).ok, false, '关系太差就别指望了')
})

test('疗伤之后身体状态会跟着重算', () => {
  const s = mk()
  const p = s.player
  p.reverseCursedTechnique.level = '精通'
  hurt(s, 0.1)
  assert.notEqual(p.status, '正常')
  const r = applyRecovery(s, 'reverse')
  assert.equal(r.status, p.status)
  assert.equal(r.status, '正常', '治好了就该回到正常')
})

// ------------------------------------------------------------------ 选项清单

test('选项清单每一项都带得动界面的灰态理由', () => {
  const s = mk()
  hurt(s, 0.4)
  const opts = recoveryOptions(s)
  assert.equal(opts.length, 3)
  for (const o of opts) {
    assert.ok(o.id && o.name && o.cost && o.time && o.desc, `${o.id} 字段不全`)
    assert.equal(typeof o.enabled, 'boolean')
    assert.equal(typeof o.reason, 'string')
    if (!o.enabled) assert.ok(o.reason.length > 0, `${o.id} 灰着却不说为什么`)
  }

  // 未掌握反转术式时，它是灰的且有理由
  s.player.reverseCursedTechnique.level = '未掌握'
  const rev = recoveryOptions(s).find((o) => o.id === 'reverse')
  assert.equal(rev.enabled, false)
  assert.match(rev.reason, /反转术式/)

  // 宿傩篇里家入硝子在学校待着 —— 这条路线必须是通的
  const shoko = recoveryOptions(s).find((o) => o.id === 'shoko')
  assert.equal(shoko.enabled, true, shoko.reason)
})

test('不存在的疗伤方式直接返回 null', () => {
  const s = mk()
  hurt(s, 0.4)
  assert.equal(applyRecovery(s, '不存在的选项'), null)
  assert.equal(recoveryById('不存在的选项'), null)
})

// ------------------------------------------------------------------ 战斗内的反转术式

function inCombat(seed = 5) {
  const s = mk(seed)
  const rng = makeRng(seed)
  const enemy = rollEnemy(rng, s.player.grade)
  initCombat(s, rng, { mode: 'quick', enemy, reason: '测试' })
  s.player.reverseCursedTechnique.level = '熟练'
  return { s, rng }
}

test('战斗中的反转术式不占回合：用完照常出招', () => {
  const { s } = inCombat()
  const c = s.combat
  const p = s.player
  hurt(s, 0.3)

  const turn0 = c.turn
  const hp0 = p.hp.cur
  const r = freeReverse(s)
  assert.equal(r.ok, true, r.reason)
  assert.equal(p.hp.cur, hp0 + r.healed, '血量必须当场变化，状态栏靠它刷新')
  assert.equal(c.turn, turn0, '用反转术式不该推进回合数')
  assert.equal(c.freeUsed, 1)
  assert.equal(FREE_REVERSE_PER_ROUND, 1)
})

test('一回合只能用一次，理由要说得明白', () => {
  const { s } = inCombat()
  hurt(s, 0.2)
  assert.equal(freeReverse(s).ok, true)

  hurt(s, 0.2)
  const again = freeReverse(s)
  assert.equal(again.ok, false)
  assert.match(again.reason, /本回合已经用过/)

  // 新回合恢复次数（血和咒力都补上，否则挡住的是别的理由，测不到"次数"）
  s.player.hp.cur = s.player.hp.max
  s.player.ce.cur = s.player.ce.max
  runRound(s, makeRng(3), { type: 'physical' })
  assert.equal(s.combat.over, false, '这一回合不该直接分出胜负')
  assert.equal(s.combat.freeUsed, 0)
  hurt(s, 0.2)
  s.player.ce.cur = s.player.ce.max
  const r = freeReverse(s)
  assert.equal(r.ok, true, `新回合应当又能用了，却被挡在：${r.reason}`)
})

test('血满 / 咒力不够 / 没开打 / 没学会 —— 四种情况都给理由', () => {
  const { s } = inCombat()
  const p = s.player

  p.hp.cur = p.hp.max
  assert.match(freeReverse(s).reason, /血条已经满了/)

  hurt(s, 0.3)
  p.ce.cur = 0
  assert.match(freeReverse(s).reason, /咒力不足/)

  const backup = s.combat
  s.combat = null
  assert.match(freeReverse(s).reason, /不在战斗中/)
  s.combat = backup

  p.reverseCursedTechnique.level = '未掌握'
  hurt(s, 0.3)
  assert.match(freeReverse(s).reason, /尚未掌握/)
})

test('freeReverse 失败时不动任何数值', () => {
  const { s } = inCombat()
  const p = s.player
  p.hp.cur = p.hp.max
  const ce0 = p.ce.cur
  const r = freeReverse(s)
  assert.equal(r.ok, false)
  assert.equal(p.ce.cur, ce0, '失败了还扣咒力就是纯坑玩家')
  assert.equal(s.combat.freeUsed, 0)
})

test('reversePreview 给得出按钮上要显示的两个数（战斗内用原值）', () => {
  const { s } = inCombat()
  const pv = reversePreview(s.player)
  assert.ok(pv.cost > 0 && pv.heal > 0)
  assert.equal(pv.heal, Math.round(s.player.hp.max * REVERSE_TABLE['熟练'].heal))
  assert.equal(pv.cost, Math.round(s.player.ce.max * REVERSE_TABLE['熟练'].cost))
  assert.equal(pv.level, '熟练')
  assert.equal(reversePreview({ reverseCursedTechnique: { level: '未掌握' } }), null)
})

test('打完一场，反转术式的使用会被记进战报', () => {
  const { s } = inCombat()
  hurt(s, 0.2)
  freeReverse(s)
  runRound(s, makeRng(9), { type: 'physical' })
  assert.equal(s.combat.stats.usedReverse, true)
  assert.ok(s.combat.freeLog.length === 1)
})

test('时间推进不会顺手把血加回来（恢复必须走恢复那条路）', () => {
  const s = mk()
  hurt(s, 0.3)
  const hp0 = s.player.hp.cur
  advanceTime(s, '3d')
  assert.equal(s.player.hp.cur, hp0, '光推日期不该回血，否则恢复选项就没意义了')
})
