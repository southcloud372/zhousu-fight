import React, { useEffect, useRef, useState } from 'react'

/**
 * 演出层。
 *
 * 这一层只负责"看起来爽"，不碰任何数值 —— 数值全在引擎里算完了，
 * 这里做的是把引擎算出来的高光（暴击、领域展开、数值突破）翻译成
 * 玩家眼睛能立刻接收到的东西。
 *
 * 为什么值得单独做一层：手动战斗原来只有一栏文字面板，玩家出招之后
 * 看到的是一行"造成 137 点伤害"，137 和 100 和 90 在视觉上没有任何区别。
 * 爽感来自差异，差异必须先被看见。
 */

/**
 * 系统层开了「减少动态效果」就把动画让路。
 * 数字滚动、屏幕冲击、残影都读它 —— 医嘱优先于爽感。
 */
const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  !!window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

/**
 * 数字滚动。
 *
 * 血条的宽度本来就是过渡着走的，数字却是直接跳的 —— 一条慢慢变短的血条
 * 旁边顶着一个已经落了地的数，看起来是两回事。让数字自己滚过去，
 * 那 0.4 秒里"被削掉了多少"就变成一个过程，而不只是一个结果。
 *
 * 第一次渲染不滚（旧值就是新值），所以刷新页面看到的是静止的数字，
 * 只有真的变了才动。
 */
export function useCountUp(value, ms = 430) {
  const to = Number(value) || 0
  const [shown, setShown] = useState(to)
  const shownRef = useRef(to)
  const raf = useRef(0)

  useEffect(() => {
    const from = shownRef.current
    if (from === to) return undefined
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
      shownRef.current = to
      setShown(to)
      return undefined
    }
    /*
     * 计时基准取**第一帧的时间戳**，不取 performance.now()。
     * 两者在浏览器里同源，但不是所有环境都保证 —— 对不上的话
     * 差值会是几千万毫秒的负数，数字直接飞出去。只认 rAF 自己的时间轴，
     * 到哪儿都不会错。
     */
    let t0 = null
    const tick = (now) => {
      if (t0 === null) t0 = now
      const p = Math.max(0, Math.min(1, (now - t0) / ms))
      // ease-out：先快后慢，像真的被削掉
      const v = p >= 1 ? to : from + (to - from) * (1 - (1 - p) ** 3)
      shownRef.current = v
      setShown(v)
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [to, ms])

  return shown
}

// ---------------------------------------------------------------- 全屏冲击

/**
 * 命中、被打、暴击、必中 —— 每一记都该在屏幕上留一下。
 *
 * 左边那一栏的数字是"信息"，可玩家的眼睛盯的是中间那一栏。
 * 一记重击如果只让血条短一截，那是数据更新；屏幕真的震一下、白一下、
 * 从命中点炸开一圈，才叫打中了。
 *
 * 强度按"这一下占了多少血条"分档，不按绝对伤害 —— 血条长的对手挨 300
 * 和血条短的挨 300 不是一回事。三档：擦到、重击、致命。
 */
export function Impact({ data }) {
  if (!data) return null
  return (
    // key 换掉就重挂载，动画自然重播 —— 连着两回合命中不会因为上一次没播完而静默
    <div
      key={data.token}
      className={`impact lv-${data.level} tone-${data.tone} from-${data.side || 'enemy'}`}
      aria-hidden="true"
    >
      <span className="im-flash" />
      <span className="im-edge" />
      <span className="im-burst" />
    </div>
  )
}

// ---------------------------------------------------------------- 大字过场

/**
 * 「領域展開」/「撃破」大字过场。
 *
 * 领域是这套设定里最贵的一招（一次要吃掉一大截咒力、还只看几回合），
 * 原来它和"体术命中"共用同一条文字通道 —— 花了大价钱铺开领域，
 * 屏幕上和普通一拳长得一模一样。这一段就是给它补的排面。
 *
 * 收场那一拍走的是同一块屏：打完一场是整局里情绪最高的时候，
 * 一颗轻提示接不住它，得有和领域展开同等的排面。
 */
/**
 * 领域三型的展示口径。
 *
 * 机制文案（brief）由服务端给 —— 这里只决定"哪一型长什么样"。
 * 三种领域原来是同一种紫光，玩家一眼分不出自己开的是哪一路，
 * 名字再响也没用：颜色和字是玩家唯一能在半秒内读懂的东西。
 */
const DOMAIN_TONE = {
  伤害型: 'dmg',
  规则型: 'rule',
  增益型: 'buff',
}

export function DomainCutin({ data, onDone }) {
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  // 收场那一拍比领域多留半秒：它后面还接着战果结算，急着走会显得草率
  const hold = data?.kind === 'win' || data?.kind === 'lose' ? 3100 : 2600

  useEffect(() => {
    if (!data) return undefined
    // 自动收场；玩家也可以点一下提前跳过
    const t = setTimeout(() => doneRef.current?.(), hold)
    return () => clearTimeout(t)
  }, [data, hold])

  if (!data) return null
  const outcome = data.kind === 'win' || data.kind === 'lose'
  const enemy = data.side === 'enemy'
  const tone = outcome ? data.kind : (DOMAIN_TONE[data.type] || 'dmg')
  const kanji = outcome ? (data.kind === 'win' ? '撃破' : '敗北') : '領域展開'

  return (
    <div
      className={`domain-cutin tone-${tone}${enemy ? ' from-enemy' : ''}${outcome ? ' is-outcome' : ''}`}
      onClick={() => doneRef.current?.()}
      role="presentation"
    >
      <div className="dc-wash" />
      <div className="dc-rings" aria-hidden="true">
        <i /><i /><i />
      </div>

      <div className="dc-body">
        <div className="dc-kanji" aria-label={outcome ? kanji : '领域展开'}>
          {kanji.split('').map((ch, i) => (
            <span key={i} style={{ animationDelay: `${120 + i * 90}ms` }}>{ch}</span>
          ))}
        </div>

        {!outcome && data.type && <div className="dc-type">{data.type}</div>}
        <div className="dc-name">{data.name}</div>

        {!outcome && data.sureHit && <div className="dc-sure">{data.sureHit}</div>}
        {outcome && data.summary && <div className="dc-sure">{data.summary}</div>}

        {/*
          展开当回合真正落下去的那几个数字：伤害型那一下重击、增益型那两口。
          以前只报"必中效果落下"，玩家看不出这一开到底换来了什么。
        */}
        {!outcome && (
          <div className="dc-fx">
            {data.burst > 0 && (
              <span className="dc-line dmg">必中重击 · 无视防御 <b>{data.burst}</b></span>
            )}
            {data.healed > 0 && <span className="dc-line heal">回复生命 <b>{data.healed}</b></span>}
            {data.recovered > 0 && <span className="dc-line ce">回复咒力 <b>{data.recovered}</b></span>}
            {data.brief && <span className="dc-line brief">{data.brief}</span>}
          </div>
        )}

        {/* 打完这一场换来了什么：战果一条条摆出来，比埋在日志里的一张卡片有分量 */}
        {outcome && data.lines?.length > 0 && (
          <div className="dc-fx">
            {data.lines.map((l, i) => (
              <span key={i} className="dc-line brief">{l}</span>
            ))}
          </div>
        )}
      </div>

      <div className="dc-skip">点击跳过</div>
    </div>
  )
}

// ---------------------------------------------------------------- 飘字 / 提示

/**
 * 轻提示队列。
 *
 * 用在"数值真的跳了"的时刻：修炼攒满 100% 跳属性、跨级击杀升级、
 * 战果结算。这些是玩家练了半天唯一想看到的东西，埋在日志里可惜了。
 */
export function Toasts({ items, onClose }) {
  if (!items?.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast tone-${t.tone || 'gold'}${t.big ? ' big' : ''}`}
          onClick={() => onClose?.(t.id)}
        >
          {t.title && <span className="toast-title">{t.title}</span>}
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}

/** Toast 队列管理：push 进来的每一条自己会走 */
export function useToasts(ttl = 3600) {
  const [items, setItems] = useState([])
  const seq = useRef(0)
  const timers = useRef([])

  const remove = React.useCallback((id) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = React.useCallback((text, { tone = 'gold', title = '', big = false } = {}) => {
    if (!text) return
    const id = ++seq.current
    setItems((prev) => [...prev.slice(-4), { id, text, tone, title, big }])
    timers.current.push(setTimeout(() => remove(id), big ? ttl + 1400 : ttl))
  }, [remove, ttl])

  const clear = React.useCallback(() => {
    setItems([])
  }, [])

  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  // 引用要稳定：调用方会把它写进 useCallback 的依赖数组，
  // 每次渲染都给一个新对象的话，那些回调等于每帧都在重建
  return React.useMemo(() => ({ items, push, remove, clear }), [items, push, remove, clear])
}

/**
 * 伤害飘字。
 *
 * 拿到一个新的战斗面板就飘一次；crit 的更大更红。
 * key 变化触发重挂载，动画自然重播 —— 用 CSS animation 而不是 transition，
 * 因为结束状态不想留在 DOM 上。
 */
export function FloatDamage({ token, value, kind, max }) {
  if (!token || !value) return null
  /*
   * 数字的大小跟着它占血条的多少走。
   * 固定字号的话，"−137"和"−2400"在屏幕上一样大 —— 而这两个数
   * 一个是不痛不痒的一拳，一个是半条命。爽感来自差异被看见。
   */
  const ratio = max > 0 ? value / max : 0
  const size = ratio >= 0.25 ? ' huge' : ratio >= 0.1 ? ' big' : ''
  return (
    <span key={token} className={`float-dmg k-${kind || 'hit'}${size}`}>
      {kind === 'heal' ? '+' : '−'}{Math.round(value).toLocaleString()}
    </span>
  )
}

// ---------------------------------------------------------------- 血条

/**
 * 血条：数值变化时闪一下，掉到危险区变色。
 *
 * 闪光靠 key 变化重挂载来重播动画，不用手写计时器。
 */
export function FxBar({ label, cur, max, cls, flashToken, danger }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0
  /*
   * 「残影」那一条：血条先掉，白影晚一拍再追上来。
   *
   * 只看最终值的话，血条从 80% 变成 40% 就是一个瞬间的跳变，
   * 掉了多少全靠脑补。留一条残影在旧位置上停一下再收，
   * "刚刚被削掉了这么长一截"就变成一个能看见的动作。
   */
  const shownCur = useCountUp(cur)
  const shownMax = useCountUp(max, 520)

  const [ghost, setGhost] = useState(pct)
  const ghostRef = useRef(pct)
  ghostRef.current = ghost

  useEffect(() => {
    if (pct >= ghostRef.current) { setGhost(pct); return undefined }
    /*
     * 停多久再收：必须比血条自己那 0.45s 的 width 过渡长一点点。
     * 短于它的话，白影在血条还没走完的时候就自己缩了 —— 玩家永远
     * 看不见"旧位置"和"新位置"同时存在的那一帧，残影就等于没做。
     * 460ms 让血条先落定，再留一瞬让那道缺口被看清。
     */
    const t = setTimeout(() => setGhost(pct), 460)
    return () => clearTimeout(t)
  }, [pct])

  const drain = ghost > pct + 0.4

  return (
    <div className={`bar${danger ? ' danger' : ''}`}>
      <div className="bar-head">
        <span>{label}</span>
        <b>{Math.round(shownCur).toLocaleString()} / {Math.round(shownMax).toLocaleString()}</b>
      </div>
      <div className="bar-track">
        {drain && <div className="bar-ghost" style={{ width: `${ghost}%` }} />}
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }}>
          {/*
            扫光：满格的血条是一块死色，加上一层慢慢走过的反光之后
            "这条还活着"就成了不用读数也能看见的事。放在 fill **里面** ——
            放外面的话它会连空槽一起扫过去，看着像血条自己变长了。
          */}
          <span className="bar-sheen" aria-hidden="true" />
        </div>
        {flashToken ? <span key={flashToken} className="bar-flash" /> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 交手机读

const MISS_LABEL = {
  technique: '术式没递出去',
  physical: '这一手落空',
  defend: '没能防住',
  domain: '领域没展开',
  reverse: '治疗没出来',
}

/**
 * 「本回合双方各做了什么」的一行读数。
 *
 * 手动战斗里，按下技能到模型把这一回合演出来之间有好几秒空档 ——
 * 原来那几秒屏幕上是静止的，玩家会怀疑自己到底点没点上。这一行是
 * 引擎算完立刻就有了的：招名、扣了多少血、有没有暴击，先落到屏幕上，
 * 模型随后写的正文再补上画面。数字是事实，画面归模型。
 */
export function BeatRow({ beat, ticks, turn }) {
  const rows = [
    { side: 'ours', who: '我方', b: beat?.player },
    { side: 'theirs', who: '敌方', b: beat?.enemy },
  ].filter((r) => r.b || (ticks || []).some((t) => t.side === (r.side === 'ours' ? 'player' : 'enemy')))
  if (!rows.length) return null

  return (
    // key 换掉即重挂载，动画自然重播 —— 连打两回合时不会因为上一次没播完而静默
    <div className="beats" key={turn}>
      {rows.map((r, i) => (
        <BeatLine
          key={r.side}
          who={r.who}
          side={r.side}
          b={r.b}
          delay={i * 90}
          ticks={(ticks || []).filter((t) => t.side === (r.side === 'ours' ? 'player' : 'enemy'))}
        />
      ))}
    </div>
  )
}

function BeatLine({ who, side, b, ticks, delay }) {
  const bits = []
  const n = (v) => Math.round(v).toLocaleString()

  if (b) {
    bits.push(<span className="bt-act" key="act">{b.label}</span>)
    if (b.damage > 0) bits.push(<b className="bt-dmg" key="d">−{n(b.damage)}</b>)
    if (b.healed > 0) bits.push(<b className="bt-heal" key="h">+{n(b.healed)}</b>)
    if (b.recovered > 0) bits.push(<span className="bt-ce" key="c">咒力 +{n(b.recovered)}</span>)
    if (b.crit) bits.push(<span className="bt-crit" key="k">暴击</span>)
    if (b.staggered) bits.push(<span className="bt-miss" key="s">被打断</span>)
    if (b.fizzled) bits.push(<span className="bt-miss" key="f">{MISS_LABEL[b.kind] || '没生效'}</span>)
  }

  for (const t of ticks) {
    if (t.damage > 0) bits.push(<b className="bt-dmg tick" key={`td${t.type}`}>追斩 −{n(t.damage)}</b>)
    if (t.healed > 0) bits.push(<b className="bt-heal tick" key={`th${t.type}`}>续 +{n(t.healed)}</b>)
    if (t.recovered > 0) bits.push(<span className="bt-ce tick" key={`tc${t.type}`}>咒力 +{n(t.recovered)}</span>)
  }

  if (!bits.length) return null

  return (
    <div className={`beat side-${side}`} style={{ animationDelay: `${delay}ms` }}>
      <span className="bt-who">{who}</span>
      {bits}
    </div>
  )
}

// ---------------------------------------------------------------- 规则封锁

/**
 * 规则型领域压着谁。
 *
 * 被封住的招在行动栏里也会灰掉，但玩家按的是"出招"，
 * 眼睛盯的是结果 —— 光把按钮变灰，很容易被当成"我咒力不够"。
 */
export function SealChip({ seal, rules, mine }) {
  if (!seal) return null
  const rules_ = rules || {}
  const locked = [
    rules_.technique && '术式',
    rules_.reverse && '反转术式',
    rules_.domain && '领域',
    rules_.defense && '防御',
  ].filter(Boolean)
  if (!locked.length) return null

  return (
    <div className={`seal-chip${mine ? ' on-me' : ''}`}>
      <span className="sc-tag">规则压制</span>
      <span className="sc-text">
        {mine ? '你' : '对方'}的{locked.join(' / ')}被封住
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- 领域光环

/** 战斗中挂在角色卡上的"展开中"光环：剩余回合数一眼可见 */
export function DomainAura({ active, name, turnsLeft, side, type }) {
  if (!active) return null
  const tone = DOMAIN_TONE[type] || 'dmg'
  return (
    <div className={`domain-aura side-${side || 'self'} tone-${tone}`}>
      <span className="da-ring" aria-hidden="true" />
      <span className="da-text">
        {/* 类型要一直挂着：领域开着的时候，玩家的每一步都受它影响 */}
        {type && <span className="da-type">{type}</span>}
        领域展开中 · {name}
        {typeof turnsLeft === 'number' && <b> 剩 {turnsLeft} 回合</b>}
      </span>
    </div>
  )
}
