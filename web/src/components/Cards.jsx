import React from 'react'
import { GradeTag } from './Panels.jsx'

function Row({ label, value, grade }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <span>
        {typeof value === 'number' ? value.toLocaleString() : value}
        {grade ? <span style={{ color: 'var(--ink-faint)', marginLeft: 6 }}>{grade}</span> : null}
      </span>
    </div>
  )
}

export function AttributeCard({ p, onPick, busy }) {
  return (
    <div className="pcard">
      <h2>属性档案 {p.slot}</h2>
      <div style={{ marginTop: 6 }}>
        综合等级 <GradeTag grade={p.overallGrade} />
      </div>

      <div className="tech">{p.techniqueName}</div>
      <div className="tech-eff">{p.techniqueEffect}</div>

      <Row label="咒力总量" value={p.ce.value} grade={p.ce.grade} />
      <Row label="血条总量" value={p.hp.value} grade={p.hp.grade} />
      <Row label="咒术伤害" value={p.cursedDamage.value} grade={p.cursedDamage.grade} />
      <Row label="体术伤害" value={p.physicalDamage.value} grade={p.physicalDamage.grade} />
      <Row label="咒力效率" value={`${Math.round(p.efficiency.value * 100)}%`} grade={p.efficiency.grade} />
      <Row label="术式倍率" value={`×${p.techniqueMultiplier}`} grade={p.techniqueGrade} />
      <Row label="术式冷却" value={`${p.techniqueCooldown} 回合`} />
      <Row label="反转术式" value={p.reverseCursedTechnique} />

      <div className="divider" />

      {p.domain?.unlocked ? (
        <div className="domain-box" style={{ marginTop: 0 }}>
          <div className="dn">
            领域 · {p.domain.name}
            <span style={{ fontSize: 11, color: 'var(--ink-faint)', marginLeft: 6 }}>{p.domain.tierName}</span>
          </div>
          <div style={{ marginTop: 4 }}>必中：{p.domain.sureHit}</div>
          <div style={{ color: 'var(--blood-bright)' }}>代价：{p.domain.cost}</div>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>领域：未领悟（进度 0%）</div>
      )}

      <div style={{ marginTop: 10 }}>
        {(p.talents || []).map((t) => <span key={t} className="tag">{t}</span>)}
        {p.tool && <span className="tag" style={{ borderColor: 'var(--gold)' }}>咒具：{p.tool}</span>}
      </div>

      {p.playstyle && (
        <div style={{ fontSize: 12.5, color: 'var(--gold)', marginTop: 8 }}>▸ {p.playstyle}</div>
      )}

      <button className="pick-btn" style={{ marginTop: 14 }} onClick={() => onPick(p.slot)} disabled={busy}>
        选择档案 {p.slot}
      </button>
    </div>
  )
}

export function IdentityCard({ p, onPick, busy }) {
  const rel = Object.entries(p.initialRelations || {}).filter(([, v]) => v !== 0)
  return (
    <div className="pcard">
      <h2>身份档案 {p.slot}</h2>
      <div className="tech">{p.name}</div>
      <div className="tech-eff">
        {p.age} 岁 · {p.kind}
      </div>

      <div className="divider" />

      <div style={{ fontSize: 13, lineHeight: 1.75 }}>
        <div style={{ color: 'var(--ink-dim)', fontSize: 11.5, letterSpacing: '0.12em', marginBottom: 2 }}>背景</div>
        <div>{p.background}</div>

        <div style={{ color: 'var(--ink-dim)', fontSize: 11.5, letterSpacing: '0.12em', margin: '10px 0 2px' }}>与主线关系</div>
        <div>{p.mainlineRelation}</div>

        <div style={{ color: 'var(--ink-dim)', fontSize: 11.5, letterSpacing: '0.12em', margin: '10px 0 2px' }}>开局处境</div>
        <div>{p.openingSituation}</div>
      </div>

      <div className="domain-box" style={{ marginTop: 12 }}>
        <div className="dn" style={{ fontSize: 13 }}>钩子</div>
        <div>{p.hook}</div>
      </div>

      {rel.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: 'var(--ink-dim)', fontSize: 11.5, letterSpacing: '0.12em', marginBottom: 3 }}>初始关系值</div>
          {rel.map(([n, v]) => (
            <div className="kv" key={n}>
              <span>{n}</span>
              <span style={{ color: v > 0 ? 'var(--ok)' : 'var(--blood)' }}>{v > 0 ? `+${v}` : v}</span>
            </div>
          ))}
        </div>
      )}

      <button className="pick-btn" style={{ marginTop: 14 }} onClick={() => onPick(p.slot)} disabled={busy}>
        选择身份 {p.slot}
      </button>
    </div>
  )
}
