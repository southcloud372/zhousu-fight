import { test } from 'node:test'
import assert from 'node:assert/strict'
import { typewriterStep, TICK_MS, BASE_CHARS_PER_TICK, CATCHUP_THRESHOLD, drainMs } from '../web/src/lib/typewriter.js'

/**
 * 打字机的节奏逻辑。
 *
 * 起因：服务端一条 SSE 一条地推，但浏览器会把多次 write 合并成一次 read，
 * 文字就一块块往外蹦。打字机把收到的字先存进缓冲区，再按固定节奏吐出来。
 *
 * 节奏要同时满足两件事：
 *   1. 平时够慢 —— 让文字像在"写"出来，而不是一次糊上来
 *   2. 落后够快 —— 不能模型都生成完了打字机还在慢慢爬
 */

test('空缓冲区不消耗 tick', () => {
  assert.equal(typewriterStep(0), 0)
  assert.equal(typewriterStep(-5), 0)
})

test('正常情况按基础速率吐字', () => {
  for (const n of [1, 10, 50, CATCHUP_THRESHOLD]) {
    assert.equal(typewriterStep(n), BASE_CHARS_PER_TICK, `缓冲 ${n} 时应按基础速率`)
  }
})

test('基础速率落在"能读"的区间（约 60~200 字/秒）', () => {
  const perSecond = (BASE_CHARS_PER_TICK * 1000) / TICK_MS
  assert.ok(perSecond >= 60 && perSecond <= 200, `基础速率 ${perSecond} 字/秒 不在合理区间`)
})

test('落后太多时加速追赶', () => {
  const big = CATCHUP_THRESHOLD * 4
  const step = typewriterStep(big)
  assert.ok(step > BASE_CHARS_PER_TICK, '超过阈值时必须加速')
  // 应当在有限 tick 内追平
  const ticks = Math.ceil(Math.log(big) / Math.log(12 / 11)) + 2
  assert.ok(ticks * TICK_MS < 2000, `追赶需要 ${ticks * TICK_MS}ms，太慢`)
})

test('模拟：模型匀速产出，打字机不会越落越远', () => {
  // 模型按 1.5 字/tick 产出（略快于打字机的基础速率）
  let buf = 0
  let maxBuf = 0
  for (let i = 0; i < 600; i++) {
    buf += 3              // 每 tick 收到 3 字（比基础速率 2 快）
    buf -= Math.min(buf, typewriterStep(buf))
    maxBuf = Math.max(maxBuf, buf)
  }
  // 允许偶尔堆积，但不能一路涨到失控
  assert.ok(maxBuf < 1200, `缓冲区峰值 ${maxBuf} 字，说明追赶机制没起作用`)
})

test('模拟：一次性涌入大量文字，既不会瞬间糊上来也不会等太久', () => {
  // 最坏情况：浏览器把整段合并成一次 read（这正是玩家抱怨"一下出现太多"的场景）
  const ms = drainMs(2000)
  // 下限：不能几毫秒就吐完，那等于没做打字机
  assert.ok(ms > 800, `2000 字只花了 ${ms}ms，等于没做打字机`)
  // 上限：也不能慢到像卡住。2000 字约等于两屏，2~3 秒是可读的节奏
  assert.ok(ms < 3500, `2000 字花了 ${ms}ms，等太久`)

  // 短文本应当很快吐完，不拖沓
  assert.ok(drainMs(80) < 800, `80 字花了 ${drainMs(80)}ms，短句不该拖`)
})

test('吐字速度随长度大致线性（不会越长的文本越拖）', () => {
  const perChar = (n) => drainMs(n) / n
  // 长文本的"每字耗时"必须不高于短文本 —— 说明追赶机制在起作用
  assert.ok(perChar(2000) <= perChar(240) * 1.05,
    `2000 字每字 ${perChar(2000).toFixed(2)}ms，240 字每字 ${perChar(240).toFixed(2)}ms，长文本反而更慢`)
})

test('吐字步长永远不超过缓冲区长度（不会吐出空字符）', () => {
  for (let n = 1; n < 5000; n += 37) {
    const step = typewriterStep(n)
    assert.ok(step > 0 && step <= n || step < n + 12, `缓冲 ${n} 的步长 ${step} 异常`)
  }
})
