import React, { useEffect, useState } from 'react'
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

// ------------------------------------------------------------ 数值输入

/**
 * 数值可改，是这个版本最要紧的一处改动。
 *
 * 之前"自定义属性"只让你描述风格，数字全由引擎掷 —— 玩家写完"我要体术流"
 * 拿到一份四级档案，除了重掷没有别的办法，而重掷是随机的，等于没有控制权。
 * 现在掷出来的那份变成**默认值**：每一项都能改，改完等级跟着数字走。
 *
 * 等级不能由玩家点单，只能由数字反推（引擎那套反向查表），
 * 所以界面上写的是"填数字，等级自己会变"，而不是"选等级"。
 */
const NUM_FIELDS = [
  { key: 'ce', label: '咒力总量', step: 100, gradeKey: 'ce' },
  { key: 'hp', label: '血条总量', step: 50, gradeKey: 'hp' },
  { key: 'cursedDamage', label: '咒术伤害', step: 10, gradeKey: 'cursedDamage' },
  { key: 'physicalDamage', label: '体术伤害', step: 5, gradeKey: 'physicalDamage' },
  { key: 'efficiency', label: '咒力效率', step: 5, unit: '%', pct: true, gradeKey: 'efficiency' },
  { key: 'techniqueMultiplier', label: '术式倍率', step: 0.5, unit: '×', raw: true },
  { key: 'techniqueCooldown', label: '术式冷却', step: 1, unit: '回合', raw: true },
]

/** 从服务端档案抽出可编辑的数字。效率在界面上用百分数，比较像"数值" */
function numbersOf(p) {
  return {
    ce: p.ce?.value ?? 0,
    hp: p.hp?.value ?? 0,
    cursedDamage: p.cursedDamage?.value ?? 0,
    physicalDamage: p.physicalDamage?.value ?? 0,
    efficiency: Math.round((p.efficiency?.value ?? 0) * 100),
    techniqueMultiplier: p.techniqueMultiplier ?? 1,
    techniqueCooldown: p.techniqueCooldown ?? 1,
  }
}

function NumberGrid({ profile, draft, setDraft, busy }) {
  return (
    <div className="num-grid">
      {NUM_FIELDS.map((f) => (
        <label className="num-row" key={f.key}>
          <span className="nl">{f.label}</span>
          <span className="nv">
            <input
              type="number"
              step={f.step}
              min={0}
              value={draft[f.key]}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value === '' ? '' : Number(e.target.value)
                setDraft((d) => ({ ...d, [f.key]: v }))
              }}
            />
            {f.unit && <em>{f.unit}</em>}
          </span>
          {/* 等级是数字的结果，不是可以点的选项 —— 所以它只是显示 */}
          {f.gradeKey && (
            <span className="ng"><GradeTag grade={profile[f.gradeKey]?.grade} /></span>
          )}
        </label>
      ))}
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
 * 玩家写一段描述 → 引擎掷一份数值底子 → 模型按描述生成术式 / 背景。
 * 属性那一侧，掷出来的数值是**可以直接改的**（见 NumberGrid）：
 * 玩家要的是能定数值，不只是定风格。
 */
export function CustomCard({
  kind, brief, setBrief, generated, onGenerate, onPick, onReroll, onTune, busy,
}) {
  const isAttr = kind === 'attribute'
  const placeholder = isAttr
    ? '例如：我想打近身压制，靠体术和一把刀，术式最好能封住对方的退路……'
    : '例如：我是被高专除名的观察员，暗中替诅咒师做事，手上有一条宿傩手指的线报……'

  const [draft, setDraft] = useState(() => (generated ? numbersOf(generated) : null))

  // 档案换了（生成 / 重掷 / 应用数值之后）就把草稿对齐到服务端那一份
  useEffect(() => {
    if (isAttr && generated) setDraft(numbersOf(generated))
  }, [isAttr, generated])

  const dirty = isAttr && generated && draft
    && NUM_FIELDS.some((f) => Number(draft[f.key]) !== Number(numbersOf(generated)[f.key]))

  const applyNumbers = () => {
    // 空框按 0 处理会让玩家莫名其妙掉一档，所以空着就退回服务端那份
    const base = numbersOf(generated)
    const numbers = Object.fromEntries(
      NUM_FIELDS.map((f) => [f.key, draft[f.key] === '' ? base[f.key] : Number(draft[f.key])]),
    )
    onTune?.(numbers)
  }

  return (
    <div className="pcard custom">
      <h2>自主定义</h2>
      <div className="tech">{isAttr ? '自己写数值和战斗风格' : '自己写身份背景'}</div>
      <div className="tech-eff">
        {isAttr
          ? '写清你想要的打法、术式感觉、武器偏好。生成之后，每一项数值都能自己改。'
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
          ? '生成时先按你的描述掷一份底子，掷出来的数字是默认值 —— 每一项你都能改，等级会跟着数字变。'
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
                <div className="kv">
                  <span>领域</span>
                  <span>
                    {generated.domain?.unlocked
                      ? <>{generated.domain.name} <span style={{ color: 'var(--ink-faint)' }}>{generated.domain.tierName}</span></>
                      : '未领悟'}
                  </span>
                </div>

                {draft && (
                  <NumberGrid
                    profile={generated}
                    draft={draft}
                    setDraft={setDraft}
                    busy={busy}
                  />
                )}

                {dirty && (
                  <button
                    className="pick-btn tune-btn"
                    onClick={applyNumbers}
                    disabled={busy}
                  >
                    {busy ? '重新推演中…' : '应用数值（等级与领域会跟着变）'}
                  </button>
                )}

                <div className="tech" style={{ fontSize: 16, margin: '10px 0 2px' }}>{generated.techniqueName}</div>
                <div className="tech-eff">{generated.techniqueEffect}</div>

                {generated.domain?.unlocked && (
                  <div className="domain-box" style={{ marginTop: 8 }}>
                    <div className="dn">领域 · {generated.domain.name}
                      <span style={{ fontSize: 11, color: 'var(--ink-faint)', marginLeft: 6 }}>{generated.domain.tierName}</span>
                    </div>
                    <div style={{ marginTop: 3 }}>必中：{generated.domain.sureHit}</div>
                    <div style={{ color: 'var(--blood)' }}>代价：{generated.domain.cost}</div>
                  </div>
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
 * 第五个身份：突然出现的人。
 *
 * 和另外四张卡的根本区别是**它不掷也不问模型** —— 没有身份就是这个身份的定义。
 * 所以卡上能填的只有玩家自己：叫什么、多大、身上带着什么。全空也能进，
 * 那就是一个连名字都没有、凭空站在那儿的人。
 *
 * 写着"没有交集"是必要的：玩家得先知道这一局不会有人认识他，
 * 才会相信后面那些跨度极大的选项不是摆设。
 */
export function SuddenArrivalCard({ name, setName, age, setAge, brief, setBrief, onSudden, busy }) {
  return (
    <div className="pcard sudden">
      <h2>突然出现的人</h2>
      <div className="tech">没有身份 · 没有交集</div>
      <div className="tech-eff">
        不做这条线上的任何一个人。上一秒你还在自己的地方，下一秒就站在了这里。
      </div>

      <div className="divider" />

      <div style={{ fontSize: 13, lineHeight: 1.75 }}>
        <div>
          没有户籍、没有咒术界的档案、没有任何人见过你 —— 和所有人<strong>关系值为 0</strong>。
          世界不知道你是谁，你也不需要向任何人解释。
        </div>
        <div style={{ marginTop: 8, color: 'var(--gold)' }}>
          ▸ 这一局给你的选项会**故意拉开跨度**：可以直接找原作角色摊牌，可以转身走开不管，
          也可以用这个世界没人会用的办法解决问题。你可以做剧情完全没准备的事。
        </div>
        <div style={{ marginTop: 8, color: 'var(--ink-dim)' }}>
          代价同样真实：没有靠山，没有人为你说话。被当成可疑人物处理是常态。
        </div>
      </div>

      <div className="sudden-form">
        <label>
          <span>名字</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="留空就是「无名之客」"
            disabled={busy}
          />
        </label>
        <label className="narrow">
          <span>年龄</span>
          <input
            type="number"
            min={10}
            max={80}
            value={age}
            onChange={(e) => setAge(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>

      <textarea
        className="custom-brief"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="（可选）你穿越过去时是什么样的人、身上带着什么？例如：普通大学生，穿着睡衣，兜里只有一个手机……"
        rows={3}
        disabled={busy}
      />

      <button className="pick-btn" style={{ marginTop: 12 }} onClick={onSudden} disabled={busy}>
        {busy ? '正在落地…' : '就这样出现'}
      </button>
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
