import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRng } from '../server/engine/dice.js'
import { rollAttributeProfile, rollIdentity, rollEnemy } from '../server/engine/rolls.js'
import { blankState, buildPlayer } from '../server/engine/state.js'
import { initCombat, runRound, chooseEnemyAction, buildPanel } from '../server/engine/combat.js'
import {
  DOMAIN_TYPES, DOMAIN_TYPE_DEFAULT, DOMAIN_KIT,
  rollDomainType, domainTypeOf, normalizeDomainType, defaultDomainTypeFor,
  domainKit, domainBrief, sealOf, domainOpenEffects, domainTickEffects, domainOpenLines,
} from '../server/engine/domains.js'

/*
 * 领域分型之前，三种领域共用同一套数值 —— "开了领域"和"掉血"是同一件事，
 * 抽到哪个领域都一样。这一组测试盯的就是分型之后有没有真的分出差别：
 * 伤害型要打得出伤害、规则型要封得住东西、增益型要回得上血，
 * 而且**没有一种类型是开了没反应的**。
 */

// ------------------------------------------------------------------ 纯函数

test('三种类型都认识，不认识的一律当伤害型', () => {
  for (const t of DOMAIN_TYPES) {
    assert.equal(domainTypeOf({ type: t }), t)
    assert.equal(normalizeDomainType(t), t)
  }
  // 老存档（没有 type）、模型瞎写、整个领域对象都没有
  for (const bad of [undefined, null, '', '攻击型', 'Damage', 0, {}]) {
    assert.equal(domainTypeOf(bad), DOMAIN_TYPE_DEFAULT)
    assert.equal(domainTypeOf({ type: bad }), DOMAIN_TYPE_DEFAULT)
  }
  assert.equal(domainTypeOf(undefined), '伤害型', '没有类型的老存档必须仍然打得出伤害')
  assert.equal(normalizeDomainType('攻击型'), '', '归一化要能区分"没填"和"填错了"')
})

test('玩家侧兜底类型跟着领域强度名走', () => {
  assert.equal(defaultDomainTypeFor('规则级领域'), '规则型')
  assert.equal(defaultDomainTypeFor('概念级领域'), '规则型')
  assert.equal(defaultDomainTypeFor('半成品'), '伤害型')
  assert.equal(defaultDomainTypeFor('完整领域'), '伤害型')
  assert.equal(defaultDomainTypeFor(undefined), '伤害型')
})

test('掷领域类型：三型都出得来，且和等级名对得上', () => {
  const rng = makeRng(4)
  const tally = {}
  const N = 30000
  for (let i = 0; i < N; i++) {
    const t = rollDomainType(rng, '完整领域')
    assert.ok(DOMAIN_TYPES.includes(t), `掷出了不认识的类型：${t}`)
    tally[t] = (tally[t] || 0) + 1
  }
  for (const t of DOMAIN_TYPES) assert.ok(tally[t] > N * 0.15, `${t} 几乎掷不出来：${tally[t]}`)

  // 半成品多半是伤害型，规则级领域多半是规则型 —— 名字和打法不能对不上
  const count = (tier, want) => {
    const r = makeRng(9)
    let n = 0
    for (let i = 0; i < 4000; i++) if (rollDomainType(r, tier) === want) n++
    return n / 4000
  }
  assert.ok(count('半成品', '伤害型') > 0.5, '半成品该以伤害型为主')
  assert.ok(count('规则级领域', '规则型') > 0.4, '「规则级领域」该以规则型为主')
  assert.ok(count('半成品', '规则型') < 0.2, '半成品不该动不动就封人')
})

test('每一型都至少有一件"开了会发生的事"', () => {
  for (const t of DOMAIN_TYPES) {
    const kit = DOMAIN_KIT[t]
    const actsOnOpen = kit.burst > 0 || kit.openHealRatio > 0 || kit.seal
    const actsPerTurn = kit.tick > 0 || kit.tickHealRatio > 0
    assert.ok(actsOnOpen, `${t} 展开当回合什么都不做`)
    // 增益型只有展开那一口，可以没有每回合效果；另外两型必须有
    if (t !== '增益型') assert.ok(actsPerTurn, `${t} 展开之后每回合什么都不做`)
  }
})

test('伤害型打得最疼，规则型封得最全，增益型回得最多', () => {
  const unit = (type, { hp = 0.5 } = {}) => ({
    domain: { unlocked: true, active: false, type, cost: 10, grade: '标特级' },
    hp: { cur: Math.round(1000 * hp), max: 1000 },
    ce: { cur: Math.round(500 * hp), max: 500 },
    cursedDamage: { value: 200 },
  })

  const dmg = domainOpenEffects(unit('伤害型', { hp: 1 }))
  const rule = domainOpenEffects(unit('规则型', { hp: 1 }))
  const buff = domainOpenEffects(unit('增益型', { hp: 0.5 }))

  assert.ok(dmg.burst > rule.burst * 3, '伤害型展开那一击必须比规则型重得多')
  assert.ok(dmg.burst > 0 && dmg.sureHit, '伤害型是无视防御的必中重击')
  assert.equal(dmg.heal, 0, '伤害型不回血')
  assert.equal(rule.heal, 0, '规则型不回血')
  assert.equal(buff.burst, 0, '增益型不直接打伤害')
  assert.ok(buff.heal > 0 && buff.ce > 0, '增益型展开当回合要回血回咒力')
  assert.deepEqual(domainOpenLines(dmg).length > 0, true)
})

test('规则型封锁术式/反转术式/领域/防御，另外两型不封', () => {
  const foe = (type, active = true) => ({ domain: { unlocked: true, active, type, cost: 1 } })
  const me = { domain: { unlocked: true, active: false } }

  const s = sealOf(me, foe('规则型'))
  assert.ok(s && s.technique && s.reverse && s.domain && s.defense, '规则型该封住这四样')
  assert.ok(s.damageMul > 0 && s.damageMul < 1, '规则型还该压低对方的输出')

  assert.equal(sealOf(me, foe('伤害型')), null, '伤害型不封招')
  assert.equal(sealOf(me, foe('增益型')), null, '增益型不封招')
  assert.equal(sealOf(me, foe('规则型', false)), null, '领域没开着就不该封人')
  assert.equal(sealOf(me, { domain: { unlocked: true } }), null)
  assert.equal(sealOf(me, undefined), null)
})

test('每回合效果：伤害型追斩、增益型续航、满状态时那条事件干脆不出现', () => {
  const power = () => 200
  const unit = (type, hpRatio, ceRatio) => ({
    domain: { unlocked: true, active: true, type, cost: 1, grade: '标特级' },
    hp: { cur: Math.round(1000 * hpRatio), max: 1000 },
    ce: { cur: Math.round(500 * ceRatio), max: 500 },
    cursedDamage: { value: power() },
  })

  const hit = domainTickEffects(unit('伤害型', 1, 1), {})
  assert.ok(hit.damage > 0, '伤害型展开之后每回合都要继续咬')
  assert.equal(hit.heal, 0)

  const heal = domainTickEffects(unit('增益型', 0.4, 0.4), {})
  assert.ok(heal.heal > 0 && heal.ce > 0, '增益型每回合续着回')

  const full = domainTickEffects(unit('增益型', 1, 1), {})
  assert.equal(full, null, '血和咒力都是满的，不该凭空冒出一条"回复 0 点"')

  const rule = domainTickEffects(unit('规则型', 1, 1), {})
  assert.ok(rule.damage > 0, '规则型也该有一点持续压制')
  assert.ok(rule.damage < hit.damage, '规则型的持续压制应当明显轻于伤害型')
})

test('展开旁白不带人称 —— 它会同时落在两边的栏里', () => {
  const lines = domainOpenLines(domainOpenEffects({
    domain: { unlocked: true, active: false, type: '伤害型', cost: 1, grade: '标特级' },
    hp: { cur: 100, max: 100 }, ce: { cur: 100, max: 100 }, cursedDamage: { value: 100 },
  }))
  assert.ok(lines.length)
  for (const l of lines) {
    assert.ok(!/^你|^它|^他|^我/.test(l), `旁白带了主语：${l}`)
  }
})

test('领域标签只在有领域时给', () => {
  assert.equal(domainBrief({ unlocked: false }), '')
  assert.equal(domainBrief(null), '')
  assert.match(domainBrief({ unlocked: true, type: '规则型' }), /规则型/)
  assert.match(domainBrief({ active: true, type: '增益型' }), /增益型/)
  // 没有 type 的老领域：标签也得给出来，而且指向伤害型那套机制
  assert.equal(domainKit({ unlocked: true }), domainKit({ unlocked: true, type: '伤害型' }))
})

test('领域强度名与领域的搭配不会被改坏（回归）', () => {
  // 这几条是界面和 prompt 都在引用的字面量，改名要一起改
  assert.deepEqual(DOMAIN_TYPES, ['伤害型', '规则型', '增益型'])
  assert.equal(DOMAIN_TYPE_DEFAULT, '伤害型')
})

// ------------------------------------------------------------------ 引擎

function makeState(rngSeed = 11) {
  const s = blankState(makeRng(rngSeed))
  const a = rollAttributeProfile(makeRng(rngSeed + 1), 'A')
  a.overallGrade = '标特级'
  /*
   * domainUnlocked 是掷出来那一刻按原始等级定死的，override overallGrade
   * 不会把它带上来 —— 忘了这一句，玩家就是个"没有领域的人"，
   * 所有领域测试都会变成在测"动作落空"。
   */
  a.domainUnlocked = true
  Object.assign(a, {
    techniqueName: '测试术式',
    techniqueEffect: '测试用',
    techniqueCooldown: 2,
    talents: [],
    playstyle: '',
    domain: {
      unlocked: true, name: '测试领域', sureHit: '必中效果', cost: '', tierName: '完整领域',
    },
  })
  const id = rollIdentity(makeRng(rngSeed + 2), '甲', '自由派')
  Object.assign(id, {
    name: '测试者', background: 'b', mainlineRelation: 'm', openingSituation: 'o', hook: 'h',
  })
  s.player = buildPlayer(a, a, id, id)
  s.relations = id.initialRelations
  return s
}

/** 把玩家和敌人的领域都改成指定类型，并让玩家先手（测试要可复现） */
function makeFight(playerType = '伤害型', enemyType = '伤害型', { enemyHpRatio = 1 } = {}) {
  const s = makeState()
  s.player.domain.type = playerType
  s.player.hp.cur = s.player.hp.max
  s.player.ce.cur = s.player.ce.max

  const enemy = rollEnemy(makeRng(21), '标特级')
  enemy.domain = {
    unlocked: true, name: '对方领域', sureHit: '', cost: Math.round(enemy.ce.max * 0.08),
    grade: '标特级', tierName: '完整领域', active: false, turnsLeft: 0, type: enemyType,
  }
  enemy.hp.cur = Math.max(1, Math.round(enemy.hp.max * enemyHpRatio))
  enemy.ce.cur = enemy.ce.max

  initCombat(s, makeRng(31), { mode: 'manual', enemy, reason: '测试' })
  s.combat.playerFirst = true
  return s
}

const domainEvent = (events) => events.find((x) => x.side === 'player' && x.type === 'domain')

/**
 * 把双方血量堆到这一场打不完。
 *
 * 标特级的领域爆发是"两发术式"级别的数字，双方都是一击秒杀的量级 ——
 * 不这么做的话，想观察"第 2 回合的追斩"时会先看到战斗已经结束。
 */
function immortal(s) {
  for (const u of [s.player, s.combat.enemy]) {
    u.hp.max = 1e6
    u.hp.cur = 1e6
  }
  return s
}

test('玩家展开领域：三种类型打出三种结果', () => {
  const dmg = makeFight('伤害型', '伤害型')
  const dmgEv = domainEvent(runRound(dmg, makeRng(41), { type: 'domain' }).events)
  assert.ok(dmgEv?.domainOpened, '伤害型领域该开起来')
  assert.equal(dmgEv.domainType, '伤害型')
  assert.ok(dmgEv.damage > 0, '伤害型展开当回合必须掉血')
  assert.ok(dmgEv.sureHitBurst, '这一下要标成必中重击，界面才有得演')
  assert.equal(dmgEv.healed || 0, 0)

  const rule = makeFight('规则型', '伤害型')
  const ruleEv = domainEvent(runRound(rule, makeRng(41), { type: 'domain' }).events)
  assert.equal(ruleEv.domainType, '规则型')
  assert.ok(ruleEv.damage > 0 && ruleEv.damage < dmgEv.damage, '规则型展开那一下该轻得多')
  assert.ok(ruleEv.lines.some((l) => l.includes('规则')), '旁白要讲清楚规则被改写了')

  const buff = immortal(makeFight('增益型', '伤害型'))
  buff.player.hp.cur = 400000
  buff.player.ce.cur = Math.round(buff.player.ce.max * 0.4)
  // 对面这一回合动不了，血条的变化就只可能来自领域那一口
  buff.combat.enemy._stagger = 1
  const before = { hp: buff.player.hp.cur, ce: buff.player.ce.cur }
  const buffEv = domainEvent(runRound(buff, makeRng(41), { type: 'domain' }).events)
  assert.equal(buffEv.domainType, '增益型')
  assert.equal(buffEv.damage || 0, 0, '增益型不该顺手打伤害')
  assert.ok(buffEv.healed > 0 && buffEv.recovered > 0, '增益型展开当回合要回血回咒力')
  assert.ok(buff.player.hp.cur > before.hp, '回的血要真的落在身上')
})

test('老存档/模型没填类型：领域照样打得出伤害', () => {
  const s = makeFight('伤害型', '伤害型')
  delete s.player.domain.type // 分型之前存下来的进度
  const ev = domainEvent(runRound(s, makeRng(43), { type: 'domain' }).events)
  assert.equal(ev.domainType, '伤害型', '没有类型时的兜底必须是"开了会掉血"的那一型')
  assert.ok(ev.damage > 0)
})

test('领域展开之后每回合继续落效果，修好的是"开完就没了"', () => {
  const s = immortal(makeFight('伤害型', '伤害型'))
  runRound(s, makeRng(44), { type: 'domain' }) // 第 1 回合：展开
  const hpAfterOpen = s.combat.enemy.hp.cur
  const r2 = runRound(s, makeRng(45), { type: 'physical' })
  const tick = r2.events.find((x) => x.domainTick)
  assert.ok(tick, '展开期间每回合都要有一条领域事件')
  assert.equal(tick.side, 'player')
  assert.ok(tick.damage > 0)
  assert.ok(s.combat.enemy.hp.cur < hpAfterOpen, '追斩要真的扣在对面身上')

  // 面板要带上这一条，界面才能演出"领域还在咬"
  assert.equal(r2.panel.domainTicks.length, 1)
  assert.equal(r2.panel.domainTicks[0].damage, tick.damage)
  assert.equal(r2.panel.domainState.player.active, true)
  assert.equal(r2.panel.domainState.player.type, '伤害型')
})

test('对面已经倒了就不再追斩 —— 不然面板上会出现"尸体又掉血"', () => {
  const s = immortal(makeFight('伤害型', '伤害型'))
  runRound(s, makeRng(46), { type: 'domain' })
  assert.ok(s.combat.enemy.hp.cur > 0, '第 1 回合还不该死')

  // 把它按到 1 血、堵死它能给自己加血的路，然后打到它倒下为止
  s.combat.enemy.hp.cur = 1
  s.combat.enemy.reverseCursedTechnique = { level: '未掌握', progress: 0 }
  let killing = null
  for (let i = 0; i < 10 && !killing; i++) {
    s.player._stagger = 0 // 别让"被压回去"插进来打乱这一测
    const r = runRound(s, makeRng(47 + i), { type: 'technique' })
    if (s.combat.enemy.hp.cur <= 0) killing = r
  }
  assert.ok(killing, '十回合内该把它打死')
  assert.ok(!killing.events.some((x) => x.domainTick),
    '对面已经倒了还在追斩 —— 面板上会出现"尸体又掉血"')
})

test('规则型领域：玩家的术式、反转术式、防御全被封住', () => {
  const s = makeFight('伤害型', '规则型')
  // 对面先把规则铺开
  s.combat.enemy.domain.active = true
  s.combat.enemy.domain.turnsLeft = 5

  const tech = runRound(s, makeRng(48), { type: 'technique' }).events
    .find((x) => x.side === 'player')
  assert.equal(tech.type, 'technique')
  assert.equal(tech.damage || 0, 0, '被封住的术式不该打出伤害')
  assert.ok(tech.lines.some((l) => l.includes('封')), '要讲清楚为什么没打出去')

  const s2 = immortal(makeFight('伤害型', '规则型'))
  s2.combat.enemy.domain.active = true
  s2.player.hp.cur = Math.round(s2.player.hp.max * 0.2)
  s2.player.reverseCursedTechnique = { level: '熟练', progress: 100 }
  // 让对面这一回合动不了，血条的变化就只可能来自那一发反转术式
  s2.combat.enemy._stagger = 1
  const before = { hp: s2.player.hp.cur, ce: s2.player.ce.cur }
  const rev = runRound(s2, makeRng(49), { type: 'reverse' }).events
    .find((x) => x.side === 'player')
  assert.equal(rev.healed || 0, 0)
  assert.ok(rev.lines.some((l) => /禁止治疗|封/.test(l)), '要讲清楚为什么治不了')
  /*
   * 只可能往下走：对面的规则型领域每回合还在咬（这一回合掉的是它）。
   * 要是那一发反转术式偷偷生效了，血条会往上跳一大截 —— 这里就是那份保险。
   */
  assert.ok(s2.player.hp.cur <= before.hp, '被封住的反转术式不该偷偷把血加上去')
  assert.ok(s2.player.ce.cur >= before.ce, '咒力也不该被这一发扣掉')
})

test('规则型领域里，展开自己的领域也不成立', () => {
  const s = makeFight('伤害型', '规则型')
  s.combat.enemy.domain.active = true
  const ev = domainEvent(runRound(s, makeRng(50), { type: 'domain' }).events)
  assert.ok(!ev.domainOpened, '被规则压着时不该展开成功')
  assert.equal(s.player.domain.active, false)
})

test('规则型领域压低对面的输出（体术仍然打得出去，只是更轻）', () => {
  /*
   * 术式在规则型领域里是**整个被封死**的（另一条测试），0.7 这个减伤系数
   * 只在体术上看得出来。一发体术带着随机项和暴击，单发比不出系数，
   * 所以每一轮都重新开一场（连击、防御姿态、血量全部重来），用固定种子表取平均。
   */
  const avg = (enemyType, sealed) => {
    let sum = 0
    const N = 200
    for (let i = 0; i < N; i++) {
      const s = immortal(makeFight('伤害型', enemyType))
      if (sealed) s.combat.enemy.domain.active = true
      const ev = runRound(s, makeRng(7000 + i), { type: 'physical' }).events
        .find((x) => x.side === 'player' && x.type === 'physical')
      sum += ev?.damage || 0
    }
    return sum / N
  }
  const plain = avg('伤害型', false)
  const ruled = avg('规则型', true)
  assert.ok(plain > 0 && ruled > 0)
  assert.ok(ruled < plain, `规则之下这一手该更轻（规则 ${Math.round(ruled)} vs 平时 ${Math.round(plain)}）`)
})

test('被规则锁住的招，敌方 AI 不会再往外递', () => {
  const s = makeFight('规则型', '伤害型')
  s.player.domain.active = true // 我方规则型领域正开着
  s.player.domain.turnsLeft = 5

  const e = s.combat.enemy
  e.hp.cur = Math.round(e.hp.max * 0.2) // 勾引它去治疗
  e.reverseCursedTechnique = { level: '熟练', progress: 100 }
  e.technique.cdLeft = 0
  e.ce.cur = e.ce.max

  const picked = new Set()
  for (let i = 0; i < 300; i++) picked.add(chooseEnemyAction(s, makeRng(1000 + i)).type)
  for (const locked of ['technique', 'reverse', 'domain', 'defend']) {
    assert.ok(!picked.has(locked), `领域开着，AI 还在递被封锁的 ${locked}`)
  }
  assert.deepEqual([...picked], ['physical'])
})

test('没有规则型领域时，AI 该出的招一个都不少', () => {
  const picked = new Set()
  // 满血：治疗和防御的开关都够不着，看它出不出术式
  const s = makeFight('伤害型', '伤害型')
  s.combat.enemy.technique.cdLeft = 0
  s.combat.enemy.ce.cur = s.combat.enemy.ce.max
  for (let i = 0; i < 300; i++) picked.add(chooseEnemyAction(s, makeRng(2000 + i)).type)
  assert.ok(picked.has('technique'), '没被封就该正常出术式')
  assert.ok(picked.size >= 2, `AI 的打法太单一：${[...picked].join('/')}`)

  // 残血：该想到治疗
  const hurt = makeFight('伤害型', '伤害型')
  hurt.combat.enemy.hp.cur = Math.round(hurt.combat.enemy.hp.max * 0.2)
  hurt.combat.enemy.reverseCursedTechnique = { level: '熟练', progress: 100 }
  hurt.combat.enemy.ce.cur = hurt.combat.enemy.ce.max
  const heal = new Set()
  for (let i = 0; i < 50; i++) heal.add(chooseEnemyAction(hurt, makeRng(3000 + i)).type)
  assert.ok(heal.has('reverse'), '残血该想到治疗')

  // 残血 + 死守性格：防御姿态也该出得来
  const guard = makeFight('伤害型', '伤害型')
  guard.combat.enemy.archetype = '死守'
  guard.combat.enemy.hp.cur = Math.round(guard.combat.enemy.hp.max * 0.2)
  guard.combat.enemy.reverseCursedTechnique = { level: '未掌握', progress: 0 }
  guard.combat.enemy.domain.active = true
  const held = new Set()
  for (let i = 0; i < 200; i++) held.add(chooseEnemyAction(guard, makeRng(4000 + i)).type)
  assert.ok(held.has('defend'), '死守性格残血却不防御')
})

test('挑战面板要把类型、封锁和每回合效果都带上', () => {
  const s = makeFight('规则型', '伤害型')
  const { panel } = runRound(s, makeRng(51), { type: 'domain' })
  assert.equal(panel.domainOpened.type, '规则型')
  assert.equal(panel.seal.enemy, true, '我方开了规则型，敌方就该是被封的那一边')
  assert.equal(panel.seal.player, false)
  assert.ok(panel.seal.rules.damageMul < 1)
  assert.equal(panel.domainState.player.type, '规则型')
  assert.ok(panel.domainState.player.turnsLeft > 0)

  // 交手机读：按下按钮之后立刻能看的那一行
  assert.ok(panel.beat.player, '玩家一侧要有 beat')
  assert.equal(panel.beat.player.label, '领域展开')
  assert.ok(panel.beat.player.damage > 0)

  // 文本面板也得读得通
  const text = buildPanel(s, [], []).domainOpened
  assert.equal(text, null, '没有领域事件时不该编一个出来')
})

test('beat 会标出"这一手什么都没发生"（被封住/冷却/咒力见底）', () => {
  const s = makeFight('伤害型', '规则型')
  s.combat.enemy.domain.active = true
  const { panel } = runRound(s, makeRng(52), { type: 'technique' })
  assert.equal(panel.beat.player.fizzled, true, '被封住的一手要能被界面认出来')
  assert.equal(panel.beat.player.damage, 0)
})
