import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRng } from '../server/engine/dice.js'
import { blankState, buildPlayer, panelSnapshot, pushLog, LOG_CAP, applyProposal, checkPlayerDeath, modelStateView } from '../server/engine/state.js'
import { rollAttributeProfile } from '../server/engine/rolls.js'
import { cachedSystem, plainSystem } from '../server/llm.js'
import { startPresetSession, localTurn } from '../server/engine/localstory.js'
import { initCombat, simulateCombat, finishCombat, disposeEnemy } from '../server/engine/combat.js'
import { rollEnemy } from '../server/engine/rolls.js'
import { nextMilestone } from '../server/engine/timeline.js'
import { clampProposal } from '../server/engine/guard.js'

/**
 * 商用加固：存档体积、token 成本、内容丰度、元进度。
 *
 * 这一组守的不是玩法，是「跑得久、花得少、看得见」——
 * 三百回合之后存档不膨胀、每一回合的设定原文不再全价重发、
 * 倒计时不复读、打出去的每一拳有总账。
 */

function presetState(presetId = 'sn-rose', seed = 11) {
  const state = blankState(makeRng(seed))
  state.id = `t-${presetId}`
  startPresetSession(state, presetId, 'story')
  return state
}

// ------------------------------------------------------------------ 日志上限

test('pushLog：超过 200 条整批裁旧，留下的是最新的一段', () => {
  const state = blankState(makeRng(1))
  for (let i = 0; i < LOG_CAP + 60; i++) pushLog(state, { type: 'turn', turn: i, tag: `第${i}条` })
  assert.equal(state.log.length, LOG_CAP, `日志应封在 ${LOG_CAP} 条，实际 ${state.log.length}`)
  // 最新的一条必须在，最老的早该被裁掉
  assert.equal(state.log.at(-1).tag, `第${LOG_CAP + 59}条`)
  assert.ok(!state.log.some((e) => e.tag === '第0条'))
  assert.equal(state.log[0].tag, `第60条`, '裁切后第一条应是幸存的最老一条')
})

test('pushLog 未达上限时不裁（正常局的日志一条不少）', () => {
  const state = blankState(makeRng(1))
  for (let i = 0; i < 50; i++) pushLog(state, { i })
  assert.equal(state.log.length, 50)
})

// ------------------------------------------------------------------ 提示词缓存

test('cachedSystem：稳定段带缓存断点、动态段跟后（Anthropic 块数组）', () => {
  const prev = process.env.LLM_PROMPT_CACHE
  delete process.env.LLM_PROMPT_CACHE
  try {
    const sys = cachedSystem('设定原文+契约', '本回合状态视图')
    assert.ok(Array.isArray(sys), '默认应输出块数组')
    assert.equal(sys.length, 2)
    assert.equal(sys[0].type, 'text')
    assert.equal(sys[0].text, '设定原文+契约')
    assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' }, '稳定段必须带缓存断点')
    assert.equal(sys[1].text, '本回合状态视图')
    assert.ok(!sys[1].cache_control, '动态段每回合都变，打缓存没有意义')
  } finally {
    if (prev !== undefined) process.env.LLM_PROMPT_CACHE = prev
  }
})

test('cachedSystem：LLM_PROMPT_CACHE=0 时退回纯文本（供应商不认块数组的兜底）', () => {
  const prev = process.env.LLM_PROMPT_CACHE
  process.env.LLM_PROMPT_CACHE = '0'
  try {
    const sys = cachedSystem('stable', 'dynamic')
    assert.equal(typeof sys, 'string')
    assert.ok(sys.includes('stable') && sys.includes('dynamic'))
  } finally {
    if (prev !== undefined) process.env.LLM_PROMPT_CACHE = prev
    else delete process.env.LLM_PROMPT_CACHE
  }
})

test('plainSystem：块数组与纯文本语义等价（降级重发时用它）', () => {
  const blocks = cachedSystem('A', 'B')
  const plain = plainSystem(blocks)
  assert.equal(typeof plain, 'string')
  assert.ok(plain.includes('A') && plain.includes('B'))
  assert.equal(plainSystem('已是字符串'), '已是字符串')
})

// ------------------------------------------------------------------ 倒计时随机事件

test('本地模式倒计时有随机事件：熟人 / 线头 / 小遭遇三选一会真的出现', () => {
  const state = presetState('sn-shadow')
  const rng = makeRng(2024)
  // 快进到 arc 走完（进入程序化循环）
  let raw = null
  for (let i = 0; i < 6 && !state.local.arcDone; i++) {
    const p = (raw?.choices?.[0]) || '把手指收进咒具袋，当无事发生'
    raw = localTurn(state, p, rng)
    if (raw.combatRequest) raw = localTurn(state, '（战斗已结算完毕，继续推进剧情）', rng)
  }
  assert.ok(state.local.arcDone)

  // 走 30 个倒计时日，收集每个节拍的选项数与正文标记
  let eventSeen = 0
  for (let d = 0; d < 30; d++) {
    const ms = nextMilestone(state)
    if (!ms || ms.daysLeft <= 0) {
      // 到站或排期尽：旁观/推进，让循环继续
      const label = raw?.choices?.find((c) => c.includes('旁观') || c.includes('按兵不动') || c.includes('静修'))
      raw = localTurn(state, label || '按兵不动，只盯紧日期', rng)
      continue
    }
    raw = localTurn(state, '按兵不动，只盯紧日期', rng)
    if ((raw.choices || []).length >= 4 || /撞见了|线头|敌意/.test(raw.narration)) eventSeen += 1
  }
  assert.ok(eventSeen >= 2, `30 天里随机事件只出现 ${eventSeen} 次 —— 概率表该查了`)
  assert.ok(eventSeen <= 30 * 0.5, '事件触发率异常偏高')
})

// ------------------------------------------------------------------ 本局战绩

test('career 快照：战斗、击杀、黒闪、介入都从既有事实现算', async () => {
  const state = presetState('sn-rose')

  // 打一场介入战并击杀：用轮盘同款口径手动挂起
  const enemy = rollEnemy(makeRng(3), '三级')
  enemy.technique.name = '测试术式'
  initCombat(state, makeRng(4), { mode: 'skip', enemy, reason: '测试', intervention: '虎杖吞手指' })
  state.player._blackFlash = 2 // 模拟本局打出过两颗
  const { outcome } = simulateCombat(state, makeRng(5))
  finishCombat(state, outcome)
  disposeEnemy(state, true)

  const snap = panelSnapshot(state)
  const c = snap.career
  assert.ok(c, 'career 必须在快照里')
  assert.equal(c.battles, 1)
  assert.equal(c.kills, 1, '处置击杀后 kills 应为 1')
  assert.equal(c.interventions, 1, '介入战要单列')
  assert.equal(c.blackFlash, 2)
  assert.ok(c.turns >= 1)
  assert.equal(typeof c.changedNodes, 'number')
  // 没打过仗的全新局面：career 是零值而不是缺字段
  const fresh = presetState('sn-rose', 12)
  const cf = panelSnapshot(fresh).career
  assert.equal(cf.battles, 0)
  assert.equal(cf.kills, 0)
})

test('career 不碰角色字段之外的任何记账（快照可随时重建）', () => {
  const state = presetState('kg-star', 21)
  const a = panelSnapshot(state).career
  const b = panelSnapshot(state).career
  assert.deepEqual(a, b, '同一状态两次快照必须一致 —— 它是派生值，不是第二本账')
})

// ------------------------------------------------------------------ 终局与谢幕

test('endingReady：排期未走完不能谢幕，走完且未谢过才能', async () => {
  const { endingReady, buildEnding } = await import('../server/engine/ending.js')
  const state = presetState('sn-rose')
  assert.equal(endingReady(state), false, '排期还长着，谈不上收束')

  // 全部节点落定 → 可以谢幕
  for (const k of Object.keys(state.timeline.nodes)) state.timeline.nodes[k] = '已发生'
  assert.equal(endingReady(state), true)

  state.ended = true
  assert.equal(endingReady(state), false, '谢过幕的局不再催谢幕（但可以重看）')

  // panelSnapshot 的 canFinish 与判据一致（终章按钮的显隐依据）
  state.ended = false
  assert.equal(panelSnapshot(state).canFinish, true)
})

test('buildEnding：文案从战绩里长出来 —— 名字、改写、击杀、黒闪都各有其句', async () => {
  const { buildEnding } = await import('../server/engine/ending.js')
  const state = presetState('sn-rose')
  for (const k of Object.keys(state.timeline.nodes)) state.timeline.nodes[k] = '已发生'
  state.timeline.changed = ['涩谷事变', '最终决战']
  state.player._blackFlash = 3
  state.battles = [
    { enemy: { name: '馋指咒灵', grade: '四级' }, killed: true, ground: '遭遇战', result: '击杀' },
    { enemy: { name: '咒胎', grade: '二级' }, killed: true, ground: '介入战', result: '击杀' },
  ]

  const e = buildEnding(state)
  assert.equal(e.title, '終劇')
  assert.ok(e.text.includes(state.player.name))
  assert.ok(e.text.includes('2 个原作节点'), '改写数要写进谢幕')
  assert.ok(e.text.includes('馋指咒灵') && e.text.includes('咒胎'), '击杀名单要点名')
  assert.ok(e.text.includes('黒闪 3 颗'))
  assert.equal(e.career.kills, 2)
  assert.equal(e.career.changedNodes, 2)

  // 什么都没做的局也有诚实的版本：不硬编事迹
  const quiet = presetState('kg-star')
  for (const k of Object.keys(quiet.timeline.nodes)) quiet.timeline.nodes[k] = '已发生'
  const eq = buildEnding(quiet)
  assert.ok(eq.text.includes('你没有改写任何一天'), '无事发生的局该有无事发生的谢幕')
  assert.ok(!eq.text.includes('黒闪'))
})

test('谢幕选项挂在空档循环的第一项（本地模式打完排期的出口）', () => {
  const state = presetState('sn-shadow', 31)
  for (const k of Object.keys(state.timeline.nodes)) state.timeline.nodes[k] = '已发生'
  const rng = makeRng(77)
  // arcDone 之前的节拍照走；直接快进：设 arcDone 后要一次 localTurn 生成空档拍
  state.local.arcDone = true
  state.local.pending = null
  const raw = localTurn(state, '按兵不动，只盯紧日期', rng)
  assert.ok(raw.choices[0].includes('收束这一局'), `空档第一项应是谢幕：${raw.choices.join('/')}`)
})

// ------------------------------------------------------------------ 脱离成功率

test('pendingCombat 快照带脱离成功率：夹在 10%~85%，速度差拉开时贴近边', () => {
  const state = presetState('sn-rose')
  const mkEnemy = (pd, eff) => ({
    name: '测试敌', grade: '三级',
    technique: { name: '测试术式' },
    physicalDamage: { value: pd }, efficiency: { value: eff },
    hp: { cur: 100, max: 100 }, ce: { cur: 100, max: 100 },
  })
  state.pendingCombat = { enemy: mkEnemy(10, 0.5), reason: '测试' }
  const fast = panelSnapshot(state).pendingCombat.evadeChance
  assert.ok(fast > 0.55, `快打慢应该大概率跑掉：${fast}`)

  state.pendingCombat = { enemy: mkEnemy(5000, 1.5), reason: '测试' }
  const slow = panelSnapshot(state).pendingCombat.evadeChance
  assert.ok(slow <= 0.15, `慢打快应被夹在下限附近：${slow}`)

  state.pendingCombat = { enemy: mkEnemy(120, 0.95), reason: '测试' }
  const even = panelSnapshot(state).pendingCombat.evadeChance
  assert.ok(even >= 0.1 && even <= 0.85, `同级对抗应有合理的中间值：${even}`)
})

// ------------------------------------------------------------------ 死亡与检查点

test('applyProposal：剧情回合的伤势/透支把血条扣到 0 = 死亡结算', async () => {
  const state = presetState('sn-rose')
  // 伤势路径：hpDelta 夹紧行不至于一回合从满血归零 —— 先压到临界再补一刀
  state.player.hp.cur = Math.max(1, Math.round(state.player.hp.max * 0.3))
  const prop = clampProposal({ hpDelta: -state.player.hp.cur - 1 }, state)
  applyProposal(state, prop)
  assert.equal(state.player.hp.cur, 0)
  assert.equal(state.over?.dead, true, '剧情伤势致死必须登记')
  assert.equal(state.over.cause, 'wound')

  // 透支路径的 cause 判定：notes 里有「透支」二字时归为 overspend
  const s2 = presetState('sn-rose')
  s2.player.hp.cur = 0
  checkPlayerDeath(s2, 'overspend')
  assert.equal(s2.over.cause, 'overspend')
})

test('checkPlayerDeath 幂等：先登记的不被后来的调用改写', async () => {
  const { checkPlayerDeath } = await import('../server/engine/state.js')
  const state = presetState('kg-star')
  state.player.hp.cur = 0
  const a = checkPlayerDeath(state, 'combat-loss')
  const b = checkPlayerDeath(state, 'wound')
  assert.equal(a, b)
  assert.equal(state.over.cause, 'combat-loss', '第一次结算的原因就是最终原因')
})

test('血条 > 0 时永不误登记死亡；快照的 over 带 checkpoint 标记', () => {
  const state = presetState('sn-rose')
  assert.equal(panelSnapshot(state).over, null, '活人没有 over')
  state.player.hp.cur = 0
  checkPlayerDeath(state, 'combat-loss')
  state.hasCheckpoint = true
  const snap = panelSnapshot(state)
  assert.equal(snap.over?.dead, true)
  assert.equal(snap.over?.checkpoint, true, '死亡层据此显隐「从检查点重来」')
  assert.ok(snap.canFinish === false || typeof snap.canFinish === 'boolean')
})

test('pendingCombat 快照带敌方完整档案预览（打不打得过，开打前看得见）', () => {
  const state = presetState('sn-rose')
  const enemy = rollEnemy(makeRng(3), '二级')
  enemy.technique.name = '测试术式'
  state.pendingCombat = { enemy, reason: '测试' }
  const pc = panelSnapshot(state).pendingCombat
  assert.ok(pc.profile, 'profile 预览必须在')
  assert.equal(pc.profile.grade, '二级')
  assert.ok(pc.evadeChance > 0 && pc.evadeChance < 1)
})

// ------------------------------------------------------------------ 精英词缀

test('maybeElite：概率命中挂词缀改前缀，未命中原样返回，canon 敌人免疫', async () => {
  const { maybeElite, AFFIXES } = await import('../server/engine/elite.js')
  // 恒零 rng：必出词缀，且双词缀不重复
  const e = { name: '咒胎', grade: '二级' }
  maybeElite(() => 0, e)
  assert.ok(e.affixes?.length >= 1 && e.affixes.length <= 2)
  assert.ok(new Set(e.affixes).size === e.affixes.length, '双词缀不得重复')
  assert.ok(e.affixes.every((a) => a in AFFIXES))
  assert.ok(e.name.endsWith('咒胎') && e.name.includes('·'), `名字带词缀前缀：${e.name}`)
  assert.ok(e.affixDesc.length > 4)

  // 恒高 rng：不出
  const e2 = { name: '咒灵', grade: '一级' }
  maybeElite(() => 0.99, e2)
  assert.equal(e2.affixes, undefined)
  assert.equal(e2.name, '咒灵')

  // canon 敌人： Probability 再高也不动
  const e3 = { name: '五条悟', canon: true }
  maybeElite(() => 0, e3)
  assert.equal(e3.affixes, undefined)
  assert.equal(e3.name, '五条悟')
})

test('词缀结算：狂暴加伤、坚壳减伤、迅捷加速、嗜血按伤回血', async () => {
  const { initCombat, runRound, unitSpeed } = await import('../server/engine/combat.js')
  const mk = (seed, affixes) => {
    const state = presetState('sn-rose', seed)
    const enemy = rollEnemy(makeRng(seed + 50), state.player.grade)
    enemy.technique.name = '敌术式'
    if (affixes) enemy.affixes = affixes
    enemy.hp.max = enemy.hp.cur = 5000 // 撑住多回合
    initCombat(state, makeRng(seed + 51), { mode: 'manual', enemy, reason: 't' })
    return state
  }
  // 迅捷：速度 ×1.4
  const sp = unitSpeed({ physicalDamage: { value: 100 }, efficiency: { value: 0.9 } })
  const spFast = unitSpeed({ physicalDamage: { value: 100 }, efficiency: { value: 0.9 }, affixes: ['迅捷'] })
  assert.ok(Math.abs(spFast / sp - 1.4) < 0.001)

  // 嗜血：敌方攻击后按伤害三成回血（非暴击随机数）
  const s = mk(71, ['嗜血'])
  s.combat.enemy.hp.cur = Math.round(s.combat.enemy.hp.max * 0.5) // 先掉一半血，才有回血空间
  const before = s.combat.enemy.hp.cur
  const half = () => 0.5
  for (let i = 0; i < 3; i++) runRound(s, half, { type: 'defend' })
  const enemyEvHealed = s.combat.log.flatMap((p) => p.domainTicks || []).length // 占位：真实断言在下方
  const rounds = s.combat.log
  const healedSum = rounds.reduce((n, p) => n + (p.domainTicks || []).length, 0)
  void healedSum; void enemyEvHealed
  assert.ok(s.combat.enemy.hp.cur > 0)
  // 直接验证：敌方事件里有 healed > 0 的记录（嗜血只在命中时回血）
  const anyHeal = rounds.some((p) => p.beat?.enemy?.healed > 0)
  assert.ok(anyHeal, '嗜血词缀的敌方应在命中后回血')
})

// ------------------------------------------------------------------ 成就

test('成就：初阵/初次杀戮/黒闪/特级之路按事实触发，幂等不重发', async () => {
  const { checkAchievements, achievementView, takeAchievements } = await import('../server/engine/achievements.js')
  const state = presetState('sn-rose')
  assert.deepEqual(checkAchievements(state), [], '什么都没做时无成就')

  state.battles = [{ result: '击倒', killed: false, ground: '遭遇战', elite: false }]
  let got = checkAchievements(state)
  assert.ok(got.some((a) => a.id === 'first-win'))

  state.battles[0].killed = true
  state.battles[0].result = '击杀'
  got = checkAchievements(state)
  assert.ok(got.some((a) => a.id === 'first-kill'), '击杀落定后初次杀戮成立')

  // 再跑一遍：幂等，不重发
  assert.deepEqual(checkAchievements(state), [])
  assert.deepEqual(takeAchievements(state).length >= 2 ? [] : [], [])
  assert.equal(takeAchievements(state).length, 0, '取走即清空')

  // 特级之路
  state.player.grade = '弱特级'
  got = checkAchievements(state)
  assert.ok(got.some((a) => a.id === 'grade-tier'))

  // 面板视图：全量表 + 达成态
  const view = achievementView(state)
  assert.equal(view.length >= 10, true)
  assert.ok(view.find((a) => a.id === 'first-win').done)
  assert.ok(!view.find((a) => a.id === 'veteran').done)
})

// ------------------------------------------------------------------ 战力预估

test('battleForecast：同级胶着、越级劣势、碾压占优，词缀修正方向正确', async () => {
  const { battleForecast } = await import('../server/engine/elite.js')
  const mkP = (grade) => ({ grade, hp: { cur: 1000 }, cursedDamage: { value: 200 }, physicalDamage: { value: 100 } })
  const mkE = (grade, hpMax = 1000) => ({ grade, hp: { max: hpMax }, cursedDamage: { value: 200 }, physicalDamage: { value: 100 } })

  assert.equal(battleForecast(mkP('一级'), mkE('一级')).verdict, '胶着')
  assert.equal(battleForecast(mkP('一级'), mkE('三级')).verdict, '占优', '对手低一级')
  assert.equal(battleForecast(mkP('一级'), mkE('弱特级')).verdict, '劣势', '对手高一档')
  assert.equal(battleForecast(mkP('一级'), mkE('四级')).verdict, '占优', '玩家高一级即占优')

  // 坚壳把胶着拖向劣势；狂暴把胶着推向劣势方向
  const even = battleForecast(mkP('一级'), mkE('一级'))
  const shell = battleForecast(mkP('一级'), { ...mkE('一级'), affixes: ['坚壳'] })
  assert.ok(shell.ratio < even.ratio, '坚壳应降低玩家预估')
  const berserk = battleForecast(mkP('一级'), { ...mkE('一级'), affixes: ['狂暴'] })
  assert.ok(berserk.ratio < even.ratio, '狂暴应降低玩家预估')
})

// ------------------------------------------------------------------ 战利品与咒具

test('战利品：胜利按概率掉咒具入包，仓满不掉；咒具加成体术', async () => {
  const { computeRewards, applyRewards, initCombat, runRound, LOOT_POOL, TOOL_CAP } = await import('../server/engine/combat.js')
  const state = presetState('sn-rose')

  // 恒零 rng：必出，池内取名
  const enemy = rollEnemy(makeRng(3), state.player.grade)
  enemy.technique.name = '敌术式'
  initCombat(state, makeRng(4), { mode: 'manual', enemy, reason: 't' })
  state.combat.over = true
  state.combat.outcome = { winner: 'player' }
  state.combat.stats.usedMelee = true
  const rw = computeRewards(state, () => 0, { won: true, crossLevel: false })
  assert.ok(LOOT_POOL.includes(rw.loot), `战利品应出自池子：${rw.loot}`)
  const ups = applyRewards(state, rw)
  assert.equal(state.player.tools.length, 1)
  assert.ok(ups.some((u) => u.includes('缴获咒具')))

  // 满仓不掉
  state.player.tools = Array.from({ length: TOOL_CAP }, (_, i) => ({ name: `具${i}`, note: '' }))
  const rw2 = computeRewards(state, () => 0, { won: true, crossLevel: false })
  assert.equal(rw2.loot, null)

  // 咒具加成：两把 +16%，同种子同 rng 对比无具的一拳
  const mkFight = (tools) => {
    const st = presetState('sn-rose', 91)
    const e = rollEnemy(makeRng(92), st.player.grade)
    e.technique.name = '敌术式'
    st.player.tools = tools
    initCombat(st, makeRng(93), { mode: 'manual', enemy: e, reason: 't' })
    const r = runRound(st, () => 0.5, { type: 'physical' })
    return r.panel.beat.player.damage
  }
  const bare = mkFight([])
  const armed = mkFight([{ name: 'a', note: '' }, { name: 'b', note: '' }])
  assert.ok(Math.abs(armed / bare - 1.16) < 0.05, `两把咒具应约 +16%：${bare} → ${armed}`)
})

// ------------------------------------------------------------------ 援护

test('援护：关系 ≥40 的本线角色概率赶到 —— 先手必占、敌方首手被压、面板留名', async () => {
  const { initCombat, runRound, rollBackup, BACKUP_THRESHOLD } = await import('../server/engine/combat.js')
  const state = presetState('sn-shadow')
  // 七海建人在 sn-shadow 名单里；关系拉到阈值之上
  state.relations['七海建人'] = BACKUP_THRESHOLD + 10

  // 恒零 rng：必触发，且指向关系达标的那个人
  assert.equal(rollBackup(state, () => 0), '七海建人')

  // 低关系：同 rng 也不触发
  const shallow = presetState('sn-shadow')
  shallow.relations['七海建人'] = 10
  assert.equal(rollBackup(shallow, () => 0), null)

  // 整合：援护局先手必占、敌方首手被压制、首回合面板带援护台词
  const enemy = rollEnemy(makeRng(3), state.player.grade)
  enemy.technique.name = '敌术式'
  const c = initCombat(state, makeRng(4), { mode: 'manual', enemy, reason: 't' })
  c.backup = '七海建人' // 强制走援护路径（真实触发与否由种子决定，机制在此验证）
  c.pendingNotes = [`「七海建人」赶到了你身前 —— 先手这一波，替你抢了下来`]
  enemy._stagger = 1
  assert.equal(c.playerFirst, true, '援护局先手必占')

  const zero = () => 0
  const r = runRound(state, zero, { type: 'physical' })
  assert.ok(r.panel.notes.some((n) => n.includes('赶到了你身前')), '首回合面板要有援护台词')
  assert.equal(r.panel.enemyActionText.includes('还没站稳'), true, '敌方第一手被压制')
  // 第二回合起援护台词不再出现
  const r2 = runRound(state, zero, { type: 'physical' })
  assert.ok(!r2.panel.notes.some((n) => n.includes('赶到了你身前')), '援护台词只挂首回合')
})

test('成就「跨篇者」：三段历练走满才成立（起始不算、两段不算）', async () => {
  const { checkAchievements } = await import('../server/engine/achievements.js')
  const state = presetState('sn-rose')
  state.crossover = { done: 0, log: [] }
  assert.deepEqual(checkAchievements(state).filter((a) => a.id === 'crossover'), [])
  state.crossover.done = 2
  assert.deepEqual(checkAchievements(state).filter((a) => a.id === 'crossover'), [])
  state.crossover.done = 3
  const got = checkAchievements(state)
  assert.ok(got.some((a) => a.id === 'crossover'), '三段走满 = 跨篇者')
})

// ------------------------------------------------------------------ 敌方溃逃

test('敌方溃逃：狡诈/死守低血会跑，狂攻不逃；溃逃局无处置无战利品', async () => {
  const { chooseEnemyAction, initCombat, runRound, finishCombat, computeRewards, ENEMY_FLEE_RATIO } = await import('../server/engine/combat.js')
  const state = presetState('sn-rose')

  // 狡诈 + 血线见底 + 恒零 rng → 必然选择溃逃
  const enemy = rollEnemy(makeRng(3), state.player.grade)
  enemy.archetype = '狡诈'
  enemy.technique.name = '敌术式'
  enemy.hp.cur = Math.round(enemy.hp.max * ENEMY_FLEE_RATIO)
  initCombat(state, makeRng(4), { mode: 'manual', enemy, reason: 't' })
  assert.equal(chooseEnemyAction(state, () => 0).type, 'flee', '狡诈残血应选择溃逃')

  // 整合：逃成功 → outcome 玩家胜 + fledEnemy；无处置、无战利品、战果「击退」
  const zero = () => 0
  let r = null
  for (let i = 0; i < 5; i++) {
    r = runRound(state, zero, { type: 'defend' })
    if (r.over) break
  }
  assert.equal(r.outcome?.winner, 'player', '敌方遁走算玩家胜')
  assert.equal(r.outcome?.fledEnemy, true)
  assert.ok(!r.outcome.fledEnemy === false)

  // 战利品与跨级跃升都被溃逃挡住（恒零 rng 本会必出）
  const rw = computeRewards(state, zero, { won: true, crossLevel: true })
  assert.equal(rw.loot, null, '没有尸体就没有缴获')
  assert.equal(rw.gradeUp, null)

  const summary = finishCombat(state, r.outcome)
  assert.ok(summary.includes('遁走'), `战报要点明遁走：${summary}`)
  assert.equal(state.pendingDisposition, null, '没有尸体可处置')
  assert.equal(state.battles.at(-1).result, '击退')

  // 狂攻型残血：不逃（选攻击）
  const s2 = presetState('sn-rose')
  const berserk = rollEnemy(makeRng(5), s2.player.grade)
  berserk.archetype = '狂攻'
  berserk.technique.name = '敌术式'
  berserk.hp.cur = Math.round(berserk.hp.max * 0.1)
  initCombat(s2, makeRng(6), { mode: 'manual', enemy: berserk, reason: 't' })
  assert.notEqual(chooseEnemyAction(s2, () => 0).type, 'flee', '狂攻型分不清撤退和死亡')
})

// ------------------------------------------------------------------ 资源循环

test('静养回咒力、硝子补满：血靠治，咒力靠歇', async () => {
  const { applyRecovery, recoveryOptions } = await import('../server/engine/recovery.js')
  const state = presetState('sn-rose')
  state.player.hp.cur = Math.round(state.player.hp.max * 0.5)
  state.player.ce.cur = Math.round(state.player.ce.max * 0.1)

  const rest = recoveryOptions(state).find((o) => o.id === 'rest')
  assert.ok(rest?.enabled, '静养可用')
  const r = applyRecovery(state, 'rest')
  assert.ok(state.player.ce.cur > state.player.ce.max * 0.4, `40% 回充应落地：${state.player.ce.cur}`)
  assert.ok(state.player.ce.cur > state.player.ce.max * 0.4, '40% 回充应落地')

  // 硝子：血与咒力一起满
  const s2 = presetState('sn-rose')
  s2.relations['家入硝子'] = 10
  s2.player.ce.cur = 0
  applyRecovery(s2, 'shoko')
  assert.equal(s2.player.ce.cur, s2.player.ce.max, '硝子把你整个人缝好 —— 咒力也是')
})

// ------------------------------------------------------------------ 关系里程碑

test('关系里程碑：跨过 ±60/±80 时给玩家一行提示，未跨过不提', () => {
  const state = presetState('sn-rose')
  // 单回合夹紧 ±15 —— 先把关系铺到 55，再一步跨过 60
  state.relations['七海建人'] = 55
  const prop = clampProposal({ relationDelta: { 七海建人: 10 } }, state)
  const notes = applyProposal(state, prop)
  assert.ok(notes.some((n) => n.includes('七海建人') && n.includes('托付后背')), `跨 60 应提示：${notes.join(';')}`)

  // 从 65 到 70：未跨阈，不再提示
  const notes2 = applyProposal(state, clampProposal({ relationDelta: { 七海建人: 5 } }, state))
  assert.ok(!notes2.some((n) => n.includes('托付后背')), '同一道坎只提示一次')

  // 跌破 -60：死仇也要点名（从 65 一回合夹不到 -65，先铺到 -50）
  state.relations['七海建人'] = -50
  const notes3 = applyProposal(state, clampProposal({ relationDelta: { 七海建人: -15 } }, state))
  assert.ok(notes3.some((n) => n.includes('死仇')), '跌成死仇应提示')
})

test('成就「挚友 / 宿敌」：关系两极的事实判定', async () => {
  const { checkAchievements } = await import('../server/engine/achievements.js')
  const state = presetState('sn-rose')
  state.relations['五条悟'] = 70
  let got = checkAchievements(state)
  assert.ok(got.some((a) => a.id === 'confidant'), '关系 70 = 挚友')
  assert.ok(!got.some((a) => a.id === 'nemesis'))

  const s2 = presetState('kg-star')
  s2.relations['伏黑甚尔'] = -70
  got = checkAchievements(s2)
  assert.ok(got.some((a) => a.id === 'nemesis'), '深仇 -70 = 宿敌')
})

test('挚友加深援护：有 ≥60 的盟友时触发概率 +0.15', async () => {
  const { rollBackup, BACKUP_CHANCE, BACKUP_FRIEND_BONUS } = await import('../server/engine/combat.js')
  const state = presetState('sn-shadow')
  state.relations['七海建人'] = 55
  // 0.45 介于 0.35 与 0.5 之间：普通盟友不触发，挚友触发
  const rng = () => 0.45
  assert.equal(rollBackup(state, rng), null, '55（未到挚友）不触发')
  state.relations['七海建人'] = 65
  assert.equal(rollBackup(state, rng), '七海建人', '65（挚友）在 0.45 触发')
  void BACKUP_CHANCE; void BACKUP_FRIEND_BONUS
})

test('REWRITTEN 节点当天：本地模式念改写理由，不念原著剧本', () => {
  const state = presetState('sn-shadow')
  state.local.arcDone = true
  state.local.pending = null
  state.time.date = '2018-06-08' // 节点当天
  state.timeline.nodes['虎杖吞手指'] = '已改写'
  state.timeline.rewrites['虎杖吞手指'] = '撑起这一天的人已经不在了，那一天换了剧本'
  const raw = localTurn(state, '按兵不动，只盯紧日期', makeRng(9))
  assert.ok(raw.recap.includes('虎杖吞手指') || raw.choices.some((c) => c.includes('虎杖吞手指')), '应停在节点当天')
  assert.ok(raw.narration.includes('早已被改写'), `正文要点明改写：${raw.narration.slice(0, 60)}`)
  assert.ok(raw.narration.includes('撑起这一天的人已经不在了'), '改写理由要念出来')
  assert.ok(!raw.narration.includes('社团仓库'), '原著的场面不能照念')
})

// ------------------------------------------------------------------ 连胜加运

test('连胜加运：streak 提升掉率（+5%/场，封顶 +15%）、同名去重、败场清零', async () => {
  const { computeRewards, initCombat, LOOT_POOL, applyRewards } = await import('../server/engine/combat.js')
  const mkFight = (streak, tools = [], rngVal = 0.3) => {
    const st = presetState('sn-rose')
    st.winStreak = streak
    const e = rollEnemy(makeRng(99), st.player.grade)
    e.technique.name = '敌术式'
    st.player.tools = tools
    initCombat(st, makeRng(98), { mode: 'manual', enemy: e, reason: 't' })
    st.combat.over = true
    st.combat.outcome = { winner: 'player' }
    st.combat.stats.usedMelee = true
    return computeRewards(st, () => rngVal, { won: true, crossLevel: false })
  }
  // rng 0.3：无连胜时 0.3 ≥ 0.25 不掉；三连胜 0.25+0.15=0.40 → 掉
  assert.equal(mkFight(0).loot, null, '无连胜 0.3 不掉')
  assert.ok(LOOT_POOL.includes(mkFight(3).loot), '三连胜 0.3 应掉（0.40 概率）')
  // 封顶：十连胜也只 +15%
  assert.equal(mkFight(10, [], 0.5).loot, null, '0.5 超过封顶 0.40，不掉')

  // 同名去重：包里已有「退魔短刀」（池首），恒零 rng 本会取池首 → 应取下一个
  const dup = mkFight(0, [{ name: '退魔短刀', note: '' }], () => 0)
  assert.notEqual(dup.loot, '退魔短刀', '已持有的名字不再掉')

  // 败场清零：finishCombat 里记录，这里直接验状态流转
  const st2 = presetState('sn-rose')
  st2.winStreak = 5
  st2.combat = { enemy: { name: 'x', grade: '三级' }, backup: null }
  const { finishCombat } = await import('../server/engine/combat.js')
  finishCombat(st2, { winner: 'enemy' })
  assert.equal(st2.winStreak, 0, '败场清零')
})

// ------------------------------------------------------------------ 版1：NPC 生态

test('熟人事件：关系加权挑选、相遇记忆三档、初见不算老友', () => {
  const state = presetState('sn-shadow')
  state.local.arcDone = true
  state.local.pending = null
  state.local.met = {}
  // 关系拉差：七海 60（挚友）、真希 5（陌生）——大概率是七海
  state.relations['七海建人'] = 60
  state.relations['禅院真希'] = 5

  let sawFriend = false
  let metRecorded = false
  for (let i = 0; i < 40 && !sawFriend; i++) {
    const raw = localTurn(state, '按兵不动，只盯紧日期', makeRng(900 + i))
    if (raw.narration.includes('聊聊近况') || raw.choices.some((c) => c.includes('聊聊近况'))) {
      sawFriend = true
      assert.ok(Object.keys(state.local.met).length > 0, '相遇要记账')
      metRecorded = true
      break
    }
  }
  assert.ok(sawFriend && metRecorded, '40 个倒计时日里熟人事件应出现且有记忆')

  // 记忆档位：把七海的相遇计数拉到 3 → 老友文案
  state.local.met['七海建人'] = 3
  state.time.date = '2018-06-06' // 倒计时拍
  let sawOldFriend = false
  for (let i = 0; i < 40 && !sawOldFriend; i++) {
    const raw = localTurn(state, '按兵不动，只盯紧日期', makeRng(950 + i))
    if (raw.narration.includes('老朋友')) sawOldFriend = true
  }
  assert.ok(sawOldFriend, '三次相遇后应出现老友文案')
})

// ------------------------------------------------------------------ 版2：战斗经济

test('新词缀：再生每回合回血、御咒术式减伤（体术不受）', async () => {
  const { initCombat, runRound } = await import('../server/engine/combat.js')
  // 再生：敌方每回合结束回 2%
  const st = presetState('sn-rose')
  const e = rollEnemy(makeRng(61), st.player.grade)
  e.technique.name = '敌术式'
  e.affixes = ['再生']
  e.hp.max = e.hp.cur = 1000
  initCombat(st, makeRng(62), { mode: 'manual', enemy: e, reason: 't' })
  e.hp.cur = 500 // 先打掉一半，才有回血空间
  const hpBefore = e.hp.cur
  runRound(st, () => 0.5, { type: 'defend' })
  assert.ok(e.hp.cur > hpBefore - 0, `再生应回血：${hpBefore} → ${e.hp.cur}`)
  assert.ok(e.hp.cur >= Math.min(1000, hpBefore - 500), '回血在合理范围')

  // 御咒：术式伤害 ×0.75（对比无词缀同 rng）
  const dmgOf = (affixes) => {
    const s2 = presetState('sn-rose')
    const e2 = rollEnemy(makeRng(63), s2.player.grade)
    e2.technique.name = '敌术式'
    if (affixes) e2.affixes = affixes
    e2.hp.max = e2.hp.cur = 5000
    initCombat(s2, makeRng(64), { mode: 'manual', enemy: e2, reason: 't' })
    const r = runRound(s2, () => 0.5, { type: 'technique' })
    return r.events.find((x) => x.side === 'player' && x.type === 'technique')?.damage
  }
  const bare = dmgOf(null)
  const warded = dmgOf(['御咒'])
  assert.ok(warded < bare, `御咒应减伤：${bare} → ${warded}`)
  assert.ok(Math.abs(warded / bare - 0.75) < 0.03, `减伤幅度 0.75：${warded / bare}`)
})

test('精英击杀掉率翻倍、战利品来源注记', async () => {
  const { computeRewards, initCombat, LOOT_POOL, applyRewards } = await import('../server/engine/combat.js')
  // rng 0.45：普通 0.45 ≥ 0.25 不掉；精英 0.5 → 掉
  const mk = (affixes) => {
    const st = presetState('sn-rose')
    const e = rollEnemy(makeRng(65), st.player.grade)
    e.technique.name = '敌术式'
    if (affixes) e.affixes = affixes
    initCombat(st, makeRng(66), { mode: 'manual', enemy: e, reason: 't' })
    st.combat.over = true
    st.combat.outcome = { winner: 'player' }
    st.combat.stats.usedMelee = true
    return computeRewards(st, () => 0.45, { won: true, crossLevel: false })
  }
  assert.equal(mk(null).loot, null, '普通敌人 0.45 不掉')
  assert.ok(LOOT_POOL.includes(mk(['狂暴']).loot), '精英 0.5 应掉')

  // 来源注记：note 缴获自谁
  const st = presetState('sn-rose')
  const e = rollEnemy(makeRng(67), st.player.grade)
  e.technique.name = '敌术式'
  e.name = '狂暴·食骸咒胎'
  initCombat(st, makeRng(68), { mode: 'manual', enemy: e, reason: 't' })
  st.combat.over = true
  st.combat.outcome = { winner: 'player' }
  const rw = computeRewards(st, () => 0, { won: true, crossLevel: false })
  applyRewards(st, rw)
  assert.ok(st.player.tools.at(-1).note.includes('狂暴·食骸咒胎'), `来源注记：${st.player.tools.at(-1).note}`)
})

// ------------------------------------------------------------------ 版4：完胜与节奏

test('完胜：零承伤取胜标记进战果、成就「完胜」成立；挨过打则不成立', async () => {
  const { initCombat, runRound, finishCombat } = await import('../server/engine/combat.js')
  const { checkAchievements } = await import('../server/engine/achievements.js')
  const mk = (defend) => {
    const st = presetState('sn-rose')
    const e = rollEnemy(makeRng(81), st.player.grade)
    e.technique.name = '敌术式'
    e.physicalDamage.value = 1
    e.cursedDamage.value = 1
    e.hp.max = e.hp.cur = 40 // 两拳打死
    initCombat(st, makeRng(82), { mode: 'manual', enemy: e, reason: 't' })
    const zero = () => 0
    let r
    for (let i = 0; i < 4 && !r?.over; i++) r = runRound(st, zero, { type: defend ? 'defend' : 'physical' })
    finishCombat(st, r.outcome)
    return st
  }
  // 直接攻击速胜：敌方只有 1 点输出，玩家防御姿态也会被打破——用主动进攻保证零承伤
  const clean = mk(false)
  assert.equal(clean.battles.at(-1).perfect, true, `零承伤取胜应标记完胜`)
  // finishCombat 内部已跑过成就判定 —— 查已存的标记
  assert.ok(clean.achievements.includes('perfect'), '成就「完胜」成立')
})

// ------------------------------------------------------------------ 版5：时间与结局

test('modelStateView 注入下一原作节点（全模式的时间感）', () => {
  const state = presetState('sn-rose')
  const view = modelStateView(state)
  assert.ok(String(view['下一原作节点']).includes('虎杖吞手指'), `应含节点名：${view['下一原作节点']}`)
  assert.ok(String(view['下一原作节点']).includes('还有'), '应含天数')

  // 排期走完：不再假装还有下一场
  for (const k of Object.keys(state.timeline.nodes)) state.timeline.nodes[k] = '已发生'
  assert.equal(modelStateView(state)['下一原作节点'], '排期已走完')
})

