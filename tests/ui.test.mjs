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
  training: {}, combat: null, pendingCombat: null, combatLog: [],
}

/** 造一个够用的假后端 */
function makeFetchStub(log) {
  return async (url, opts = {}) => {
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
    if (u.includes('/api/health')) return json({ ok: true })
    if (u.endsWith('/api/session') && method === 'POST') return json({ sessionId: 'ui-test', phase: 'storyline' })
    // ---- 故事线 ----
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
      // 分 8 段慢速吐，中间留出足够时间让测试去滚动
      const chunks = ['第一段。', '第二段，咒灵从阴影里爬出来。', '第三段。', '第四段，双方试探。', '第五段。', '第六段。', '第七段。', '第八段收尾。']
      return sseSlow([
        ...chunks.map((t) => ['narration', { text: t }]),
        ['done', {
          turn: 2,
          dialogue: [{ speaker: '虎杖悠仁', text: '小心！' }],
          notes: [],
          choices: [
            { id: '1', label: '迎战', kind: 'story' },
            { id: 'T', label: '【跳过当天，进行修炼】', kind: 'training' },
          ],
          panel: null,
          usage: usageFixture,
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
        }
        return sse([
          ['panel', { panel, text: '', mode: 'manual' }],
          ['awaiting', { actions: [
            { type: 'physical', label: '体术攻击', enabled: true },
            { type: 'technique', label: '生得术式·测试术式', enabled: true },
            { type: 'defend', label: '防御（回复咒力）', enabled: true },
            { type: 'flee', label: '脱离战斗', enabled: true },
          ] }],
          // 契约：done.snapshot 是角色快照；战斗回合面板只走 panel 事件
          ['done', { over: false, snapshot: CHARACTER_SNAPSHOT, text: '' }],
        ])
      }
      return sse([
        ['narration', { text: '一刀两断。' }],
        ['done', {
          over: true, outcome: { winner: 'player', loser: 'enemy' }, summary: '击退了二级的腐骨咒灵',
          rewards: { gains: { 术式演练: 6.5 }, notes: ['术式实战运用'] }, ups: [],
          panel: null, combat: null,
        }],
      ])
    }

    // ---- 战斗：出一手，这一手直接打死 ----
    if (u.endsWith('/combat/action')) {
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
        log: [{ type: 'turn', turn: 1, narration: '测试正文。', dialogue: [{ speaker: '宿傩', text: '特级？' }], notes: [], choices: ['前进', '后退', '观察'] }],
        panel: CHARACTER_SNAPSHOT,
        usage: usageFixture,
        choices: [{ id: '1', label: '前进', kind: 'story' }],
        actions: null, combat: null, inCombat: null,
      })
    }
    // ---- 自主定义 ----
    if (u.includes('/attributes/custom')) {
      const brief = JSON.parse(opts.body || '{}').brief || ''
      if (String(brief).trim().length < 2) return json({ error: '请先描述你想要的战斗风格' }, 400)
      return json({ usage: usageFixture, profile: {
        slot: '自定义', overallGrade: '一级', ce: { value: 4200, grade: '一级' },
        hp: { value: 1180, grade: '一级' }, cursedDamage: { value: 193, grade: '一级' },
        physicalDamage: { value: 117, grade: '一级' }, efficiency: { value: 0.88, grade: '一级' },
        techniqueGrade: '一级', techniqueMultiplier: 2.5,
        techniqueName: '绯缠咒法', techniqueEffect: '绯色咒线缠住退路，只能正面接招',
        techniqueCooldown: 2, domainUnlocked: false, domain: { unlocked: false },
        reverseCursedTechnique: '未掌握', toolCount: 0, tool: null,
        talents: ['体术天赋', '抗痛性强'], playstyle: '贴脸近战压制', brief,
      } })
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
        narration: '开局正文。', dialogue: [{ speaker: '虎杖悠仁', text: '你是谁？' }], notes: [],
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

test('开局属性页有「自主定义」第四项，能生成并采用', async () => {
  await mount()
  await gotoAttributes()

  // 四张卡：A / B / C / 自主定义
  const cards = [...dom.window.document.querySelectorAll('.pcard')]
  assert.equal(cards.length, 4, `应有 3 份预设 + 1 项自主定义，实际 ${cards.length} 张`)
  const custom = dom.window.document.querySelector('.pcard.custom')
  assert.ok(custom, '找不到自主定义卡片')
  assert.match(custom.textContent, /自主定义/)

  // 必须写明等级不可指定，否则玩家会以为能点单"我要超特级"
  assert.match(custom.textContent, /等级由引擎按设定概率掷出/, '没有说明等级不可指定')

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

  const cards = [...dom.window.document.querySelectorAll('.pcard')]
  assert.equal(cards.length, 4, `身份页也应有 4 张卡，实际 ${cards.length}`)
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
