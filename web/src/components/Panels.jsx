import React, { useState } from 'react'
import { useCountUp } from './Fx.jsx'

const TIER = ['弱特级', '标特级', '超特级', '龙级']
const isTier = (g) => TIER.includes(g)

/** 特级细分只在玩家可见的面板里出现，NPC 那边由服务端过滤 */
export function GradeTag({ grade }) {
  if (!grade) return null
  return <span className={`grade${isTier(grade) ? ' tier' : ''}`}>{grade}</span>
}

function Bar({ label, cur, max, cls, suffix }) {
  // 数字滚动和血条自己的宽度过渡走同一段时间 —— 见 Fx.jsx 的 useCountUp
  const shownCur = useCountUp(cur)
  const shownMax = useCountUp(max, 520)
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0
  return (
    <div className="bar">
      <div className="bar-head">
        <span>{label}</span>
        <b>
          {Math.round(shownCur).toLocaleString()} / {Math.round(shownMax).toLocaleString()}
          {suffix}
        </b>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }}>
          <span className="bar-sheen" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}

export function StatusPanel({ panel, onEdit }) {
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
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="who-name">{p.name}</div>
            <div className="who-meta">
              {p.age}岁 · {p.backgroundType} · <GradeTag grade={p.grade} />
            </div>
          </div>
          {/*
            改自己。数值驱动的游戏里总会有"我想把这局调成我想要的样子"的时候 ——
            与其让人去翻存档文件，不如把门摆在面板上。
          */}
          {onEdit && (
            <button className="dossier-btn" onClick={onEdit} title="修改自己的数值">编辑</button>
          )}
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
 * 改数值。
 *
 * 每一个输入框都直接对应引擎里的一个字段，**等级不在其中** ——
 * 等级是这些数推出来的标签，不是能单独设定的一项（见 rolls.js 的注释）。
 * 领域觉醒、术式消耗同理，都是跟着数字走的派生量。
 *
 * 数字原样送上去，夹取也在服务端做：客户端自己夹一遍的话，
 * 两边规则迟早会分叉成"界面说能填到 999，服务端只认 800"。
 */
const EDIT_FIELDS = [
  { key: 'hp', label: '血条上限', get: (p) => p.hp.max },
  { key: 'hpCur', label: '当前血', get: (p) => p.hp.cur },
  { key: 'ce', label: '咒力上限', get: (p) => p.ce.max },
  { key: 'ceCur', label: '当前咒力', get: (p) => p.ce.cur },
  { key: 'cursedDamage', label: '咒术伤害', get: (p) => p.cursedDamage.value },
  { key: 'physicalDamage', label: '体术伤害', get: (p) => p.physicalDamage.value },
  { key: 'efficiency', label: '咒力效率 %', get: (p) => Math.round(p.efficiency.value * 100) },
  { key: 'techniqueMultiplier', label: '术式倍率', get: (p) => p.technique.multiplier },
  { key: 'techniqueCooldown', label: '术式冷却（回合）', get: (p) => p.technique.cooldown },
]

const seedForm = (p) => Object.fromEntries(EDIT_FIELDS.map((f) => [f.key, String(f.get(p))]))

export function EditPlayerModal({ panel, onSave, onClose }) {
  const [form, setForm] = useState(() => seedForm(panel))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notes, setNotes] = useState(null)

  async function save() {
    setBusy(true)
    setErr('')
    try {
      const numbers = {}
      for (const f of EDIT_FIELDS) {
        const v = Number(form[f.key])
        // 空着或写了非数字的项就不提交 —— 服务端会当成"这一项没改"
        if (Number.isFinite(v)) numbers[f.key] = v
      }
      const r = await onSave(numbers)
      setNotes(r?.notes || [])
      // 重新播种：服务端夹过的值才是真值，输入框得跟着它走
      if (r?.panel) setForm(seedForm(r.panel))
    } catch (e) {
      setErr(String(e?.message || e).slice(0, 200))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>改数值</h2>
        <div className="hint">
          改完立刻生效。等级、领域觉醒、术式消耗都是这些数推出来的，会跟着一起重算 ——
          所以这里没有「等级」这一项。
        </div>

        <div className="edit-grid">
          {EDIT_FIELDS.map((f) => (
            <label className="edit-row" key={f.key}>
              <span>{f.label}</span>
              <input
                value={form[f.key]}
                inputMode="decimal"
                disabled={busy}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && save()}
              />
            </label>
          ))}
        </div>

        {notes?.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ok)', lineHeight: 1.7 }}>
            {notes.map((n, i) => <div key={i}>· {n}</div>)}
          </div>
        )}
        {notes?.length === 0 && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ink-faint)' }}>
            数值没有变化。
          </div>
        )}
        {err && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--blood-bright)' }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="choice" style={{ flex: 1, textAlign: 'center' }} onClick={save} disabled={busy}>
            {busy ? '应用中…' : '应用'}
          </button>
          <button className="choice" style={{ flex: 1, textAlign: 'center' }} onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>
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
  /*
   * 进度条画的是**容器吞下的根数**，不是从前那条 0~100% 的"觉醒度"。
   * 原著里宿傩回来的度量只有手指：二十根，吞一根回来一分。
   * 自造一个百分比只是把同一件事说两遍，而且在原著里查无此物。
   *
   * 玩家自己吞下的那份单独列一行，而且**不进进度条** —— 他不是容器，
   * 那一口换的是咒力上限和一身侵蚀，宿傩一点都没回来。
   */
  const mine = sukuna.fingersPlayerEaten || 0
  return (
    <div className="panel">
      <h3>宿傩手指追踪</h3>
      <div className="card">
        <Bar label="容器已吞下" cur={sukuna.fingersEaten} max={20} cls="hp" suffix=" 根" />
        <div className="kv" style={{ marginTop: 8 }}><span>已收集</span><span>{sukuna.fingersCollected} / 20</span></div>
        {mine > 0 && (
          <div className="kv">
            <span>你自己吞下</span>
            <span style={{ color: 'var(--tier)' }}>{mine} 根</span>
          </div>
        )}
        {mine > 0 && sukuna.corruption && sukuna.corruption !== '无' && (
          <div className="kv"><span>侵蚀</span><span style={{ color: 'var(--blood)' }}>{sukuna.corruption}</span></div>
        )}
        <div className="kv"><span>宿傩态度</span><span style={{ color: 'var(--tier)' }}>{sukuna.attitude}</span></div>
      </div>
    </div>
  )
}

export function TimelinePanel({ timeline }) {
  if (!timeline) return null
  const rewrites = timeline.rewrites || {}
  return (
    <div className="panel">
      <h3>原作分歧追踪</h3>
      <div className="card">
        {Object.entries(timeline.nodes).map(([k, v]) => (
          <div key={k}>
            <div className="tl-row">
              <span>{k}</span>
              <span className={`st ${v}`}>{v}</span>
            </div>
            {/*
              改写的理由比状态本身重要得多 —— 只说「已改写」，玩家只知道
              那天变了，不知道变成了什么。下面这行就是那一天的新剧本。
            */}
            {v === '已改写' && rewrites[k] && <div className="tl-why">{rewrites[k]}</div>}
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

/** 五种收场各自的颜色 —— 击杀最重，逃脱最轻 */
const RESULT_CLS = {
  击杀: 'kill', 击退: 'win', 逃脱: 'flee', 战败: 'lose', 未分胜负: 'draw',
}

/**
 * 战果面板。
 *
 * 越界限制取消之后，"打过谁"成了这条时间线上最硬的事实之一：杀了虎杖，
 * 后面的戏全都要重排。所以每一场都落一条，倒序显示（最近的在最上面）——
 * 玩家刚打完那一仗就该看见它。
 *
 * 只显示结果不够：还要看得出**这一仗动了什么**。命中了关键人物时带上
 * 那句「连带影响」，玩家才知道自己刚才不只是赢了一场战斗。
 */
export function BattleLogPanel({ battles }) {
  if (!battles?.length) return null
  const rows = battles.slice(-20).reverse()
  const kills = battles.filter((b) => b.killed).length
  return (
    <div className="panel">
      <h3>战果</h3>
      <div className="card">
        <div className="kv" style={{ marginBottom: 6 }}>
          <span>交战 {battles.length} 场</span>
          <span style={{ color: kills ? 'var(--blood)' : 'var(--ink-faint)' }}>
            {kills ? `击杀 ${kills}` : '尚无击杀'}
          </span>
        </div>
        {rows.map((b, i) => (
          <div className="bt-row" key={`${b.date}-${b.turn}-${i}`}>
            <span className={`bt-result ${RESULT_CLS[b.result] || 'draw'}`}>{b.result}</span>
            <span className="bt-main">
              <span className="bt-name">
                {b.enemy.grade && <em>{b.enemy.grade}</em>}
                {b.enemy.name}
                {b.enemy.canon && <b title="按原作表校正">原作</b>}
              </span>
              <span className="bt-meta">
                {b.date} · {b.ground}
                {b.node ? ` · ${b.node}` : ''}
                {b.hpMax ? ` · 剩血 ${Math.max(0, Math.round((b.hpLeft / b.hpMax) * 100))}%` : ''}
              </span>
              {b.rewrite && <span className="bt-why">{b.rewrite}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
