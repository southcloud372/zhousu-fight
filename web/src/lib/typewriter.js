/**
 * 打字机的节奏逻辑（纯函数，不依赖 React）。
 *
 * 起因：服务端一条 SSE 一条地推文字，但浏览器会把多次 write 合并成一次 read，
 * 于是文字一块块往外蹦。做法是先把收到的字存进缓冲区，再按固定节奏吐出来。
 *
 * 节奏要同时满足两件事：
 *   1. 平时够慢 —— 文字像在"写"出来，而不是一次糊上来
 *   2. 落后够快 —— 不能模型都生成完了，打字机还在慢慢爬
 *
 * 放在独立文件里是为了能被 Node 直接 import 做单元测试（.jsx 跑不了）。
 */

export const TICK_MS = 16
export const BASE_CHARS_PER_TICK = 2
export const CATCHUP_THRESHOLD = 240

/**
 * 每 tick 吐多少个字。
 *
 * 正常按 BASE 走（约 125 字/秒，和模型生成速度接近，所以缓冲区通常接近空）；
 * 落后超过阈值就按比例加速，保证不会越拖越远。
 */
export function typewriterStep(bufferLength) {
  if (!(bufferLength > 0)) return 0
  return bufferLength > CATCHUP_THRESHOLD
    ? Math.ceil(bufferLength / 12)
    : BASE_CHARS_PER_TICK
}

/** 把缓冲区全部吐完需要多少毫秒（用于测试和调参） */
export function drainMs(bufferLength) {
  let buf = bufferLength
  let ticks = 0
  while (buf > 0 && ticks < 100000) {
    buf -= Math.min(buf, typewriterStep(buf))
    ticks++
  }
  return ticks * TICK_MS
}
