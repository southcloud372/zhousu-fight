/**
 * 正文预算的端到端验证：真的跑一遍 /turn，看引擎有没有把长篇正文压回去。
 *
 * 和别的测试的分工：
 *   narration.test.mjs  纯函数，算得对不对
 *   这一条              整套流程，管不管得住 —— 起一个真的服务端，
 *                       但把模型指向本地假端点，所以不花钱、可重复
 *
 * 为什么值得起一个真服务端：这条链路上有好几处会动正文（工具 schema、
 * 服务器重试、句号截断、postProcess），纯函数测试一个都盖不到。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SAVES = path.join(ROOT, 'server', 'saves')

const { blankState, buildPlayer } = await import('../server/engine/state.js')
const { makeRng } = await import('../server/engine/dice.js')
const { rollAttributeProfile, rollIdentity, rollIdentityKind } = await import('../server/engine/rolls.js')

const RUN = Date.now().toString(36).slice(-5)
const SID = `bg-${RUN}`

// ------------------------------------------------------------ 假模型端点

/** 每次流式调用按顺序取一份正文；取完就重复最后一份 */
const scripted = []
let llmCalls = 0
/** 收到的**流式**请求体，用来验证"退回重写时到底跟模型说了什么" */
const streamRequests = []

const toolInput = (narration) => JSON.stringify({
  narration,
  recap: '他站在原处，对面那个东西还没死。',
  dialogue: [],
  choices: ['抢攻', '后撤重整', '盯住它的手'],
  proposal: {
    hpDelta: 0, ceDelta: 0, relationDelta: {}, sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0,
    deaths: [], flags: [], timeAdvance: '0',
  },
  combatRequest: null,
})

/** 按 SSE 格式吐出工具入参，故意切成小块，顺带压一压流式解析 */
function sseFor(json) {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 500, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_test', name: 'submit_turn' } },
  ]
  const SIZE = 40
  for (let i = 0; i < json.length; i += SIZE) {
    events.push({
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: json.slice(i, i + SIZE) },
    })
  }
  events.push({ type: 'content_block_stop', index: 0 })
  events.push({ type: 'message_delta', usage: { output_tokens: 300 } })
  events.push({ type: 'message_stop' })
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}

const llm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(body) } catch {}

    // 探活走的是非流式接口（/api/health → ping → callTool），回一份最小 pong。
    // 不处理这条路的话，服务端会一直起不来。
    if (!parsed?.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        content: [{ type: 'tool_use', id: 'toolu_ping', name: 'pong', input: { ok: true } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }))
      return
    }

    streamRequests.push(parsed)
    const text = scripted[Math.min(llmCalls, scripted.length - 1)]
    llmCalls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sseFor(toolInput(text)))
  })
})

// ------------------------------------------------------------ 被测服务端

const freePort = () => new Promise((resolve) => {
  const s = http.createServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})

let child = null
let base = ''

/** 造一份"已经进了主循环"的存档。开局那几步（选路线/掷属性/定身份）这里跳过 */
function writeSave(playMode) {
  const s = blankState(makeRng(7))
  const a = rollAttributeProfile(makeRng(11), 'A')
  Object.assign(a, {
    techniqueName: '测试术式', techniqueEffect: 'e', techniqueCooldown: 2,
    talents: [], playstyle: '', domain: { unlocked: false },
  })
  const ident = rollIdentity(makeRng(13), '甲', rollIdentityKind(makeRng(17), 0))
  Object.assign(ident, {
    name: '试验者', background: 'b', mainlineRelation: 'm',
    openingSituation: 'o', hook: 'h', initialRelations: { 家入硝子: 20 },
  })
  s.player = buildPlayer(a, a, ident, ident)
  s.id = SID
  s.phase = 'playing'
  s.playMode = playMode
  s.choices = []
  s.log = [{ type: 'turn', turn: 1, narration: '测试。', choices: ['前进'] }]
  fs.mkdirSync(SAVES, { recursive: true })
  fs.writeFileSync(path.join(SAVES, `${SID}.json`), JSON.stringify(s, null, 2), 'utf8')
}

const cleanup = () => {
  try { fs.unlinkSync(path.join(SAVES, `${SID}.json`)) } catch {}
  try { child?.kill() } catch {}
  try { llm.close() } catch {}
}
after(cleanup)
process.on('exit', cleanup)

/** 走一遍 /turn，把 SSE 事件按顺序收下来 */
async function runTurn(input = '打过去') {
  const r = await fetch(`${base}/api/session/${SID}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  })
  assert.equal(r.status, 200, `turn 应当返回 200，实际 ${r.status}`)
  const events = []
  for (const block of (await r.text()).split('\n\n')) {
    const ev = block.split('\n').find((l) => l.startsWith('event:'))
    const data = block.split('\n').find((l) => l.startsWith('data:'))
    if (!ev || !data) continue
    try { events.push([ev.slice(6).trim(), JSON.parse(data.slice(5).trim())]) } catch {}
  }
  return events
}

/**
 * 玩家最后真正看到的正文。
 *
 * 不能把所有 narration 事件拼起来 —— 引擎换了正文时会先发 reset，
 * 前面那些是已经被丢弃的流式草稿。只取最后一次 reset 之后的。
 */
function finalNarration(events) {
  let lastReset = -1
  events.forEach(([e], i) => { if (e === 'reset') lastReset = i })
  return events.slice(lastReset + 1).filter(([e]) => e === 'narration').map(([, d]) => d.text).join('')
}

/** 服务端存下来的那条回合正文 —— 屏幕上看到的和存档里的必须是同一份 */
async function loggedNarration() {
  const st = await (await fetch(`${base}/api/session/${SID}/state`)).json()
  const turn = [...(st.log || [])].reverse().find((e) => e.type === 'turn')
  assert.ok(turn, '没有落进日志的回合')
  return turn.narration
}

const resetCount = (events) => events.filter(([e]) => e === 'reset').length

/** 每回合开头清一次账 */
function resetScript(...texts) {
  llmCalls = 0
  scripted.length = 0
  scripted.push(...texts)
}

/** 一段够长、但句句到位的正文：每句 100 字，方便数超了多少 */
const draft = (ch, sentences) => (ch.repeat(99) + '。').repeat(sentences)

// ------------------------------------------------------------ 准备

const llmPort = await new Promise((resolve) => {
  llm.listen(0, '127.0.0.1', () => resolve(llm.address().port))
})
const port = await freePort()
base = `http://127.0.0.1:${port}`

writeSave('combat')

let bootLog = ''
child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    // dotenv 不覆盖已经存在的环境变量，所以这两条一定生效
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}`,
    LLM_API_KEY: 'test-key',
    LLM_MODEL: 'fake',
    LLM_MODEL_PRO: 'fake',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => { bootLog += d })
child.stderr.on('data', (d) => { bootLog += d })

{
  const t0 = Date.now()
  let up = false
  while (Date.now() - t0 < 30000) {
    if (child.exitCode !== null) break
    try {
      const h = await fetch(`${base}/api/health`)
      if (h.ok) { up = true; break }
    } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  assert.ok(up, `被测服务端没起来，它的输出是：\n${bootLog.slice(-2000)}`)
}

// ------------------------------------------------------------ 用例
//
// 服务端把会话缓存在内存里，磁盘只在第一次用到某个 id 时读。
// 所以下面只有开头 writeSave 那一次真正影响它；后面改模式要走接口。

test('战斗向：写超预算的正文会被退回重写，屏幕上留的是重写后的那一份', async () => {
  // 重写稿要够 60 字 —— 太短会被当成"空壳正文"，那是另一条重试理由
  resetScript(
    '血'.repeat(430) + '刀锋到了。',
    '他侧身让开，反手一刀劈在它肩上，骨头裂开的轻响盖过了呼吸。它晃了晃，'
    + '血顺着肩线淌下来，抬手的动作慢了半拍。你退开两步，重新压低重心，这一刀咬住了它的左臂。',
  )
  streamRequests.length = 0

  const events = await runTurn()
  const final = finalNarration(events)

  assert.equal(llmCalls, 2, `应当退回重写一次，实际调了 ${llmCalls} 次模型`)
  assert.match(final, /反手一刀/, '屏幕上应当换成重写后的短正文')
  assert.equal(await loggedNarration(), final, '屏幕上的正文和存档里的不是同一份')

  // 预算必须写进工具字段说明里 —— 模型写 narration 时正看着这句话，
  // 比在几千字开外的系统提示里说一遍管用得多
  const wire = streamRequests[0]
  assert.equal(wire.tools[0].name, 'submit_turn')
  assert.equal(wire.tool_choice.name, 'submit_turn')
  assert.match(wire.tools[0].input_schema.properties.narration.description, /400 字/,
    '发出去的工具 schema 里没有字数预算')

  // 退回重写时得说清楚"删什么"。光说"太长了"，模型会再交一份同样长的
  const retry = JSON.stringify(streamRequests[1].messages)
  assert.match(retry, /400 字/, '重写说明里没有给出预算')
  assert.match(retry, /环境|心理|铺垫/, '重写说明没有点明该删掉哪一类描写')

  // 服务端换了正文就得把换完的那份推给前端，否则屏幕和存档对不上
  assert.ok(resetCount(events) >= 1, '没有通知前端丢弃原来那份正文')
})

test('战斗向：两次都超预算，交给玩家的也一定在 400 字以内，且断在句号上', async () => {
  // 越写越长：退回重写反而更糟。引擎该留住先前那份短的，而不是照单全收
  resetScript(draft('一', 5), draft('二', 8))

  const events = await runTurn()
  const final = finalNarration(events)

  assert.equal(llmCalls, 2, `长度问题只该重写一次，实际调了 ${llmCalls} 次`)

  const logged = await loggedNarration()
  assert.equal(final, logged, '屏幕上的正文和存档里的不是同一份')
  assert.ok(final.length <= 400, `正文超预算：${final.length} 字`)
  assert.match(final, /。$/, '截断应当断在句号上，不该留半句话')
  assert.ok(!final.includes('二'), '重写稿更长，应当退回先前那份短的')
  assert.ok(final.length > 200, `截得太狠了：${final.length} 字`)
})

test('剧情向：同样长度的正文一个字都不动', async () => {
  const long = draft('三', 9)
  resetScript(long)

  // 内存里那份还是战斗向，换模式必须走接口
  const r = await fetch(`${base}/api/session/${SID}/play-mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'story' }),
  })
  assert.equal(r.status, 200, '切换游玩模式失败')

  const events = await runTurn()
  assert.equal(llmCalls, 1, '剧情向不该为了字数重写')
  assert.equal(resetCount(events), 0, '剧情向不该有重置正文的动作')
  assert.equal(await loggedNarration(), long, '剧情向的正文被动过了')
})
