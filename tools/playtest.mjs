/**
 * 无头试玩：把真实构建产物挂进 jsdom，打真实 API，逐屏打印玩家看到的内容。
 *
 * 和 tests/ 里的测试不同 —— 那些是断言，这个是"读一遍实际输出"，
 * 用来发现断言覆盖不到的叙事质量、数值手感、流程顺畅度问题。
 *
 * 用法：
 *   1. 先起服务：npm run server
 *   2. node tools/playtest.mjs [seed提示]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = process.env.PLAYTEST_API || 'http://localhost:8787'
const DIST = path.join(ROOT, 'dist')

// ---------------------------------------------------------------- 输出

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grn: (s) => `\x1b[32m${s}\x1b[0m`,
  yel: (s) => `\x1b[33m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`,
}
const step = (n, s) => console.log(`\n${C.b(C.cy(`━━━ ${n}. ${s} `))}${C.dim('━'.repeat(Math.max(0, 46 - s.length)))}`)
const info = (s) => console.log(`  ${C.dim('·')} ${s}`)

function wrap(text, indent = '  ', width = 86) {
  const out = []
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    let line = ''
    for (const ch of para) {
      line += ch
      // 中文按 1 宽度算，接近终端的显示宽度
      if (line.length >= width) { out.push(indent + line); line = '' }
    }
    if (line) out.push(indent + line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- 环境

function findBundle() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  const m = html.match(/<script[^>]+src="([^"]+\.js)"/)
  if (!m) throw new Error('dist/index.html 里找不到入口脚本，先 npm run build')
  return path.join(DIST, m[1].replace(/^\//, ''))
}

const requests = []
let dom

async function mountApp() {
  const bundle = findBundle()
  dom = new JSDOM(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'), {
    url: 'http://localhost:5173/', pretendToBeVisual: true,
  })
  dom.window.Element.prototype.scrollIntoView = function () {}
  dom.window.HTMLElement.prototype.scrollIntoView = function () {}

  const g = globalThis
  const define = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true })
  define('window', dom.window)
  define('document', dom.window.document)
  define('IS_REACT_ACT_ENVIRONMENT', false)
  for (const k of [
    'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeList',
    'DocumentFragment', 'Text', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
    'MutationObserver', 'MessageChannel', 'getComputedStyle', 'FormData', 'Blob', 'File',
    'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'localStorage',
  ]) if (dom.window[k] !== undefined) define(k, dom.window[k])
  define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 16))
  define('cancelAnimationFrame', (id) => clearTimeout(id))

  // 相对路径转成真实后端地址，其余原样交给 Node 的 fetch（流式响应照样能读）
  const realFetch = globalThis.fetch
  define('fetch', (url, opts) => {
    const u = String(url)
    const full = u.startsWith('http') ? u : API + u
    requests.push(`${opts?.method || 'GET'} ${u}`)
    return realFetch(full, opts)
  })

  await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`)
  await sleep(200)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const txt = () => dom.window.document.getElementById('root')?.textContent || ''
const btns = () => [...dom.window.document.querySelectorAll('button')]
const findBtn = (label) => btns().find((b) => b.textContent.includes(label))

function click(el, label) {
  if (!el) throw new Error(`找不到按钮：${label}`)
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
}

/** 等屏幕上出现某个东西 */
async function waitFor(pattern, { timeout = 90000, label = String(pattern) } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (new RegExp(pattern).test(txt())) return true
    await sleep(120)
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`)
}

/**
 * 等界面安静下来。
 * 必须要求"持续安静" —— 只看一次采样会踩到两段请求之间的空档
 * （上一个请求 setBusy(false) 与下一个 setBusy(true) 之间有一帧没 spinner），
 * 结果误判成已完成，后面的断言全部对着半成品界面跑。
 */
/** 断言没有覆盖层弹窗 —— 询问现在都长在对话流里 */
function assert_no_overlay(msg) {
  const ov = dom.window.document.querySelector('.overlay')
  note(!ov ? 'ok' : 'bad', ov ? `${msg}（实际出现了 .overlay）` : msg)
}

/** 当前是否有遭遇战询问块（取代了原来的弹窗） */
function hasCombatInquiry() {
  return [...dom.window.document.querySelectorAll('.log .inquiry')]
    .some((el) => el.textContent.includes('遭遇'))
}

async function waitIdle({ timeout = 150000, quietMs = 1200 } = {}) {
  const t0 = Date.now()
  let quietSince = null
  while (Date.now() - t0 < timeout) {
    const busy = dom.window.document.querySelector('.spinner') || dom.window.document.querySelector('.caret')
    if (busy) quietSince = null
    else {
      if (quietSince === null) quietSince = Date.now()
      if (Date.now() - quietSince >= quietMs) return
    }
    await sleep(120)
  }
  console.log(C.yel(`  ! waitIdle 超时（${timeout}ms）`))
}

// ---------------------------------------------------------------- 主流程

const findings = []
const note = (kind, msg) => { findings.push({ kind, msg }); console.log(`  ${kind === 'bad' ? C.red('✘') : kind === 'warn' ? C.yel('!') : C.grn('✔')} ${msg}`) }

async function main() {
  console.log(C.b('\n╔══════════════════════════════════════════════════════════╗'))
  console.log(C.b('║   回战 · 宿傩篇 —— 无头试玩                                ║'))
  console.log(C.b('╚══════════════════════════════════════════════════════════╝'))
  console.log(C.dim(`  后端 ${API}　构建产物 ${path.relative(ROOT, findBundle())}`))

  await mountApp()

  // ---------------------------------------------------------- 开始

  step(1, '开始界面')
  const startText = txt()
  note(startText.includes('回战') ? 'ok' : 'bad', startText.includes('回战') ? '开始界面正常渲染' : '开始界面没渲染出来')
  note(findBtn('开始生成') ? 'ok' : 'bad', findBtn('开始生成') ? '有「开始生成」按钮' : '缺少开始按钮')

  const t0 = Date.now()
  click(findBtn('开始生成'), '开始生成')
  await waitFor('第一步 · 属性', { timeout: 120000, label: '属性档案生成' })
  info(`属性档案生成耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // ---------------------------------------------------------- 属性

  step(2, '属性档案 A / B / C')
  const cards = [...dom.window.document.querySelectorAll('.pcard')]
  note(cards.length === 4 ? 'ok' : 'bad', `渲染了 ${cards.length} 张属性卡（3 份预设 + 自主定义）`)

  // 第 4 张是「自主定义」（生成前没有内容），所有预设相关的处理都要先把它摘出去
  const presetCards = cards.filter((c) => !c.className.includes('custom'))
  const customCard = cards.find((c) => c.className.includes('custom'))
  note(customCard ? 'ok' : 'bad', customCard ? '存在「自主定义」第四项' : '缺少自主定义卡片')
  note(presetCards.length === 3 ? 'ok' : 'bad', `预设档案 ${presetCards.length} 份`)
  if (customCard) {
    const hasNote = /等级由引擎按设定概率掷出/.test(customCard.textContent)
    note(hasNote ? 'ok' : 'bad',
      hasNote ? '已写明等级不可指定' : '没有说明等级不可指定，玩家会以为能点单')
  }

  const ALL_GRADES = ['弱特级', '标特级', '超特级', '准一级', '龙级', '一级', '二级', '三级', '四级']
  const attrInfo = presetCards.map((c) => {
    const grade = ALL_GRADES.find((g) => c.textContent.includes(g)) || '?'
    const tech = c.querySelector('.tech')?.textContent?.trim() || '?'
    const eff = (c.textContent.match(/(\d+)%/) || [])[1]
    const vals = [...c.textContent.matchAll(/([\d,]{2,})\s*(\S*级)/g)].slice(0, 2).map((m) => m[1])
    return { grade, tech, eff, vals }
  })
  attrInfo.forEach((a, i) => info(`${'ABC'[i]}: ${C.mag(a.grade.padEnd(4))} ${a.tech}　效率 ${a.eff}%　主数值 ${a.vals.join(' / ')}`))

  // 校验每份预设档案都有必填内容
  for (const [i, c] of presetCards.entries()) {
    const t = c.textContent
    const missing = ['咒力总量', '血条总量', '咒术伤害', '体术伤害', '咒力效率'].filter((k) => !t.includes(k))
    if (missing.length) note('bad', `档案 ${'ABC'[i]} 缺少字段：${missing.join('、')}`)
  }

  // 挑一个中等的（避开特级碾压、也避开四级太弱）
  const pickIdx = attrInfo.findIndex((a) => !['弱特级', '标特级', '超特级', '龙级', '四级'].includes(a.grade))
  const chosen = pickIdx >= 0 ? pickIdx : 0
  info(`选择档案 ${'ABC'[chosen]}（${attrInfo[chosen].grade}）`)
  click(findBtn(`选择档案 ${'ABC'[chosen]}`), '选择档案')
  await waitFor('第二步 · 身份', { timeout: 120000, label: '身份档案生成' })

  // ---------------------------------------------------------- 身份

  step(3, '身份档案 甲 / 乙 / 丙')
  const idCards = [...dom.window.document.querySelectorAll('.pcard')]
  note(idCards.length === 4 ? 'ok' : 'bad', `渲染了 ${idCards.length} 张身份卡（3 份预设 + 自主定义）`)
  // 同样跳过「自主定义」那张（没生成前还没有类型）
  const presetIdent = idCards.filter((c) => !c.className.includes('custom'))
  presetIdent.forEach((c, i) => {
    const name = c.querySelector('.tech')?.textContent?.trim() || '?'
    const kind = (c.textContent.match(/(反派向|自由派|原作关联)/) || [])[1] || '?'
    info(`${'甲乙丙'[i]}: ${C.mag(name)}（${kind}）`)
  })
  const kinds = presetIdent.map((c) => (c.textContent.match(/(反派向|自由派|原作关联)/) || [])[1])
  note(kinds.includes('反派向') && kinds.includes('自由派') ? 'ok' : 'bad',
    kinds.includes('反派向') && kinds.includes('自由派') ? '反派向 / 自由派各有一份（符合第十节）' : `身份类型不全：${kinds.join('、')}`)

  click(findBtn('选择身份 甲'), '选择身份')
  await waitFor('穿越者|实时|存档', { timeout: 150000, label: '开局情境生成' })
  await waitIdle()

  // ---------------------------------------------------------- 开局情境

  step(4, '开局情境')
  const opening = [...dom.window.document.querySelectorAll('.narr')].map((n) => n.textContent).join('\n')
  console.log(wrap(opening.slice(0, 700)))
  const dlg = [...dom.window.document.querySelectorAll('.line')].map((l) => {
    const who = l.querySelector('.who')?.textContent || ''
    const what = l.querySelector('.what')?.textContent || ''
    return `${who}：「${what}」`
  })
  if (dlg.length) { console.log(); dlg.forEach((d) => console.log(C.cy('  ' + d))) }

  note(opening.length > 150 ? 'ok' : 'bad', `开局正文 ${opening.length} 字`)
  const openChoices = [...dom.window.document.querySelectorAll('.choice')].map((c) => c.textContent.trim())
  // 开局若立刻触发遭遇，选项栏会被战斗询问接管（迎战 / 脱离），这时只有两项
  const combatTakingOver = openChoices.some((c) => c.includes('迎战'))
  note(openChoices.length >= (combatTakingOver ? 2 : 4) ? 'ok' : 'bad',
    `${openChoices.length} 个选项${combatTakingOver ? '（已被战斗询问接管）' : ''}`)
  if (!combatTakingOver) {
    note(openChoices.at(-1)?.includes('跳过当天') ? 'ok' : 'bad',
      openChoices.at(-1)?.includes('跳过当天') ? '「跳过当天修炼」排在最后（符合第八节）' : '末项不是修炼选项')
  }

  // 特级细分泄漏检查（NPC 台词里不该有）
  const leak = dlg.filter((d) => /弱特级|标特级|超特级|龙级/.test(d))
  note(leak.length === 0 ? 'ok' : 'bad', leak.length === 0 ? 'NPC 台词无特级细分泄漏' : `台词泄漏细分：${leak[0]}`)

  // ---------------------------------------------------------- 主循环

  step(5, '主循环 · 连打三回合')
  for (let t = 1; t <= 3; t++) {
    // 若出现遭遇询问，转入战斗流程
    if (hasCombatInquiry()) {
      info(C.yel(`第 ${t} 回合触发遭遇战，转入战斗流程`))
      break
    }
    const ch = [...dom.window.document.querySelectorAll('.choice')].filter((c) => !c.textContent.includes('跳过当天'))
    if (!ch.length) { note('warn', `第 ${t} 回合没有可点选项`); break }
    const pickText = ch[0].textContent.trim().replace(/^\d+\.\s*/, '')
    console.log(`\n  ${C.b('▸ 玩家：')}${pickText}`)

    click(ch[0], '选项')
    await waitFor('第 \\d+ 回合|遭遇战|保存中', { timeout: 90000 }).catch(() => {})
    await waitIdle()

    const narr = [...dom.window.document.querySelectorAll('.narr')].pop()?.textContent || ''
    console.log(wrap(narr.slice(0, 420)))
    if (narr.length < 60) note('warn', `第 ${t} 回合正文只有 ${narr.length} 字`)

    const hp = (txt().match(/血条\s*([\d,]+)\s*\/\s*([\d,]+)/) || []).slice(1)
    const ce = (txt().match(/咒力\s*([\d,]+)\s*\/\s*([\d,]+)/) || []).slice(1)
    if (hp.length === 2) info(`HP ${hp[0]}/${hp[1]}　咒力 ${ce[0] || '?'}/${ce[1] || '?'}`)
  }

  // ---------------------------------------------------------- 战斗

  if (hasCombatInquiry()) {
    step(6, '遭遇战 · 询问 → 手动模式')

    // ① 先问要不要打
    assert_no_overlay('遭遇战不该是弹窗，应当在对话流里')
    const inq = [...dom.window.document.querySelectorAll('.log .inquiry')].pop()
    console.log(wrap(inq.textContent.replace(/\s+/g, ' ').slice(0, 260)))
    note(findBtn('迎战') ? 'ok' : 'bad', findBtn('迎战') ? '提供「迎战」' : '缺少迎战选项')
    note(findBtn('尝试脱离') ? 'ok' : 'bad', findBtn('尝试脱离') ? '提供「尝试脱离」（第六节之外的新增询问）' : '缺少脱离选项')

    click(findBtn('迎战'), '迎战')
    await waitFor('选择战斗模式', { timeout: 30000, label: '模式询问' })
    assert_no_overlay('战斗模式选择也不该是弹窗')

    const modeBtns = btns().filter((b) => /手动模式|跳过模式|剧情描述式/.test(b.textContent))
    note(modeBtns.length === 3 ? 'ok' : 'bad', `${modeBtns.length} 种战斗模式可选（第六节要求三种）`)

    click(findBtn('手动模式'), '手动模式')
    // 战斗数值面板现在在左侧战斗栏，不再进中间的剧情区
    await waitFor('第 1 回合', { timeout: 60000, label: '战斗栏出现回合号' })
    await waitIdle()
    const cs = dom.window.document.querySelector('.combat-side')
    note(cs && /第 1 回合/.test(cs.textContent) ? 'ok' : 'bad',
      cs && /第 1 回合/.test(cs.textContent) ? '左侧战斗栏渲染出回合面板' : '左侧战斗栏没有回合面板')
    if (cs) console.log(wrap(cs.textContent.replace(/\s+/g, ' ').slice(0, 200), '    '))

    let round = 0
    while (round < 14 && !txt().includes('战斗结算')) {
      const actBtns = btns().filter((b) => /体术攻击|生得术式|防御|领域展开|反转术式|脱离战斗/.test(b.textContent) && !b.disabled)
      if (!actBtns.length) {
        // 行动栏消失是个真问题，把现场打出来而不是只报一句
        note('bad', `第 ${round + 1} 次出手前行动栏消失`)
        console.log(C.dim('    现场按钮：' + (btns().map((b) => b.textContent.trim().slice(0, 18)).join(' | ') || '（无）')))
        console.log(C.dim('    战斗态：' + JSON.stringify({
          有战斗栏面板: !!dom.window.document.querySelector('.combat-side .card'),
          结算出现: txt().includes('战斗结算'),
          有loading: !!dom.window.document.querySelector('.spinner'),
          有错误: !!dom.window.document.querySelector('.err'),
        })))
        console.log(C.dim('    可见文本尾部：' + txt().slice(-220).replace(/\s+/g, ' ')))
        const blocks = [...dom.window.document.querySelectorAll('.log-inner > *')]
        console.log(C.dim(`    日志区共 ${blocks.length} 块，最后 5 块：`))
        blocks.slice(-5).forEach((b, i) => {
          console.log(C.dim(`      [${blocks.length - 5 + i}] ${b.className || b.tagName} :: ${b.textContent.replace(/\s+/g, ' ').slice(0, 70)}`))
        })
        break
      }

      const pick = actBtns.find((b) => b.textContent.includes('生得术式')) || actBtns[0]
      console.log(`\n  ${C.b('▸ 出招：')}${pick.textContent.trim()}`)

      click(pick, '行动')
      await waitIdle({ timeout: 90000 })
      await sleep(500)
      round++

      // 战斗数值在左侧战斗栏里读（中间那栏已经只剩剧情了）
      const cs = dom.window.document.querySelector('.combat-side')
      const cst = cs?.textContent || ''
      // 战斗栏用的是「血量 N / M」这种中文标签
      const bars = (cst.match(/(?:血量|血条)\s*[\d,]+\s*\/\s*[\d,]+/g) || []).slice(0, 2)
      const dmg = cst.match(/=\s*([\d,]+)/)
      info(`碰撞 ${round}　${bars.join('　') || '（战斗栏未读到）'}${dmg ? `　伤害 ${dmg[1]}` : ''}`)
    }

    const resultCard = [...dom.window.document.querySelectorAll('.notes')].find((n) => n.textContent.includes('战斗结算'))
    if (resultCard) {
      console.log()
      console.log(wrap(resultCard.textContent.trim(), '  '))
      note('ok', '战斗正常结算')
    } else {
      note('bad', `${round} 回合后仍未看到战斗结算`)
    }
    await waitIdle()
  } else {
    step(6, '遭遇战')
    note('warn', '三轮内没触发战斗，跳过战斗试玩（不是错误，只是这次没随机到）')
  }

  // ---------------------------------------------------------- 修炼

  step(7, '跳过当天 · 修炼')
  const trainBtn = findBtn('跳过当天，进行修炼')
  if (trainBtn && !trainBtn.disabled) {
    click(trainBtn, '修炼')
    await waitFor('跳过当天 · 修炼', { timeout: 30000 })

    // 修炼项目现在是对话流询问块下面的选项，不再是弹窗里的 .trow
    assert_no_overlay('修炼不该是弹窗，应当在对话流里')
    const items = [...dom.window.document.querySelectorAll('.choice')]
      .map((b) => b.textContent.replace(/^※\.|^\d+\./, '').trim())
      .filter((t) => /体能训练|咒力冥想|术式演练|反转术式修习|领域雏形冥想|体术实战/.test(t))
      .map((t) => t.split('（')[0])
    note(items.length === 6 ? 'ok' : 'bad', `列出 ${items.length} 个修炼项目（设定为 6 项）`)
    info(items.join('、'))

    click(findBtn('体能训练'), '体能训练')
    await waitIdle({ timeout: 90000 })
    await sleep(500)
    const trainCard = [...dom.window.document.querySelectorAll('.notes')].find((n) => n.textContent.includes('修炼 ·'))
    if (trainCard) {
      console.log()
      console.log(wrap(trainCard.textContent.trim(), '  '))
      note('ok', '修炼结算正常')
    } else {
      note('bad', '修炼没有产出结果卡')
    }
  } else {
    note('warn', `修炼入口不可用${trainBtn?.disabled ? `（${trainBtn.title || '被禁用'}）` : ''}`)
  }

  // ---------------------------------------------------------- 存档

  step(8, '存档 / 读档')
  await waitIdle()
  click(findBtn('存档'), '存档')
  await waitFor('还没有任何存档|读取', { timeout: 30000 })
  const nameInput = dom.window.document.querySelector('.modal input')
  if (nameInput) {
    // React 受控组件：得用原生 setter 触发 onChange
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(nameInput, '试玩存档')
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await sleep(100)
    click(findBtn('保存'), '保存')
    await waitFor('已保存', { timeout: 30000, label: '存档写入' })
    note('ok', '存档写入成功')

    const rows = [...dom.window.document.querySelectorAll('.trow')]
    note(rows.length >= 1 ? 'ok' : 'bad', `存档列表显示 ${rows.length} 条`)
    if (rows[0]) info(rows[0].textContent.replace(/\s+/g, ' ').slice(0, 90))

    click(findBtn('读取'), '读取')
    await waitIdle({ timeout: 60000 })
    await sleep(600)
    note(txt().includes('回战') ? 'ok' : 'bad', '读档后回到游戏界面')
  } else {
    note('bad', '存档弹窗里没有输入框')
  }

  // ---------------------------------------------------------- 用量表

  step(9, '左上角用量表')
  const meter = dom.window.document.querySelector('.usage')
  if (!meter) {
    note('bad', '左上角没有用量表')
  } else {
    const topbar = dom.window.document.querySelector('.topbar')
    note(topbar.firstElementChild === meter ? 'ok' : 'bad',
      topbar.firstElementChild === meter ? '用量表在左上角第一个位置' : '用量表不在左上角')

    console.log(`  ${C.dim('·')} 显示：${C.b(meter.textContent)}`)
    const tokMatch = meter.textContent.match(/([\d.]+[kM]?)\s*tok/)
    note(tokMatch ? 'ok' : 'bad', tokMatch ? `token 计数：${tokMatch[1]}` : '没有显示 token 数')

    // 展开明细
    click(meter, '用量表')
    await sleep(150)
    const pop = dom.window.document.querySelector('.usage-pop')
    if (pop) {
      const pt = pop.textContent
      const rows = ['输入', '输出', '调用次数', '费用'].filter((k) => pt.includes(k))
      note(rows.length === 4 ? 'ok' : 'bad', `明细包含：${rows.join('、')}${rows.length === 4 ? '' : '（缺项）'}`)
      console.log(wrap(pt.replace(/\s+/g, ' ').slice(0, 160), '    '))

      // 账目要能和实际调用次数对上
      const calls = (pt.match(/调用次数(\d+)/) || [])[1]
      if (calls) {
        note(Number(calls) <= requests.length ? 'ok' : 'bad',
          `记录 ${calls} 次调用，实际发出 ${requests.length} 次 HTTP 请求（含非 LLM 请求，所以前者应更少）`)
      }
    } else {
      note('bad', '点击没有展开用量明细')
    }
    click(meter, '用量表')
    await sleep(100)
  }

  // ---------------------------------------------------------- 界面完整性

  step(10, '界面完整性巡查')
  const t = txt()
  for (const [label, kw] of [['角色面板', '穿越者'], ['关系网', '关系网'], ['手指追踪', '宿傩手指追踪'], ['时间线', '原作分歧追踪']]) {
    note(t.includes(kw) ? 'ok' : 'bad', `${label}${t.includes(kw) ? '已渲染' : '缺失'}`)
  }
  const errEl = dom.window.document.querySelector('.err')
  note(!errEl ? 'ok' : 'bad', errEl ? `出现错误横幅：${errEl.textContent.slice(0, 80)}` : '全程没有出现错误横幅/白屏')

  // ---------------------------------------------------------- 汇总

  const bad = findings.filter((f) => f.kind === 'bad')
  const warn = findings.filter((f) => f.kind === 'warn')
  console.log(C.b('\n╔══════════════════════════════════════════════════════════╗'))
  console.log(C.b('║   试玩汇总                                                ║'))
  console.log(C.b('╚══════════════════════════════════════════════════════════╝'))
  console.log(`  ${C.grn('通过')} ${findings.length - bad.length - warn.length}　${C.yel('提示')} ${warn.length}　${C.red('失败')} ${bad.length}`)
  console.log(C.dim(`  API 请求 ${requests.length} 次`))
  if (bad.length) { console.log(C.red('\n  失败项：')); bad.forEach((f) => console.log(`    · ${f.msg}`)) }
  if (warn.length) { console.log(C.yel('\n  提示项：')); warn.forEach((f) => console.log(`    · ${f.msg}`)) }

  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error(C.red('\n试玩中断：'), e.message)
  console.error(C.dim(e.stack?.split('\n').slice(1, 5).join('\n') || ''))
  process.exit(2)
})
