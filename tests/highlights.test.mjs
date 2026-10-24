import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRng } from '../server/engine/dice.js'
import { rollAttributeProfile, rollEnemy } from '../server/engine/rolls.js'
import { blankState, buildPlayer, applyProposal } from '../server/engine/state.js'
import { clampProposal } from '../server/engine/guard.js'
import { CONTRACT } from '../server/prompts.js'
import { canonFlavorFor } from '../server/engine/canon.js'
import { STORYLINE_LIST, nodeDescOf } from '../server/engine/storylines.js'
import { spinWheel, INSIGHT_CHANCE } from '../server/engine/wheel.js'
import {
  initCombat, runRound, blackFlashOdds, BLACK_FLASH_MUL,
} from '../server/engine/combat.js'
import { startPresetSession, localTurn, localRoundNarration } from '../server/engine/localstory.js'
import { presetOf } from '../server/engine/localpresets.js'
import { nextMilestone } from '../server/engine/timeline.js'

/**
 * 高光机制：黑闪、顿悟日、原作声线与节点场景。
 *
 * 这些东西的共同点：**只加爽感，不动平衡的地基** —— 黑闪是暴击深处的一档
 * （同一次判定，不扰动既有随机序列），顿悟走独立随机源，声线与场景是纯文本。
 * 这里的断言守的就是这条边界。
 */

// ------------------------------------------------------------------ 工具

/** 一个能用体术连续敲三拳、又不至于敲死对手（或被敲死）的战场 */
function bfState(seed = 5) {
  const state = blankState(makeRng(seed))
  state.id = 'bf'
  const a = rollAttributeProfile(makeRng(seed + 1), 'A')
  // 拉平到一级区间中位：敌我同级、血量都撑得过三个回合，只验机制不验运气
  Object.assign(a, {
    overallGrade: '一级', techniqueGrade: '一级', techniqueMultiplier: 2.5,
    ce: { value: 4500, grade: '一级', label: '咒力总量' },
    hp: { value: 1150, grade: '一级', label: '血条总量' },
    cursedDamage: { value: 220, grade: '一级', label: '咒术伤害' },
    physicalDamage: { value: 110, grade: '一级', label: '体术伤害' },
    efficiency: { value: 0.9, grade: '一级', label: '咒力效率' },
    techniqueName: '测试术式', techniqueEffect: '测试', techniqueCooldown: 2,
    talents: [], playstyle: '', domain: { unlocked: false },
  })
  state.player = buildPlayer(a, a,
    { kind: '自由派', age: 18 },
    {
      name: '拳手', age: 18, background: '测'.repeat(12),
      mainlineRelation: '测'.repeat(8), openingSituation: '测'.repeat(8), hook: '测'.repeat(10),
    })
  const enemy = rollEnemy(makeRng(seed + 2), '一级')
  enemy.technique.name = '测试敌方术式'
  // 压低敌方速度与输出：保证玩家先手、且不会把玩家打断/打死 ——
  // 这组测试只验黑闪的机制，不验先手运气
  enemy.physicalDamage.value = 80
  enemy.cursedDamage.value = 150
  enemy.hp.value = enemy.hp.max = enemy.hp.cur = 1200
  initCombat(state, makeRng(seed + 3), { mode: 'manual', enemy, reason: '黑闪测试' })
  return state
}

function wheelState(seed = 3) {
  const state = blankState(makeRng(seed))
  state.id = 'wheel'
  const a = rollAttributeProfile(makeRng(seed + 1), 'A')
  Object.assign(a, {
    techniqueName: '测试术式', techniqueEffect: '测试', techniqueCooldown: 2,
    talents: [], playstyle: '', domain: { unlocked: false },
  })
  state.player = buildPlayer(a, a,
    { kind: '自由派', age: 20 },
    {
      name: '轮手', age: 20, background: '测'.repeat(12),
      mainlineRelation: '测'.repeat(8), openingSituation: '测'.repeat(8), hook: '测'.repeat(10),
    })
  // 排期之外的日子：不受节点闸门干扰，专测轮盘本身
  state.time.date = '2019-12-31'
  return state
}

/** 与 index.js 的 postProcess 后半段同一套夹紧（测试里手动代劳） */
function turn(state, text, rng) {
  const raw = localTurn(state, text, rng)
  applyProposal(state, clampProposal(raw.proposal, state))
  return raw
}

function driveToNodeDay(state, rng) {
  const preset = presetOf('sn-shadow')
  let raw = null
  for (let i = 0; i < 6 && !state.local.arcDone; i++) {
    raw = turn(state, raw ? raw.choices[0] : preset.beats[0].c[0].label, rng)
    if (raw.combatRequest) raw = turn(state, '（战斗已结算完毕，继续推进剧情）', rng)
  }
  let guard = 0
  while (nextMilestone(state)?.daysLeft > 0 && guard++ < 40) {
    raw = turn(state, '按兵不动，只盯紧日期', rng)
  }
  return raw
}

// ------------------------------------------------------------------ 黑闪

test('blackFlashOdds：无颗数 30%，三颗后封顶 60%（原著：打出过的身体会记住）', () => {
  assert.equal(blackFlashOdds({}), 0.3)
  assert.equal(blackFlashOdds({ _blackFlash: 1 }), 0.4)
  assert.equal(blackFlashOdds({ _blackFlash: 2 }), 0.5)
  assert.equal(blackFlashOdds({ _blackFlash: 3 }), 0.6)
  assert.equal(blackFlashOdds({ _blackFlash: 9 }), 0.6, '颗数再多也封顶，不滚雪球')
})

test('黑闪只在连击 ≥2 之后发生：前两拳不闪，第三拳（判定压到最深）必闪', () => {
  const state = bfState()
  assert.ok(state.combat.playerFirst, '这组测试要求玩家先手（速度已在 bfState 里压好）')
  // 恒 0 的 rng：伤害取下限、暴击判定压到最深 —— 排除随机性，只验机制
  const zero = () => 0
  const panels = []
  for (let i = 0; i < 3; i++) panels.push(runRound(state, zero, { type: 'physical' }).panel)
  assert.ok(!panels[0].beat.player.blackFlash, '第一拳（连击 0）不闪')
  assert.ok(!panels[1].beat.player.blackFlash, '第二拳（连击 1）不闪')
  assert.ok(panels[2].beat.player.blackFlash, '第三拳起（连击 ≥2）可以闪')
  assert.equal(state.player._blackFlash, 1, '颗数记在玩家身上，跟着存档走')
  assert.ok(panels[2].actionText.includes('黑闪'), '交手机读里写明黑闪')
  assert.equal(panels[2].blackFlash, 'player', '面板暴露黑闪的一方，演出层靠它放特写')
})

test('黑闪伤害高于暴击（几何级 vs 1.8 倍），且兼有暴击的打断效果', () => {
  const state = bfState(9)
  const zero = () => 0
  const rounds = []
  for (let i = 0; i < 3; i++) rounds.push(runRound(state, zero, { type: 'physical' }))
  const critDmg = rounds[1].panel.beat.player.damage
  const bfDmg = rounds[2].panel.beat.player.damage
  assert.ok(bfDmg > critDmg * 1.2, `黑闪(${bfDmg}) 应明显高于暴击(${critDmg})`)
  assert.equal(rounds[2].panel.staggered, 'enemy', '黑闪照旧打断对方下一手')
  assert.ok(BLACK_FLASH_MUL > 1.8)
})

test('黑闪只在体术上发生：术式命中永远只是普通暴击', () => {
  const state = bfState(11)
  const zero = () => 0
  for (let i = 0; i < 3; i++) runRound(state, zero, { type: 'physical' }) // 先铺连击
  state.player.technique.cdLeft = 0
  const r = runRound(state, zero, { type: 'technique' })
  assert.ok(!r.panel.beat.player.blackFlash, '术式不闪')
  assert.ok(r.panel.beat.player.crit, '但暴击照常')
})

// ------------------------------------------------------------------ 顿悟日

test('顿悟日：独立随机源、确定性复现，中了就翻倍并写进日报', () => {
  let fired = 0
  let trainDays = 0
  for (let seed = 1; seed <= 24; seed++) {
    const state = wheelState(seed)
    for (let d = 0; d < 12; d++) {
      const r = spinWheel(state, makeRng(seed * 100 + d))
      if (r.kind !== 'train') continue // 静养日没有顿悟，不算数
      trainDays += 1
      assert.equal(typeof r.insight, 'boolean', '每个训练日都要给出顿悟与否')
      if (r.insight) {
        fired += 1
        assert.ok(r.notes.some((n) => String(n).includes('顿悟')), '顿悟必须写进日报')
        // 翻倍那一份的收获并进 notes 而不是 ups —— 顿悟是惊喜，不是通胀
        assert.ok(!r.ups.some((u) => String(u).includes('顿悟')), '顿悟不该占 ups 的位置')
      }
    }
  }
  assert.ok(fired > 0, `24 个种子 × 12 天一个顿悟都没有（${fired}/${trainDays}）—— 概率表该查了`)
  assert.ok(fired < trainDays * INSIGHT_CHANCE * 2.5, '顿悟触发率异常偏高，独立随机源可能失效')
})

// ------------------------------------------------------------------ 声线与场景

test('canonFlavorFor：原作人物有声线与真术式名，别名能查，路人为空', () => {
  const gojo = canonFlavorFor('五条悟', 'sukuna')
  assert.ok(gojo)
  assert.ok(gojo.voice.length >= 8)
  assert.ok(gojo.lines.length >= 2)
  assert.equal(gojo.technique.name, '无下限术式')
  assert.equal(gojo.domain.name, '无量空处')
  assert.equal(canonFlavorFor('五条', 'sukuna')?.name, '五条悟', '别名走同一张卡')
  assert.ok(canonFlavorFor('夏油杰', 'kaigyoku')?.lines.length >= 2)
  assert.ok(canonFlavorFor('五条悟', 'kaigyoku'), '怀玉篇的五条悟是同一张声线')
  assert.equal(canonFlavorFor('食骸咒胎', 'sukuna'), null, '无名敌人没有声线')
  assert.equal(canonFlavorFor('咒灵', 'sukuna'), null)
})

test('每条线的每个原作节点都配了「那一天」的场景描述', () => {
  for (const line of STORYLINE_LIST) {
    for (const row of line.nodeSchedule) {
      const desc = nodeDescOf(line.id, row.node)
      assert.ok(desc.length >= 14, `${line.id}「${row.node}」的场景描述缺失或过短`)
    }
  }
  assert.equal(nodeDescOf('sukuna', '不存在的节点'), '', '查不到的节点返回空串')
})

test('契约里有高潮写作守则：黑闪、领域、落刀都要写足分量', () => {
  assert.ok(CONTRACT.includes('黑闪'))
  assert.ok(CONTRACT.includes('高潮时刻的写法'))
  assert.ok(CONTRACT.includes('短句'))
})

// ------------------------------------------------------------------ 本地模式的高光

test('本地模式：节点当天的正文写进原著场景描述', () => {
  const state = blankState(makeRng(21))
  state.id = 'lnode'
  startPresetSession(state, 'sn-shadow', 'story')
  const raw = driveToNodeDay(state, makeRng(22))
  const ms = nextMilestone(state)
  assert.equal(ms?.daysLeft, 0)
  const desc = nodeDescOf('sukuna', ms.node)
  assert.ok(desc.length > 0 && raw.narration.includes(desc.slice(0, 10)),
    `节点当天正文应包含原著场景：${raw.narration.slice(0, 40)}`)
})

test('本地模式：与原作人物开打时，他们说的是自己的台词', () => {
  const state = blankState(makeRng(31))
  state.id = 'lspar'
  startPresetSession(state, 'sn-shadow', 'story')
  const rng = makeRng(32)
  let raw = driveToNodeDay(state, rng)
  // 旁观掉这一天 → 回到倒计时拍（切磋只在倒计时里出现）
  raw = turn(state, '远远看着，把一切记下来', rng)
  let guard = 0
  while (!(raw.choices || []).some((c) => c.includes('过一场手')) && guard++ < 10) {
    raw = turn(state, '按兵不动，只盯紧日期', rng)
  }
  const spar = raw.choices.find((c) => c.includes('过一场手'))
  assert.ok(spar, '倒计时拍应提供切磋选项')
  const fight = localTurn(state, spar, rng)
  assert.ok(fight.combatRequest, '切磋开打')
  assert.ok(fight.dialogue.length >= 1, '原作对手应当开口')
  const speaker = fight.dialogue[0].speaker
  assert.ok(['七海建人', '禅院真希', '钉崎野蔷薇', '伏黑惠'].includes(speaker),
    `切磋对象应是原作人物：${speaker}`)
})

test('本地回合演出：黑闪写成全场最高的一拍（敌我两侧都有）', () => {
  const state = blankState(makeRng(41))
  state.id = 'lbf'
  startPresetSession(state, 'sn-rose', 'story')
  const mine = localRoundNarration(state, {
    blackFlash: 'player',
    beat: { player: { blackFlash: true, damage: 999, label: '体术', crit: true }, enemy: {} },
    enemy: { name: '馋指咒灵' },
  })
  assert.ok(mine.includes('黑闪'), '我方黑闪要写出来')
  assert.ok(mine.includes('亿万分之一秒'), '要有原著的分量感')

  const theirs = localRoundNarration(state, {
    blackFlash: 'enemy',
    beat: { player: {}, enemy: { blackFlash: true, damage: 500 } },
    enemy: { name: '馋指咒灵' },
  })
  assert.ok(theirs.includes('黑闪'), '敌方黑闪也要写出来')
  assert.ok(theirs.includes('馋指咒灵'))
})
