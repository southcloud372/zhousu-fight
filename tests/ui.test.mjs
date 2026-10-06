import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

/**
 * 前端冒烟测试：把生产构建产物真的跑起来渲染一遍。
 *
 * 为什么必须是"跑构建产物"而不是读源码：
 * 之前发现过一个 useCallback 依赖数组里引用了后面才声明的 const，
 * 触发 TDZ 直接白屏 —— 这种错只有真的执行渲染才会暴露，读代码很容易漏掉。
 *
 * 这里不引入 vitest / testing-library，直接用 jsdom + 构建产物，
 * 依赖只多一个 jsdom。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

/**
 * 从 dist/index.html 里读出真正的入口脚本。
 *
 * 不能用 readdir 猜 —— dist 里可能残留旧构建的产物（曾出现过 5 份 bundle 并存），
 * 猜错就会对着半小时前的旧代码跑测试，测试全绿但什么都没验证到。
 */
function findBundle() {
  const indexPath = path.join(DIST, 'index.html')
  if (!fs.existsSync(indexPath)) return null
  const html = fs.readFileSync(indexPath, 'utf8')
  const m = html.match(/<script[^>]+src="([^"]+\.js)"/)
  if (!m) return null
  const p = path.join(DIST, m[1].replace(/^\//, ''))
  return fs.existsSync(p) ? p : null
}

/** dist 里残留的旧 bundle 会让"测试到底跑了哪份代码"变得不可信，直接报出来 */
function staleBundles() {
  const assets = path.join(DIST, 'assets')
  if (!fs.existsSync(assets)) return []
  const entry = findBundle()
  return fs.readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => path.join(assets, f) !== entry)
}

/** 角色快照：侧栏 StatusPanel 需要的形状。战斗回合面板没有这些字段。 */
/** 用量快照：服务端每次响应都会带 */
const USAGE = {
  input: 4633, output: 2562, cacheRead: 53504, cacheWrite: 0,
  total: 7195, calls: 4, cost: 0.061192, currency: '¥', priceConfigured: true,
  byModel: { 'deepseek-v4-pro': { input: 2051, output: 1743, cacheRead: 40704, cacheWrite: 0, calls: 3 } },
}

let usageFixture = USAGE
let evadeSucceeds = false // 脱离判定结果，测试里可切换
let turnHasCombat = true  // 这一回合是否触发遭遇战
let crossoverDone = 0      // 跨篇历练已完成的段数
/** 「清空全部数据」真的打到服务端几次（没确认就不该打） */
let wipeCalls = 0
let playModeFixture = 'story' // /state 报的当前模式
let wounded = false       // 角色是否带伤（触发疗伤入口）
let wheelReady = false    // 轮盘是否已经走到剧情当天
let reverseUnknown = false // 角色还没练成反转术式（自由行动那一格该灰着）
let turnFails = false      // 这一回合模型调用失败（用来验证错误不再整屏接管）
/*
 * "打爽了的那一手"：暴击 + 连击 + 把对方打断 + 当场铺开领域。
 * 专门喂给演出层 —— 这些字段平时散在几百回合里各出现一次，
 * 只有一次全给出来，才测得到飘字、抖动、过场、连击计数同时在场的样子。
 */
let juicyAction = false
/** 那一手之后，对面正开着规则型领域压着玩家（用来看封锁的呈现） */
let sealedCombat = false
/** 跳过模式那一场里开过领域（验证不逐回合推面板时也有过场） */
let highlightDomain = false
/** 那一场慢慢吐：用来验证全屏特写期间，正文会先停在原地 */
let slowHighlight = false
/**
 * 战斗向的正文写超了 400 字：服务端截短之后会「重置 + 重发」。
 * 前端不接这个重置的话，手里那份长文不会被丢掉，屏幕上就成了两段叠在一起。
 */
let trimmedCombat = false
/** 长的那份带个显眼标记（雨幕），短的那份带另一个（反手一刀），好分辨屏幕上留下了谁 */
const LONG_NARR = '雨幕被撕开一道口子。' + '血'.repeat(420) + '。'
const SHORT_NARR = '反手一刀劈在它肩上，骨头裂开的轻响盖过了呼吸。它抬手的动作慢了半拍。'
const TRIM_EVENTS = [
  ['narration', { text: LONG_NARR }],
  ['reset', {}],
  ['narration', { text: SHORT_NARR }],
]

const CHARACTER_SNAPSHOT = {
  name: '测试者', age: 17, grade: '一级', backgroundType: '自由派', background: 'b',
  hp: { cur: 100, max: 100, grade: '一级' }, ce: { cur: 200, max: 200, grade: '一级' },
  status: '正常',
  technique: { name: '测试术式', effect: 'e', multiplier: 2.5, cooldown: 2, cdLeft: 0 },
  domain: { unlocked: false },
  reverseCursedTechnique: { level: '未掌握', progress: 0 },
  tools: [], talents: ['命硬'],
  cursedDamage: { value: 10, grade: '一级' }, physicalDamage: { value: 10, grade: '一级' },
  efficiency: { value: 0.9, grade: '一级' },
  relations: { 虎杖悠仁: 10 },
  sukuna: { fingersCollected: 1, fingersEaten: 1, awakening: 5, attitude: '无视' },
  timeline: { nodes: { 虎杖吞手指: '已发生' }, changed: [], deaths: [], newEvents: [] },
  time: { date: '2018-06-05', day: 1, skipStreak: 0 },
  // 六条成长进度（0~100）。属性是攒满才跳一次的，这几个数就是玩家唯一
  // 能看见"轮盘没白转"的地方 —— 少了它，右边状态栏一整天都不动
  training: { 体能训练: 38, 咒力冥想: 12, 术式演练: 0, 体术实战: 0, 反转术式修习: 0, 领域雏形冥想: 0 },
  combat: null, pendingCombat: null, combatLog: [],
}

/** 成长面板的六行标题 —— 服务端每次 /state 都会带下来 */
const GROWTH = [
  { id: '体能训练', short: '体能', effect: '血条上限 · 体术伤害' },
  { id: '咒力冥想', short: '冥想', effect: '咒力上限 · 咒力效率' },
  { id: '术式演练', short: '术式', effect: '咒术伤害 · 术式熟练' },
  { id: '体术实战', short: '实战', effect: '体术伤害（有受伤风险）' },
  { id: '反转术式修习', short: '反转', effect: '反转术式熟练度' },
  { id: '领域雏形冥想', short: '领域', effect: '领域雏形进度' },
]

/** 带伤的角色快照 —— 疗伤/反转术式要看得见血条变化 */
let hpCur = 40
const woundedSnapshot = (cur = hpCur) => ({
  ...CHARACTER_SNAPSHOT,
  hp: { cur, max: 100, grade: '一级' },
  status: cur >= 100 ? '正常' : cur >= 60 ? '轻伤' : cur >= 25 ? '重伤' : '濒死',
})
const snapshotFor = () => (wounded ? woundedSnapshot() : CHARACTER_SNAPSHOT)

/** 轮盘快照：界面要拿它画六个扇区、疲劳、以及"还差几天" */
const wheelFixture = (ready = false) => ({
  days: 12,
  sectors: { 体能训练: 5, 咒力冥想: 4 },
  lastItem: '体能训练',
  lastUps: [],
  fatigue: 0.86,
  interventions: [],
  milestone: {
    id: '少年院任务', label: '2018年6月24日 · 少年院任务', date: '2018-06-24',
    node: '少年院任务', danger: 2, dangerLabel: '危险', daysLeft: ready ? 0 : 19,
  },
  ready,
  // 六条进度条：右边成长面板和轮盘里的细条都读这一份
  progress: { 体能: 38, 冥想: 12, 术式: 0, 实战: 0, 反转: 0, 领域: 0 },
  sectorsTable: [
    { id: '体能训练', short: '体能', effect: '血条上限', count: 5, weight: 1.3, progress: 38 },
    { id: '咒力冥想', short: '冥想', effect: '咒力上限', count: 4, weight: 1.2, progress: 12 },
    { id: '术式演练', short: '术式', effect: '术式伤害', count: 2, weight: 1.2, progress: 0 },
    { id: '体术实战', short: '体术', effect: '体术伤害', count: 1, weight: 1.1, progress: 0 },
    { id: '反转术式修习', short: '反转', effect: '反转掌握度', count: 0, weight: 0.7, progress: 0 },
    { id: '领域雏形冥想', short: '领域', effect: '领域雏形', count: 0, weight: 0.5, progress: 0 },
  ],
})

/**
 * 轮盘闸门：ok=这套玩法现在能不能用，spin/advance=两个按钮各自能不能按。
 * 到剧情节点当天时 spin 关掉、advance 留着 —— 一起禁掉的话玩家会卡在节点当天。
 */
const wheelGateFixture = (ready = wheelReady) =>
  playModeFixture !== 'combat'
    ? { ok: false, spin: false, advance: false, reason: '日常轮盘只在战斗向里跑' }
    : ready
      ? { ok: true, spin: false, advance: true, reason: '「少年院任务」就是今天 —— 先打完这一场' }
      : { ok: true, spin: true, advance: true, reason: '' }

/** 战斗行动列表 —— 自由行动那一条单独给 */
const COMBAT_ACTIONS = [
  { type: 'physical', label: '体术攻击', enabled: true },
  { type: 'technique', label: '生得术式·测试术式', enabled: true },
  { type: 'defend', label: '防御（回复咒力）', enabled: true },
  { type: 'flee', label: '脱离战斗', enabled: true },
]
const FREE_REVERSE = (used = false) => (reverseUnknown ? ([
  // 没练成的角色：这一格照样在，只是灰着并写明去哪儿练 ——
  // 之前这里返回空数组，玩家打完了都不知道战斗栏本该有个不占回合的技能
  {
    type: 'reverse', label: '反转术式·未掌握', free: true, enabled: false,
    note: '先修炼「反转术式修习」，练到初步就能用', cost: 0, heal: 0,
  },
]) : ([
  {
    type: 'reverse', label: '反转术式·初步', free: true,
    enabled: !used, note: used ? '本回合已用过' : '消耗 50 咒力，回复 30 生命',
    cost: 50, heal: 30,
  },
]))

/**
 * 「自主定义属性」生成出来的那份档案。
 * 抽成常量是因为它有两个消费者：生成（/attributes/custom）和逐项改数值（/tune）。
 * 两边必须长得一样，否则测不出"改数字不会重写术式"。
 */
const CUSTOM_ATTR = {
  slot: '自定义', overallGrade: '一级', ce: { value: 4200, grade: '一级' },
  hp: { value: 1180, grade: '一级' }, cursedDamage: { value: 193, grade: '一级' },
  physicalDamage: { value: 117, grade: '一级' }, efficiency: { value: 0.88, grade: '一级' },
  techniqueGrade: '一级', techniqueMultiplier: 2.5,
  techniqueName: '绯缠咒法', techniqueEffect: '绯色咒线缠住退路，只能正面接招',
  techniqueCooldown: 2, domainUnlocked: false, domain: { unlocked: false },
  reverseCursedTechnique: '未掌握', toolCount: 0, tool: null,
  talents: ['体术天赋', '抗痛性强'], playstyle: '贴脸近战压制',
}

/** 造一个够用的假后端 */
function makeFetchStub(log) {  return async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    log.push(`${method} ${u}`)
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

    // SSE 端点：把事件串成一整段 body，fetch 的 res.body 一样能读
    const sse = (events) =>
      new Response(
        events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )

    /**
     * 分时段吐的 SSE。真实生成是几秒钟里陆续到字的，
     * 一次性返回整段 body 测不到"生成中途"的行为（滚动跟随、打字机）。
     */
    const sseSlow = (events, delayMs = 70) => {
      const enc = new TextEncoder()
      let i = 0
      return new Response(
        new ReadableStream({
          async pull(ctrl) {
            if (i >= events.length) { ctrl.close(); return }
            const [ev, data] = events[i++]
            ctrl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`))
            await new Promise((r) => setTimeout(r, delayMs))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }

    if (u.endsWith('/api/saves')) return json({ saves: [] })
    // 清空全部数据：服务端要求二次确认口令，这里照着 server/engine/wipe.js 的形状做
    if (u.endsWith('/api/data') && method === 'DELETE') {
      const body = JSON.parse(opts.body || '{}')
      if (body.confirm !== '清除') return json({ error: '需要二次确认' }, 400)
      wipeCalls++
      return json({ ok: true, sessions: 3, files: 2 })
    }
    if (u.includes('/api/health')) return json({ ok: true })
    if (u.endsWith('/api/session') && method === 'POST') return json({ sessionId: 'ui-test', phase: 'storyline' })
    // ---- 故事线 ----
    if (u.endsWith('/api/play-modes')) {
      return json({ default: 'story', modes: [
        { id: 'story', name: '剧情向', tagline: '战斗为主线，但让剧情、关系、日常有呼吸的空间', desc: '战斗占大头。', accent: 'blood' },
        { id: 'combat', name: '战斗向', tagline: '弱化剧情，每轮都是战斗', desc: '转场日常一句话带过。', accent: 'blood' },
      ] })
    }
    if (u.includes('/play-mode')) return json({ usage: usageFixture, playMode: JSON.parse(opts.body || '{}').mode })

    if (u.endsWith('/api/storylines')) {
      return json({ storylines: [
        { id: 'sukuna', name: '宿傩篇', subtitle: '2018 · 诅咒之王', era: '2018 — 2019',
          tagline: '虎杖悠仁吞下第一根宿傩手指之后', desc: '你是穿越者，落到一个已经很糟的局里。',
          startDate: '2018-06-05', accent: 'blood', nodeCount: 10,
          characters: ['虎杖悠仁', '伏黑惠', '钉崎野蔷薇', '五条悟', '七海建人', '宿傩'] },
        { id: 'kaigyoku', name: '怀玉篇', subtitle: '2006 · 最强二人', era: '2006 — 2007',
          tagline: '五条悟与夏油杰还是高专二年级的时候', desc: '天内理子将被交给天元。',
          startDate: '2006-06-01', accent: 'tier', nodeCount: 8,
          characters: ['五条悟', '夏油杰', '家入硝子', '天内理子', '伏黑甚尔', '七海建人'] },
        { id: 'future', name: '未来篇', subtitle: '2029 · 之后的事', era: '2029 — 2031',
          tagline: '原作结束了，但你改出来的那条线还在往前走',
          desc: '十年前的那场仗打完了，也把该碎的都碎了。',
          startDate: '2029-04-01', accent: 'cursed', nodeCount: 6,
          characters: ['虎杖悠仁', '伏黑惠', '钉崎野蔷薇', '禅院真希', '家入硝子', '天元'] },
      ] })
    }
    if (u.includes('/choose-storyline')) return json({ usage: usageFixture, storyline: 'sukuna', startDate: '2018-06-05' })

    // ---- 主循环：返回一场待结算的遭遇战，用来驱动战斗 UI ----
    if (u.endsWith('/turn')) {
      // 模型调用失败：错误该是一条能关掉的横幅，而不是把整个界面换掉
      if (turnFails) return sse([['error', { message: '模型连接超时' }]])
      // 分 8 段慢速吐，中间留出足够时间让测试去滚动
      const chunks = ['第一段。', '第二段，咒灵从阴影里爬出来。', '第三段。', '第四段，双方试探。', '第五段。', '第六段。', '第七段。', '第八段收尾。']
      return sseSlow([
        ...chunks.map((t) => ['narration', { text: t }]),
        ['done', {
          turn: 2,
          recap: '咒灵退进地下，你左肩的伤还在渗血。',
          dialogue: [{ speaker: '虎杖悠仁', text: '小心！' }],
          notes: [],
          choices: [
            { id: '1', label: '迎战', kind: 'story' },
            { id: 'T', label: '【跳过当天，进行修炼】', kind: 'training' },
          ],
          panel: snapshotFor(),
          usage: usageFixture,
          wheel: playModeFixture === 'combat' ? wheelFixture(wheelReady) : null,
          wheelGate: playModeFixture === 'combat' ? wheelGateFixture() : null,
          freeActions: [],
          combat: turnHasCombat
            ? { enemyName: '腐骨咒灵', enemyGrade: '二级', enemyTechnique: '蚀骨', reason: '它挡在路上' }
            : null,
        }],
      ])
    }

    // ---- 遭遇战前的脱离判定 ----
    if (u.endsWith('/combat/evade')) {
      return json({
        success: evadeSucceeds,
        note: evadeSucceeds ? '避开了与腐骨咒灵（二级）的正面冲突' : '腐骨咒灵（二级）咬得太紧，没能甩掉',
        chance: 0.42,
        combat: evadeSucceeds ? null : { enemyName: '腐骨咒灵', enemyGrade: '二级', enemyTechnique: '蚀骨', reason: '它挡在路上' },
        panel: CHARACTER_SNAPSHOT,
        usage: usageFixture,
      })
    }

    // ---- 战斗：手动模式 ----
    if (u.endsWith('/combat/start')) {
      const body = JSON.parse(opts.body || '{}')
      if (body.mode === 'manual') {
        const panel = {
          turn: 1,
          player: { hp: 100, hpMax: 100, ce: 200, ceMax: 200, status: '正常', technique: '测试术式', cdLeft: 0, domain: '未展开' },
          enemy: { name: '腐骨咒灵', grade: '二级', hp: 300, hpMax: 300, ceEstimate: 400, status: '正常', domain: '未展开' },
          actionText: '——', enemyActionText: '——', breakdown: null, damage: 0, notes: [],
          domainState: {
            player: { active: false, name: '', turnsLeft: 0, type: '' },
            enemy: { active: false, name: '', turnsLeft: 0, type: '' },
          },
          seal: { player: false, enemy: false, rules: null },
          domainTicks: [],
          beat: { player: null, enemy: null },
        }
        return sse([
          ['panel', { panel, text: '', mode: 'manual' }],
          ...(trimmedCombat ? TRIM_EVENTS : []),
          ['awaiting', { actions: COMBAT_ACTIONS, freeActions: FREE_REVERSE(false) }],
          // 契约：done.snapshot 是角色快照；战斗回合面板只走 panel 事件
          ['done', { over: false, snapshot: snapshotFor(), text: '', freeActions: FREE_REVERSE(false) }],
        ])
      }
      const highlight = {
        domainOpened: {
          side: 'player', name: '伏魔御厨子·残', sureHit: '必中斩击', burst: 640,
          type: '伤害型', brief: '必中重击，之后每回合追斩', healed: 0, recovered: 0,
        },
        crits: 2,
        rounds: 5,
      }
      const doneEvent = ['done', {
        over: true, outcome: { winner: 'player', loser: 'enemy' }, summary: '击退了二级的腐骨咒灵',
        rewards: { gains: { 术式演练: 6.5 }, notes: ['术式实战运用'] }, ups: [],
        panel: null, combat: null,
      }]

      // 慢慢吐的那一场：特写亮起时正文还在路上 —— 这才是真机上"生成中途"的样子
      if (slowHighlight) {
        return sseSlow([
          ['narration', { text: '一刀两断。' }],
          ['highlight', highlight],
          ['narration', { text: '必中的斩击自四面八方合拢，把整片领域切成碎块。' }],
          doneEvent,
        ], 700)
      }

      return sse([
        ...(trimmedCombat ? TRIM_EVENTS : [['narration', { text: '一刀两断。' }]]),
        // 跳过 / 剧情模式不逐回合推面板，"这一场最值得看的那一下"走 highlight
        ...(highlightDomain ? [['highlight', highlight]] : []),
        doneEvent,
      ])
    }

    // ---- 战斗：出一手，这一手直接打死 ----
    if (u.endsWith('/combat/action')) {
      // 打爽了的那一手：仗还没打完，但这一回合该有的高光全有
      if (juicyAction) {
        return sse([
          ['panel', {
            panel: {
              turn: 3,
              player: { hp: 680, hpMax: 800, ce: 90, ceMax: 200, status: '正常', technique: '测试术式', cdLeft: 1, domain: '展开中' },
              enemy: { name: '腐骨咒灵', grade: '二级', hp: 140, hpMax: 300, ceEstimate: 400, status: '重伤', domain: '未展开' },
              actionText: '领域铺开，必中斩击落下', enemyActionText: '——',
              breakdown: { 咒术伤害: 10, 术式倍率: 2.5, 咒力效率: 0.9, 相性: 1, 等级压制: 1.5, 领域加成: 1.3, 随机: 1, 敌方防御: 8 },
              damage: 640, notes: [],
              crit: 'player', combo: 3, staggered: 'enemy', sureHit: true,
              domainOpened: {
                side: 'player', name: '伏魔御厨子·残', sureHit: '必中斩击',
                type: '伤害型', brief: '必中重击，之后每回合追斩', burst: 640,
                healed: 0, recovered: 0,
              },
              domainState: {
                player: { active: true, name: '伏魔御厨子·残', turnsLeft: 3, type: '伤害型' },
                enemy: { active: false, name: '', turnsLeft: 0, type: '' },
              },
              // 领域展开之后每回合那一口，和自己这一手分开记
              domainTicks: [{ side: 'player', type: '伤害型', name: '伏魔御厨子·残', damage: 88, healed: 0, recovered: 0 }],
              // 交手机读：按下招之后立刻能看的那两行
              beat: {
                player: {
                  label: '领域展开', kind: 'domain', damage: 640, tickDamage: 88,
                  healed: 0, recovered: 0, tickHealed: 0, tickCe: 0,
                  crit: false, staggered: false, fizzled: false,
                },
                enemy: sealedCombat
                  ? {
                    label: '生得术式', kind: 'technique', damage: 0, tickDamage: 0,
                    healed: 0, recovered: 0, tickHealed: 0, tickCe: 0,
                    crit: false, staggered: false, fizzled: true,
                  }
                  : {
                    label: '术式', kind: 'technique', damage: 120, tickDamage: 0,
                    healed: 0, recovered: 40, tickHealed: 0, tickCe: 0,
                    crit: false, staggered: false, fizzled: false,
                  },
              },
              // 规则型领域正压着谁（sealedCombat 那一场：对面开的规则型，被压的是玩家）
              seal: sealedCombat
                ? {
                  player: true,
                  enemy: false,
                  rules: { technique: true, reverse: true, domain: true, defense: true, damageMul: 0.7 },
                }
                : { player: false, enemy: false, rules: null },
            },
            text: '',
          }],
          ['narration', { text: '领域铺开。' }],
          ['done', {
            over: false, panel: snapshotFor(), text: '',
            actions: COMBAT_ACTIONS, freeActions: FREE_REVERSE(false),
          }],
        ])
      }
      const panel = {
        turn: 2,
        player: { hp: 100, hpMax: 100, ce: 150, ceMax: 200, status: '正常', technique: '测试术式', cdLeft: 2, domain: '未展开' },
        enemy: { name: '腐骨咒灵', grade: '二级', hp: 0, hpMax: 300, ceEstimate: 400, status: '濒死', domain: '未展开' },
        actionText: '测试术式轰出，造成 300 点伤害', enemyActionText: '——',
        breakdown: { 咒术伤害: 10, 术式倍率: 2.5, 咒力效率: 0.9, 相性: 1, 等级压制: 1.5, 随机: 1, 敌方防御: 8 },
        damage: 300, notes: [],
      }
      return sse([
        ['panel', { panel, text: '' }],
        ['narration', { text: '咒力贯穿了它。' }],
        ['done', {
          over: true, outcome: { winner: 'player', loser: 'enemy' }, summary: '击退了二级的腐骨咒灵',
          rewards: { gains: { 术式演练: 6.5 }, notes: ['术式实战运用'] }, ups: [],
          panel: null, combat: null,
        }],
      ])
    }

    // ---- 不占回合的自由行动（反转术式）----
    if (u.endsWith('/combat/free-action')) {
      const action = JSON.parse(opts.body || '{}').action
      // 治疗真的落到角色身上 —— 后面的快照都要带着这个新血量
      if (action === 'reverse') hpCur = 70
      return json({
        usage: usageFixture,
        ok: true, healed: 30, cost: 50,
        lines: [`反转术式铺开：${action === 'reverse' ? '伤口在数秒内收拢' : '无事发生'}`],
        // 关键：这条接口不推进回合，但必须带角色快照 —— 血条要当场动
        snapshot: woundedSnapshot(),
        actions: COMBAT_ACTIONS,
        freeActions: FREE_REVERSE(true),
      })
    }

    // ---- 疗伤 ----
    if (u.includes('/recovery-options')) {
      return json({
        needed: wounded,
        items: [
          { id: 'reverse', name: '反转术式', cost: 50, time: 0, desc: '消耗 50 咒力，回复 30 生命（不占时间）', enabled: true, reason: '' },
          { id: 'rest', name: '静养一天', cost: 0, time: 1, desc: '休息一天，回复 18 生命', enabled: true, reason: '' },
          { id: 'shoko', name: '找家入硝子', cost: 0, time: 1, desc: '一天，几乎治好', enabled: false, reason: '你和她的关系还不够' },
        ],
      })
    }
    if (u.endsWith('/recovery') && method === 'POST') {
      const id = JSON.parse(opts.body || '{}').id
      hpCur = 58
      return json({
        usage: usageFixture, id, name: '静养一天', healed: 18, cost: 0, days: 1,
        notes: ['睡了一整天，伤口不再渗血'], status: '轻伤',
        hp: { cur: hpCur, max: 100 }, ce: { cur: 120, max: 200 },
        panel: { ...woundedSnapshot(), ce: { cur: 120, max: 200, grade: '一级' } },
      })
    }

    // ---- 战斗向：日常轮盘 ----
    if (u.endsWith('/wheel') && method === 'GET') {
      return json({
        usage: usageFixture, enabled: playModeFixture === 'combat',
        gate: wheelGateFixture(), wheel: wheelFixture(wheelReady), panel: snapshotFor(),
        growth: playModeFixture === 'combat' ? GROWTH : null,
      })
    }
    if (u.endsWith('/wheel/spin')) {
      return json({
        usage: usageFixture,
        report: {
          day: 13, date: '2018-06-06', kind: 'train',
          sector: { id: '体能训练', short: '体能', effect: '血条上限' },
          progress: 6.2, progressNow: 44, healed: 0, ups: ['血条上限 → 1,240'],
          notes: [], hpDelta: 0, gradeUp: null,
        },
        wheel: wheelFixture(wheelReady), combat: null, panel: snapshotFor(),
        // 闸门跟着回来：转完这一天可能正好落在剧情节点当天
        gate: wheelGateFixture(),
        growth: GROWTH,
      })
    }
    if (u.endsWith('/wheel/advance')) {
      return json({
        usage: usageFixture,
        summary: {
          kind: 'advance', from: '2018-06-05', to: '2018-06-24', days: 19, rest: 0,
          sectors: { 体能训练: 7, 术式演练: 4, 咒力冥想: 3 },
          ups: ['血条上限 → 1,340'], notes: [], healed: 0, damage: 0, gradeUps: [], status: '正常',
          progress: { 体能: 52, 冥想: 30, 术式: 18, 实战: 5, 反转: 2, 领域: 0 },
        },
        wheel: wheelFixture(true),
        // 练到当天，服务端顺势把这场仗挂上
        combat: { enemyName: '少年院特级咒胎', enemyGrade: '特级', enemyTechnique: '变形', reason: '「少年院任务」就在今天' },
        panel: snapshotFor(),
        // 当天闸门：不许再往后转，但这一场要打得成
        gate: wheelGateFixture(true),
        growth: GROWTH,
      })
    }

    // ---- 修炼 ----
    if (u.includes('/training-options')) {
      return json({
        gate: { ok: true },
        items: [
          { name: '体能训练', range: '15%~25%', cost: '体力', progress: 20 },
          { name: '咒力冥想', range: '10%~20%', cost: '时间', progress: 0 },
          { name: '术式演练', range: '10%~18%', cost: '咒力', progress: 0 },
          { name: '反转术式修习', range: '8%~15%', cost: '大量咒力', progress: 0 },
          { name: '领域雏形冥想', range: '5%~12%', cost: '大量咒力+精神', progress: 0 },
          { name: '体术实战', range: '12%~20%', cost: '体力+可能受伤', progress: 0 },
        ],
      })
    }
    if (u.endsWith('/train')) {
      return json({
        item: '体能训练', progress: 22.5, ups: ['血条上限 → 1100'],
        notes: ['天赋「战斗能力」提供额外进度'], hpDelta: 0, flavor: '负重奔跑。', panel: null,
      })
    }
    if (u.endsWith('/state')) {
      return json({
        phase: 'playing',
        playMode: playModeFixture,
        log: [{ type: 'turn', turn: 1, narration: '测试正文。', recap: '你落在杉泽第三高中外的巷口，虎杖刚从墙里翻出来。', dialogue: [{ speaker: '宿傩', text: '特级？' }], notes: [], choices: ['前进', '后退', '观察'] }],
        recap: '你落在杉泽第三高中外的巷口，虎杖刚从墙里翻出来。',
        panel: snapshotFor(),
        usage: usageFixture,
        choices: [
          { id: '1', label: '前进', kind: 'story' },
          // 受伤时服务端会在末尾追加疗伤入口
          ...(wounded ? [{ id: 'R', label: '【疗伤】处理身上的伤（反转术式 / 静养 / 家入硝子）', kind: 'recovery' }] : []),
        ],
        actions: null, combat: null, inCombat: null,
        // 战斗向才有轮盘，剧情向这两个字段是 null
        wheel: playModeFixture === 'combat' ? wheelFixture(wheelReady) : null,
        wheelGate: playModeFixture === 'combat' ? wheelGateFixture() : null,
        // 成长面板的六行标题（进度条本身在 panel.training 里）
        growth: playModeFixture === 'combat' ? GROWTH : null,
      })
    }
    // ---- 自主定义 ----
    /*
     * 逐项改数值。必须排在 /attributes/custom 前面 —— 那一条用的是 includes，
     * 不先接住 tune 的话，改数值的请求会被当成"重新生成"，术式整个被换掉。
     * 这里刻意**只改数字、不动术式**，因为那正是服务端的行为（等级由数字反推）。
     */
    if (u.includes('/attributes/custom/tune')) {
      const n = JSON.parse(opts.body || '{}').numbers || {}
      return json({ usage: usageFixture, profile: {
        ...CUSTOM_ATTR, ce: { value: n.ce ?? CUSTOM_ATTR.ce.value, grade: '二级' },
      } })
    }
    if (u.includes('/attributes/custom')) {
      const brief = JSON.parse(opts.body || '{}').brief || ''
      if (String(brief).trim().length < 2) return json({ error: '请先描述你想要的战斗风格' }, 400)
      return json({ usage: usageFixture, profile: { ...CUSTOM_ATTR, brief, techniqueName: '绯缠咒法', techniqueEffect: '绯色咒线缠住退路，只能正面接招', playstyle: '贴脸近战压制' } })
    }
    if (u.includes('/identities/custom')) {
      const brief = JSON.parse(opts.body || '{}').brief || ''
      if (String(brief).trim().length < 2) return json({ error: '请先描述你想要的背景' }, 400)
      return json({ usage: usageFixture, identity: {
        slot: '自定义', kind: '反派向', age: 17, name: '神代秋生',
        background: '被除名的咒灵观察员，靠倒卖情报活着',
        mainlineRelation: '截到一条宿傩手指的线报',
        openingSituation: '深夜在丰岛的办公室里核对加密邮件',
        hook: '买家名单里有咒术界内部的人',
        initialRelations: { 五条悟: -6, 宿傩: 6 },
        brief,
      } })
    }

    if (u.includes('/attributes')) {
      return json({ usage: usageFixture, profiles: ['A', 'B', 'C'].map((slot) => ({
        slot, overallGrade: '一级', ce: { value: 300, grade: '一级' }, hp: { value: 1000, grade: '一级' },
        cursedDamage: { value: 20, grade: '一级' }, physicalDamage: { value: 20, grade: '一级' },
        efficiency: { value: 0.9, grade: '一级' }, techniqueGrade: '一级', techniqueMultiplier: 2.5,
        techniqueName: `术式${slot}`, techniqueEffect: '效果', techniqueCooldown: 2,
        domainUnlocked: false, domain: { unlocked: false }, reverseCursedTechnique: '未掌握',
        toolCount: 0, tool: null, talents: ['命硬'], playstyle: '风格', defense: 50,
      })) })
    }
    if (u.includes('/choose-attributes')) {
      return json({ usage: usageFixture, identities: ['甲', '乙', '丙'].map((slot) => ({
        slot, kind: slot === '甲' ? '反派向' : '自由派', age: 17,
        name: `角色${slot}`, background: '背景', mainlineRelation: '关系',
        openingSituation: '处境', hook: '钩子', initialRelations: { 虎杖悠仁: 5 },
      })) })
    }
    // 第二步选定后 → 返回三份穿越时间（不再直接开局）
    if (u.includes('/choose-identity')) {
      return json({
        usage: usageFixture,
        times: [
          { id: 'start', date: '2018-06-05', label: '2018年6月 · 宿傩手指', when: '虎杖吞下第一根手指前后', situation: '一切的开端。', hook: '你早知道结局。', nodesDone: [], danger: 1, dangerLabel: '序章' },
          { id: 'sisters', date: '2018-07-12', label: '2018年7月 · 京都姊妹校交流', when: '两校交流战', situation: '咒灵侧开始试探。', hook: '真人会注意到容器。', nodesDone: ['虎杖吞手指'], danger: 3, dangerLabel: '暗流' },
          { id: 'shibuya', date: '2018-10-31', label: '2018年10月31日 · 涩谷事变', when: '五条悟被封印', situation: '涩谷已经封场。', hook: '这一天之后天平翻了。', nodesDone: ['虎杖吞手指', '涩谷事变'], danger: 4, dangerLabel: '地狱' },
        ],
      })
    }
    // ---- 跨篇衔接 ----
    if (u.endsWith('/crossover') && method === 'GET') {
      return json({
        gate: { ok: true, inProgress: false, stages: 3, done: crossoverDone },
        stages: [
          { from: '2007', to: '2010', years: 3, label: '最初的三年' },
          { from: '2010', to: '2014', years: 4, label: '中间四年' },
          { from: '2014', to: '2018', years: 4, label: '最后的四年' },
        ],
        focuses: [
          { id: 'ascetic', name: '苦修', desc: '把时间全砸在身体上。' },
          { id: 'meditation', name: '冥想', desc: '向内。扩张咒力的容量。' },
          { id: 'research', name: '术式钻研', desc: '把生得术式拆开再装回去。' },
          { id: 'wander', name: '游历', desc: '在咒术界的灰色地带走动。' },
        ],
        done: crossoverDone,
        target: '宿傩篇',
      })
    }
    if (u.includes('/crossover/advance')) {
      const focus = JSON.parse(opts.body || '{}').focus
      crossoverDone += 1
      const range = [{ from: '2007', to: '2010' }, { from: '2010', to: '2014' }, { from: '2014', to: '2018' }][crossoverDone - 1]
      const base = {
        stage: crossoverDone - 1, focusId: focus, focusName: { ascetic: '苦修', meditation: '冥想', research: '术式钻研', wander: '游历' }[focus] || '苦修',
        range, gains: [], notes: [],
      }
      if (crossoverDone >= 3) {
        crossoverDone = 0
        return json({
          usage: usageFixture, finished: true, result: base,
          ups: ['血条总量 1,379 → 1,606'],
          crossover: {
            from: '怀玉篇', to: '宿傩篇', toId: 'sukuna', startDate: '2018-06-05',
            gapYears: 11, gradeUp: '二级',
            carriedRelations: [{ name: '五条悟', value: 45 }],
            note: '11 年过去，五条悟还记得你',
          },
          panel: CHARACTER_SNAPSHOT,
        })
      }
      return json({ usage: usageFixture, finished: false, result: base, ups: ['咒力总量 4,458 → 4,569'], done: crossoverDone, panel: CHARACTER_SNAPSHOT })
    }

    // 自主定义穿越时间
    if (u.includes('/time/custom')) {
      const brief = JSON.parse(opts.body || '{}').brief || ''
      if (String(brief).trim().length < 2) return json({ error: '请先描述你想穿越到的时机' }, 400)
      return json({ usage: usageFixture, point: {
        id: '自定义',
        date: '2018-09-30',
        label: '2018年9月30日 · 涩谷前夜的前夜',
        when: '距涩谷事变还有一个月',
        situation: '表面上一切照旧，咒灵侧已经在布针对五条悟的局。',
        hook: '你还有一个月。说不说，是你的事。',
        nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流'],
        danger: 3, dangerLabel: '暗流',
        anchorLabel: '2018年8月 · 涩谷前夜',
        brief,
      } })
    }
    // 第三步：选定穿越时间 → 才是真正的开局
    if (u.includes('/choose-time')) {
      return json({
        usage: usageFixture,
        narration: '开局正文。', recap: '你落在杉泽第三高中外的巷口，虎杖刚从墙里翻出来。',
        dialogue: [{ speaker: '虎杖悠仁', text: '你是谁？' }], notes: [],
        choices: [{ id: '1', label: '出手', kind: 'story' }, { id: 'T', label: '【跳过当天，进行修炼】', kind: 'training' }],
        panel: CHARACTER_SNAPSHOT, combat: null,
      })
    }
    return json({ ok: true })
  }
}

let dom
let bundle

before(() => {
  bundle = findBundle()
})

/**
 * 起一个干净的 jsdom 环境，导入构建产物，等 React 把首次渲染冲刷完。
 * createRoot().render() 是异步调度的，所以要让出一个宏任务。
 */
async function mount(prep) {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true })

  // jsdom 没实现 scrollIntoView，聊天区自动滚动会用到
  dom.window.Element.prototype.scrollIntoView = function () {}
  dom.window.HTMLElement.prototype.scrollIntoView = function () {}
  // jsdom 不做布局：scrollHeight/clientHeight 恒为 0，会让贴底判定永远成立。
  // 这里给出一组固定尺寸，让滚动逻辑可测。
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get() { return this.__sh ?? 3000 },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true, get() { return this.__ch ?? 600 },
  })

  // prep 必须在导入 bundle 之前跑 —— 应用挂载时就会读 localStorage
  prep?.(dom.window)

  // Node 自带的 navigator / localStorage 是只读 getter，必须用 defineProperty 覆盖
  const g = globalThis
  const define = (k, v) =>
    Object.defineProperty(g, k, { value: v, writable: true, configurable: true })

  define('window', dom.window)
  define('document', dom.window.document)
  define('IS_REACT_ACT_ENVIRONMENT', false)

  // 把 jsdom 提供的浏览器全局尽量搬过来，React 与构建产物会用到其中不少
  const WANTED = [
    'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLDivElement',
    'Element', 'Node', 'NodeList', 'DocumentFragment', 'Text', 'Comment',
    'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent',
    'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
    'MessageChannel', 'MessagePort', 'requestAnimationFrame', 'cancelAnimationFrame',
    'getComputedStyle', 'matchMedia', 'CSS', 'DOMParser', 'XMLHttpRequest',
    'FormData', 'Blob', 'File', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  ]
  for (const k of WANTED) {
    if (dom.window[k] !== undefined) define(k, dom.window[k])
  }
  // requestAnimationFrame 在 jsdom 里可能挂在 window 上但没被上面列到
  if (!g.requestAnimationFrame) {
    define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 16))
    define('cancelAnimationFrame', (id) => clearTimeout(id))
  }

  const calls = []
  g.fetch = makeFetchStub(calls)

  // 每次导入都是新模块实例吗？不是 —— 加个 query 强制重新求值
  const mod = await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`)
  void mod
  // 让 React 的调度器跑完
  await new Promise((r) => setTimeout(r, 60))
  return calls
}

const text = () => dom.window.document.getElementById('root')?.textContent || ''
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))

/** 等界面上出现某段文本，比死等固定毫秒稳 */
async function waitFor(pattern, { timeout = 20000 } = {}) {
  const t0 = Date.now()
  const re = new RegExp(pattern)
  while (Date.now() - t0 < timeout) {
    if (re.test(text())) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等待超时：${pattern}（当前：${text().slice(0, 120)}）`)
}
const findButton = (label) =>
  [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent.includes(label))

test('dist 里没有残留的旧 bundle（否则测试可能在验证旧代码）', () => {
  assert.ok(bundle, '找不到构建产物，请先跑 npm run build')
  const stale = staleBundles()
  assert.equal(stale.length, 0, `dist/assets 残留了旧产物：${stale.join(', ')} —— 先删掉 dist 重新构建`)
})

test('生产构建产物能挂载并渲染开始界面', async () => {
  assert.ok(bundle, '找不到构建产物，请先跑 npm run build')
  await mount()
  const root = dom.window.document.getElementById('root')
  assert.ok(root, '#root 不存在')
  assert.ok(root.innerHTML.length > 100, '#root 是空的 —— 应用没渲染出来')
  assert.match(text(), /回战/)
  assert.match(text(), /开始生成/)
})

test('开始界面能点开存档面板（没有会话时不给保存）', async () => {
  await mount()
  const btn = findButton('读取存档')
  assert.ok(btn, '找不到「读取存档」按钮')
  click(btn)
  await new Promise((r) => setTimeout(r, 40))
  assert.match(text(), /存档/, '存档面板没打开')
  assert.match(text(), /只能读取已有存档/, '无会话时不该提供保存入口')
})

test('走完开局三选一不崩，且能进入主界面', async () => {
  await mount()

  await gotoAttributes()
  assert.match(text(), /第一步 · 属性/, '没有进入属性选择')

  click(findButton('选择档案 A'))
  await new Promise((r) => setTimeout(r, 80))
  assert.match(text(), /第二步 · 身份/, '没有进入身份选择')

  click(findButton('选择身份 甲'))
  await new Promise((r) => setTimeout(r, 120))
  assert.match(text(), /第三步 · 穿越时间/, '没有进入穿越时间选择')

  click(findButton('从这里开始'))
  await new Promise((r) => setTimeout(r, 150))
  assert.match(text(), /回战/, '没有进入主界面')
  assert.ok(findButton('存档'), '主界面缺少存档按钮')
})

test('开局第一屏是故事线选择，三条线各有自己的年代与阵容', async () => {
  await mount()
  click(findButton('开始生成'), '开始生成')
  await waitFor('选择故事线', { timeout: 60000 })

  const cards = [...dom.window.document.querySelectorAll('.pcard.story')]
  assert.equal(cards.length, 3, `应有三条故事线（宿傩 / 怀玉 / 未来），实际 ${cards.length}`)

  const sukuna = cards.find((c) => c.textContent.includes('宿傩篇'))
  const future = cards.find((c) => c.textContent.includes('未来篇'))
  const kaigyoku = cards.find((c) => c.textContent.includes('怀玉篇'))
  assert.ok(sukuna && kaigyoku && future, '缺少某条故事线')
  assert.match(future.textContent, /2029-04-01/, '未来篇起始日期不对')

  // 年份、起始日期、阵容必须各自独立
  assert.match(sukuna.textContent, /2018-06-05/, '宿傩篇起始日期不对')
  assert.match(kaigyoku.textContent, /2006-06-01/, '怀玉篇起始日期不对')
  assert.match(sukuna.textContent, /虎杖悠仁/, '宿傩篇阵容里没有虎杖')
  assert.match(kaigyoku.textContent, /夏油杰/, '怀玉篇阵容里没有夏油')
  assert.ok(!/虎杖悠仁/.test(kaigyoku.textContent), '怀玉篇不该出现虎杖 —— 2006 年他还没出生')

  // 选定后才掷属性
  assert.ok(!dom.window.document.querySelector('.choices'), '这时不该有游戏界面')
  click([...sukuna.querySelectorAll('button')].find((b) => b.textContent.includes('进入这条线')))
  await waitFor('第一步 · 属性', { timeout: 60000 })
})

test('第一屏能选游玩模式，默认剧情向', async () => {
  await mount()
  click(findButton('开始生成'), '开始生成')
  await waitFor('选择故事线', { timeout: 60000 })

  const cards = [...dom.window.document.querySelectorAll('.mode-card')]
  assert.equal(cards.length, 2, `应有两种游玩模式，实际 ${cards.length}`)
  const names = cards.map((c) => c.querySelector('.mode-n').textContent)
  assert.deepEqual(names, ['剧情向', '战斗向'])

  // 默认选中剧情向
  assert.ok(cards[0].className.includes('on'), '默认应当选中剧情向')
  assert.ok(!cards[1].className.includes('on'), '战斗向不该默认选中')

  // 点一下能切
  click(cards[1])
  await new Promise((r) => setTimeout(r, 60))
  const after = [...dom.window.document.querySelectorAll('.mode-card')]
  assert.ok(after[1].className.includes('on'), '点击后没有切到战斗向')
  assert.ok(!after[0].className.includes('on'), '剧情向应当取消选中')

  // 每种模式都要有说明
  for (const c of after) {
    assert.ok(c.querySelector('.mode-t').textContent.trim(), '缺少一句话说明')
    assert.ok(c.querySelector('.mode-d').textContent.trim(), '缺少详细说明')
  }
})

test('游戏内顶栏显示当前模式，点击可切换', async () => {
  await enterGame()
  const badge = dom.window.document.querySelector('.mode-badge')
  assert.ok(badge, '顶栏没有模式徽章')
  assert.match(badge.textContent, /剧情向/, '默认应显示剧情向')

  click(badge)
  await new Promise((r) => setTimeout(r, 200))
  assert.match(dom.window.document.querySelector('.mode-badge').textContent, /战斗向/,
    '点击后应当切到战斗向')

  click(dom.window.document.querySelector('.mode-badge'))
  await new Promise((r) => setTimeout(r, 200))
  assert.match(dom.window.document.querySelector('.mode-badge').textContent, /剧情向/,
    '再点一次应当切回剧情向')
})

test('穿越时间：三选一，保底含最开篇，按时间排序', async () => {
  await mount()
  await gotoAttributes()
  click(findButton('选择档案 A'))
  await waitFor('第二步 · 身份', { timeout: 60000 })
  click(findButton('选择身份 甲'))
  await waitFor('第三步 · 穿越时间', { timeout: 60000 })

  const cards = [...dom.window.document.querySelectorAll('.pcard.time')]
  assert.equal(cards.length, 3, `应有 3 份穿越时间，实际 ${cards.length}`)

  const dates = cards.map((c) => c.querySelector('.time-date').textContent)
  assert.ok(dates.includes('2018-06-05'), `保底必须含最开篇，实际：${dates.join(' / ')}`)
  assert.deepEqual(dates, [...dates].sort(), `时间点应按先后排序：${dates.join(' / ')}`)

  // 每张卡都要写清"那一刻在发生什么"和危险度
  for (const c of cards) {
    assert.ok(c.querySelector('.tech').textContent.trim(), '缺少时间点标题')
    assert.match(c.textContent, /那一刻/, '没有说明那一刻的处境')
    assert.ok(c.querySelector('.time-danger'), '没有危险度标识')
  }
  // 最开篇那张应当明说"一切还没开始"
  const first = cards.find((c) => c.querySelector('.time-date').textContent === '2018-06-05')
  assert.match(first.textContent, /还没开始/, '最开篇没有标出"从头改写"')
  // 靠后的时间点要列出已经发生、不可更改的节点
  const late = cards[cards.length - 1]
  assert.match(late.textContent, /已经发生（不可更改）/, '后期时间点没有列出既定事实')
})

test('刷新续接：localStorage 里有会话时自动回到游戏', async () => {
  await mount((win) => win.localStorage.setItem('sunuo:session', 'ui-test'))
  await new Promise((r) => setTimeout(r, 120))
  assert.match(text(), /测试者/, '没有从存档接回角色面板')
  assert.match(text(), /2018-06-05/, '没有恢复游戏内日期')
})

/** 走完故事线选择，停在属性页 */
async function gotoAttributes() {
  click(findButton('开始生成'), '开始生成')
  await waitFor('选择故事线', { timeout: 60000 })
  click(findButton('进入这条线'), '进入这条线')
  await waitFor('第一步 · 属性', { timeout: 60000 })
}

/** 把界面推进到"主循环可操作"的状态 */
async function enterGame() {
  await mount((win) => win.localStorage.setItem('sunuo:session', 'ui-test'))
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(findButton('存档'), '没进到主界面')
}

test('主页按钮：从局内回得去，也回得来（进度不丢）', async () => {
  /*
   * 回主页不是"结束这一局"：进度每回合都落在服务端，会话 id 也留在本地。
   * 但开始界面上原来只有 开始生成 / 读取存档 —— 从主页回来的人找不到刚才那局，
   * 会以为被扔掉了，所以得有「继续上次」。
   */
  await enterGame()
  assert.match(text(), /测试正文/, '没进到局内')

  click(findButton('主页'))
  await new Promise((r) => setTimeout(r, 150))

  assert.ok(!dom.window.document.querySelector('.topbar'), '回到主页了，顶上还挂着游戏内的顶栏')
  assert.ok(findButton('开始生成'), '没回到开始界面')
  const cont = findButton('继续上次')
  assert.ok(cont, '主页没有回去的路 —— 玩家只能去翻存档')

  click(cont)
  await waitFor('测试正文', { timeout: 15000 })
  assert.ok(dom.window.document.querySelector('.topbar'), '「继续上次」没有把局面接回来')
})

test('开始界面就要能看到用量表（不是只有游戏内才有）', async () => {
  // 曾经的缺口：UsageMeter 只挂在主界面顶栏里，开始界面和开局选卡那几屏都没有。
  // 而开局生成恰恰是最花钱的一步，玩家在那几屏反而看不到账。
  await mount()
  const meter = dom.window.document.querySelector('.usage')
  assert.ok(meter, '开始界面没有用量表')
  assert.equal(meter.parentElement.className, 'meter-fixed', '用量表应固定在页面左上角')
  assert.match(meter.textContent, /0 tok/, '未开局时应显示 0 而不是隐藏')

  click(meter)
  await new Promise((r) => setTimeout(r, 60))
  const pop = dom.window.document.querySelector('.usage-pop')
  assert.ok(pop, '点击没有展开')
  assert.match(pop.textContent, /还没开始/, '未开局时的说明文案不对')
  // 未开局不该冒出"未配置单价"这种噪音
  assert.ok(!/未配置单价/.test(pop.textContent), '未开局时不该提示价格未配置')
})

test('开局流程里也能撤回主页：选错了不用硬着头皮走完', async () => {
  /*
   * 故事线 / 属性 / 身份 / 时间这四屏都没有顶栏，本来是一条道走到黑 ——
   * 掷出三份都不想要的属性也只能往下点。
   */
  await mount()
  await gotoAttributes()
  const back = findButton('返回主页')
  assert.ok(back, '开局流程里没有出口')

  click(back)
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(findButton('开始生成'), '点了「返回主页」却没回到开始界面')
  assert.ok(findButton('继续上次'), '撤回主页之后，这一局就没有回去的路了')
})

test('开局属性页有「自主定义」第四项，能填数值并采用', async () => {
  const calls = await mount()
  await gotoAttributes()

  // 四张卡：A / B / C / 自主定义
  const cards = [...dom.window.document.querySelectorAll('.pcard')]
  assert.equal(cards.length, 4, `应有 3 份预设 + 1 项自主定义，实际 ${cards.length} 张`)
  const custom = dom.window.document.querySelector('.pcard.custom')
  assert.ok(custom, '找不到自主定义卡片')
  assert.match(custom.textContent, /自主定义/)

  // 必须写明数字是玩家自己填的、等级跟着数字走 ——
  // 否则玩家会以为只能描述风格（这正是这一版要改掉的那件事）
  assert.match(custom.textContent, /每一项你都能改，等级会跟着数字变/, '没有说明数值可改')

  const ta = custom.querySelector('textarea')
  assert.ok(ta, '没有输入框')
  const genBtn = [...custom.querySelectorAll('button')].find((b) => b.textContent.includes('按我的描述生成'))
  assert.ok(genBtn && genBtn.disabled, '输入为空时生成按钮应当禁用')

  // 填描述后生成
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '我想打近身压制，靠体术和短刀，术式封住对方退路')
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  click([...custom.querySelectorAll('button')].find((b) => b.textContent.includes('按我的描述生成')))
  await waitFor('依据你的描述生成', { timeout: 30000 })

  const result = dom.window.document.querySelector('.custom-result')
  assert.ok(result, '没有显示生成结果')
  const rt = result.textContent
  assert.match(rt, /绯缠咒法/, '结果里没有术式')
  assert.match(rt, /贴脸近战压制/, '结果里没有玩法风格')
  assert.match(rt, /一级/, '结果里没有等级')

  /*
   * 数值格子：这一版的核心 —— 掷出来的只是默认值，玩家能直接改。
   * 七项都要在（咒力/血条/咒术伤害/体术伤害/效率/倍率/冷却）。
   */
  const rows = [...result.querySelectorAll('.num-row')]
  assert.equal(rows.length, 7, `应有 7 项数值输入，实际 ${rows.length}`)
  const ceInput = rows[0].querySelector('input')
  assert.ok(ceInput, '咒力那一行没有输入框')
  assert.equal(ceInput.value, '4200', '输入框里应当是引擎掷出来的默认值')
  assert.match(rows[0].textContent, /一级/, '每一行旁边要显示这一项反推出来的等级')

  // 没改之前不出现「应用数值」—— 免得玩家以为不改也得点一下
  assert.ok(!findButton('应用数值'), '还没改数字就出现了应用按钮')

  // 改一项 → 按钮出现 → 点它 → 走 /attributes/custom/tune
  const setterN = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setterN.call(ceInput, '12000')
  ceInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  const tuneBtn = [...custom.querySelectorAll('button')].find((b) => b.textContent.includes('应用数值'))
  assert.ok(tuneBtn, '改了数字之后应当出现「应用数值」')
  click(tuneBtn)
  await new Promise((r) => setTimeout(r, 120))
  const tuneCall = calls.find((c) => c.includes('/attributes/custom/tune'))
  assert.ok(tuneCall, '没有把改后的数值发给服务端')
  assert.match(result.textContent, /绯缠咒法/, '换数值把术式也换掉了 —— 数字和术式是两回事')

  // 采用它 → 进入身份页
  const useBtn = [...custom.querySelectorAll('button')].find((b) => b.textContent.includes('就用这个'))
  assert.ok(useBtn, '缺少「就用这个」按钮')
  click(useBtn)
  await waitFor('第二步 · 身份', { timeout: 60000 })
})

test('开局身份页也有「自主定义」，模型判定类型后重掷关系', async () => {
  await mount()
  await gotoAttributes()
  click(findButton('选择档案 A'))
  await waitFor('第二步 · 身份', { timeout: 60000 })

  // 五张卡：三份预设 + 自主定义 + 「突然出现的人」
  const cards = [...dom.window.document.querySelectorAll('.pcard')]
  assert.equal(cards.length, 5, `身份页应有 5 张卡，实际 ${cards.length}`)
  const custom = dom.window.document.querySelector('.pcard.custom')
  assert.match(custom.textContent, /身份类型由模型按你的描述判定/, '没有说明类型由模型判定')

  const ta = custom.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '我是被高专除名的观察员，暗中替诅咒师做事')
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  click([...custom.querySelectorAll('button')].find((b) => b.textContent.includes('按我的描述生成')))
  await waitFor('依据你的描述生成', { timeout: 30000 })

  const rt = dom.window.document.querySelector('.custom-result').textContent
  assert.match(rt, /神代秋生/, '结果里没有姓名')
  assert.match(rt, /反派向/, '没有显示模型判定的身份类型')
  assert.match(rt, /钩子/, '没有钩子')
})

test('第五个身份「突然出现的人」：只填一句话就能用，不走模型', async () => {
  const calls = await mount()
  await gotoAttributes()
  click(findButton('选择档案 A'))
  await waitFor('第二步 · 身份', { timeout: 60000 })

  // 它和另外四张长得不一样：那四张是"给你的身份"，这张是"没有身份"
  const sudden = dom.window.document.querySelector('.pcard.sudden')
  assert.ok(sudden, '身份页缺少「突然出现的人」这张卡')
  assert.match(sudden.textContent, /突然出现的人/)

  // 什么都不填也能直接出现 —— 没有输入框挡路（名字和年龄都是可选的）
  const btn = [...sudden.querySelectorAll('button')].find((b) => b.textContent.includes('就这样出现'))
  assert.ok(btn, '缺少「就这样出现」按钮')
  assert.ok(!btn.disabled, '一个字都不填也应当能直接开始')

  const before = calls.filter((c) => c.includes('/identities/sudden')).length
  click(btn)
  await waitFor('第三步 · 穿越时间', { timeout: 60000 })
  const after = calls.filter((c) => c.includes('/identities/sudden')).length
  assert.equal(after, before + 1, '没有把这次选择发给服务端')
  // 这个身份是引擎自己造的：问了模型，它一定会给玩家补出一个来历
  assert.ok(!calls.some((c) => c.includes('/identities/custom')), '不该为这个身份调模型')
})

test('主页能清空全部数据：点一次只亮确认条，点两次才真清', async () => {
  /*
   * 场景就是玩家真实的处境：手上有局、本地留着会话 id，
   * 想开个新角色却怕"继续上次"接回来的是一周前那局 —— 每接一次都要为
   * 一段早忘了的剧情先付第一回合的钱。所以这里先真的进一局再回主页。
   */
  wipeCalls = 0
  await enterGame()          // localStorage 里现在有 sunuo:session
  click(findButton('主页'))
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(dom.window.localStorage.getItem('sunuo:session'), '前置条件：本地应当有会话 id')

  const ask = findButton('清空全部数据')
  assert.ok(ask, '主页缺少「清空全部数据」')
  click(ask)
  await new Promise((r) => setTimeout(r, 40))
  assert.match(text(), /不能撤销/, '没有说明这一下不可逆')
  assert.ok(findButton('确认清空'))
  assert.equal(wipeCalls, 0, '第一次点击就动手删了 —— 那是没有撤销键的操作')
  assert.ok(dom.window.localStorage.getItem('sunuo:session'), '确认之前不该动本地数据')

  // 取消要能退回去
  click(findButton('取消'))
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(findButton('清空全部数据'), '取消之后按钮没回来')
  assert.equal(wipeCalls, 0)

  // 真确认
  click(findButton('清空全部数据'))
  await new Promise((r) => setTimeout(r, 40))
  click(findButton('确认清空'))
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(wipeCalls, 1, '确认之后没有清')
  assert.equal(dom.window.localStorage.getItem('sunuo:session'), null, '本地那把钥匙没被抹掉')
  assert.match(text(), /已清空 3 个会话、2 个存档文件/, '清完没有回执')
  assert.ok(!findButton('继续上次'), '数据都清了，主页还挂着「继续上次」')
})

test('穿越时间也有「自主定义」：日期自定义、进度继承锚点', async () => {
  await mount()
  await gotoAttributes()
  click(findButton('选择档案 A'))
  await waitFor('第二步 · 身份', { timeout: 60000 })
  click(findButton('选择身份 甲'))
  await waitFor('第三步 · 穿越时间', { timeout: 60000 })

  // 3 份预设 + 1 份自主定义
  const cards = [...dom.window.document.querySelectorAll('.pcard')]
  assert.equal(cards.length, 4, `应有 3 份预设 + 自主定义，实际 ${cards.length} 张`)
  const custom = dom.window.document.querySelector('.time-custom')
  assert.ok(custom, '穿越时间页没有自主定义卡片')
  // 必须说明进度是继承的，否则玩家以为连进度都能自定义
  assert.match(custom.textContent, /继承自最接近的既有节点/, '没有说明原作进度是继承的')

  const ta = custom.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '我想穿到涩谷事变前一个月，还来得及做点什么的时候')
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))

  const genBtn = [...custom.querySelectorAll('button')].find((b) => b.textContent.includes('按我的描述定位'))
  assert.ok(genBtn && !genBtn.disabled, '找不到生成按钮或按钮被禁用')
  click(genBtn)
  await waitFor('依据你的描述定位', { timeout: 30000 })

  const rt = dom.window.document.querySelector('.time-custom .custom-result').textContent
  // 关键：日期是自定义的（不是锚点的 2018-08-20），进度却来自锚点
  assert.match(rt, /2018-09-30/, `落地日期应当自定义，实际：${rt.slice(0, 60)}`)
  assert.match(rt, /原作进度取自/, '没有标明进度取自哪里')
  assert.match(rt, /涩谷前夜/, '没有显示锚点名称')
  assert.match(rt, /京都姊妹校交流/, '没有列出继承的已发生节点')

  // 采用它 → 进入游戏
  click([...custom.querySelectorAll('button')].find((b) => b.textContent.includes('从这里开始')))
  await new Promise((r) => setTimeout(r, 200))
  assert.match(text(), /回战/, '没有进入主界面')
})

test('跨篇：入口在顶栏，点开是三段历练', async () => {
  crossoverDone = 0
  await enterGame()

  const btn = findButton('跨篇')
  assert.ok(btn, '顶栏没有跨篇入口')
  click(btn)
  await waitFor('跨越', { timeout: 30000 })

  const t = text()
  assert.match(t, /2007 – 2018/, '没有显示跨度')
  assert.match(t, /宿傩篇/, '没有说明目标篇章')
  // 突破门槛已废止 —— 界面不该再说"需要专属突破剧情"
  assert.match(t, /积累够就直接提升一个等级/, '没有说明等级靠积累提升')
  assert.ok(!/专属突破|突破剧情/.test(t), '界面上还残留着已废止的突破门槛说法')

  // 四段历练方向（是 4 个方向、3 个阶段）
  const focuses = [...dom.window.document.querySelectorAll('.xo-focus')]
  assert.equal(focuses.length, 4, `应有 4 个历练方向，实际 ${focuses.length}`)
  const names = focuses.map((f) => f.querySelector('.xo-focus-n').textContent)
  for (const n of ['苦修', '冥想', '术式钻研', '游历']) {
    assert.ok(names.includes(n), `缺少历练方向「${n}」`)
  }

  // 三段进度指示
  const dots = [...dom.window.document.querySelectorAll('.xo-dot')]
  assert.equal(dots.length, 3, `应有 3 段历练，实际 ${dots.length}`)
  assert.equal(dots[0].className.includes('now'), true, '第一段应当是高亮状态')
})

test('跨篇：走完三段会落到新篇章，并保留该保留的东西', async () => {
  crossoverDone = 0
  await enterGame()
  click(findButton('跨篇'))
  await waitFor('跨越', { timeout: 30000 })

  for (let i = 0; i < 3; i++) {
    const f = dom.window.document.querySelector('.xo-focus')
    assert.ok(f, `第 ${i + 1} 段找不到历练方向`)
    click(f)
    await new Promise((r) => setTimeout(r, 250))
  }

  // 走完三段后界面应当关闭，日志里出现跨篇结算卡
  await waitFor('跨篇', { timeout: 30000 })
  await new Promise((r) => setTimeout(r, 300))
  const log = dom.window.document.querySelector('.log').textContent
  assert.match(log, /怀玉篇\s*→\s*宿傩篇/, '没有跨篇结算卡')
  assert.match(log, /2018-06-05/, '没有显示新篇起始日期')
  assert.match(log, /11 年过去/, '没有显示时间跨度')
  assert.match(log, /等级提升至/, '没有显示等级提升')
  assert.match(log, /五条悟/, '没有列出记得你的人')
  assert.ok(!dom.window.document.querySelector('.xo-focus'), '跨完后界面应当关闭')
})

test('开局选卡界面也有用量表', async () => {
  await mount()
  await gotoAttributes()
  const meter = dom.window.document.querySelector('.usage')
  assert.ok(meter, '属性选卡界面没有用量表')
  // 生成属性已经花钱了，这里应当显示真实数字
  assert.match(meter.textContent, /7\.2k tok/, `选卡界面应显示已产生的用量：${meter.textContent}`)

  click(findButton('选择档案 A'), '选择档案 A')
  await waitFor('第二步 · 身份', { timeout: 60000 })
  assert.ok(dom.window.document.querySelector('.usage'), '身份选卡界面没有用量表')
})

test('左上角显示 token 用量与费用', async () => {
  await enterGame()
  const meter = dom.window.document.querySelector('.usage')
  assert.ok(meter, '左上角没有用量表')
  const t = meter.textContent
  assert.match(t, /7\.2k tok/, `没有显示 token 数：${t}`)
  assert.match(t, /¥0\.061/, `没有显示费用：${t}`)

  // 它在顶栏里应当是最左侧的元素
  const topbar = dom.window.document.querySelector('.topbar')
  assert.equal(topbar.firstElementChild.className, 'usage', '用量表不在左上角第一个位置')

  // 点击展开明细（触屏没有 hover，所以必须支持点击）
  meter.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  const pop = dom.window.document.querySelector('.usage-pop')
  assert.ok(pop, '悬停没有展开明细')
  const p = pop.textContent
  for (const k of ['输入', '输出', '调用次数', '费用', '缓存命中']) {
    assert.ok(p.includes(k), `明细里缺少「${k}」`)
  }
  assert.match(p, /4,633/, '输入 token 数不对')
  assert.match(p, /deepseek-v4-pro/, '没有分模型明细')
})

test('未配置单价时显示 "—"，不编造金额', async () => {
  usageFixture = { ...USAGE, cost: null, priceConfigured: false }
  try {
    await enterGame()
    const meter = dom.window.document.querySelector('.usage')
    assert.ok(meter, '左上角没有用量表')
    assert.match(meter.textContent, /—/, '未配置单价时应显示 "—"')
    assert.ok(!/0\.00/.test(meter.textContent), '未配置单价时不该显示 0.00')

    meter.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 60))
    assert.match(dom.window.document.querySelector('.usage-pop').textContent,
      /未配置单价/, '明细里应提示去 .env 配置')
    // token 数照常显示，不受价格配置影响
    assert.match(meter.textContent, /7\.2k tok/)
  } finally {
    usageFixture = USAGE
  }
})

test('生成过程中往上翻，不会被强行拽回底部', async () => {
  // 曾经的毛病：任何内容变化都 scrollIntoView，玩家边读边被拽到底
  await enterGame()
  const log = dom.window.document.querySelector('.log')
  assert.ok(log, '找不到叙事区')

  const scrollTo = async (top) => {
    log.scrollTop = top
    log.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }))
    await new Promise((r) => setTimeout(r, 30))
  }

  // 玩家出手
  click(findButton('前进'))
  await new Promise((r) => setTimeout(r, 120))

  // 关键场景：生成还在继续，玩家主动往上翻去重读
  await scrollTo(150)
  const btn = dom.window.document.querySelector('.jump-latest')
  assert.ok(btn, '往上翻之后应出现「回到最新」按钮')
  assert.match(btn.textContent, /回到最新/)

  // 后面几段正文陆续到达 —— 不能把他拽回去
  await new Promise((r) => setTimeout(r, 320))
  assert.equal(log.scrollTop, 150, `后续内容把滚动条拽到了 ${log.scrollTop}，应当留在原处`)
  assert.ok(dom.window.document.querySelector('.jump-latest'), '仍应显示「回到最新」')

  // 点按钮才回到最新
  click(dom.window.document.querySelector('.jump-latest'))
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(log.scrollTop, log.scrollHeight, '点击后应滚到底部')
  assert.ok(!dom.window.document.querySelector('.jump-latest'), '回到最新后按钮应消失')
})

test('生成中的文字是逐渐出现的，不是一次糊上来', async () => {
  await enterGame()
  click(findButton('前进'))

  // 等第一段到达后取样，此时后面几段还没到
  await new Promise((r) => setTimeout(r, 200))
  const early = (dom.window.document.querySelector('.log').textContent.match(/第[一二三四五六七八]段/g) || []).length
  await new Promise((r) => setTimeout(r, 500))
  const later = (dom.window.document.querySelector('.log').textContent.match(/第[一二三四五六七八]段/g) || []).length

  assert.ok(early < 8, `取样太晚，${early} 段已经全到了，测不出渐进效果`)
  assert.ok(later > early, `文字没有逐渐增加：${early} → ${later}`)
})

test('点击选项后停在那一行，不被甩到段落结尾', async () => {
  // 之前的毛病：点完选项就跟到底，新正文一边生成一边把视线往下推，
  // 结果永远只看到最后几行。要的是从自己那一手开始往下读。
  await enterGame()
  const log = dom.window.document.querySelector('.log')

  click(findButton('前进'))
  await new Promise((r) => setTimeout(r, 250))

  assert.notEqual(log.scrollTop, log.scrollHeight,
    '点完选项就被拉到了最底部 —— 应当停在自己那一手的位置')
  // 停住之后要能一键回到最新
  assert.ok(dom.window.document.querySelector('.jump-latest'),
    '停在中间时应提供「回到最新」')
})

test('停在半途时，后续正文不会把视野推走', async () => {
  await enterGame()
  const log = dom.window.document.querySelector('.log')
  click(findButton('前进'))
  await new Promise((r) => setTimeout(r, 150))

  // 记下此刻位置，等后面的片段陆续到达
  const anchored = log.scrollTop
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(log.scrollTop, anchored, '后续生成把视野推走了')
})

test('三栏结构：左战斗 / 中剧情 / 右状态', async () => {
  await enterGame()
  const shell = dom.window.document.querySelector('.shell')
  const combat = shell.querySelector('.combat-side')
  const main = shell.querySelector('.main')
  const side = shell.querySelector('.side')

  assert.ok(combat && main && side, '三栏没有齐')
  assert.ok(shell.querySelector('.topbar'), '缺少顶栏')

  // DOM 顺序必须和视觉顺序一致：战斗 → 剧情 → 状态
  const order = [...shell.children].map((c) => c.className)
  assert.ok(order.indexOf('combat-side') < order.indexOf('main'), '战斗栏应在剧情栏左边')
  assert.ok(order.indexOf('main') < order.indexOf('side'), '剧情栏应在状态栏左边')

  // 不在战斗时，战斗栏给出备战数据而不是空白
  const ct = combat.textContent
  assert.match(ct, /备战/, '未开战时战斗栏没有备战信息')
  assert.match(ct, /生得术式/, '战斗栏缺少术式信息')
})

test('三栏各自独立滚动（长内容不会把整页顶开）', () => {
  // jsdom 不加载外部样式表，所以这里查 CSS 源而不是 getComputedStyle
  const css = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8')
  // 必须锚在行首，否则会把 `.main, .side, .combat-side {` 那条共用规则也匹配进来
  const block = (sel) => {
    const m = css.match(new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm'))
    return m ? m[1] : ''
  }
  // .main/.side/.combat-side 共用一条规则
  const shared = css.match(/\.main,\s*\.side,\s*\.combat-side\s*\{([^}]*)\}/)
  assert.ok(shared, '找不到三栏的共用规则')
  assert.match(shared[1], /min-height:\s*0/, '三栏缺少 min-height:0，grid 子项不会收缩，滚动会失效')

  assert.match(block('.side'), /overflow-y:\s*auto/, '状态栏应当独立滚动')
  assert.match(block('.combat-side'), /overflow-y:\s*auto/, '战斗栏应当独立滚动')
  assert.match(block('.log'), /overflow-y:\s*auto/, '剧情区应当独立滚动')
})

test('选项上方显示本回合局面提要', async () => {
  await enterGame()
  // 开局那条 recap 应当已经在
  let recap = dom.window.document.querySelector('.recap')
  assert.ok(recap, '选项上方没有局面提要')
  assert.match(recap.textContent, /局面/, '缺少标识')
  assert.match(recap.textContent, /杉泽第三高中/, '没有显示开局提要内容')

  // 它必须在选项列表之前
  const choices = dom.window.document.querySelector('.choices')
  const order = [...choices.children].map((c) => c.className)
  assert.ok(order.indexOf('recap') < order.indexOf('choices-head'),
    '提要应当排在选项之前')

  // 推一回合后要换成新的提要
  click(findButton('前进'))
  await waitFor('咒灵退进地下', { timeout: 15000 })
  recap = dom.window.document.querySelector('.recap')
  assert.match(recap.textContent, /咒灵退进地下/, '推回合后提要不更新')
  assert.ok(!/杉泽第三高中/.test(recap.textContent), '提要还是上一回合的')
})

test('正文与台词不受影响，提要是额外加的一行', async () => {
  await enterGame()
  click(findButton('前进'))
  await waitFor('咒灵退进地下', { timeout: 15000 })

  // 台词块要照旧存在 —— 提要是补充，不是替换
  const log = dom.window.document.querySelector('.log')
  assert.ok(log.querySelector('.narr'), '正文没了')
  assert.ok(log.querySelector('.line .who'), '台词没了')
  assert.ok(log.querySelector('.line .what'), '台词内容没了')
})

test('选项栏每次都有自定义行动输入', async () => {
  await enterGame()
  const input = dom.window.document.querySelector('.custom-row input')
  assert.ok(input, '没有自定义行动输入框')
  // 提示文案放在 placeholder 里，不再单独占一行
  assert.match(input.placeholder, /自定义行动/, '没有标明这是自定义行动')
  assert.match(input.placeholder, /例如/, '缺少输入示例')

  // 输入后提交，应当作为玩家行动进入日志
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '先退到巷口观察')
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))

  const btn = [...dom.window.document.querySelectorAll('.custom-row button')][0]
  assert.ok(btn && !btn.disabled, '输入后执行按钮应当可用')
  click(btn)
  await new Promise((r) => setTimeout(r, 200))

  assert.match(dom.window.document.querySelector('.log').textContent, /先退到巷口观察/,
    '自定义行动没有进入剧情日志')
})

test('选项区可以收起，把空间还给剧情', async () => {
  turnHasCombat = false // 用普通剧情回合测（遭遇战会接管选项栏）
  try {
  await enterGame()
  click(findButton('前进'))
  await waitFor('跳过当天，进行修炼', { timeout: 15000 })

  const choices = dom.window.document.querySelector('.choices')
  assert.ok(dom.window.document.querySelector('.choices-list'), '默认应当展开选项列表')

  const toggle = dom.window.document.querySelector('.choices-toggle')
  assert.ok(toggle, '没有收起按钮')
  assert.match(toggle.textContent, /选择行动/)
  assert.match(toggle.textContent, /\d/, '没有显示选项数量')

  click(toggle)
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(!dom.window.document.querySelector('.choices-list'), '收起后不该还有选项列表')
  assert.ok(choices.className.includes('collapsed'), '缺少 collapsed 类')
  // 收起后自定义输入必须还在 —— 那是主要输入方式之一
  assert.ok(dom.window.document.querySelector('.custom-row input'), '收起后自定义输入不该消失')
  } finally {
    turnHasCombat = true
  }
})

test('选项区高度有上限，不会占掉半个屏幕', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8')
  const block = (sel) => {
    const re = new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm')
    const m = css.match(re)
    return m ? m[1] : ''
  }

  // 整个选项区必须有和内容无关的天花板：修炼一次列 6 项，光靠"调紧凑"不够
  const box = block('.choices')
  const cap = (box.match(/max-height:\s*([^;]+)/) || [])[1]
  assert.ok(cap, '选项区没有高度上限 —— 选项一多就会挤压剧情')
  const pct = Number((cap.match(/(\d+(?:\.\d+)?)%/) || [])[1])
  assert.ok(pct && pct <= 45, `选项区最多只能占 ${cap}，超过一半就本末倒置了`)
  assert.match(box, /display:\s*flex/, '选项区需要 flex 才能让列表内部滚动')

  // 列表自己滚，不往外挤
  const list = block('.choices-list')
  assert.match(list, /overflow-y:\s*auto/, '超出上限时应当自己滚')
  assert.match(list, /min-height:\s*0/, '列表缺少 min-height:0，flex 子项不会收缩')

  // 剧情区必须能拿到剩余空间
  assert.match(block('.log-wrap'), /flex:\s*1/, '剧情区应当占据剩余空间')
})

test('亮色主题：底色是浅色、正文是深色', async () => {
  await enterGame()
  const body = dom.window.document.body
  // jsdom 不做布局，但能读到内联与样式表里的变量
  const css = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8')
  const bg = (css.match(/--bg:\s*(#[0-9a-fA-F]{6})/) || [])[1]
  assert.ok(bg, '找不到 --bg 变量')
  // 亮度足够高才算亮色主题
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  assert.ok(lum(bg) > 0.8, `--bg 是 ${bg}，不够亮`)
  const ink = (css.match(/--ink:\s*(#[0-9a-fA-F]{6})/) || [])[1]
  assert.ok(lum(ink) < 0.2, `--ink 是 ${ink}，不够深`)
  // 不能再有纯黑底
  assert.ok(!/background:\s*#0[0-9a-f]{5}/i.test(css), '样式里还残留纯黑背景')
  assert.ok(body, 'body 不存在')
})

test('三栏之间的空隙是 10px', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8')
  const gap = (css.match(/--gap:\s*(\d+)px/) || [])[1]
  assert.equal(gap, '10', `--gap 应当是 10px，实际 ${gap}px`)
  // 网格要用上这个变量
  assert.match(css, /\.shell\s*\{[^}]*gap:\s*var\(--gap\)/, '.shell 没有使用 --gap')
})

test('侧栏四块面板都渲染出来了', async () => {
  await enterGame()
  const t = text()
  for (const label of ['穿越者', '关系网', '宿傩手指追踪', '原作分歧追踪']) {
    assert.ok(t.includes(label), `侧栏缺少「${label}」`)
  }
  // 面板要显示特级内部细分（玩家可见），不是被过滤后的"特级"
  assert.ok(t.includes('一级'), '角色等级没显示')
  assert.ok(t.includes('虎杖悠仁'), '关系网没有内容')
})

test('遭遇战在对话流里询问，先问要不要打（可逃）', async () => {
  await enterGame()
  click(findButton('前进'))
  await waitFor('遭遇', { timeout: 15000 })

  // 询问块应当长在日志里，而不是一个覆盖层弹窗
  const inLog = dom.window.document.querySelector('.log .inquiry')
  assert.ok(inLog, '询问块没有出现在对话流里')
  assert.equal(dom.window.document.querySelector('.overlay'), null, '不该再有覆盖层弹窗')

  const t = inLog.textContent
  assert.match(t, /腐骨咒灵/, '询问块里没有敌人名')
  assert.match(t, /蚀骨/, '询问块里没有对方术式')
  assert.match(t, /不一定成功/, '没有提示脱离有风险')

  // 两个选项：迎战 / 脱离
  assert.ok(findButton('迎战'), '缺少「迎战」选项')
  assert.ok(findButton('尝试脱离'), '缺少「尝试脱离」选项')
})

test('选迎战后在对话流里问战斗模式（三种都给）', async () => {
  await enterGame()
  click(findButton('前进'))
  await waitFor('遭遇', { timeout: 15000 })

  click(findButton('迎战'))
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(dom.window.document.querySelector('.overlay'), null, '模式选择也不该是弹窗')
  const t = text()
  assert.match(t, /选择战斗模式/, '没有出现模式询问')
  assert.match(t, /手动模式（回合制）/, '缺少手动模式')
  assert.match(t, /跳过模式（快速结算）/, '缺少跳过模式')
  assert.match(t, /剧情描述式（自动演出）/, '缺少剧情模式')
})

test('脱离成功则跳过战斗，剧情继续', async () => {
  evadeSucceeds = true
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('遭遇', { timeout: 15000 })

    click(findButton('尝试脱离'))
    await waitFor('脱离', { timeout: 15000 })
    await new Promise((r) => setTimeout(r, 400))

    const t = text()
    assert.match(t, /避开了与/, '没有给出脱离成功的说明')
    assert.ok(!findButton('迎战'), '脱离成功后不该还挂着迎战选项')
    assert.ok(!dom.window.document.querySelector('.log .card'), '脱离成功不该进入战斗面板')
  } finally {
    evadeSucceeds = false
  }
})

test('脱离失败则被迫应战，直接进入模式选择', async () => {
  evadeSucceeds = false
  await enterGame()
  click(findButton('前进'))
  await waitFor('遭遇', { timeout: 15000 })

  click(findButton('尝试脱离'))
  await waitFor('被迫应战', { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 200))

  const t = text()
  assert.match(t, /甩不掉/, '没有给出脱离失败的说明')
  assert.match(t, /选择战斗模式/, '脱离失败后应直接进入模式选择')
  assert.ok(findButton('手动模式'), '应当可以选模式')
})

test('手动模式：行动栏渲染，并能打完一场', async () => {
  await enterGame()
  click(findButton('前进'))
  await waitFor('遭遇', { timeout: 15000 })

  click(findButton('迎战'))
  await waitFor('选择战斗模式', { timeout: 15000 })
  click(findButton('手动模式'))
  await new Promise((r) => setTimeout(r, 250))

  // 战斗数值在左侧战斗栏，不在中间剧情栏
  const cs = dom.window.document.querySelector('.combat-side')
  assert.ok(cs, '左侧没有战斗栏')
  const ct = cs.textContent
  assert.match(ct, /第 1 回合/, '战斗栏没有回合号')
  assert.match(ct, /腐骨咒灵/, '战斗栏没有敌方名字')
  assert.match(ct, /咒力估算/, '战斗栏缺少咒力估算')
  assert.match(ct, /领域/, '战斗栏缺少领域信息')

  const log = dom.window.document.querySelector('.log').textContent
  assert.ok(!/实时战况/.test(log), '战斗面板不该出现在中间的剧情栏里')

  // 行动栏仍然在底部
  const t = text()
  assert.match(t, /体术攻击/, '行动栏没有体术攻击')
  assert.match(t, /生得术式/, '行动栏没有术式')
  assert.match(t, /脱离战斗/, '行动栏没有脱离战斗')

  // 出一手，这一手结束战斗
  click(findButton('生得术式'))
  await new Promise((r) => setTimeout(r, 300))
  const after = text()
  assert.match(after, /战斗结算/, '没有出现战斗结算卡')
  assert.match(after, /胜利/, '结算卡没有写胜负')
  assert.match(after, /术式演练/, '结算卡没有战果')
})

/** 推进到"手动战斗里已经出了一手"的状态，用那一手的面板驱动演出层 */
async function enterJuicyCombat({ settle = 300 } = {}) {
  await enterGame()
  click(findButton('前进'))
  await waitFor('遭遇', { timeout: 15000 })
  click(findButton('迎战'))
  await waitFor('选择战斗模式', { timeout: 15000 })
  click(findButton('手动模式'))
  await new Promise((r) => setTimeout(r, 250))
  click(findButton('生得术式'))
  await new Promise((r) => setTimeout(r, settle))
}

test('领域展开有专属过场：大字、领域名、必中爆发，点一下能跳过', async () => {
  /*
   * 领域是这套设定里最贵的一招，原来它和"体术命中"共用同一条文字通道 ——
   * 花了大价钱铺开领域，屏幕上和普通一拳长得一模一样。
   */
  juicyAction = true
  try {
    await enterJuicyCombat()

    const cutin = dom.window.document.querySelector('.domain-cutin')
    assert.ok(cutin, '开出领域却没有过场')
    assert.match(cutin.textContent, /領域展開/, '过场里没有「領域展開」四个字')
    assert.match(cutin.textContent, /伏魔御厨子·残/, '过场没有写领域名')
    assert.match(cutin.textContent, /必中斩击/, '过场没有写必中效果')
    assert.match(cutin.textContent, /640/, '过场没有写必中爆发的伤害')
    // 三种领域打法完全不同，过场上必须先说清是哪一型
    assert.match(cutin.textContent, /伤害型/, '过场没有写领域类型')
    assert.match(cutin.textContent, /之后每回合追斩/, '过场没有写这一型的机制')

    // 一个字一个 span，才能错开做逐字入场
    assert.equal(cutin.querySelectorAll('.dc-kanji span').length, 4, '「領域展開」应该是四个独立的字')

    click(cutin)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(dom.window.document.querySelector('.domain-cutin'), null, '点一下应该能提前收场')
  } finally {
    juicyAction = false
  }
})

test('打出高光时：伤害飘字、连击计数、暴击提示、领域光环都在', async () => {
  juicyAction = true
  try {
    /*
     * 这一条查的全是"面板一到就该在"的东西，其中残影还是有寿命的。
     * 所以不等固定时长，而是盯着交手机读出现的那一刻 —— 面板落地即断言，
     * 残影的 460ms 留白怎么都够。
     */
    await enterJuicyCombat({ settle: 0 })
    await waitForEl('.beats')
    const cs = dom.window.document.querySelector('.combat-side')
    const ct = cs.textContent

    // 飘字：137 和 100 的区别得先被看见。
    // 数字是这一回合总共掉了多少（640 那一击 + 88 的领域追斩），
    // 和血条掉下去的长度必须是同一个数，不然看起来像引擎算错了。
    // 这一手是领域必中，必中优先于暴击 —— 玩家该看到的是"无视防御"而不是"运气好"
    const float = cs.querySelector('.float-dmg')
    assert.match(float?.textContent || '', /728/, '血条上没有伤害飘字（该是这一回合的总伤害）')
    assert.match(float.className, /k-sure/, '必中那一手的飘字应该是必中色')
    // 728 占 300 点血条的一大截，字号要跟着涨 —— 大小本身就是信息
    assert.match(float.className, /huge/, '打掉一大截血条的飘字该放大')

    // 交手机读：招名和数字分开摆，领域的追斩单独一笔
    const beats = cs.querySelector('.beats')
    assert.ok(beats, '没有交手机读')
    assert.match(beats.textContent, /领域展开/, '交手机读没写这一手是什么')
    assert.match(beats.textContent, /−640/, '交手机读没写直击伤害')
    assert.match(beats.textContent, /追斩 −88/, '领域追斩该单独一笔')
    assert.match(beats.textContent, /咒力 \+40/, '对面的咒力回复也该记一笔')

    /*
     * 自己这边的血条也要飘。以前只有敌方血条会出数字 ——
     * 挨了一记重的，玩家只看见血条短了一截，不知道短了多少。
     * 这一回合对面打过来 120，飘字该是负数。
     */
    const floats = [...cs.querySelectorAll('.float-dmg')].map((e) => e.textContent)
    assert.equal(floats.length, 2, `两条血条该各有一份飘字，实际 ${floats.length} 份`)
    assert.ok(floats.some((t) => t.includes('−120')), `我方血条上没写这一回合掉了多少：${floats.join(' / ')}`)

    // 血条残影：掉下去的那一截留住一拍再收。
    // 残影是限时存在的（收掉之后就不该留在 DOM 里），所以这里只断言
    // "这一刻它在" —— 时序由 FxBar 保证比血条自己的过渡更长。
    assert.ok(cs.querySelector('.bar-ghost'), '血条没有留下掉血残影')

    // 连击与打断
    assert.match(ct, /3/, '战斗栏没有连击计数')
    assert.match(ct, /连击/, '连击没有文字标签')
    assert.match(ct, /暴击/, '没有暴击提示')
    assert.match(cs.textContent, /打断|踉跄/, '没有写出对方被这一手压住')

    // 我方领域还挂着，剩余回合数要看得见
    const aura = cs.querySelector('.domain-aura')
    assert.ok(aura, '领域展开中却没有光环')
    assert.match(aura.textContent, /剩 3 回合/, '光环没写剩余回合')

    // 必中那一行要标明无视防御 —— 否则玩家会以为计算式漏了一项
    assert.match(ct, /必中·无视防御/, '必中那一手没有标明无视防御')
  } finally {
    juicyAction = false
  }
})

test('规则型领域压着玩家时：战斗栏要写明被封了什么', async () => {
  /*
   * 规则型领域的强度全在"你的招不能用"上，而这件事光靠按钮变灰说不清楚 ——
   * 玩家只会以为是自己咒力不够。被封的清单必须写在明面上。
   */
  sealedCombat = true
  juicyAction = true
  try {
    await enterJuicyCombat()
    const cs = dom.window.document.querySelector('.combat-side')
    const chip = cs.querySelector('.seal-chip')
    assert.ok(chip, '被规则压着却没有提示')
    assert.match(chip.textContent, /规则压制/, '没写清是规则造成的')
    for (const what of ['术式', '反转术式', '领域', '防御']) {
      assert.match(chip.textContent, new RegExp(what), `没写清 ${what} 被封`)
    }
    // 被压的是自己：这一条要用告警色，不能和"我压着对面"混成一样
    assert.match(chip.className, /on-me/, '被压的是玩家时该用告警样式')

    // 对面那一手也递不出去 —— 交手机读要如实写出来
    assert.match(cs.querySelector('.beats').textContent, /没递出去|术式没递出去/,
      '对面被封住的那一手没有如实记下来')
  } finally {
    sealedCombat = false
    juicyAction = false
  }
})

test('转完一天：陈旧的剧情选项清掉，轮盘展开顶上', async () => {
  /*
   * 两条规则合起来才是"时机不别扭"：
   *   · 转一天之后，上一轮留下的选项过期了 —— 里面还混着"迎战"这种带引擎语义的，
   *     留着就能被重复点，等于把一场已经打完的遭遇再触发一次。
   *   · 选项清空之后，轮盘得顶上来当主操作台；否则玩家面前一个能按的都没有。
   * 而剧情选项一回来，轮盘又要让位（见另一条用例）。
   */
  playModeFixture = 'combat'
  try {
    await enterGame()
    await waitFor('日常轮盘', { timeout: 15000 })
    assert.ok(dom.window.document.querySelector('.choices-list'), '这时该摆着剧情选项')

    click(findButton('转一天'))
    await new Promise((r) => setTimeout(r, 200))

    assert.equal(dom.window.document.querySelector('.choices-list'), null, '陈旧的剧情选项没清掉')
    assert.ok(dom.window.document.querySelector('.wheel-panel').className.includes('open'),
      '选项都清空了，轮盘还收着，玩家面前一个能按的都没有')
    // 自定义行动一直在，玩家想干什么仍然写得出来
    assert.ok(dom.window.document.querySelector('.custom-row'), '选项清空后连自定义行动都没了')
  } finally {
    playModeFixture = 'story'
  }
})

test('跳过模式也会播领域过场，并回顾这一场打了几次暴击', async () => {
  /*
   * 跳过 / 剧情模式不逐回合推面板，战斗只剩一段文字。
   * 手动模式那套演出（过场、暴击）在这两种模式里同样该有 ——
   * 否则切了模式就像换了个游戏。
   */
  highlightDomain = true
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('遭遇', { timeout: 15000 })
    click(findButton('迎战'))
    await waitFor('选择战斗模式', { timeout: 15000 })
    click(findButton('跳过模式'))
    await new Promise((r) => setTimeout(r, 300))

    const cutin = dom.window.document.querySelector('.domain-cutin')
    assert.ok(cutin, '跳过模式里开了领域却没播过场')
    assert.match(cutin.textContent, /領域展開/)
    assert.match(cutin.textContent, /伏魔御厨子·残/)

    const toasts = dom.window.document.querySelector('.toasts')?.textContent || ''
    assert.match(toasts, /2 次暴击/, '整场的高光没有回顾给玩家')
  } finally {
    highlightDomain = false
  }
})

/** 正文里正在流式往外吐的那一段（最后一条 .narr） */
const streamText = () => {
  const all = dom.window.document.querySelectorAll('.log .narr')
  return all.length ? all[all.length - 1].textContent : ''
}
const waitForEl = async (sel, { timeout = 20000 } = {}) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const el = dom.window.document.querySelector(sel)
    if (el) return el
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等待元素超时：${sel}`)
}

test('领域特写的那几秒，正文先停在原地等它演完', async () => {
  /*
   * 「領域展開」是全屏的。正文要是在背后照常吐，等特写撤掉，
   * 玩家看到的已经是半句话的尾巴 —— 最该看的那几个字正好错过。
   */
  slowHighlight = true
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('遭遇', { timeout: 15000 })
    click(findButton('迎战'))
    await waitFor('选择战斗模式', { timeout: 15000 })
    click(findButton('跳过模式'))

    const cutin = await waitForEl('.domain-cutin')
    const before = streamText()
    assert.match(before, /一刀两断/, '特写之前该先看到这一场的开场')

    // 特写还盖着：后面的正文已经在缓冲区里了，但一个字都不该往外冒
    await new Promise((r) => setTimeout(r, 800))
    assert.equal(streamText(), before, '特写还盖着，正文却自己往下跑了')
    assert.ok(!text().includes('四面八方'), '特写期间的正文不该已经吐出来')

    // 撤掉特写，节奏接回去
    click(cutin)
    await new Promise((r) => setTimeout(r, 500))
    assert.match(text(), /四面八方/, '特写撤掉之后正文该接着往下吐')
  } finally {
    slowHighlight = false
  }
})

test('战斗正文被截短时：屏幕上只留短的那份，不会两段叠着', async () => {
  /*
   * 战斗向每次输出限 400 字。服务端是在文字**已经吐完**之后才发现超了，
   * 于是截短并重发一次（reset + narration）。
   * 前端要是不认这个 reset，先前那份长文还攥在手里，屏幕上就是
   * "长文 + 截短版"接在一起 —— 比不截还长。
   */
  trimmedCombat = true
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('遭遇', { timeout: 15000 })
    click(findButton('迎战'))
    await waitFor('选择战斗模式', { timeout: 15000 })
    click(findButton('跳过模式'))
    await waitFor('反手一刀', { timeout: 15000 })

    assert.ok(!text().includes('雨幕'), '被截掉的那一段还留在屏幕上')
  } finally {
    trimmedCombat = false
  }
})

test('手动模式同样认重置：战斗栏里不会留下超预算的那一段', async () => {
  trimmedCombat = true
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('遭遇', { timeout: 15000 })
    click(findButton('迎战'))
    await waitFor('选择战斗模式', { timeout: 15000 })
    click(findButton('手动模式'))
    await waitFor('反手一刀', { timeout: 15000 })

    assert.ok(!text().includes('雨幕'), '被截掉的那一段还留战斗栏里')
    // 重置不能把行动栏一起清掉 —— 那样玩家就没法出招了
    assert.ok(dom.window.document.querySelector('.act-grid button.choice'), '行动栏被重置冲掉了')
  } finally {
    trimmedCombat = false
  }
})

test('数字键直接出招（按屏幕上印的编号，不是按下标）', async () => {
  juicyAction = true
  try {
    await enterJuicyCombat()
    const win = dom.window
    // 先退回第 2 回合前的状态没有意义 —— 直接确认编号和按钮对得上：
    // 行动栏第 1 格是「体术攻击」，屏幕上写着 1。
    const first = dom.window.document.querySelector('.act-grid button.choice')
    assert.match(first.textContent, /^1\./, '第一格行动应该印着编号 1')

    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: '1', bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))

    // 打出去了：面板换成了这一手之后的样子（第 3 回合）
    assert.match(
      dom.window.document.querySelector('.combat-side').textContent,
      /第 3 回合/,
      '按下数字键没有出招',
    )
  } finally {
    juicyAction = false
  }
})

test('编号是「※」的选项不吃数字键', async () => {
  /*
   * 修炼项在选项栏里的序号是「※」而不是数字 —— 它不参与编号。
   * 如果按数组下标去数，按下 2 就会打到屏幕上写着 ※ 的那一格：
   * 手指按的和眼睛看的对不上，是最难忍的一类错。
   */
  turnHasCombat = false
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('跳过当天，进行修炼', { timeout: 15000 })
    await new Promise((r) => setTimeout(r, 150))

    const list = dom.window.document.querySelector('.choices-list')
    const marked = [...list.querySelectorAll('button.choice')]
      .find((b) => b.querySelector('.idx')?.textContent.includes('※'))
    assert.ok(marked, '修炼项应该用 ※ 标出来，而不是混进数字里')

    const before = text()
    const win = dom.window
    // 屏幕上根本没有"2"这一格，按 2 就不该有任何反应
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: '2', bubbles: true }))
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(text(), before, '按下一个屏幕上不存在的编号，不该触发任何选项')
  } finally {
    turnHasCombat = true
  }
})

test('出错只弹一条能关掉的横幅，正文和选项都还在', async () => {
  /*
   * 原来 error 一旦有值就整屏换成一张"出错了"卡片：打着打着模型抖一下，
   * 正文、行动栏、角色数值全没了，只剩一个「知道了」。
   */
  turnFails = true
  try {
    await enterGame()
    const logBefore = dom.window.document.querySelector('.log')?.textContent || ''
    assert.ok(logBefore.length > 0, '进游戏时就该有正文了')

    click(findButton('前进'))
    await new Promise((r) => setTimeout(r, 400))

    const banner = dom.window.document.querySelector('.err-banner')
    assert.ok(banner, '失败时没有出现错误横幅')
    assert.match(banner.textContent, /模型连接超时/, '横幅没写清楚出了什么事')

    // 关键：局面还在
    assert.ok(dom.window.document.querySelector('.log'), '出错不该把正文换掉')
    assert.ok(dom.window.document.querySelector('.choices'), '出错不该把操作栏换掉')
    assert.ok(findButton('存档'), '出错不该把顶栏换掉')

    banner.querySelector('.eb-close').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(dom.window.document.querySelector('.err-banner'), null, '横幅应该能关掉')
  } finally {
    turnFails = false
  }
})

test('轮盘能收起也能展开，收起时仍然看得见这一次转到哪儿', async () => {
  playModeFixture = 'combat'
  try {
    await enterGame()
    await waitFor('日常轮盘', { timeout: 15000 })

    const panel = () => dom.window.document.querySelector('.wheel-panel')
    assert.ok(panel().className.includes('compact'), '轮盘默认应该是收起的 —— 两个操作台并排会不知道该按哪边')
    assert.equal(panel().querySelectorAll('.grow-row').length, 0, '收起时不该还摆着六条进度条')
    // 收起了也得看得见落点，否则转完一天回到状态栏发现数字没动，像白转了
    assert.ok(panel().querySelector('.wheel-landed'), '收起时应该把这次的落点顶在转盘下面')

    click(panel().querySelector('.wheel-toggle'))
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(panel().className.includes('open'), '点「进度」应该能展开')
    assert.equal(panel().querySelectorAll('.grow-row').length, 6, '展开后应该给出六条进度条')

    click(panel().querySelector('.wheel-toggle'))
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(panel().className.includes('compact'), '再点一下应该收回去')
  } finally {
    playModeFixture = 'story'
  }
})

test('跳过模式：直接给演出与结算，不给行动栏', async () => {
  await enterGame()
  click(findButton('前进'))
  await waitFor('遭遇', { timeout: 15000 })

  click(findButton('迎战'))
  await waitFor('选择战斗模式', { timeout: 15000 })
  click(findButton('跳过模式'))
  await new Promise((r) => setTimeout(r, 200))

  const t = text()
  assert.match(t, /一刀两断/, '没有渲染演出文本')
  assert.match(t, /战斗结算/, '没有出现结算卡')
  assert.ok(!findButton('体术攻击'), '跳过模式不该出现行动栏')

  // 打完一场是整局情绪最高的一拍，只落在日志卡片上的话，玩家低头按键盘时就错过了
  const toasts = dom.window.document.querySelector('.toasts')?.textContent || ''
  assert.match(toasts, /胜利/, '拿下了却没有报喜')
  assert.match(toasts, /击退了二级的腐骨咒灵/, '报喜只说"胜利"，不说是哪一场')
})

test('修炼也是对话流里的询问，不是弹窗', async () => {
  // 遭遇战会接管选项栏（架还没打完就跳过当天去修炼说不通），
  // 所以用没有战斗的一回合来测修炼流程
  turnHasCombat = false
  try {
  await enterGame()
  click(findButton('前进'))
  await waitFor('跳过当天，进行修炼', { timeout: 15000 })

  const trainBtn = findButton('跳过当天，进行修炼')
  assert.ok(trainBtn, '选项栏里没有修炼入口')
  click(trainBtn)
  await waitFor('跳过当天 · 修炼', { timeout: 15000 })

  // 修炼也是询问块 + 选项，不是弹窗
  assert.ok(dom.window.document.querySelector('.log .inquiry'), '修炼询问块没进对话流')
  assert.equal(dom.window.document.querySelector('.overlay'), null, '修炼不该弹窗')

  const t = text()
  assert.match(t, /体能训练/, '没有列出修炼项目')
  assert.match(t, /咒力冥想/, '没有列出全部项目')
  assert.match(t, /术式演练/, '没有列出全部项目')

  click(findButton('体能训练'))
  await new Promise((r) => setTimeout(r, 200))
  const after = text()
  assert.match(after, /修炼 · 体能训练/, '没有渲染修炼结果')
  assert.match(after, /\+22\.5%/, '没有显示进度增量')
  assert.match(after, /血条上限/, '没有显示数值提升')
  } finally {
    turnHasCombat = true
  }
})

// ---------------------------------------------------------------- 战斗向

test('战斗向：主界面有日常轮盘，转一天落一个方向', async () => {
  playModeFixture = 'combat'
  try {
    await enterGame()
    const wp = dom.window.document.querySelector('.wheel-panel')
    assert.ok(wp, '战斗向的主界面没有日常轮盘')

    const t = wp.textContent
    assert.match(t, /日常轮盘/, '没有标题')
    assert.match(t, /累计修炼 12 天/, '没有累计天数')
    assert.match(t, /疲劳/, '没有疲劳系数')
    assert.match(t, /少年院任务/, '没有显示下一个剧情节点')
    assert.match(t, /还有\s*19\s*天/, `没有显示倒计时：${t.slice(0, 80)}`)

    // 六个扇区都画出来，落点计数跟着走
    const labels = [...wp.querySelectorAll('svg text')].map((n) => n.textContent)
    assert.equal(labels.length, 6, `轮盘应有 6 个扇区，实际 ${labels.length}`)
    assert.ok(labels.some((l) => l.includes('体能') && l.includes('×5')), '扇区没有标出落点次数')

    // 右边状态栏的成长面板：属性是攒满 100% 才跳一次的，进度条就是那句
    // "我确实练到了"。没有它，玩家转完一天回头看右边，数字纹丝不动，以为白转了
    const side = () => dom.window.document.querySelector('.side')
    const rows = [...side().querySelectorAll('.grow-row')]
    assert.equal(rows.length, 6, `右侧栏应有六条成长进度，实际 ${rows.length}`)
    assert.match(side().textContent, /成长 · 修炼 12 天/, '成长面板没标出累计天数')
    assert.match(rows[0].textContent, /38%/, `体能那条进度不对：${rows[0].textContent}`)

    // 转一天：引擎算完就落进日志，不用等模型
    click(findButton('转一天'))
    await waitFor('落点 体能', { timeout: 15000 })
    const log = dom.window.document.querySelector('.log').textContent
    assert.match(log, /第 13 天/, '没有记下这一天')
    assert.match(log, /进度 \+6\.2%/, '没有渲染当天的进度')
    assert.match(log, /44%/, '没有显示这条进度条现在到哪儿了')
    assert.match(log, /血条上限/, '没有渲染属性提升')
  } finally {
    playModeFixture = 'story'
  }
})

test('战斗向：练到剧情当天，轮盘变成「介入这场战斗」', async () => {
  playModeFixture = 'combat'
  try {
    await enterGame()
    const btn = findButton('练到剧情当天')
    assert.ok(btn, '没有「练到剧情当天」按钮')
    assert.match(btn.textContent, /19\s*天/, '没有标出还要练几天')

    click(btn)
    await waitFor('共 19 天', { timeout: 20000 })

    // 合并成一张日报，而不是十九行流水账
    const log = dom.window.document.querySelector('.log').textContent
    assert.match(log, /2018-06-05\s*→\s*2018-06-24/, '没有显示练过的日期区间')
    assert.match(log, /体能训练\s*×7/, '没有合并各方向的天数')
    assert.match(log, /血条上限/, '没有显示成长')
    assert.match(log, /52%/, '日报没带出六条进度条各自到哪儿了')

    // 到当天就该打起来：轮盘当场让位给这场仗的询问 —— 而不是继续摆着
    // 一个可点的「转一天」让人接着转（那正是"到节点了还在让我转轮盘"的病灶）
    await waitFor('少年院特级咒胎', { timeout: 15000 })
    assert.equal(dom.window.document.querySelector('.wheel-panel'), null,
      '介入战都挂上了，轮盘还摆在那儿让人接着转')
    assert.ok(dom.window.document.querySelector('.log .inquiry'), '介入战的询问块没进对话流')
    assert.ok(findButton('迎战'), '介入战缺少迎战选项')
    assert.ok(findButton('尝试脱离'), '介入战缺少脱离选项')
  } finally {
    playModeFixture = 'story'
  }
})

test('战斗向：开局就站在剧情节点当天，轮盘直接锁住等开打', async () => {
  playModeFixture = 'combat'
  wheelReady = true
  try {
    await enterGame()

    const wp = dom.window.document.querySelector('.wheel-panel')
    assert.match(wp.textContent, /「少年院任务」就在今天/, `没认出今天就是剧情节点：${wp.textContent.slice(0, 80)}`)

    const btn = (label) => [...wp.querySelectorAll('.wheel-btn')].find((b) => b.textContent.includes(label))
    assert.ok(btn('转一天').disabled, '节点当天「转一天」还能点')
    assert.ok(!btn('介入这场战斗').disabled, '节点当天「介入这场战斗」被禁掉了 —— 人就卡在这儿了')
    assert.match(wp.textContent, /先打完这一场/, '没有把原因说出来')
  } finally {
    playModeFixture = 'story'
    wheelReady = false
  }
})

// ---------------------------------------------------------------- 反转术式 / 疗伤

test('反转术式不占回合：按下去血条当场动，回合数不动', async () => {
  wounded = true
  hpCur = 40
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('遭遇', { timeout: 15000 })
    click(findButton('迎战'))
    await waitFor('选择战斗模式', { timeout: 15000 })
    click(findButton('手动模式'))
    await new Promise((r) => setTimeout(r, 250))

    // 自由行动单独占一行，和普通行动分开 —— 否则玩家以为按了这回合就过去了
    const free = dom.window.document.querySelector('.free-row')
    assert.ok(free, '行动栏上方没有"不占回合"那一行')
    assert.match(free.textContent, /不占回合/)
    assert.match(free.textContent, /反转术式·初步/, '没有反转术式按钮')
    assert.match(free.textContent, /消耗 50 咒力/, '没有写明代价')

    const side = () => dom.window.document.querySelector('.side').textContent
    assert.match(side(), /40 \/ 100/, '按之前状态栏应当显示带伤')

    click(findButton('反转术式·初步'))
    await waitFor('伤口在数秒内收拢', { timeout: 15000 })

    // 关键：血条当场走到 70，回合还是第 1 回合
    assert.match(side(), /70 \/ 100/, `状态栏没有实时更新血条：${side().slice(0, 120)}`)
    assert.match(dom.window.document.querySelector('.combat-side').textContent, /第 1 回合/,
      '反转术式不该推进回合')
    // 本回合用过了要说清楚，而不是按钮还亮着点了没反应
    const again = dom.window.document.querySelector('.free-row button')
    assert.ok(again.disabled, '本回合用过一次后应当禁用')
    assert.match(again.textContent, /本回合已用过/)
  } finally {
    wounded = false
  }
})

test('还没练成反转术式时，那一格照样在，只是灰着写明去哪儿练', async () => {
  reverseUnknown = true
  try {
    await enterGame()
    click(findButton('前进'))
    await waitFor('遭遇', { timeout: 15000 })
    click(findButton('迎战'))
    await waitFor('选择战斗模式', { timeout: 15000 })
    click(findButton('手动模式'))
    await new Promise((r) => setTimeout(r, 250))

    const free = dom.window.document.querySelector('.free-row')
    assert.ok(free, '没练成时整行都消失了 —— 玩家不会知道有这个技能')
    assert.match(free.textContent, /未掌握/)
    // 灰着的原因必须写在按钮上，不能只挂在 title 上（触屏看不到）
    assert.match(free.textContent, /先修炼「反转术式修习」/)
    assert.ok(free.querySelector('button').disabled, '没练成不该能按')
  } finally {
    reverseUnknown = false
  }
})

test('受伤时多出疗伤入口，选一种当场结算', async () => {
  wounded = true
  hpCur = 40
  try {
    await enterGame()
    const entry = findButton('疗伤')
    assert.ok(entry, '受伤时选项栏里没有疗伤入口')
    click(entry)
    await waitFor('选一种', { timeout: 15000 })

    assert.ok(dom.window.document.querySelector('.log .inquiry'), '疗伤询问块没进对话流')
    assert.equal(dom.window.document.querySelector('.overlay'), null, '疗伤不该弹窗')

    const t = text()
    assert.match(t, /反转术式/, '没有列出反转术式')
    assert.match(t, /静养一天/, '没有列出静养')
    assert.match(t, /家入硝子/, '没有列出家入硝子')
    // 用不了的那条要写明理由，不能只挂个 tooltip
    assert.match(t, /你和她的关系还不够/, '用不了的方法没有说明原因')

    click(findButton('静养一天'))
    await waitFor('疗伤 · 静养一天', { timeout: 15000 })
    const log = dom.window.document.querySelector('.log').textContent
    assert.match(log, /生命 \+18/, '没有显示回血量')
    assert.match(log, /耗时 1 天/, '没有显示花了几天')
    assert.match(dom.window.document.querySelector('.side').textContent, /58 \/ 100/,
      '状态栏没有刷新到结算后的血条')
  } finally {
    wounded = false
  }
})

test('没受伤时不该挂着疗伤入口', async () => {
  wounded = false
  await enterGame()
  assert.ok(!findButton('疗伤'), '满血时不该出现疗伤选项')
})
