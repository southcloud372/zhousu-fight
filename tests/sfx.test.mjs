import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CUES, cueNames, play, setEnabled, isEnabled } from '../web/src/lib/sfx.js'

/**
 * 合成音效层。
 *
 * 这里测的是**审美契约**而不是音频本身（Node 里没有扬声器）：
 * 事件表是纯数据，音色/节奏/音量的红线全部可以对表断言。
 */

const WAVES = new Set(['sine', 'triangle', 'square', 'sawtooth'])

test('每个 cue 都是合法的事件串：波形、频率、时长、音量全在界内', () => {
  assert.ok(cueNames().length >= 11, 'cue 覆盖面不足')
  for (const [name, events] of Object.entries(CUES)) {
    assert.ok(Array.isArray(events) && events.length >= 1, `${name} 是空 cue`)
    for (const [i, ev] of events.entries()) {
      assert.ok(WAVES.has(ev.wave), `${name}[${i}] 波形非法：${ev.wave}`)
      assert.ok(ev.freq > 20 && ev.freq < 8000, `${name}[${i}] 频率出人耳舒适区：${ev.freq}`)
      if (ev.freqTo) assert.ok(ev.freqTo > 20, `${name}[${i}] 滑移目标频率过低`)
      assert.ok(ev.dur > 0.01 && ev.dur <= 1, `${name}[${i}] 时长异常：${ev.dur}`)
      assert.ok(ev.gain > 0 && ev.gain <= 1, `${name}[${i}] 音量出界：${ev.gain}`)
      assert.ok((ev.at || 0) >= 0, `${name}[${i}] 延迟为负`)
    }
  }
})

test('黑闪的节奏是「一闪 → 顿 → 轰」：先高后停再低，时间停一拍的听觉化', () => {
  const ev = CUES.blackFlash
  // 先：一记高频
  const flash = ev.find((x) => (x.at || 0) === 0 && x.freq >= 2000)
  assert.ok(flash, '开头必须有一记高频的「闪」')
  // 顿：闪与轰之间留出空白
  const boom = ev.find((x) => x.freq < 100 && (x.at || 0) > 0.08)
  assert.ok(boom, '低频的「轰」必须在闪之后留出停顿再落下')
  assert.ok((boom.at || 0) - 0.05 >= 0.05, '闪与轰之间的停顿太短，听不出「时间停了一拍」')
})

test('音量的审美红线：任何单个事件都不超过满幅（总闸在播放层另压）', () => {
  for (const [name, events] of Object.entries(CUES)) {
    for (const ev of events) {
      assert.ok(ev.gain <= 1, `${name} 有事件音量超满幅`)
    }
  }
})

test('高频刺耳音色受限：square / sawtooth 不允许出现在 800Hz 以上', () => {
  for (const [name, events] of Object.entries(CUES)) {
    for (const ev of events) {
      if (ev.wave === 'square' || ev.wave === 'sawtooth') {
        assert.ok(ev.freq <= 800 && (ev.freqTo || ev.freq) <= 800,
          `${name} 的刺耳波形出现在高频段（${ev.freq}Hz）—— 审美红线`)
      }
    }
  }
})

test('play 在任何环境都不抛：关掉 / 未知 cue / 没有 WebAudio（Node）', () => {
  const wasEnabled = isEnabled()
  try {
    setEnabled(true)
    assert.doesNotThrow(() => play('blackFlash'), 'Node 里没有 AudioContext，应当静默返回')
    assert.doesNotThrow(() => play('no-such-cue'))
    assert.doesNotThrow(() => play())
    setEnabled(false)
    assert.equal(isEnabled(), false)
    assert.doesNotThrow(() => play('win'), '关掉之后更不该有声（也不该抛）')
  } finally {
    setEnabled(wasEnabled) // 别把开关状态泄漏给其他测试
  }
})

test('setEnabled 在没有 localStorage 的环境也不抛（持久化是尽力而为）', () => {
  assert.doesNotThrow(() => { setEnabled(true); setEnabled(false) })
})
