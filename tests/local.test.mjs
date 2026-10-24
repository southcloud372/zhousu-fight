import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRng } from '../server/engine/dice.js'
import { RANGES, TECH_MULT, isTier, GRADES, gradeIndex, ATTR_GRADE_CAP } from '../server/engine/tables.js'
import { blankState, applyProposal } from '../server/engine/state.js'
import { clampProposal } from '../server/engine/guard.js'
import { TALENT_POOL } from '../server/engine/rolls.js'
import { storylineOf, STORYLINE_LIST } from '../server/engine/storylines.js'
import { pointsFor, charactersFor, nextMilestone } from '../server/engine/timeline.js'
import {
  PRESETS, presetOf, presetProfile, presetIdentity, presetBriefs, sheet, gradeDistribution, LEAN_TABLE,
} from '../server/engine/localpresets.js'
import {
  startPresetSession, localTurn, localCombatNarration, localRoundNarration, localTrainingFlavor,
} from '../server/engine/localstory.js'

/**
 * 本地游玩模式。
 *
 * 守的核心承诺只有一个：**本地模式是 token 模式的同一条数值管线的另一张嘴** ——
 * 数值落在同一张 RANGES 表里、等级走同一套反推、提议过同一道夹紧。
 * 所以这里的断言大多是「和 token 模式对齐」，而不是「看起来像就行」。
 */

// ------------------------------------------------------------------ 预设库

test('预设数量达到「几十种」且 id 唯一', () => {
  assert.ok(PRESETS.length >= 30, `预设只有 ${PRESETS.length} 套`)
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length)
})

test('等级分布对齐 token 模式开局的权重结构（一级最多、特级稀有）', () => {
  const dist = gradeDistribution()
  // INITIAL_WEIGHTS 归一化：一级 50%、四级 1%、超特 5%。本地预设是写死的，
  // 不必逐项相等，但结构必须同向：一级是众数、超特不超过两套、龙级不存在。
  const mode = Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0]
  assert.equal(mode, '一级')

  // 每条线都要有完整的强度选择：二级 / 一级 / 各特级（用户的开局档位诉求）
  for (const line of STORYLINE_LIST) {
    const grades = new Set(PRESETS.filter((p) => p.line === line.id).map((p) => p.grade))
    for (const need of ['二级', '一级', '弱特级', '标特级', '超特级']) {
      assert.ok(grades.has(need), `${line.id} 缺少 ${need} 的预设`)
    }
  }
  assert.ok((dist['超特级'] || 0) <= 4)
  assert.equal(dist['龙级'] || 0, 0)
  assert.ok((dist['四级'] || 0) <= 3, '四级开局应当稀少')
})

test('每套预设的数值都落在 RANGES 区间内，且反推综合等级 === 声明等级', () => {
  for (const p of PRESETS) {
    const prof = presetProfile(p)
    assert.equal(prof.overallGrade, p.grade, `${p.id} 综合等级 ${prof.overallGrade} ≠ 声明 ${p.grade}`)
    for (const [key, rangeKey] of [['ce', 'ce'], ['hp', 'hp'], ['cursedDamage', 'cd'], ['physicalDamage', 'pd']]) {
      const [lo, hi] = RANGES[prof[key].grade][rangeKey]
      assert.ok(prof[key].value >= lo && prof[key].value <= hi,
        `${p.id} ${key}=${prof[key].value} 越出 ${prof[key].grade} 区间 [${lo},${hi}]`)
    }
    assert.equal(prof.efficiency.value, RANGES[p.grade].eff, `${p.id} 效率未取声明等级定值`)
    // 术式倍率吸附等级定值（与 tuneAttributeProfile 同一条铁律）
    assert.equal(prof.techniqueMultiplier, TECH_MULT[p.grade])
    // 开局封顶：任何单项都不得摸到龙级
    for (const key of ['ce', 'hp', 'cursedDamage', 'physicalDamage']) {
      assert.ok(gradeIndex(prof[key].grade) <= gradeIndex(ATTR_GRADE_CAP), `${p.id} ${key} 等级越开局封顶`)
    }
    // 领域只有特级开局觉醒（第五节例外条款），非特级不得携带领域
    if (!isTier(p.grade)) assert.equal(prof.domain.unlocked, false, `${p.id} 非特级却带领域`)
    else {
      assert.equal(prof.domain.unlocked, true)
      assert.ok(prof.domain.name && prof.domain.name !== '未命名领域', `${p.id} 特级预设的领域必须有名字`)
    }
  }
})

test('sheet() 六种倾向都保持中位数等级不变（同一预设重跑数值一致）', () => {
  for (const g of ['四级', '三级', '二级', '一级', '弱特级', '标特级', '超特级']) {
    for (const lean of Object.keys(LEAN_TABLE)) {
      const a = sheet(g, lean, 'salt')
      const b = sheet(g, lean, 'salt')
      assert.equal(a.overall, g, `${g}/${lean} 中位数被倾向顶跑了：${a.overall}`)
      assert.deepEqual(a, b, '同一盐值必须确定性生成同一份属性')
    }
  }
})

test('每套预设的剧情节拍齐全：四拍、正文成段、选项 ≥3、战斗规格合法', () => {
  for (const p of PRESETS) {
    assert.ok(p.beats.length >= 4, `${p.id} 节拍不足四拍`)
    for (const [i, b] of p.beats.entries()) {
      assert.ok(b.n.length >= 80, `${p.id} 第${i}拍正文太短（${b.n.length} 字）`)
      assert.ok(b.c.length >= 3 && b.c.length <= 4, `${p.id} 第${i}拍选项数异常`)
      for (const c of b.c) {
        assert.ok(c.label.length >= 4, `${p.id} 第${i}拍有选项文案过短`)
        if (c.k) {
          assert.ok(GRADES.includes(c.k.g), `${p.id} 第${i}拍战斗等级非法：${c.k.g}`)
          assert.ok(c.k.n && c.k.t && c.k.why, `${p.id} 第${i}拍战斗规格缺字段`)
          // 介入节点名必须真实存在于该线排期，否则时间线永远对不上账
          if (c.k.node) {
            assert.ok(storylineOf(p.line).nodes.includes(c.k.node),
              `${p.id} 介入节点「${c.k.node}」不在 ${p.line} 的排期里`)
          }
        }
        // 关系值只能给本线登场的人（引擎外的名字进不了关系网）
        for (const name of Object.keys(c.rel || {})) {
          assert.ok(charactersFor(p.line).includes(name),
            `${p.id} 第${i}拍给名单外的人「${name}」动了关系值`)
        }
      }
    }
  }
})

test('预设的穿越时间点与身份关系都挂在本线上', () => {
  for (const p of PRESETS) {
    const point = pointsFor(p.line).find((t) => t.id === p.at)
    assert.ok(point, `${p.id} 时间点 ${p.at} 不在 ${p.line} 的候选里`)
    const ident = presetIdentity(p)
    assert.ok(ident.name && ident.background && ident.hook)
    for (const [name, v] of Object.entries(ident.initialRelations)) {
      assert.ok(charactersFor(p.line).includes(name), `${p.id} 初始关系指向名单外的「${name}」`)
      assert.ok(Math.abs(v) <= 15, `${p.id} 初始关系值超 ±15`)
    }
    // 天赋必须来自引擎的天赋池 —— 池子外的是模型自由发挥的口子，本地模式没有这道口子
    for (const t of p.talents) assert.ok(TALENT_POOL.includes(t), `${p.id} 天赋「${t}」不在池内`)
  }
})

test('presetBriefs() 给前端的卡片信息完整（不暴露正文）', () => {
  const briefs = presetBriefs()
  assert.equal(briefs.length, PRESETS.length)
  for (const b of briefs) {
    assert.ok(b.id && b.name && b.tag && b.lineName && b.atLabel && b.grade)
    assert.ok(b.stats.ce > 0 && b.stats.hp > 0 && b.stats.cd > 0 && b.stats.pd > 0)
    assert.ok(!JSON.stringify(b).includes('beats'), '卡片不得夹带剧情正文')
  }
})

// ------------------------------------------------------------------ 开局

function localState(presetId = 'sn-shadow', playMode = 'story', seed = 7) {
  const state = blankState(makeRng(seed))
  state.id = `t-${presetId}`
  const opening = startPresetSession(state, presetId, playMode)
  assert.ok(opening, '开局必须给出第一拍')
  return { state, opening }
}

/**
 * 测试版的「回合」：localTurn 只产出提议，数值与时间要经 postProcess 的后半段
 * （clampProposal → applyProposal）才落地 —— 生产环境由路由代劳，测试里手动补上。
 * 不走这一步，时间推进永远不生效，倒计时循环会原地打转。
 */
function turn(state, text, rng) {
  const raw = localTurn(state, text, rng)
  applyProposal(state, clampProposal(raw.proposal, state))
  return raw
}

test('startPresetSession：一选即开局，故事线/角色/时间线全部来自预设', () => {
  const { state, opening } = localState('kg-star')
  assert.equal(state.phase, 'playing')
  assert.equal(state.storyline, 'kaigyoku')
  assert.equal(state.turn, 1)
  assert.equal(state.player.name, '星守')
  assert.equal(state.player.grade, '二级')
  // 时间线进度继承自预设的穿越时间点（护卫委托是怀玉篇最开篇 → 全部未发生）
  assert.ok(Object.values(state.timeline.nodes).every((v) => v === '未发生'))
  assert.ok(state.relations['天内理子'] > 0)
  // 开局正文压着时间点处境 + 第一拍正文，且带满选项
  assert.ok(opening.narration.length >= 80)
  assert.ok(opening.choices.length >= 3)
})

test('未知预设开局被拒（返回 null 不抛异常）', () => {
  const state = blankState(makeRng(1))
  assert.equal(startPresetSession(state, 'no-such-preset'), null)
})

test('预设角色可以直接进入战斗引擎（与 token 模式同一套数值判定）', async () => {
  const { state } = localState('sn-shadow')
  const { initCombat, runRound } = await import('../server/engine/combat.js')
  const { rollEnemy } = await import('../server/engine/rolls.js')
  const enemy = rollEnemy(makeRng(3), '二级')
  enemy.technique.name = '溶骨酸雾'
  initCombat(state, makeRng(4), { mode: 'manual', enemy, reason: '测试遭遇' })
  const r = runRound(state, makeRng(5), { type: 'physical' })
  assert.ok(r.panel, '本地模式的角色必须能被战斗引擎直接结算')
  assert.ok(typeof r.panel.damage === 'number')
})

// ------------------------------------------------------------------ 回合

test('选普通选项：效果落地、节拍翻页、下一拍的选项摆上来', () => {
  const { state, opening } = localState('sn-shadow')
  const preset = presetOf('sn-shadow')
  const pick = preset.beats[0].c[0] // 「把手指收进咒具袋」
  const before = state.player.ce.cur
  const raw = localTurn(state, pick.label, makeRng(11))

  assert.equal(state.local.beat, 1, '翻到第二拍')
  assert.ok(raw.narration.includes(preset.beats[1].n.slice(0, 10)), '正文是第二拍')
  assert.deepEqual(raw.choices, preset.beats[1].c.map((c) => c.label))

  // 效果以「提议」的身份回流 —— 这里手动过一遍 postProcess 的后半段
  const prop = clampProposal(raw.proposal, state)
  applyProposal(state, prop)
  assert.ok(state.player.ce.cur < before, 'ce 消耗应已落地')
})

test('选战斗选项：挂起遭遇、不出选项；结算桥接后翻页', () => {
  const { state } = localState('sn-shadow')
  const preset = presetOf('sn-shadow')
  // 快进到第三拍（仓库），选「先打倒咒胎」
  localTurn(state, preset.beats[0].c[1].label, makeRng(1))
  localTurn(state, preset.beats[1].c[0].label, makeRng(2))
  const raw = localTurn(state, preset.beats[2].c[0].label, makeRng(3))

  assert.ok(raw.combatRequest, '战斗选项必须带回 combatRequest')
  assert.equal(raw.combatRequest.enemyName, '食骸咒胎')
  assert.equal(raw.combatRequest.enemyGrade, '二级')
  assert.equal(raw.choices.length, 0, '遭遇未结算时不摆剧情选项')
  assert.equal(state.local.beat, 2, '节拍停住等战斗')

  const bridged = localTurn(state, '（战斗已结算完毕，继续推进剧情）', makeRng(4))
  assert.equal(state.local.beat, 3, '桥接翻到最后一拍')
  assert.ok(bridged.narration.includes(preset.beats[3].n.slice(0, 10)))
})

test('自由行动：意图识别有节制地回应，两次之后故事自动翻页', () => {
  const { state, opening } = localState('sn-rose')
  const r1 = localTurn(state, '【我的行动】我观察一下操场的动静', makeRng(1))
  assert.ok(r1.narration.length >= 60)
  assert.equal(r1.choices.length, 3, '第一次自由行动后选项应重新摆出')
  assert.equal(state.local.beat, 0, '还没翻页')

  const r2 = localTurn(state, '【我的行动】再绕着仓库侦查一圈', makeRng(2))
  assert.equal(state.local.beat, 1, '第二次自由行动后翻页')
  assert.ok(r2.narration.includes(presetOf('sn-rose').beats[1].n.slice(0, 10)), '翻页正文接在行动回响后面')
})

test('对着带战斗选项的节拍写「动手」＝选了那一项', () => {
  const { state } = localState('sn-rose')
  const raw = localTurn(state, '【我的行动】直接冲进去把那只咒灵打出去', makeRng(1))
  assert.ok(raw.combatRequest, '攻击意图应触发当前拍的战斗')
  assert.equal(raw.combatRequest.enemyName, '馋指咒灵')
})

test('修炼/疗伤的静默回合：不翻页，把当前选项摆回去', () => {
  const { state } = localState('sn-shadow')
  const r = localTurn(state, '（跳过当天，进行体能训练修炼）', makeRng(1))
  assert.equal(state.local.beat, 0)
  assert.ok(r.narration.includes('体能训练'))
  assert.equal(r.choices.length, 3)

  const h = localTurn(state, '（处理身上的伤）', makeRng(2))
  assert.equal(state.local.beat, 0)
  assert.ok(h.narration.includes('伤'))
})

// ------------------------------------------------------------------ 程序化续写

test('arc 走完后进入程序化循环：先倒计时，节点当天给介入战', () => {
  const { state } = localState('sn-rose', 'story')
  const rng = makeRng(100)
  // 快进：把四拍全部走完（每拍选第一项）
  let raw = null
  for (let i = 0; i < 6 && !state.local.arcDone; i++) {
    raw = turn(state, raw ? raw.choices[0] : presetOf('sn-rose').beats[0].c[0].label, rng)
    if (raw.combatRequest) raw = turn(state, '（战斗已结算完毕，继续推进剧情）', rng)
  }
  assert.ok(state.local.arcDone, '四拍走完应进入程序化循环')

  // 程序化第一拍：预设收尾选项自带的时间推进可能恰好落在节点当天，
  // 所以第一拍要么是倒计时（还有 N 天），要么已经停在节点当天
  assert.ok(raw.recap.includes('距「') || raw.recap.includes('就是今天'),
    `程序化第一拍应是倒计时或节点当天：${raw.recap}`)

  // 反复「按兵不动」直到节点当天 —— clampProposal 的闸门保证不会转过头
  let guard = 0
  while (nextMilestone(state)?.daysLeft > 0 && guard++ < 30) {
    const r = turn(state, '按兵不动，只盯紧日期', makeRng(guard))
    assert.ok(!r.combatRequest, '倒计时拍不应触发战斗')
  }
  assert.equal(nextMilestone(state).daysLeft, 0, '时间推进必须停在节点当天')

  // 节点当天：介入选项带着节点名，postProcess 那条线会把它记进时间线。
  // 预设自带的时间推进可能越过某个节点（错过节点是引擎的合法机制），
  // 所以这里断言的是「当前里程碑」，不假设具体是哪一个。
  const day = turn(state, '按兵不动，只盯紧日期', makeRng(999))
  const intervene = day.choices.find((c) => c.includes('介入'))
  const ms = nextMilestone(state)
  assert.ok(ms && ms.daysLeft === 0, '应停在某个节点当天')
  assert.ok(intervene && intervene.includes(ms.node), `介入选项应带节点名「${ms.node}」：${day.choices.join('/')}`)

  const fight = localTurn(state, intervene, makeRng(1000))
  assert.ok(fight.combatRequest.intervention === ms.node, '介入战必须带节点名交给战斗收尾')
})

test('避开节点：那一天照旧发生，时间线记为已发生', () => {
  const { state } = localState('sn-shadow')
  const rng = makeRng(200)
  let raw = null
  for (let i = 0; i < 6 && !state.local.arcDone; i++) {
    raw = turn(state, raw ? raw.choices[0] : presetOf('sn-shadow').beats[0].c[0].label, rng)
    if (raw.combatRequest) raw = turn(state, '（战斗已结算完毕，继续推进剧情）', rng)
  }
  let guard = 0
  while (nextMilestone(state)?.daysLeft > 0 && guard++ < 40) {
    turn(state, '按兵不动，只盯紧日期', makeRng(guard))
  }
  assert.equal(nextMilestone(state)?.daysLeft, 0)
  const avoid = localTurn(state, '避开这一天，让它照旧发生', makeRng(300))
  assert.ok(avoid.proposal.flags.includes('虎杖吞手指_开始'))
  applyProposal(state, clampProposal(avoid.proposal, state))
  assert.equal(state.timeline.nodes['虎杖吞手指'], '已发生')
})

// ------------------------------------------------------------------ 战斗与修炼文案

test('localCombatNarration：按战报事实成文，两种模式都成段且不空', () => {
  const { state } = localState('sn-shadow')
  const brief = {
    敌方: '食骸咒胎（二级）',
    结果: '玩家胜',
    回合数: 7,
    玩家剩余HP占比: '62%',
    关键节点: [
      { 回合: 1, 玩家行动: '体术攻击命中，造成 340 点伤害', 敌方行动: '酸雾喷吐，造成 120 点伤害' },
      { 回合: 4, 玩家行动: '生得术式命中，造成 520 点伤害', 敌方行动: '防御' },
    ],
  }
  for (const mode of ['skip', 'narrative']) {
    const text = localCombatNarration(state, brief, mode)
    assert.ok(text.length >= 60, `${mode} 模式演出过短`)
    assert.ok(!/[0-9]+ ?点/.test(text), '演出不得复述面板数字')
    assert.ok(text.includes('62%') || text.includes('62'), '血量占比可以保留（玩家自己的状态）')
  }
})

test('localRoundNarration：从面板事实出文，空面板也有兜底句', () => {
  const { state } = localState('sn-shadow')
  const text = localRoundNarration(state, {
    beat: { player: { damage: 300, label: '生得术式', crit: true }, enemy: { damage: 0, fizzled: true } },
    enemy: { name: '食骸咒胎' },
  })
  assert.ok(text.length >= 20)
  assert.ok(text.includes('破绽') || text.includes('狠'))

  const empty = localRoundNarration(state, { beat: { player: {}, enemy: {} }, enemy: { name: '咒灵' } })
  assert.ok(empty.length >= 10, '空面板必须有兜底')
})

test('localTrainingFlavor：六项修炼都有模板，产出非空', () => {
  const { state } = localState('sn-rose')
  for (const item of ['体能训练', '咒力冥想', '术式演练', '体术实战', '反转术式修习', '领域雏形冥想']) {
    const t = localTrainingFlavor(state, item, makeRng(1))
    assert.ok(t.length >= 8, `${item} 的模板为空`)
  }
})

// ------------------------------------------------------------------ 与引擎管线的对齐

test('本地模式的提议过 clampProposal 与 token 模式同一套夹紧', () => {
  const { state } = localState('sn-mirror') // 标特级预设
  // 亡国之镜第二拍有一条 ce:-200 的选项 —— 夹紧后不得超过上限 60%
  const prop = clampProposal({ hpDelta: 0, ceDelta: -200, relationDelta: { 宿傩: 99 } }, state)
  assert.ok(Math.abs(prop.ceDelta) <= state.player.ce.max * 0.6)
  assert.equal(prop.relationDelta['宿傩'], 15, '关系值单回合夹到 ±15')
})

test('本地叙事引擎不依赖 llm 模块（无 token 消耗的静态保证）', async () => {
  const fs = await import('node:fs')
  for (const f of ['server/engine/localstory.js', 'server/engine/localpresets.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.ok(!/from '\.\.\/llm|from "\.\.\/llm|streamText|callTool|streamTool/.test(src),
      `${f} 不得引用模型客户端`)
  }
})

test('手指类效果走同一套手指账本（预设「无名指骨」的吞指选项）', () => {
  const { state } = localState('sn-finger')
  const preset = presetOf('sn-finger')
  localTurn(state, preset.beats[0].c[0].label, makeRng(1)) // 钻下水道 → 翻到第二拍
  const raw = localTurn(state, preset.beats[1].c[2].label, makeRng(2)) // 「吞下手指」
  assert.equal(raw.proposal.sukunaFingersCollectedDelta, 1)
  assert.equal(raw.proposal.sukunaFingersPlayerEatenDelta, 1)

  const ceBefore = state.player.ce.max
  applyProposal(state, clampProposal(raw.proposal, state))
  assert.ok(state.player.ce.max > ceBefore, '吞指应按第八节推高咒力上限')
  assert.equal(state.sukuna.fingersPlayerEaten, 1)
})
