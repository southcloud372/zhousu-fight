import React from 'react'

/**
 * 战斗向的日常轮盘。
 *
 * 两段剧情之间的空闲时间，一天转一次：落在一个方向上就涨一点属性。
 * 转到剧情节点当天，这颗按钮变成"介入战斗"。
 *
 * 这一块是战斗向的主要操作台，所以放在正文和选项之间的正中间，
 * 而不是塞进右侧那条窄状态栏里。
 */

const SIZE = 132
const CX = SIZE / 2
const CY = SIZE / 2
const R = 54

const midAngle = (i, n) => ((i + 0.5) / n) * 360 - 90

function slicePath(i, n, r = R) {
  const a0 = ((i / n) * 2 - 0.5) * Math.PI
  const a1 = (((i + 1) / n) * 2 - 0.5) * Math.PI
  const x0 = CX + r * Math.cos(a0)
  const y0 = CY + r * Math.sin(a0)
  const x1 = CX + r * Math.cos(a1)
  const y1 = CY + r * Math.sin(a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${CX} ${CY} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`
}

function labelPos(i, n, r = R * 0.64) {
  const a = (midAngle(i, n) * Math.PI) / 180
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) }
}

function Wheel({ sectors, landed }) {
  const n = sectors.length
  const [deg, setDeg] = React.useState(0)

  // 指针永远往前走，不要倒着转回去
  React.useEffect(() => {
    if (!landed) return
    const idx = sectors.findIndex((s) => s.id === landed)
    if (idx < 0) return
    const target = midAngle(idx, n)
    setDeg((d) => {
      const cur = ((d % 360) + 360) % 360
      const delta = (((target - cur) % 360) + 360) % 360
      return d + delta + 360
    })
  }, [landed, n, sectors])

  return (
    <svg className="wheel-svg" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
      <g>
        {sectors.map((s, i) => (
          <path
            key={s.id}
            d={slicePath(i, n)}
            fill={s.id === landed ? 'var(--gold-dim)' : i % 2 ? 'var(--bg-2)' : 'var(--bg-3)'}
            stroke="var(--line)"
            strokeWidth="1"
          />
        ))}
      </g>
      {sectors.map((s, i) => {
        const p = labelPos(i, n)
        return (
          <text
            key={s.id}
            x={p.x}
            y={p.y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="10.5"
            fill={s.id === landed ? 'var(--ink)' : 'var(--ink-dim)'}
          >
            {s.short}
            {s.count > 0 && <tspan fill="var(--ink-faint)" fontSize="9"> ×{s.count}</tspan>}
          </text>
        )
      })}
      <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: `${CX}px ${CY}px`, transition: 'transform 620ms cubic-bezier(.15,.85,.2,1)' }}>
        <line x1={CX} y1={CY} x2={CX} y2={CY - R - 8} stroke="var(--blood-bright)" strokeWidth="3" strokeLinecap="round" />
      </g>
      <circle cx={CX} cy={CY} r="6" fill="var(--bg)" stroke="var(--line)" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * 六条进度条。
 *
 * 属性不是"转一天加一点"，而是**攒满 100% 才跳一次**（血条上限 +10% 之类）。
 * 不把进度摆出来的话，玩家转完一天回到右边状态栏，会发现数字根本没动 ——
 * 看起来就像轮盘白转了。进度条就是那句"我确实练到了"。
 */
function Bars({ rows, compact = false }) {
  if (!rows?.length) return null
  return (
    <div className={`grow-bars${compact ? ' compact' : ''}`}>
      {rows.map((r) => (
        <div className="grow-row" key={r.id} title={r.effect ? `练满 100% 给：${r.effect}` : undefined}>
          <span className="grow-name">{compact ? r.short : r.id}</span>
          <span className="grow-track">
            <i className="grow-fill" style={{ width: `${Math.max(0, Math.min(100, r.progress))}%` }} />
          </span>
          <span className="grow-pct">{r.progress}%</span>
        </div>
      ))}
    </div>
  )
}

export function WheelPanel({ wheel, gate, busy, onSpin, onAdvance }) {
  if (!wheel) return null

  const ms = wheel.milestone
  const ready = !!ms && ms.daysLeft <= 0
  // 闸门现在分两档：到剧情当天时"不能再往后转"但"可以打"。
  // 用一个 blocked 把两个按钮一起禁掉的话，玩家会卡在节点当天动不了
  const spinOff = busy || !gate?.spin
  const advOff = busy || !gate?.advance
  const blocked = !gate?.ok

  return (
    <div className={`wheel-panel${ready ? ' ready' : ''}`}>
      <div className="wheel-left">
        <Wheel sectors={wheel.sectorsTable} landed={wheel.lastItem} />
      </div>

      <div className="wheel-mid">
        <div className="wheel-head">
          <span className="wheel-title">日常轮盘</span>
          <span className="wheel-days">累计修炼 {wheel.days} 天</span>
          <span className="wheel-fatigue" title="连续修炼的收益衰减，静养一天或打完一场介入战会恢复">
            疲劳 {Number(wheel.fatigue).toFixed(2)}
          </span>
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

        <Bars rows={wheel.sectorsTable} compact />

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
          {blocked && <span className="wheel-block">{gate.reason}</span>}
          {!blocked && !gate?.spin && <span className="wheel-block hot">先打完这一场</span>}
        </div>
      </div>
    </div>
  )
}
