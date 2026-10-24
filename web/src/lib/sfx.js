/**
 * 合成音效层（WebAudio，零素材）。
 *
 * 商用质感里声音占一半，但素材音频有三个工程问题：体积、授权、加载时序。
 * 这里全部用振荡器 + 包络现场合成 —— 代价是音色极简，换来的是：
 * 零请求、零版权、随代码走版本管理。
 *
 * 审美的三条底线（爽感不等于吵）：
 *   1. 主音量压得很低（MASTER 0.16），任何一个 cue 单独听都只是"轻轻一记"；
 *   2. 高频用 sine/triangle，square/saw 只在低频段当"重量"，不用噪声；
 *   3. 黑闪是唯一允许"抢戏"的 cue —— 高频一闪、顿 80ms、低频再轰，
 *      这是"时间停了一拍"的听觉化，也是全游戏最高的一拍该有的排面。
 *
 * 事件表是纯数据（CUES），排程消费它 —— Node 里也能对表写测试。
 */

/** 主音量：所有 cue 的总闸。想整体更轻改这里，别逐个调 cue */
const MASTER = 0.16

/**
 * 每个 cue = 一串事件。字段：
 *   wave 振荡器类型 | freq 起始频率 | freqTo 滑向的频率（可省）
 *   dur 时长（秒）| gain 本 cue 内的相对音量（0~1）| at 相对起始的延迟（秒）
 */
export const CUES = {
  // 界面：轻到几乎只是"确认收到了"
  uiTick: [{ wave: 'sine', freq: 1300, dur: 0.035, gain: 0.22 }],

  // 命中：短促的两层（体术的"实"）
  hit: [
    { wave: 'triangle', freq: 190, freqTo: 120, dur: 0.09, gain: 0.6 },
    { wave: 'sine', freq: 95, dur: 0.06, gain: 0.4, at: 0.005 },
  ],
  // 重击：更沉、更长
  heavy: [
    { wave: 'sawtooth', freq: 150, freqTo: 60, dur: 0.16, gain: 0.5 },
    { wave: 'sine', freq: 55, dur: 0.18, gain: 0.75 },
  ],
  // 暴击：命中之上加两粒高音的"裂"
  crit: [
    { wave: 'triangle', freq: 190, freqTo: 120, dur: 0.09, gain: 0.6 },
    { wave: 'sine', freq: 880, dur: 0.07, gain: 0.35, at: 0.01 },
    { wave: 'sine', freq: 1320, dur: 0.05, gain: 0.25, at: 0.045 },
  ],
  // 黒闪：一闪（高频）→ 顿 80ms → 轰（低频）→ 余韵。"时间停了一拍"
  blackFlash: [
    { wave: 'sine', freq: 2800, dur: 0.05, gain: 0.55 },
    { wave: 'sine', freq: 48, dur: 0.3, gain: 0.95, at: 0.13 },
    { wave: 'sawtooth', freq: 96, freqTo: 40, dur: 0.28, gain: 0.35, at: 0.13 },
    { wave: 'sine', freq: 1960, dur: 0.18, gain: 0.2, at: 0.3 },
  ],
  // 领域展开：上扫 + 低垫 —— 铺开的感觉，不是打
  domainOpen: [
    { wave: 'sawtooth', freq: 180, freqTo: 760, dur: 0.55, gain: 0.3 },
    { wave: 'sine', freq: 90, dur: 0.7, gain: 0.5 },
    { wave: 'sine', freq: 1520, dur: 0.12, gain: 0.25, at: 0.5 },
  ],
  // 治疗：两音上行，柔
  heal: [
    { wave: 'sine', freq: 523, dur: 0.12, gain: 0.35 },
    { wave: 'sine', freq: 784, dur: 0.16, gain: 0.3, at: 0.09 },
  ],
  // 胜利：三音小号角 + 一个亮音垫底
  win: [
    { wave: 'sine', freq: 523, dur: 0.12, gain: 0.45 },
    { wave: 'sine', freq: 659, dur: 0.12, gain: 0.45, at: 0.1 },
    { wave: 'sine', freq: 784, dur: 0.2, gain: 0.5, at: 0.2 },
    { wave: 'sine', freq: 1046, dur: 0.18, gain: 0.2, at: 0.2 },
  ],
  // 败北：两音下行
  lose: [
    { wave: 'sine', freq: 311, dur: 0.18, gain: 0.45 },
    { wave: 'sine', freq: 208, dur: 0.3, gain: 0.45, at: 0.16 },
  ],
  // 升级：四音琶音 + 收尾一点亮
  gradeUp: [
    { wave: 'sine', freq: 523, dur: 0.1, gain: 0.4 },
    { wave: 'sine', freq: 659, dur: 0.1, gain: 0.4, at: 0.07 },
    { wave: 'sine', freq: 784, dur: 0.1, gain: 0.4, at: 0.14 },
    { wave: 'sine', freq: 1046, dur: 0.16, gain: 0.45, at: 0.21 },
    { wave: 'sine', freq: 1568, dur: 0.14, gain: 0.18, at: 0.28 },
  ],
  // 顿悟：三粒高音的星尘
  insight: [
    { wave: 'sine', freq: 1760, dur: 0.1, gain: 0.3 },
    { wave: 'sine', freq: 2093, dur: 0.1, gain: 0.28, at: 0.06 },
    { wave: 'sine', freq: 2637, dur: 0.14, gain: 0.24, at: 0.12 },
  ],
}

export const cueNames = () => Object.keys(CUES)

// ---------------------------------------------------------------- 开关

const STORE_KEY = 'sunuo:sfx'

function readStored() {
  try {
    return localStorage.getItem(STORE_KEY) !== '0'
  } catch {
    return true
  }
}

let enabled = readStored()

export function setEnabled(v) {
  enabled = !!v
  try {
    localStorage.setItem(STORE_KEY, v ? '1' : '0')
  } catch { /* 存不进去就算了，本次会话内仍然生效 */ }
}
export const isEnabled = () => enabled

// ---------------------------------------------------------------- 播放

let ctx = null

/** 惰性建 AudioContext：必须发生在用户手势之后，否则浏览器会挂起它 */
function ac() {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null
  if (!ctx) ctx = new window.AudioContext()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

/**
 * 播一个 cue。以下情况一律静默返回（不抛错）：
 * 关了 / 没有 WebAudio（Node、老浏览器）/ 没这个 cue。
 * 音效是锦上添花，任何环境都不该因为它坏掉一手牌。
 */
export function play(name) {
  if (!enabled) return
  const events = CUES[name]
  if (!events?.length) return
  const c = ac()
  if (!c) return

  const t0 = c.currentTime + 0.01
  for (const ev of events) {
    const at = t0 + (ev.at || 0)
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = ev.wave
    osc.frequency.setValueAtTime(ev.freq, at)
    if (ev.freqTo) osc.frequency.exponentialRampToValueAtTime(ev.freqTo, at + ev.dur)

    const peak = Math.max(0.001, ev.gain * MASTER)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(peak, at + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, at + ev.dur)

    osc.connect(g).connect(c.destination)
    osc.start(at)
    osc.stop(at + ev.dur + 0.05)
  }
}
