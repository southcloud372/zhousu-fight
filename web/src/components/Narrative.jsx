import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CombatResult } from './CombatPanel.jsx'
import { typewriterStep, TICK_MS } from '../lib/typewriter.js'
import { Inquiry } from './Inquiry.jsx'

function Dialogue({ lines }) {
  if (!lines?.length) return null
  return (
    <div className="dialogue">
      {lines.map((d, i) => (
        <div className="line" key={i}>
          <span className="who">{d.speaker}</span>
          <div className="what">{d.text}</div>
        </div>
      ))}
    </div>
  )
}

function Notes({ notes }) {
  if (!notes?.length) return null
  return (
    <div className="notes">
      {notes.map((n, i) => (
        <div key={i} className={n.includes('→') || n.includes('+') ? 'up' : ''}>
          · {n}
        </div>
      ))}
    </div>
  )
}

function Entry({ e }) {
  if (e.kind === 'player') {
    return <div className="player-input">{e.text}</div>
  }
  if (e.kind === 'combat') {
    // 数值面板已经挪到左侧战斗栏，中间这一栏只留演出文字
    return e.narration ? <p className="narr">{e.narration}</p> : null
  }
  if (e.kind === 'combatResult') {
    return <CombatResult outcome={e.outcome} summary={e.summary} rewards={e.rewards} ups={e.ups} />
  }
  if (e.kind === 'inquiry') {
    return <Inquiry inquiry={e.inquiry} />
  }
  if (e.kind === 'training') {
    return (
      <div className="notes" style={{ borderColor: 'var(--gold)' }}>
        <div style={{ color: 'var(--gold)', letterSpacing: '0.1em', marginBottom: 4 }}>
          修炼 · {e.item}　进度 +{e.progress}%
        </div>
        {e.flavor && <div style={{ fontFamily: 'var(--font-narr)', color: 'var(--ink)', marginBottom: 4 }}>{e.flavor}</div>}
        {e.ups?.map((u, i) => <div key={i} className="up">· {u}</div>)}
        {e.notes?.map((n, i) => <div key={`n${i}`}>· {n}</div>)}
        {e.hpDelta ? <div style={{ color: 'var(--blood-bright)' }}>· 受伤 {e.hpDelta}</div> : null}
      </div>
    )
  }
  return (
    <>
      {e.narration && <p className="narr">{e.narration}</p>}
      <Dialogue lines={e.dialogue} />
      <Notes notes={e.notes} />
    </>
  )
}

/**
 * 打字机队列。
 *
 * 服务端是一条 SSE 事件一条地推，但浏览器会把多次 write 合并成一次 read，
 * 于是文字一块一块往外蹦。这里把收到的字先进缓冲区，再按固定节奏吐出来。
 *
 * 节奏：基础 2 字 / 16ms（约 125 字/秒，和模型生成速度接近）。
 * 落后超过 240 字就加速追上，避免打字机永远追不上生成速度。
 */
function useTypewriter() {
  const bufRef = useRef('')
  const shownRef = useRef('')
  const timerRef = useRef(null)
  const [shown, setShown] = useState(null) // null 表示当前没有在流式输出

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const tick = useCallback(() => {
    const buf = bufRef.current
    if (!buf) return
    const take = Math.min(buf.length, typewriterStep(buf.length))
    bufRef.current = buf.slice(take)
    shownRef.current += buf.slice(0, take)
    setShown(shownRef.current)
  }, [])

  const feed = useCallback((text) => {
    if (!text) return
    bufRef.current += text
    if (timerRef.current) return
    timerRef.current = setInterval(tick, TICK_MS)
  }, [tick])

  /** 开始一段新的流式输出 */
  const begin = useCallback(() => {
    stop()
    bufRef.current = ''
    shownRef.current = ''
    setShown('')
  }, [stop])

  /** 服务端要求重来（正文为空的重试），丢掉已显示的部分 */
  const reset = useCallback(() => {
    bufRef.current = ''
    shownRef.current = ''
    setShown('')
  }, [])

  /** 收尾：把剩下的字立刻吐完，避免和最终条目之间出现跳变 */
  const flush = useCallback(() => {
    stop()
    if (bufRef.current) {
      shownRef.current += bufRef.current
      bufRef.current = ''
    }
    const final = shownRef.current
    setShown(null)
    return final
  }, [stop])

  useEffect(() => stop, [stop])

  return { shown, feed, begin, reset, flush }
}

/** 贴底阈值：离底部这么近才算"用户在看最新" */
const PIN_THRESHOLD = 80

export function NarrativeLog({ entries, streaming, busy, liveCombat }) {
  const logRef = useRef(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)

  // 只有用户本来就贴在底部时才自动跟随。
  // 早先任何变化都 scrollIntoView，玩家往回翻两屏就会被拽到底，根本读不了。
  const handleScroll = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD
    pinnedRef.current = atBottom
    setPinned((prev) => (prev === atBottom ? prev : atBottom))
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = logRef.current
    if (!el) return
    pinnedRef.current = true
    setPinned(true)
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }, [])

  // 玩家出手的次数。注意要比较"有没有新增"，不能看"最后一条是不是玩家行动" ——
  // 后者在整个流式生成期间都成立，于是每一帧都会把玩家拽回底部，
  // 这正是"强制跟随"的根源。
  const playerRounds = entries.reduce((n, e) => n + (e.kind === 'player' ? 1 : 0), 0)
  const playerRoundsRef = useRef(playerRounds)

  useEffect(() => {
    const el = logRef.current
    if (!el) return

    // 玩家刚刚出手（新增了他的行动条目）→ 恢复跟随，他要看结果
    if (playerRoundsRef.current !== playerRounds) {
      playerRoundsRef.current = playerRounds
      pinnedRef.current = true
      setPinned(true)
    }
    if (!pinnedRef.current) return

    // 用 scrollTop 直接定位而不是 scrollIntoView({smooth})：
    // 流式时每 16ms 触发一次，平滑动画会互相打断，看着像卡顿。
    el.scrollTop = el.scrollHeight
  }, [entries, playerRounds, streaming, liveCombat?.narration, busy])

  return (
    <div className="log-wrap">
      <div className="log" ref={logRef} onScroll={handleScroll}>
        <div className="log-inner">
          {entries.map((e, i) => (
            <React.Fragment key={i}>
              {i > 0 && !['training', 'combat', 'combatResult', 'inquiry'].includes(e.kind) && (
                <div className="turn-sep">第 {e.turn ?? ''} 回合</div>
              )}
              <Entry e={e} />
            </React.Fragment>
          ))}

          {/* 战斗中的演出正文留在中间，数值面板在左侧战斗栏 */}
          {liveCombat?.narration && (
            <p className="narr">
              {liveCombat.narration}
              {/* 光标只在真的还在生成时闪 —— 一直挂着会让人以为没写完 */}
              {liveCombat.streaming && <span className="caret" />}
            </p>
          )}

          {streaming !== null && (
            <p className="narr">
              {streaming}
              <span className="caret" />
            </p>
          )}

          {busy && streaming === null && (
            <div className="loading" style={{ padding: '18px 0' }}>
              <div className="spinner" />
            </div>
          )}
        </div>
      </div>

      {!pinned && (
        <button className="jump-latest" onClick={() => scrollToBottom(true)}>
          ↓ 回到最新
        </button>
      )}
    </div>
  )
}

/**
 * 选项栏。
 *
 * 自定义输入是常驻的 —— 每一轮剧情都能不走选项、直接写自己想做的事。
 * 之前它混在选项下面不太显眼，现在单独一行并加了标题。
 */
export function ChoiceList({ choices, onPick, disabled }) {
  const [free, setFree] = React.useState('')
  const trimmed = free.trim()

  return (
    <div className="choices">
      <div className="choices-inner">
        {choices.map((c) => (
          <button
            key={c.id}
            className={`choice${c.kind === 'training' ? ' train' : ''}`}
            disabled={disabled || c.disabled}
            title={c.reason || ''}
            onClick={() => onPick(c)}
          >
            <span className="idx">{c.kind === 'training' ? '※' : c.id}.</span>
            {c.label}
          </button>
        ))}

        <div className="custom-row">
          <div className="custom-label">自定义行动 —— 想做什么直接写</div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!trimmed) return
              setFree('')
              // 记住上一次输入，方便微调重发
              try { localStorage.setItem('sunuo:lastAction', trimmed) } catch {}
              onPick({ id: 'free', label: trimmed, kind: 'story' })
            }}
          >
            <input
              value={free}
              onChange={(e) => setFree(e.target.value)}
              placeholder="例如：先退到巷口，用咒力试探它的反应"
              disabled={disabled}
              aria-label="自定义行动"
            />
            <button type="submit" disabled={disabled || !trimmed}>执行</button>
          </form>
        </div>
      </div>
    </div>
  )
}

export { useTypewriter }
