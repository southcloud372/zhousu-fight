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

/**
 * 日常轮盘。
 *
 * 默认是**收起**的一条窄条：一颗小转盘 + 一行"还差几天" + 两个按钮。
 * 为什么默认收起 —— 战斗向里，一批剧情选项和轮盘会同时存在，两个都是
 * "接下来该干什么"的操作区，并排摆着玩家会不知道该按哪边；而轮盘原来
 * 还占着正文上方一大块，把最该读的那一栏挤扁了。收起来之后层次就清楚了：
 * 剧情是主线，轮盘是"我想跳过这段空档"时才伸手去够的东西。
 *
 * 展开后给出六条进度条 —— 它们是"我确实练到了"的唯一凭据，
 * 但只在想看的时候看。
 */
export function WheelPanel({ wheel, gate, busy, onSpin, onAdvance, open, onToggle }) {
  if (!wheel) return null

  const ms = wheel.milestone
  const ready = !!ms && ms.daysLeft <= 0
  // 闸门现在分两档：到剧情当天时"不能再往后转"但"可以打"。
  // 用一个 blocked 把两个按钮一起禁掉的话，玩家会卡在节点当天动不了
  const spinOff = busy || !gate?.spin
  const advOff = busy || !gate?.advance
  const blocked = !gate?.ok

  return (
    <div className={`wheel-panel${ready ? ' ready' : ''}${open ? ' open' : ' compact'}`}>
      <div className="wheel-left">
        <Wheel sectors={wheel.sectorsTable} landed={wheel.lastItem} size={open ? 132 : 96} />
        {/* 收起来的时候，把这一次的落点顶在盘下面 —— 转完一天最想看的就是这个 */}
        {!open && wheel.lastItem && (
          <span className="wheel-landed" key={wheel.days}>
            {wheel.sectorsTable.find((s) => s.id === wheel.lastItem)?.short || wheel.lastItem}
          </span>
        )}
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

        {open && <Bars rows={wheel.sectorsTable} compact />}

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
          <button
            className="wheel-toggle"
            onClick={onToggle}
            aria-expanded={!!open}
            title={open ? '收起轮盘，把空间还给剧情' : '展开：看六个方向的修炼进度'}
          >
            {open ? '收起 ▴' : '进度 ▾'}
          </button>
          {blocked && <span className="wheel-block">{gate.reason}</span>}
          {!blocked && !gate?.spin && <span className="wheel-block hot">先打完这一场</span>}
        </div>
      </div>
    </div>
  )
}
