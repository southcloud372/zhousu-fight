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

/**
 * 「自主定义」卡片。
 *
 * 玩家写一段描述 → 引擎重掷数值 → 模型按描述生成术式 / 背景。
 * 界面上必须写明**等级不可指定** —— 否则玩家会以为能点单"我要超特级"，
 * 掷出来是二级就会觉得是 bug。
 */
export function CustomCard({ kind, brief, setBrief, generated, onGenerate, onPick, onReroll, busy }) {
  const isAttr = kind === 'attribute'
  const placeholder = isAttr
    ? '例如：我想打近身压制，靠体术和一把刀，术式最好能封住对方的退路……'
    : '例如：我是被高专除名的观察员，暗中替诅咒师做事，手上有一条宿傩手指的线报……'

  return (
    <div className="pcard custom">
      <h2>自主定义</h2>
      <div className="tech">{isAttr ? '自己写战斗风格' : '自己写身份背景'}</div>
      <div className="tech-eff">
        {isAttr
          ? '写清你想要的打法、术式感觉、武器偏好。'
          : '写清来历、立场、眼下的处境和你想埋的钩子。'}
      </div>

      <textarea
        className="custom-brief"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder={placeholder}
        rows={4}
        disabled={busy}
      />

      <div className="custom-note">
        {isAttr
          ? '等级由引擎按设定概率掷出，不能指定 —— 那套分布是战斗平衡的地基。你说的是「风格」，强度照掷。'
          : '身份类型由模型按你的描述判定，初始关系值随即重掷。'}
      </div>

      {!generated && (
        <button
          className="pick-btn"
          style={{ marginTop: 12 }}
          onClick={onGenerate}
          disabled={busy || brief.trim().length < 2}
        >
          {busy ? '生成中…' : '按我的描述生成'}
        </button>
      )}

      {generated && (
        <>
          <div className="divider" />
          <div className="custom-result">
            <div className="custom-result-h">依据你的描述生成</div>
            {isAttr ? (
              <>
                <div className="kv">
                  <span>综合等级</span>
                  <span><GradeTag grade={generated.overallGrade} /></span>
                </div>
                <div className="tech" style={{ fontSize: 16, margin: '6px 0 2px' }}>{generated.techniqueName}</div>
                <div className="tech-eff">{generated.techniqueEffect}</div>
                <Row label="咒力总量" value={generated.ce.value} grade={generated.ce.grade} />
                <Row label="血条总量" value={generated.hp.value} grade={generated.hp.grade} />
                <Row label="咒术伤害" value={generated.cursedDamage.value} grade={generated.cursedDamage.grade} />
                <Row label="体术伤害" value={generated.physicalDamage.value} grade={generated.physicalDamage.grade} />
                <Row label="咒力效率" value={`${Math.round(generated.efficiency.value * 100)}%`} grade={generated.efficiency.grade} />
                {generated.domain?.unlocked ? (
                  <div className="domain-box" style={{ marginTop: 8 }}>
                    <div className="dn">领域 · {generated.domain.name}
                      <span style={{ fontSize: 11, color: 'var(--ink-faint)', marginLeft: 6 }}>{generated.domain.tierName}</span>
                    </div>
                    <div style={{ marginTop: 3 }}>必中：{generated.domain.sureHit}</div>
                    <div style={{ color: 'var(--blood)' }}>代价：{generated.domain.cost}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--ink-faint)', marginTop: 6 }}>领域：未领悟</div>
                )}
                <div style={{ marginTop: 8 }}>
                  {(generated.talents || []).map((t) => <span key={t} className="tag">{t}</span>)}
                  {generated.tool && <span className="tag" style={{ borderColor: 'var(--gold)' }}>咒具：{generated.tool}</span>}
                </div>
                {generated.playstyle && (
                  <div style={{ fontSize: 12.5, color: 'var(--gold)', marginTop: 7 }}>▸ {generated.playstyle}</div>
                )}
              </>
            ) : (
              <>
                <div className="tech" style={{ fontSize: 16 }}>{generated.name}</div>
                <div className="tech-eff">{generated.age} 岁 · {generated.kind}</div>
                <div style={{ fontSize: 13, lineHeight: 1.75, marginTop: 6 }}>
                  <div>{generated.background}</div>
                  <div style={{ marginTop: 8 }}><span style={{ color: 'var(--ink-dim)' }}>与主线：</span>{generated.mainlineRelation}</div>
                  <div style={{ marginTop: 4 }}><span style={{ color: 'var(--ink-dim)' }}>开局处境：</span>{generated.openingSituation}</div>
                </div>
                <div className="domain-box" style={{ marginTop: 10 }}>
                  <div className="dn" style={{ fontSize: 13 }}>钩子</div>
                  <div>{generated.hook}</div>
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button className="pick-btn" style={{ flex: 1 }} onClick={() => onPick('自定义')} disabled={busy}>
              就用这个
            </button>
            <button
              className="pick-btn"
              style={{ flex: '0 0 84px', borderColor: 'var(--line)', color: 'var(--ink-dim)' }}
              onClick={onReroll}
              disabled={busy}
            >
              重掷
            </button>
          </div>
        </>
      )}
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
