import React from 'react'
import { GradeTag } from './Panels.jsx'

/**
 * 回合行动栏。
 *
 * freeActions 是"不占回合"的那一类（目前只有反转术式）：按下去之后
 * 回合数不变、敌方不动，玩家照样从下面挑一个行动。所以它单独占一行，
 * 和普通行动视觉上分开 —— 否则玩家会以为按了它这一回合就过去了。
 */
export function ActionBar({ actions, freeActions, onAct, disabled }) {
  if (!actions?.length) return null
  const frees = (freeActions || []).filter(Boolean)

  return (
    <div className="choices">
      <div className="choices-inner">
        {frees.length > 0 && (
          <div className="free-row">
            <span className="free-label">不占回合</span>
            {frees.map((f) => (
              <button
                key={f.type}
                className="choice free"
                style={{ marginBottom: 0, padding: '5px 12px', fontSize: 13 }}
                disabled={disabled || !f.enabled}
                title={f.note || ''}
                onClick={() => onAct(f.type, { free: true })}
              >
                ↺ {f.label}
                {f.note && <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>（{f.note}）</span>}
              </button>
            ))}
          </div>
        )}

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
