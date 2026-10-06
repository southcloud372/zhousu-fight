import 'dotenv/config'

const BASE = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '')
const KEY = process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_MODEL || 'deepseek-flash'
const MODEL_PRO = process.env.LLM_MODEL_PRO || MODEL

export const models = { fast: MODEL, pro: MODEL_PRO }

/** 该供应商的思考模式与强制 tool_choice 互斥，结构化调用必须关掉 thinking。 */
const NO_THINKING = { type: 'disabled' }

function headers() {
  return {
    'content-type': 'application/json',
    'x-api-key': KEY,
    'anthropic-version': '2023-06-01',
  }
}

async function post(body, { signal } = {}) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`LLM ${res.status}: ${text.slice(0, 500)}`)
    err.status = res.status
    throw err
  }
  return res
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 重试只针对限流/网络抖动这类瞬时错误。 */
async function withRetry(fn, { tries = 3 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const retryable = !e.status || e.status === 429 || e.status >= 500
      if (!retryable || i === tries - 1) throw e
      await sleep(600 * 2 ** i)
    }
  }
  throw last
}

/**
 * 结构化调用：强制模型调用指定工具，返回校验过的入参对象。
 * 用 pro 模型跑开局生成/战斗判定这类"不能错"的活。
 */
export async function callTool({ system, messages, tool, maxTokens = 4000, model = MODEL }) {
  const body = {
    model,
    max_tokens: maxTokens,
    thinking: NO_THINKING,
    system,
    messages,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  }
  const data = await withRetry(async () => (await post(body)).json())
  const block = (data.content || []).find((b) => b.type === 'tool_use')
  if (!block) throw new Error(`模型未返回 tool_use：${JSON.stringify(data).slice(0, 400)}`)
  return { input: block.input, usage: data.usage }
}

/** JSON 的全部单字符转义。漏掉 \r \b \f 会把它们当成字母原样吐出来。 */
const SIMPLE_ESCAPES = {
  '"': '"', '\\': '\\', '/': '/',
  b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
}

/**
 * 从仍在增长的部分 JSON 里抽出某个字符串字段的当前值。
 * 用于把 tool 入参里的 narration 边生成边推给前端。
 *
 * 保证：在任意位置截断缓冲区，返回值都是完整解析结果的前缀。
 * `tests/llm.test.mjs` 里有一条性质测试专门守这个。
 */
export function extractPartialString(buf, key) {
  const k = `"${key}"`
  const i = buf.indexOf(k)
  if (i < 0) return null
  let j = buf.indexOf(':', i + k.length)
  if (j < 0) return null
  j++
  while (j < buf.length && /\s/.test(buf[j])) j++
  if (buf[j] !== '"') return null
  j++
  let out = ''
  while (j < buf.length) {
    const c = buf[j]
    if (c === '\\') {
      const n = buf[j + 1]
      if (n === undefined) break // 转义序列还没传完，等下一块
      if (n === 'u') {
        const hex = buf.slice(j + 2, j + 6)
        if (hex.length < 4) break // \uXXXX 还没传完
        const code = parseInt(hex, 16)
        if (Number.isNaN(code)) { out += 'u'; j += 2; continue } // 非法转义，原样保留
        out += String.fromCharCode(code)
        j += 6
        continue
      }
      out += SIMPLE_ESCAPES[n] ?? n
      j += 2
      continue
    }
    if (c === '"') return out // 字段闭合
    out += c
    j++
  }
  return out // 还在增长
}

/**
 * 流式结构化调用。依次 yield：
 *   {type:'delta', text}       — narration 的增量（打字机用）
 *   {type:'done', input}       — 完整且已解析的 tool 入参
 */
export async function* streamTool({ system, messages, tool, maxTokens = 4000, model = MODEL, narrationKey = 'narration', onUsage }) {
  const body = {
    model,
    max_tokens: maxTokens,
    thinking: NO_THINKING,
    stream: true,
    system,
    messages,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  }
  const res = await withRetry(async () => post(body))

  let jsonBuf = ''
  let sent = 0
  let decoder = new TextDecoder()
  let carry = ''
  // 流式响应里的用量是分两处给的：message_start 给输入，message_delta 给输出
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  for await (const chunk of res.body) {
    carry += decoder.decode(chunk, { stream: true })
    const lines = carry.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let ev
      try {
        ev = JSON.parse(payload)
      } catch {
        continue
      }
      if (ev.type === 'message_start' && ev.message?.usage) {
        mergeUsage(usage, ev.message.usage)
      } else if (ev.type === 'message_delta' && ev.usage) {
        mergeUsage(usage, ev.usage)
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
        jsonBuf += ev.delta.partial_json || ''
        const text = extractPartialString(jsonBuf, narrationKey)
        if (text && text.length > sent) {
          yield { type: 'delta', text: text.slice(sent) }
          sent = text.length
        }
      } else if (ev.type === 'error') {
        throw new Error(`LLM 流式错误：${JSON.stringify(ev.error).slice(0, 300)}`)
      }
    }
  }

  onUsage?.(usage)

  let parsed
  try {
    parsed = JSON.parse(jsonBuf)
  } catch (e) {
    // 模型偶尔会把自己的 XML 式工具调用语法写进 JSON 字符串里
    // （实测见过 </doubao>、<parameter name="dialogue">），
    // 那个引号会提前闭合字符串，整个 JSON 就废了。
    // 直接抛会让整回合失败，所以先尽量把能救的字段捞出来。
    parsed = salvageToolInput(jsonBuf)
    if (parsed) {
      parsed.__salvaged = e.message
    } else {
      throw new Error(`tool 入参 JSON 解析失败：${e.message}\n${jsonBuf.slice(0, 500)}`)
    }
  }
  yield { type: 'done', input: parsed, usage }
}

/**
 * JSON 解析失败时的抢救。
 *
 * 只从残缺的缓冲区里抠出还算完整的字段，凑一份能用的入参。
 * 抠不出正文就返回 null —— 让调用方重试，而不是拿半截内容糊弄玩家。
 */
export function salvageToolInput(buf) {
  if (typeof buf !== 'string' || !buf) return null

  let narration = extractPartialString(buf, 'narration')
  if (!narration) return null

  // 尾部常挂着被截断的标签（</doubao>、<parameter name= 之类），切掉。
  // 必须循环 —— 一次 replace 只吃掉最后一个，切掉它之后底下还压着一个。
  const TAIL_TAG = /<\/?[a-zA-Z][^>]*>?\s*$/
  let prev
  do {
    prev = narration
    narration = narration.replace(TAIL_TAG, '').trim()
  } while (narration !== prev)
  if (narration.length < 20) return null

  // dialogue / choices 尽量捞；捞不到就留空，引擎和界面都能接受
  const dialogue = salvageArray(buf, 'dialogue', ['speaker', 'text'])
  const choices = salvageStringArray(buf, 'choices')

  return {
    narration,
    dialogue,
    choices,
    proposal: {
      hpDelta: 0, ceDelta: 0, relationDelta: {},
      sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0, sukunaFingersPlayerEatenDelta: 0,
      flags: [], timeAdvance: '0',
    },
    combatRequest: null,
  }
}

/** 从残破 JSON 里抠对象数组（只取每个元素里能认出来的字符串字段） */
function salvageArray(buf, key, fields) {
  const seg = sliceValue(buf, key)
  if (!seg) return []
  const out = []
  for (const m of seg.matchAll(/\{([^{}]*)\}/g)) {
    const item = {}
    for (const f of fields) {
      const v = extractPartialString(`{${m[1]}}`, f)
      if (v) item[f] = v
    }
    if (Object.keys(item).length) out.push(item)
  }
  return out
}

function salvageStringArray(buf, key) {
  const seg = sliceValue(buf, key)
  if (!seg) return []
  return [...seg.matchAll(/"([^"\\]{2,120})"/g)].map((m) => m[1]).slice(0, 6)
}

/** 取出某个键后面方括号里的那一段原文 */
function sliceValue(buf, key) {
  const i = buf.indexOf(`"${key}"`)
  if (i < 0) return null
  const start = buf.indexOf('[', i)
  if (start < 0) return null
  const end = buf.indexOf(']', start)
  return buf.slice(start + 1, end < 0 ? buf.length : end)
}

/** message_delta 里的 output_tokens 是累计值，直接覆盖而不是相加 */
function mergeUsage(target, src) {
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (typeof src[k] === 'number') target[k] = Math.max(target[k] || 0, src[k])
  }
}

/** 纯文本流式（剧情描述式战斗这类不需要结构化输出的场景）。 */
export async function* streamText({ system, messages, maxTokens = 4000, model = MODEL, thinking = false, onUsage }) {
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages,
    ...(thinking ? {} : { thinking: NO_THINKING }),
  }
  const res = await withRetry(async () => post(body))
  const decoder = new TextDecoder()
  let carry = ''
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  for await (const chunk of res.body) {
    carry += decoder.decode(chunk, { stream: true })
    const lines = carry.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let ev
      try {
        ev = JSON.parse(payload)
      } catch {
        continue
      }
      if (ev.type === 'message_start' && ev.message?.usage) {
        mergeUsage(usage, ev.message.usage)
      } else if (ev.type === 'message_delta' && ev.usage) {
        mergeUsage(usage, ev.usage)
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        yield ev.delta.text
      }
    }
  }
  onUsage?.(usage)
}

export async function ping() {
  const r = await callTool({
    system: 'You are a test.',
    messages: [{ role: 'user', content: 'ping' }],
    tool: {
      name: 'pong',
      description: 'reply pong',
      input_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    },
    maxTokens: 100,
  })
  return r.input
}
