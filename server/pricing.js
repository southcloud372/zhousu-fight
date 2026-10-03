import 'dotenv/config'

/**
 * token 计价与累计。
 *
 * ⚠️ .env 里的默认单价是**示例值**，不保证与你的实际计费一致 ——
 * 请按你的账单把 PRICE_* 换成真实单价。没配置时界面只显示 token 数，
 * 金额显示为 "—"，不会编一个数字出来。
 *
 * 单价单位：每 100 万 token 的价格。
 */

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export const PRICING = {
  flash: {
    input: num(process.env.PRICE_FLASH_IN),
    output: num(process.env.PRICE_FLASH_OUT),
  },
  pro: {
    input: num(process.env.PRICE_PRO_IN),
    output: num(process.env.PRICE_PRO_OUT),
  },
  // 缓存命中的输入通常便宜很多；未配置则按普通输入价算
  cacheRead: num(process.env.PRICE_CACHE_READ),
  cacheWrite: num(process.env.PRICE_CACHE_WRITE),
}

export const CURRENCY = process.env.PRICE_CURRENCY || '¥'

/** 有没有任何一项配了价 —— 决定界面是显示金额还是 "—" */
export const PRICE_CONFIGURED =
  Object.values(PRICING.flash).some((v) => v !== null) ||
  Object.values(PRICING.pro).some((v) => v !== null)

export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    byModel: {},
  }
}

/**
 * 把一次调用的 usage 累加进去。
 * Anthropic 兼容端点的字段：input_tokens / output_tokens /
 * cache_read_input_tokens / cache_creation_input_tokens。
 */
export function accumulate(total, usage, model) {
  if (!usage) return total
  const t = total || emptyUsage()
  const inp = usage.input_tokens || 0
  const out = usage.output_tokens || 0
  const cr = usage.cache_read_input_tokens || 0
  const cw = usage.cache_creation_input_tokens || 0

  t.input += inp
  t.output += out
  t.cacheRead += cr
  t.cacheWrite += cw
  t.calls += 1

  const key = model || 'unknown'
  const m = (t.byModel[key] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 })
  m.input += inp
  m.output += out
  m.cacheRead += cr
  m.cacheWrite += cw
  m.calls += 1

  return t
}

/** 某个模型名该用哪档价 */
function ratesFor(model) {
  const m = String(model || '')
  if (/pro/i.test(m)) return PRICING.pro
  return PRICING.flash
}

/**
 * 估算费用。按 byModel 逐模型计价，因为 pro 和 flash 单价不同。
 * 返回 null 表示没配置单价（界面据此显示 "—"）。
 */
export function costOf(total) {
  if (!total || !PRICE_CONFIGURED) return null
  let sum = 0
  for (const [model, u] of Object.entries(total.byModel || {})) {
    const r = ratesFor(model)
    const inRate = r.input ?? 0
    const outRate = r.output ?? 0
    const crRate = PRICING.cacheRead ?? inRate
    const cwRate = PRICING.cacheWrite ?? inRate
    // 计入 input 的是"未命中缓存"的部分：总输入 = 命中 + 写入 + 全新
    const freshInput = Math.max(0, u.input - u.cacheRead - u.cacheWrite)
    sum += (freshInput * inRate + u.cacheRead * crRate + u.cacheWrite * cwRate + u.output * outRate) / 1e6
  }
  return sum
}

/** 给前端的快照 */
export function usageSnapshot(total) {
  const t = total || emptyUsage()
  const cost = costOf(t)
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    total: t.input + t.output,
    calls: t.calls,
    cost,
    currency: CURRENCY,
    priceConfigured: PRICE_CONFIGURED,
    byModel: t.byModel,
  }
}

/**
 * 流式输出时的实时估算，只用于"正在生成"时给个跳动的数字。
 * 中日韩字符按 1 token/字，其余按 4 字符/token 粗估 —— 只是体感，不是账。
 */
export function estimateTokens(text) {
  // 传进来的必须是一段文本。早先这里被误传了字符数，直接抛
  // "text.match is not a function" 把整个回合打断了 —— 加个类型兜底。
  if (typeof text !== 'string' || !text) return 0
  const cjk = (text.match(/[　-鿿＀-￯]/g) || []).length
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}
