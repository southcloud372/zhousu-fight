/**
 * 服务端随机数。骰子必须由引擎掷，不能交给模型，
 * 否则同一回合重试会得到不同结果，也无法复现 bug。
 */

/** mulberry32：小而快的可播种 PRNG，方便用 seed 复盘某一局 */
export function makeRng(seed = Date.now() >>> 0) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const rint = (rng, min, max) => Math.floor(rng() * (max - min + 1)) + min

export const rfloat = (rng, min, max) => rng() * (max - min) + min

export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]

/** 带权重的抽取，weights 为 {key: number} */
export function weightedPick(rng, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [key, w] of entries) {
    r -= w
    if (r <= 0) return key
  }
  return entries[entries.length - 1][0]
}

/** 按概率表抽取：table = [{value, p}, ...] */
export function pickByProb(rng, table) {
  let r = rng()
  for (const { value, p } of table) {
    r -= p
    if (r <= 0) return value
  }
  return table[table.length - 1].value
}
