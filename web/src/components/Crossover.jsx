import React from 'react'
import { GradeTag } from './Panels.jsx'

/**
 * 跨篇衔接：两篇之间的时间空白。
 *
 * 不做成"十年后"一句话带过 —— 那样角色一点没长，
 * 2006 年的新人和 2018 年的新人撞上同一批敌人却战力相同，很割裂。
 * 这里把空白拆成三段历练，玩家决定这些年怎么过。
 */
export function CrossoverScreen({ data, step, onChoose, onClose, busy, lastResult }) {
  const { stages, focuses, target, done } = data
  const stage = stages[step]
  const span = `${stages[0].from} – ${stages.at(-1).to}`

  return (
    <div className="pick crossover">
      <div className="pick-inner" style={{ maxWidth: 720 }}>
        <h1>跨越 {span}</h1>
        <div className="sub">
          距离《{target}》还有这些年。它不是白过的 —— 你决定怎么用。
        </div>

        <div className="xo-progress">
          {stages.map((s, i) => (
            <div key={i} className={`xo-dot${i < done ? ' done' : i === step ? ' now' : ''}`}>
              <span className="n">{i + 1}</span>
              <span className="y">{s.from}–{s.to}</span>
            </div>
          ))}
        </div>

        {lastResult && (
          <div className="notes" style={{ borderColor: 'var(--gold)', marginBottom: 18 }}>
            <div style={{ color: 'var(--gold)', letterSpacing: '0.1em', marginBottom: 4 }}>
              {lastResult.range.from}–{lastResult.range.to}　{lastResult.focusName}
            </div>
            {(lastResult.ups || []).map((u, i) => <div key={i} className="up">· {u}</div>)}
          </div>
        )}

        <div className="xo-stage">
          <div className="xo-stage-h">
            <span className="xo-tag">第 {step + 1} 段</span>
            {stage ? `${stage.label}（${stage.from}–${stage.to}，${stage.years} 年）` : '已走完'}
          </div>

          <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            {focuses.map((f) => (
              <button key={f.id} className="xo-focus" onClick={() => onChoose(f.id)} disabled={busy}>
                <span className="xo-focus-n">{f.name}</span>
                <span className="xo-focus-d">{f.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="custom-note" style={{ marginTop: 16 }}>
          三段走完，积累够就直接提升一个等级 —— 没有"瓶颈"或"突破任务"，
          一路堆到龙级也可以。领域仍按自己的方式领悟，与等级无关。
        </div>

        {onClose && (
          <button className="choice" style={{ marginTop: 14, textAlign: 'center' }} onClick={onClose} disabled={busy}>
            稍后再跨
          </button>
        )}
      </div>
    </div>
  )
}

/** 跨篇完成后的结算卡 */
export function CrossoverResult({ result, panel }) {
  if (!result) return null
  return (
    <div className="notes" style={{ borderColor: 'var(--tier)' }}>
      <div style={{ color: 'var(--tier)', letterSpacing: '0.14em', marginBottom: 5 }}>
        ⤳ 跨篇　{result.from} → {result.to}
      </div>
      <div style={{ color: 'var(--ink)', marginBottom: 4 }}>
        {result.startDate}　·　跨越 {result.gapYears} 年
      </div>
      <div style={{ color: 'var(--ink-dim)', marginBottom: 6 }}>{result.note}</div>
      {result.gradeUp && (
        <div style={{ color: 'var(--gold)', marginBottom: 4 }}>
          ★ 综合等级提升至 <GradeTag grade={result.gradeUp} />
        </div>
      )}
      {result.carriedRelations?.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
          记得你的人：{result.carriedRelations.map((r) => `${r.name}(${r.value > 0 ? '+' : ''}${r.value})`).join('　')}
        </div>
      )}
      {panel && (
        <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 5 }}>
          当前 {panel.grade}　HP {panel.hp.max.toLocaleString()}　咒力 {panel.ce.max.toLocaleString()}
        </div>
      )}
    </div>
  )
}
