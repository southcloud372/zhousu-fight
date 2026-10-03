import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CombatResult } from './CombatPanel.jsx'
import { CrossoverResult } from './Crossover.jsx'
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
  if (e.kind === 'crossover') {
    return <CrossoverResult result={e.result} panel={e.panel} />
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

    /*
     * 玩家出手时：把他刚点的那一行**钉在视野顶部**，新正文从它下面往下长。
     *
     * 之前这里是"跟到底"，结果是点完选项直接被甩到段落结尾 ——
     * 新正文一边生成一边把视线往下推，等于永远只看到最后几行。
     * 玩家要的是从自己那一手开始，顺着往下读。
     */
    if (playerRoundsRef.current !== playerRounds) {
      playerRoundsRef.current = playerRounds
      const nodes = el.querySelectorAll('.log-inner > *')
      const anchor = nodes[nodes.length - 1]
      if (anchor) {
        // 用相对位移而不是 offsetTop —— 后者依赖 offsetParent，容易算错
        const delta = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
        el.scrollTop += delta - 10
      }
      // 关掉自动跟随：正文继续生成，但视野停在玩家那一手
      pinnedRef.current = false
      setPinned(false)
      return // 这一拍不跟到底
    }

    if (!pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [entries, playerRounds, streaming, liveCombat?.narration, busy])

  return (
    <div className="log-wrap">
      <div className="log" ref={logRef} onScroll={handleScroll}>
        <div className="log-inner">
          {entries.map((e, i) => (
            <React.Fragment key={i}>
              {i > 0 && !['training', 'combat', 'combatResult', 'inquiry', 'crossover'].includes(e.kind) && (
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
  const [collapsed, setCollapsed] = React.useState(false)
  const trimmed = free.trim()
  const count = choices.length

  return (
    <div className={`choices${collapsed ? ' collapsed' : ''}`}>
      {/* 选项多的时候这块会占掉半屏，留个收起按钮把空间还给剧情 */}
      <div className="choices-head">
        <button
          className="choices-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          title={collapsed ? '展开选项' : '收起选项，把空间还给剧情'}
        >
          <span className="chev">{collapsed ? '▸' : '▾'}</span>
          选择行动
          <span className="cnt">{count}</span>
        </button>
        {!collapsed && count > 0 && (
          <span className="choices-tip">也可以直接在下面写你想做的事</span>
        )}
      </div>

      {/* 选项列表：超出高度时自己滚，不挤压剧情 */}
      {!collapsed && count > 0 && (
        <div className="choices-list">
          {choices.map((c, i) => (
            <button
              key={c.id}
              className={`choice${c.kind === 'training' ? ' train' : ''}`}
              disabled={disabled || c.disabled}
              title={c.reason || ''}
              onClick={() => onPick(c)}
            >
              {/* 序号用数组下标，不能用 c.id —— 那是内部标识
                  （修炼项是 t-体能训练 这种），当成序号显示会变成 "t-体能训练.体能训练" */}
              <span className="idx">{c.kind === 'training' ? '※' : i + 1}.</span>
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* 自定义行动常驻：收起选项时也留着，它是主要输入方式之一 */}
      <div className="custom-row">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!trimmed) return
            setFree('')
            try { localStorage.setItem('sunuo:lastAction', trimmed) } catch {}
            onPick({ id: 'free', label: trimmed, kind: 'story' })
          }}
        >
          <input
            value={free}
            onChange={(e) => setFree(e.target.value)}
            placeholder="自定义行动 —— 想做什么直接写，例如：先退到巷口，试探它的反应"
            disabled={disabled}
            aria-label="自定义行动"
          />
          <button type="submit" disabled={disabled || !trimmed}>执行</button>
        </form>
      </div>
    </div>
  )
}

export { useTypewriter }
