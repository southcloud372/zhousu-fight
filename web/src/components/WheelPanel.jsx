import React from 'react'

/**
 * 日常轮盘。
 *
 * **位置：右侧状态栏的第一块，不在正文和选项之间。**
 * 它原来占着中间那一栏的整条宽度，把最该读的正文挤扁了 —— 而它本身是
 * "我想跳过这段空档"时才伸手去够的东西，不值得常驻在视野正中。
 *
 * **形态：默认只剩一条可点的窄条**，点一下才展开出转盘和两个动作。
 * 窄条上留了三件必须一眼看到的事：累计练了几天、下一个节点还有几天
 * （到当天会变红）、上一次转到了哪儿 —— 收起来不等于把这些藏掉。
 *
 * 收支（六条成长进度）不在这里重复：状态栏下面那块「成长」面板给的是同一份数据，
 * 而且是服务端算好的那份（panel.training），比这里更权威，名字也更全。
 */

const midAngle = (i, n) => ((i + 0.5) / n) * 360 - 90

function Wheel({ sectors, landed, size = 132 }) {
  const n = sectors.length
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.409
  const [deg, setDeg] = React.useState(0)
  // 转到哪儿由 landed 决定，但指针每一转都要多绕一圈 —— 不绕的话
  // 相邻两次落在邻近扇区时指针几乎不动，看起来像"没转"
  const [spins, setSpins] = React.useState(0)

  const slicePath = (i) => {
    const a0 = ((i / n) * 2 - 0.5) * Math.PI
    const a1 = (((i + 1) / n) * 2 - 0.5) * Math.PI
    const x0 = cx + r * Math.cos(a0)
    const y0 = cy + r * Math.sin(a0)
    const x1 = cx + r * Math.cos(a1)
    const y1 = cy + r * Math.sin(a1)
    const large = a1 - a0 > Math.PI ? 1 : 0
    return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`
  }

  React.useEffect(() => {
    if (!landed) return
    const idx = sectors.findIndex((s) => s.id === landed)
    if (idx < 0) return
    setSpins((k) => k + 1)
    setDeg(midAngle(idx, n))
  }, [landed, n, sectors])

  const fontSize = Math.max(8, size * 0.0795)

  return (
    <svg className="wheel-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <g>
        {sectors.map((s, i) => (
          <path
            key={s.id}
            d={slicePath(i)}
            fill={s.id === landed ? 'var(--gold-dim)' : i % 2 ? 'var(--bg-2)' : 'var(--bg-3)'}
            stroke="var(--line)"
            strokeWidth="1"
          />
        ))}
      </g>
      {sectors.map((s, i) => {
        const a = (midAngle(i, n) * Math.PI) / 180
        const p = { x: cx + r * 0.64 * Math.cos(a), y: cy + r * 0.64 * Math.sin(a) }
        return (
          <text
            key={s.id}
            x={p.x}
            y={p.y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={fontSize}
            fill={s.id === landed ? 'var(--ink)' : 'var(--ink-dim)'}
          >
            {s.short}
            {s.count > 0 && <tspan fill="var(--ink-faint)" fontSize={fontSize * 0.86}> ×{s.count}</tspan>}
          </text>
        )
      })}
      <g
        style={{
          transform: `rotate(${deg + spins * 360}deg)`,
          transformOrigin: `${cx}px ${cy}px`,
          transition: 'transform 720ms cubic-bezier(.15,.85,.2,1)',
        }}
      >
        <line x1={cx} y1={cy} x2={cx} y2={cy - r - 8} stroke="var(--blood-bright)" strokeWidth="3" strokeLinecap="round" />
      </g>
      <circle cx={cx} cy={cy} r="6" fill="var(--bg)" stroke="var(--line)" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * 收起状态：一条可点的窄条，留在状态栏里不占地方。
 *
 * 收起来是为了让出空间，不是为了把这些藏掉 —— 下一次节点还有几天、
 * 这次练到哪儿，恰恰是"要不要点开"的判据，必须写在条上。
 *
 * 窄条**任何时候都能点**（包括正文还在打字的时候）：展开不是行动，不改任何
 * 数值，拦着它只会让玩家在读字的时候伸不了手。真正要拦的是里面那两个按钮。
 */
function Strip({ wheel, ready, ms, landed, onToggle }) {
  return (
    <button
      className={`wheel-strip${ready ? ' ready' : ''}`}
      onClick={onToggle}
      aria-expanded={false}
      title="点开：转一天 / 一路练到剧情当天"
    >
      <span className="ws-row">
        <span className="ws-title">日常轮盘</span>
        <span className="ws-days">累计 {wheel.days} 天</span>
        <span className="ws-more">展开 ▾</span>
      </span>
      <span className="ws-next">
        {ms ? (
          ready ? (
            <><b className="hot">「{ms.node}」就在今天</b><span className="ws-sub">{ms.date} · 点开介入</span></>
          ) : (
            <>距「{ms.node}」还有 <b className="hot">{ms.daysLeft}</b> 天<span className="ws-sub">{ms.date} · {ms.dangerLabel}</span></>
          )
        ) : (
          <span className="ws-sub">这条线的节点都打完了 —— 点顶栏「跨篇」接着走</span>
        )}
      </span>
      {landed && (
        // 转完一天最想看的就是"落到哪儿了"，收起来也得留着
        <span className="ws-landed" key={wheel.days}>上次落在 {landed.short}{landed.count > 0 ? ` ×${landed.count}` : ''}</span>
      )}
    </button>
  )
}

/**
 * 日常轮盘：两段剧情之间的空闲时间，一天转一次，落在一个方向上就涨一点属性。
 * 转到剧情节点当天，主按钮变成「介入这场战斗」。
 */
export function WheelPanel({ wheel, gate, busy, onSpin, onAdvance, open, onToggle }) {
  if (!wheel) return null

  const ms = wheel.milestone
  const ready = !!ms && ms.daysLeft <= 0
  // 闸门分两档：到剧情当天时"不能再往后转"但"可以打"。
  // 用一个 blocked 把两个按钮一起禁掉的话，玩家会卡在节点当天动不了
  const spinOff = busy || !gate?.spin
  const advOff = busy || !gate?.advance
  const blocked = !gate?.ok
  const landed = wheel.sectorsTable.find((s) => s.id === wheel.lastItem)

  if (!open) return <Strip wheel={wheel} ready={ready} ms={ms} landed={landed} onToggle={onToggle} />

  return (
    <div className={`wheel-panel${ready ? ' ready' : ''}`}>
      <div className="wheel-head">
        <span className="wheel-title">日常轮盘</span>
        <button className="wheel-toggle" onClick={onToggle} aria-expanded title="收起，把状态栏还给其它面板">
          收起 ▴
        </button>
      </div>

      <div className="wheel-left">
        <Wheel sectors={wheel.sectorsTable} landed={wheel.lastItem} />
      </div>

      <div className="wheel-next">
        {ms ? (
          ready ? (
            <>
              <b className="hot">「{ms.node}」就在今天</b>
              <span className="wheel-sub">{ms.date} · {ms.dangerLabel}　先打完这一场，再往下走</span>
            </>
          ) : (
            <>
              距离 <b>「{ms.node}」</b> 还有 <b className="hot">{ms.daysLeft}</b> 天
              <span className="wheel-sub">{ms.date} · {ms.dangerLabel}</span>
            </>
          )
        ) : (
          <span className="wheel-sub">
            这条线的节点都打完了 —— 点顶栏「跨篇」接着走，或者切回剧情向自由发挥。
          </span>
        )}
      </div>

      <div className="wheel-actions">
        <button
          className="wheel-btn"
          disabled={spinOff}
          title={gate?.reason || '转一天：随机落在六个方向之一，涨一点属性'}
          onClick={onSpin}
        >
          转一天
        </button>
        <button
          className="wheel-btn primary"
          disabled={advOff || !ms}
          title={gate?.reason || (ready ? '就在今天，直接开打' : '一路练到剧情当天，逐天结算')}
          onClick={onAdvance}
        >
          {ready ? '介入这场战斗' : ms ? `练到剧情当天（${ms.daysLeft} 天）` : '已无节点'}
        </button>
      </div>
      {blocked && <div className="wheel-block">{gate.reason}</div>}
      {!blocked && !gate?.spin && <div className="wheel-block hot">先打完这一场</div>}

      <div className="wheel-meta">
        累计修炼 {wheel.days} 天 · 疲劳 {Number(wheel.fatigue).toFixed(2)}
      </div>
    </div>
  )
}
