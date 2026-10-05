import React from 'react'

const TIER = ['弱特级', '标特级', '超特级', '龙级']
const isTier = (g) => TIER.includes(g)

/** 特级细分只在玩家可见的面板里出现，NPC 那边由服务端过滤 */
export function GradeTag({ grade }) {
  if (!grade) return null
  return <span className={`grade${isTier(grade) ? ' tier' : ''}`}>{grade}</span>
}

function Bar({ label, cur, max, cls, suffix }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0
  return (
    <div className="bar">
      <div className="bar-head">
        <span>{label}</span>
        <b>
          {Math.round(cur).toLocaleString()} / {Math.round(max).toLocaleString()}
          {suffix}
        </b>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function StatusPanel({ panel }) {
  if (!panel) return null
  const p = panel
  // 面板数据来自服务端，字段缺失时宁可少显示一块，也不要整页崩掉
  if (!p.hp || !p.ce || !p.technique) {
    return (
      <div className="panel">
        <h3>穿越者</h3>
        <div className="card" style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>
          角色数据不完整，等待同步…
        </div>
      </div>
    )
  }
  return (
    <div className="panel">
      <h3>穿越者</h3>
      <div className="card">
        <div className="who-name">{p.name}</div>
        <div className="who-meta">
          {p.age}岁 · {p.backgroundType} · <GradeTag grade={p.grade} />
        </div>

        <Bar label="血条" cur={p.hp.cur} max={p.hp.max} cls="hp" />
        <Bar label="咒力" cur={p.ce.cur} max={p.ce.max} cls="ce" />

        <div className="kv" style={{ marginTop: 8 }}>
          <span>状态</span>
          <span className={`status-pill s-${p.status}`}>{p.status}</span>
        </div>
        <div className="kv"><span>咒术伤害</span><span>{p.cursedDamage.value.toLocaleString()}（{p.cursedDamage.grade}）</span></div>
        <div className="kv"><span>体术伤害</span><span>{p.physicalDamage.value.toLocaleString()}（{p.physicalDamage.grade}）</span></div>
        <div className="kv"><span>咒力效率</span><span>{Math.round(p.efficiency.value * 100)}%（{p.efficiency.grade}）</span></div>

        <div className="divider" style={{ height: 1, background: 'var(--line-soft)', margin: '10px 0' }} />

        <div className="kv"><span>生得术式</span><span>{p.technique.name}</span></div>
        <div style={{ fontSize: 12, color: 'var(--ink-faint)', lineHeight: 1.6, marginTop: 2 }}>
          {p.technique.effect}
        </div>
        <div className="kv" style={{ marginTop: 6 }}>
          <span>倍率 / 冷却</span>
          <span>×{p.technique.multiplier} / {p.technique.cooldown}回合{p.technique.cdLeft > 0 ? `（冷却中 ${p.technique.cdLeft}）` : ''}</span>
        </div>

        {p.domain?.unlocked ? (
          <div className="domain-box">
            <div className="dn">领域 · {p.domain.name}</div>
            <div style={{ color: 'var(--ink-dim)' }}>{p.domain.tierName}</div>
            <div style={{ marginTop: 4 }}>必中：{p.domain.sureHit}</div>
            <div style={{ color: 'var(--blood-bright)' }}>代价：{p.domain.cost}</div>
          </div>
        ) : (
          <div className="kv" style={{ marginTop: 6 }}><span>领域</span><span>未领悟</span></div>
        )}

        <div className="kv" style={{ marginTop: 6 }}>
          <span>反转术式</span>
          <span>{p.reverseCursedTechnique.level}{p.reverseCursedTechnique.progress ? `（${p.reverseCursedTechnique.progress}%）` : ''}</span>
        </div>

        {p.talents?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {p.talents.map((t) => <span key={t} className="tag">{t}</span>)}
          </div>
        )}
        {p.tools?.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {p.tools.map((t) => <span key={t.name} className="tag">{t.name}</span>)}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 成长面板 —— 六个修炼方向的进度条。
 *
 * 属性不是"转一天加一点"，而是**攒满 100% 才跳一次**（血条上限 +10%、
 * 术式熟练 +10%……），轮盘一天只推几个点。不把进度摆出来的话，玩家转完一天
 * 回头看右边，数字纹丝不动，只会以为轮盘白转了 —— "加了属性右边怎么没更新"
 * 说的就是这件事。进度条就是那句"我确实练到了"。
 */
export function GrowthPanel({ rows, training, days }) {
  if (!rows?.length) return null
  const list = rows.map((r) => ({ ...r, progress: Math.round(training?.[r.id] || 0) }))
  // 一次都没练过就别占地方 —— 开局六条全 0 的进度条只是噪音
  if (!list.some((r) => r.progress > 0) && !days) return null

  return (
    <div className="panel">
      <h3>成长{days > 0 ? ` · 修炼 ${days} 天` : ''}</h3>
      <div className="card">
        {list.map((r) => (
          <div className="grow-row" key={r.id} title={`练满 100% 给：${r.effect}`}>
            <span className="grow-name">{r.id}</span>
            <span className="grow-track">
              <i className="grow-fill" style={{ width: `${Math.max(0, Math.min(100, r.progress))}%` }} />
            </span>
            <span className="grow-pct">{r.progress}%</span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6, lineHeight: 1.6 }}>
          攒满 100% 当场结算：血条上限 / 咒力上限 / 伤害 +10%，咒力效率 +5%，
          术式熟练、领域雏形、反转术式按各自的档位走
        </div>
      </div>
    </div>
  )
}

export function RelationPanel({ relations }) {
  if (!relations) return null
  const rows = Object.entries(relations).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  return (
    <div className="panel">
      <h3>关系网</h3>
      <div className="card">
        {rows.map(([name, v]) => (
          <div className="rel-row" key={name}>
            <span className="n">{name}</span>
            <span className="rel-bar">
              <i style={{
                left: v >= 0 ? '50%' : `${50 - (Math.abs(v) / 100) * 50}%`,
                width: `${(Math.abs(v) / 100) * 50}%`,
                background: v >= 0 ? 'var(--ok)' : 'var(--blood)',
              }} />
            </span>
            <span className="v" style={{ color: v > 0 ? 'var(--ok)' : v < 0 ? 'var(--blood)' : 'var(--ink-faint)' }}>
              {v > 0 ? `+${v}` : v}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SukunaPanel({ sukuna }) {
  if (!sukuna) return null
  return (
    <div className="panel">
      <h3>宿傩手指追踪</h3>
      <div className="card">
        <Bar label="觉醒度" cur={sukuna.awakening} max={100} cls="hp" suffix="%" />
        <div className="kv" style={{ marginTop: 8 }}><span>已收集</span><span>{sukuna.fingersCollected} / 20</span></div>
        <div className="kv"><span>虎杖已吞下</span><span>{sukuna.fingersEaten} 根</span></div>
        <div className="kv"><span>宿傩态度</span><span style={{ color: 'var(--tier)' }}>{sukuna.attitude}</span></div>
      </div>
    </div>
  )
}

export function TimelinePanel({ timeline }) {
  if (!timeline) return null
  return (
    <div className="panel">
      <h3>原作分歧追踪</h3>
      <div className="card">
        {Object.entries(timeline.nodes).map(([k, v]) => (
          <div className="tl-row" key={k}>
            <span>{k}</span>
            <span className={`st ${v}`}>{v}</span>
          </div>
        ))}
        {timeline.newEvents?.length > 0 && (
          <div style={{ marginTop: 8, borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginBottom: 4 }}>因玩家介入产生</div>
            {timeline.newEvents.map((e) => (
              <div key={e} style={{ fontSize: 12, color: 'var(--gold)' }}>· {e}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
