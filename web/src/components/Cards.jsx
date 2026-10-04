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

/**
 * 游玩模式选择。
 * 和故事线是两个独立的轴 —— 故事线决定"在哪条时间线上"，
 * 模式决定"这条线怎么玩"。放在同一屏，避免多一步空点。
 */
export function PlayModePicker({ modes, value, onChange }) {
  return (
    <div className="mode-picker">
      <div className="mode-picker-h">游玩模式</div>
      <div className="mode-picker-row">
        {modes.map((m) => (
          <button
            key={m.id}
            className={`mode-card${value === m.id ? ' on' : ''}`}
            onClick={() => onChange(m.id)}
          >
            <span className="mode-n">{m.name}</span>
            <span className="mode-t">{m.tagline}</span>
            <span className="mode-d">{m.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** 故事线选择：开局第一屏 */
export function StorylineCard({ s, onPick, busy }) {
  return (
    <div className={`pcard story ${s.accent || ''}`}>
      <h2>{s.subtitle}</h2>
      <div className="tech">{s.name}</div>
      <div className="tech-eff">{s.tagline}</div>

      <div className="divider" />

      <div style={{ fontSize: 13, lineHeight: 1.8 }}>{s.desc}</div>

      <div className="story-meta">
        <div>
          <span className="story-k">起始</span>
          <span className="story-v">{s.startDate}</span>
        </div>
        <div>
          <span className="story-k">原作节点</span>
          <span className="story-v">{s.nodeCount} 个</span>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ color: 'var(--ink-dim)', fontSize: 11.5, letterSpacing: '0.1em', marginBottom: 4 }}>
          登场角色
        </div>
        <div>
          {(s.characters || []).map((c) => <span key={c} className="tag">{c}</span>)}
          {s.nodeCount > 0 && s.characters?.length === 6 && <span className="tag">…</span>}
        </div>
      </div>

      <button className="pick-btn" style={{ marginTop: 14 }} onClick={() => onPick(s.id)} disabled={busy}>
        进入这条线
      </button>
    </div>
  )
}

/** 自主定义穿越时间 */
export function CustomTimeCard({ brief, setBrief, generated, onGenerate, onPick, busy }) {
  return (
    <div className="pcard custom time-custom">
      <h2>自主定义</h2>
      <div className="tech">自己指定穿越时机</div>
      <div className="tech-eff">
        写清你想穿到什么时候、想赶上或避开哪件事。
      </div>

      <textarea
        className="custom-brief"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="例如：我想穿到涩谷事变前一个月，还来得及做点什么的时候……"
        rows={3}
        disabled={busy}
      />

      <div className="custom-note">
        日期可以自定义，但**原作进度与危险度**会继承自最接近的既有节点 ——
        否则「哪些事件已经发生」就无从算起。生成时会告诉你锚定在哪。
      </div>

      {!generated && (
        <button className="pick-btn" style={{ marginTop: 12 }} onClick={onGenerate} disabled={busy || brief.trim().length < 2}>
          {busy ? '推演中…' : '按我的描述定位'}
        </button>
      )}

      {generated && (
        <>
          <div className="divider" />
          <div className="custom-result">
            <div className="custom-result-h">依据你的描述定位</div>
            <div className="tech" style={{ fontSize: 16, marginBottom: 2 }}>{generated.label}</div>
            <div className="time-meta">
              <span className="time-date">{generated.date}</span>
              <span className="time-danger" data-lv={generated.danger}>
                {'●'.repeat(generated.danger)}{'○'.repeat(Math.max(0, 5 - generated.danger))}
                <em>{generated.dangerLabel}</em>
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.75, marginTop: 8 }}>
              <div>{generated.situation}</div>
              <div style={{ marginTop: 7, color: 'var(--gold)' }}>▸ {generated.hook}</div>
            </div>

            {/* 必须说清进度是从哪来的 —— 否则玩家以为日期是新算的，进度却是继承的 */}
            {generated.anchorLabel && (
              <div className="custom-note" style={{ marginTop: 9 }}>
                原作进度取自「{generated.anchorLabel}」：
                {generated.nodesDone.length ? generated.nodesDone.join('、') : '一切都还没发生'}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button className="pick-btn" style={{ flex: 1 }} onClick={() => onPick('自定义')} disabled={busy}>
              从这里开始
            </button>
            <button
              className="pick-btn"
              style={{ flex: '0 0 84px', borderColor: 'var(--line)', color: 'var(--ink-dim)' }}
              onClick={onGenerate}
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

/** 穿越时间卡片：日期、那时在发生什么、危险度 */
export function TimeCard({ p, onPick, busy }) {
  const danger = '●'.repeat(p.danger) + '○'.repeat(Math.max(0, 5 - p.danger))
  return (
    <div className="pcard time">
      <h2>穿越时间</h2>
      <div className="tech">{p.label}</div>
      <div className="tech-eff">{p.when}</div>

      <div className="time-meta">
        <span className="time-date">{p.date}</span>
        <span className="time-danger" data-lv={p.danger} title={`危险度 ${p.danger} / 5`}>
          {danger} <em>{p.dangerLabel}</em>
        </span>
      </div>

      <div className="divider" />

      <div style={{ fontSize: 13, lineHeight: 1.75 }}>
        <div style={{ color: 'var(--ink-dim)', fontSize: 11.5, letterSpacing: '0.1em', marginBottom: 3 }}>那一刻</div>
        <div>{p.situation}</div>
      </div>

      {p.nodesDone?.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: 'var(--ink-dim)', fontSize: 11.5, letterSpacing: '0.1em', marginBottom: 4 }}>
            已经发生（不可更改）
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', lineHeight: 1.7 }}>
            {p.nodesDone.join(' · ')}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--ok)' }}>
          一切都还没开始 —— 你可以从头改写
        </div>
      )}

      {p.hook && (
        <div className="domain-box" style={{ marginTop: 10, borderColor: 'rgba(168,35,27,.25)', background: 'rgba(168,35,27,.04)' }}>
          <div className="dn" style={{ color: 'var(--blood)', fontSize: 13 }}>局势</div>
          <div>{p.hook}</div>
        </div>
      )}

      <button className="pick-btn" style={{ marginTop: 14 }} onClick={() => onPick(p.id)} disabled={busy}>
        从这里开始
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
