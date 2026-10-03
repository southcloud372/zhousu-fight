import React from 'react'
import { GradeTag } from './Panels.jsx'

export function ActionBar({ actions, onAct, disabled }) {
  if (!actions?.length) return null
  return (
    <div className="choices">
      <div className="choices-inner">
        <div style={{ fontSize: 11, letterSpacing: '0.2em', color: 'var(--ink-faint)', marginBottom: 8 }}>
          选择行动
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 7 }}>
          {actions.map((a) => (
            <button
              key={a.type}
              className="choice"
              style={{ marginBottom: 0 }}
              disabled={disabled || !a.enabled}
              title={a.note || ''}
              onClick={() => onAct(a.type)}
            >
              {a.label}
              {a.note && <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>（{a.note}）</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 战斗结算卡 */
export function CombatResult({ outcome, summary, rewards, ups }) {
  const label = {
    player: '胜利',
    enemy: '败北',
    fled: '脱离',
    draw: '未分胜负',
  }[outcome?.winner] || '结束'
  const color = outcome?.winner === 'player' ? 'var(--ok)'
    : outcome?.winner === 'enemy' ? 'var(--blood-bright)' : 'var(--gold)'

  const gains = Object.entries(rewards?.gains || {})

  return (
    <div className="notes" style={{ borderColor: color }}>
      <div style={{ color, letterSpacing: '0.16em', marginBottom: 5 }}>
        ⚔ 战斗结算 · {label}
      </div>
      {summary && <div style={{ color: 'var(--ink)', marginBottom: 5 }}>{summary}</div>}
      {rewards?.notes?.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>战果：{rewards.notes.join('、')}</div>
      )}
      {gains.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 4 }}>
          {gains.map(([k, v]) => (
            <span key={k} className="tag" style={{ color: 'var(--ok)' }}>{k} +{v}%</span>
          ))}
        </div>
      )}
      {ups?.map((u, i) => (
        <div key={i} style={{ color: 'var(--gold)', fontSize: 12.5, marginTop: 3 }}>★ {u}</div>
      ))}
    </div>
  )
}
