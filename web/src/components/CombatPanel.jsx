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

        <div className="choices-head" style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 11, letterSpacing: '0.2em', color: 'var(--ink-faint)' }}>
            选择行动
          </span>
          <span className="choices-tip">按数字键直接出招</span>
        </div>
        <div className="act-grid">
          {actions.map((a, i) => (
            <button
              key={a.type}
              // 数字键直接出招：全局快捷键就是按这个顺序找 .choice 点下去的
              className={`choice act-${a.type}`}
              style={{ marginBottom: 0 }}
              disabled={disabled || !a.enabled}
              title={a.note || ''}
              onClick={() => onAct(a.type)}
            >
              <span className="idx">{i + 1}.</span>
              {a.label}
              {a.note && <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>（{a.note}）</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 处置倒下的对手：杀，还是放。
 *
 * 打赢一场之后必然要过的一问。原来它藏在玩家的行动文本里 —— 打了"杀了他"
 * 三个字才算击杀，没说就当放走。可"杀"是这条线上最不可逆的一件事：
 * 杀错了人，他撑起的那一天就没了，后面整条线都要重排。这种事不该由
 * 一行文本的措辞决定，也不该被顺手一带而过。
 *
 * 摆在打完那一刻，因为那是玩家手里最有余裕的一刻：人刚倒下，
 * "要不要留他一命"还是个问题；等下一段正文写完，它就成了过去式。
 *
 * lethalIntent 只做一件事：开打前就说过要命的人，「击杀」默认带一道高亮 ——
 * 那个答案他早就说出口了，别让他再点一次。真正按下哪一边仍然由他定。
 */
export function DisposeModal({ data, busy, onPick }) {
  if (!data) return null
  const who = `${data.grade ? `${data.grade}的` : ''}${data.name}`
  return (
    <div className="overlay">
      <div className="modal dispose-modal">
        <h2>怎么处置他</h2>

        <div className="dispose-who">
          {data.grade && <GradeTag grade={data.grade} />}
          <b>{data.name}</b>
          {/* 原作人物值得单独标一下：杀他的分量和杀一个无名咒灵不是一回事 */}
          {data.canon && <em title="按原作表校正过的人物">原作</em>}
        </div>

        <div className="hint">
          {who}已经倒下，站不起来了。
          {data.intervention ? `今天是「${data.intervention}」—— 这一下会决定这一天变成什么样。` : ''}
        </div>

        <div className="dispose-acts">
          <button
            className={`choice dispose-pick kill${data.lethalIntent ? ' armed' : ''}`}
            disabled={busy}
            onClick={() => onPick(true)}
          >
            击杀
            <span>他不会再出现。撑起的那一天会被改写。</span>
          </button>
          <button className="choice dispose-pick spare" disabled={busy} onClick={() => onPick(false)}>
            放走
            <span>他还活着，后面还会找上你。</span>
          </button>
        </div>

        {data.lethalIntent && (
          <div className="dispose-note">开打前你就说过要他的命 —— 已经替你把「击杀」标上。</div>
        )}
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
