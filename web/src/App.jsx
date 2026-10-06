import React, { useCallback, useEffect, useState } from 'react'
import * as api from './api.js'
import {
  AttributeCard, IdentityCard, CustomCard, TimeCard, CustomTimeCard, StorylineCard, PlayModePicker,
  SuddenArrivalCard,
} from './components/Cards.jsx'
import { NarrativeLog, ChoiceList, useTypewriter } from './components/Narrative.jsx'
import { StatusPanel, RelationPanel, SukunaPanel, TimelinePanel, GrowthPanel, BattleLogPanel, EditPlayerModal } from './components/Panels.jsx'
import { ActionBar } from './components/CombatPanel.jsx'
import { WheelPanel } from './components/WheelPanel.jsx'
import { SaveModal } from './components/SaveModal.jsx'
import { CombatSidebar } from './components/CombatSidebar.jsx'
import { CrossoverScreen, CrossoverResult } from './components/Crossover.jsx'
import { UsageMeter } from './components/UsageMeter.jsx'
import { DomainCutin, Impact, Toasts, useToasts } from './components/Fx.jsx'

/**
 * 「突然出现的人」的档案槽位名。
 * 必须和 server/engine/rolls.js 里的 SUDDEN_ARRIVAL_SLOT 一致 ——
 * 选定身份时按这个字符串去服务端那份列表里找档案。
 */
const SUDDEN_SLOT = '穿越者'

/**
 * 抹掉本应用存在浏览器里的东西。
 *
 * 只有两把钥匙：当前会话 id（sunuo:session）和上一次手写的行动（sunuo:lastAction）。
 * 按前缀删而不是 localStorage.clear() —— 同一个源下可能还放着别的东西，
 * 一个"清游戏数据"的按钮不该顺手把它们带走。
 */
function clearLocalKeys() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sunuo:')) localStorage.removeItem(k)
    }
  } catch {}
}

/** 存档里的 log 还原成界面条目 */
function entriesFromLog(log) {
  return (log || []).map((e) => {
    if (e.type === 'training') return { ...e, kind: 'training' }
    // 轮盘记录的 kind 装的是 'train' / 'rest' / 'advance'（这天干了什么），
    // 所以分派用的 kind 换一个格子放，把原值搬到 mode 上。
    // 顺序不能反：e 里自带 kind，摊在后面会把 'wheel' 冲掉。
    if (e.type === 'wheel') return { ...e, kind: 'wheel', mode: e.kind }
    if (e.type === 'recovery') return { ...e, kind: 'recovery' }
    return { kind: 'turn', turn: e.turn, narration: e.narration, recap: e.recap, dialogue: e.dialogue, notes: e.notes }
  })
}

export default function App() {
  const [phase, setPhase] = useState('start') // start | attributes | identity | playing
  const [sessionId, setSessionId] = useState(null)
  // 回主页之后再点「继续上次」：把会话续接那段逻辑重新跑一遍
  const [resumeTick, setResumeTick] = useState(0)
  const [attrProfiles, setAttrProfiles] = useState([])
  const [identProfiles, setIdentProfiles] = useState([])
  const [entries, setEntries] = useState([])
  const [choices, setChoices] = useState([])
  const [panel, setPanel] = useState(null)
  const [pending, setPending] = useState(null)   // 待处理的遭遇战（引擎侧仍叫 pendingCombat）
  const [liveCombat, setLiveCombat] = useState(null) // 手动模式进行中的回合
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [showSaves, setShowSaves] = useState(false)
  // 改数值的弹层。放在 App 这一层是因为改完要 resync 整份面板 ——
  // 等级、领域档位、术式消耗都会跟着数字一起变
  const [editOpen, setEditOpen] = useState(false)
  // 清空数据的二次确认：点一次只是把确认条亮出来，不是真删
  const [wipeAsk, setWipeAsk] = useState(false)
  const [wiping, setWiping] = useState(false)
  const [wipeDone, setWipeDone] = useState(null) // 清完的回执，留在原地给玩家看
  const [showSide, setShowSide] = useState(false) // 窄屏时右侧状态栏抽屉
  const [showCombat, setShowCombat] = useState(false) // 中等宽度时左侧战斗栏抽屉
  // 自主定义：玩家自己写的那份，以及重掷前的输入
  const [customBrief, setCustomBrief] = useState('')
  const [customAttr, setCustomAttr] = useState(null)
  const [customIdent, setCustomIdent] = useState(null)
  // 第五个身份「突然出现的人」：只由玩家自己填，不掷也不问模型
  const [suddenName, setSuddenName] = useState('')
  const [suddenAge, setSuddenAge] = useState(17)
  const [suddenBrief, setSuddenBrief] = useState('')
  const [timeProfiles, setTimeProfiles] = useState([])
  const [storylines, setStorylines] = useState([])
  const [playModes, setPlayModes] = useState([])
  const [playMode, setMode] = useState('story')
  const [recap, setRecap] = useState('') // 选项上方那句局面提要
  const [xo, setXo] = useState(null)        // 跨篇数据（有值就说明可以跨）
  const [xoStep, setXoStep] = useState(0)   // 当前第几段历练
  const [xoOpen, setXoOpen] = useState(false)
  const [xoLast, setXoLast] = useState(null) // 上一段的成长结算
  const [customTime, setCustomTime] = useState(null)
  const [usage, setUsage] = useState(null) // 本局 token 用量与费用
  // 战斗向：日常轮盘 + 不占回合的自由行动（反转术式）
  const [wheel, setWheel] = useState(null)
  const [wheelGate, setWheelGate] = useState(null)
  const [freeActions, setFreeActions] = useState([])
  // 成长面板的六行标题（服务端给，静态），进度值在 panel.training 里
  const [growth, setGrowth] = useState(null)
  // 轮盘展开 / 收起。默认收起 —— 见 WheelPanel 顶部的说明
  const [wheelOpen, setWheelOpen] = useState(false)
  // 战斗中的即时演出：伤害飘字、血条闪光、抖动、连击
  const [fx, setFx] = useState(null)
  // 全屏冲击：命中、挨打、暴击那一下的闪光与震动
  const [impact, setImpact] = useState(null)
  /*
   * 大字过场排队。
   *
   * 原来是单个槽位，后到的直接盖掉先到的 —— 跳过模式那一场里，
   * 「領域展開」和打完的「撃破」是同一段流里前后脚到的，领域那一屏
   * 会被瞬间顶掉，等于白做。排队之后两屏依次演完。
   */
  const [cutins, setCutins] = useState([])
  const cutinSeq = React.useRef(0)
  const pushCutin = useCallback((c) => {
    if (!c) return
    setCutins((q) => [...q, { ...c, key: ++cutinSeq.current }])
  }, [])

  // 打字机：把成块到达的文字按节奏吐出来，而不是一块块往外蹦
  const tw = useTypewriter()

  // 轻提示：数值真的跳了的时候弹一下（修炼攒满、跨级升级、战果）
  const toaster = useToasts()
  const { push: toast } = toaster

  /**
   * 收场那一下。
   *
   * 打完一场是整局里情绪最高的一拍，可它原来只落在日志里的一张小卡片上 ——
   * 玩家正在低头看行动栏的时候就错过了。赢了弹个金色的，输了弹个血色的，
   * 让这一拍从正文里跳出来。
   *
   * 一颗轻提示接不住整场里最高的一拍，所以同一时刻还压一屏大字过场：
   * 轻提示留着（战果明细跟着它一条条弹），过场负责那一下心跳。
   */
  const toastOutcome = useCallback((outcome, summary, lines = []) => {
    const w = outcome?.winner
    if (w === 'player') toast(summary ? `胜 · ${summary}` : '这一场拿下了', { tone: 'gold', big: true, title: '胜利' })
    else if (w === 'enemy') toast(summary ? `败 · ${summary}` : '这一场没能拿下', { tone: 'blood', big: true, title: '败北' })
    else return
    pushCutin({
      kind: w === 'player' ? 'win' : 'lose',
      name: summary || (w === 'player' ? '这一场拿下了' : '这一场没能拿下'),
      lines,
    })
  }, [toast, pushCutin])

  // 战斗面板要等下一块面板到了才能归档（那时才拿到这一回合的完整演出）
  const livePanelRef = React.useRef(null)
  // 已经播报过的遭遇询问的指纹。它挡的是重复插入 —— 见 askCombatEnter
  const announcedRef = React.useRef(null)
  const fxSeq = React.useRef(0)

  const onLoadSave = useCallback((r) => {
    try { localStorage.setItem('sunuo:session', r.sessionId) } catch {}
    setSessionId(r.sessionId)
    setEntries(entriesFromLog(r.log))
    setRecap(r.recap || '')
    setChoices(r.choices || [])
    setPanel(r.panel)
    if (r.playMode) setMode(r.playMode)
    setWheel(r.wheel || null)
    setWheelGate(r.wheelGate || null)
    setFreeActions(r.freeActions || [])
    if (r.growth) setGrowth(r.growth)
    // 读的是另一局了，上一局的"问过没问过"不能带过来
    announcedRef.current = null
    setFx(null)
    setImpact(null)
    setCutins([])
    setWheelOpen(false)
    toaster.clear()
    askCombatEnter(r.combat)
    takeUsage(r.usage)
    setLiveCombat(null)
    livePanelRef.current = null
    tw.reset()
    setShowSaves(false)
    setPhase('playing')
    // 注意：askCombatEnter 声明在后面，写进依赖数组会触发 TDZ。它本身是空依赖的稳定引用
  }, [tw, toaster])

  /** 任何响应里带了 usage 就更新计量表 */
  const takeUsage = useCallback((u) => { if (u) setUsage(u) }, [])

  /**
   * 回主页。
   *
   * 不是"结束这一局"：进度每回合都落盘在服务端，localStorage 里的会话 id 也留着，
   * 所以这里做的是把界面恢复成没进过游戏的样子。回来走开始界面的「继续上次」，
   * 或者直接刷新页面都行。
   *
   * 现场的东西必须清干净 —— 留着的话，回头点「开始生成」开新局，
   * 旧的对话流会被 submit 的 append 接上去，新角色的第一屏里躺着上一个人的剧情。
   *
   * 按钮在 busy 时是禁用的：正在生成的那条流会在回调里往界面上写东西，
   * 人已经站在主页了，下一秒又被塞回一局对话里。
   */
  const goHome = useCallback(() => {
    tw.reset() // 掐掉打字机的节拍，别让它在看不见的地方继续吐
    setEntries([])
    setRecap('')
    setChoices([])
    setPanel(null)
    setPending(null)
    setLiveCombat(null)
    setWheel(null)
    setWheelGate(null)
    setGrowth(null)
    setFreeActions([])
    setFx(null)
    setImpact(null)
    setCutins([])
    setError(null)
    announcedRef.current = null
    livePanelRef.current = null
    toaster.clear()
    setShowSaves(false)
    setShowSide(false)
    setShowCombat(false)
    setXoOpen(false)
    setXoLast(null)
    setWheelOpen(false)
    setPhase('start')
  }, [tw, toaster])

  /**
   * 清空本机所有数据：进行中的会话、全部存档，以及浏览器里存的那两把钥匙。
   *
   * 这是**没有撤销键**的操作 —— 没手动存过档的那一局，清掉就真的没了。
   * 所以界面上要点两次：第一次只是把确认条亮出来，第二次才发请求。
   * 服务端也另有一道口令（见 server/engine/wipe.js），两道都要过。
   *
   * 清完必须跟着 goHome：留在对战界面上会出鬼 —— 面板还画着一个已经不存在的
   * 角色，下一回合的请求带着旧 sessionId 打过去，只会拿回 404。
   */
  const wipeAll = useCallback(async () => {
    setWiping(true)
    setError(null)
    try {
      const r = await api.wipeAllData()
      clearLocalKeys()
      setSessionId(null) // goHome 刻意不动它（那是有局在手的判据），这里必须自己清
      setWipeAsk(false)
      goHome()
      /*
       * 回执写在卡片里而不是弹 toast：开始界面这一屏没有挂 Toasts 容器，
       * 而且"刚才那一下删掉了什么"是玩家清完最想知道的事，
       * 该留在原地让他看清，不该几秒后自己飘走。
       */
      setWipeDone(`已清空 ${r.sessions} 个会话、${r.files} 个存档文件`)
    } catch (e) {
      setError(`清空失败：${e.message}`)
    } finally {
      setWiping(false)
    }
  }, [goHome])

  // ---------------------------------------------------------- 会话续接

  // 刷新页面不该丢掉进度：把会话 id 存在本地，挂载时尝试接回来
  useEffect(() => {
    if (sessionId) {
      try { localStorage.setItem('sunuo:session', sessionId) } catch {}
    }
  }, [sessionId])

  useEffect(() => {
    let id = null
    try { id = localStorage.getItem('sunuo:session') } catch {}
    if (!id) return

    let cancelled = false
    ;(async () => {
      try {
        const r = await api.getState(id)
        if (cancelled) return
        setSessionId(id)
        setPanel(r.panel)
        takeUsage(r.usage) // 刷新后用量表要立刻恢复，不能等下一次调用
        // 模式列表和当前模式也要恢复 —— 否则顶栏那个徽章找不到名字，
        // 会一直显示默认的"剧情向"，切了也看不出来
        if (r.playMode) setMode(r.playMode)
        api.listPlayModes()
          .then((mr) => { if (!cancelled) setPlayModes(mr.modes || []) })
          .catch(() => {})
        if (r.phase === 'playing') {
          setEntries(entriesFromLog(r.log))
          setRecap(r.recap || '') // 刷新后选项上方那句提要也要恢复
          setChoices(r.choices || [])
          setWheel(r.wheel || null)
          setWheelGate(r.wheelGate || null)
          if (r.growth) setGrowth(r.growth)
          setFreeActions(r.freeActions || r.inCombat?.freeActions || [])
          // 刷新等于重来一遍界面，日志已经重建过了，询问块不能再补一块
          announcedRef.current = null
          askCombatEnter(r.combat)
          if (r.inCombat) {
            setLiveCombat({ mode: r.inCombat.mode, panel: r.inCombat.panel, narration: '', actions: r.inCombat.actions })
            playPanelFx(r.inCombat.panel)
          }
          setPhase('playing')
        } else if (r.phase === 'storyline') {
          const { storylines: lines } = await api.listStorylines()
          if (cancelled) return
          setStorylines(lines || [])
          setPhase('storyline')
        } else if (r.phase === 'attributes') {
          setAttrProfiles(r.attributeProfiles || [])
          setPhase('attributes')
        } else if (r.phase === 'identity') {
          setIdentProfiles(r.identityProfiles || [])
          setPhase('identity')
        } else if (r.phase === 'time') {
          setTimeProfiles(r.timeProfiles || [])
          setCustomBrief('')
          setPhase('time')
        }
      } catch {
        // 会话已失效（存档被清过），安静地回到开始界面。
        // 顺手把 sessionId 也清掉 —— 它同时是"有没有局可以继续"的判据，
        // 留着的话主页会挂一个点了就报错的「继续上次」
        setSessionId(null)
        try { localStorage.removeItem('sunuo:session') } catch {}
      }
    })()
    return () => { cancelled = true }
  }, [takeUsage, resumeTick])


  /**
   * 遭遇战不再弹窗，而是在对话流里插一块询问，选项走底部那一栏。
   * 第一次问「要不要打」（可以逃），选了迎战再问用哪种战斗模式。
   *
   * ⚠️ 必须去重。这个函数会在很多地方被调到：每次回合结束、每次报错后的
   * resync、读档、刷新会话……而**同一场遭遇会跨过其中好几次**（比如出招
   * 失败 → resync 就会带着同一个 pendingCombat 再回来一次）。早先它无条件
   * 往 entries 里塞，于是对话流里会叠出两块一模一样的「遭遇·腐骨咒灵」，
   * 选项也被重置回"迎战/脱离" —— 玩家明明已经在选战斗模式了，又被拽回第一步。
   *
   * 判据用「这是哪一场」而不是「有没有问过」：同一场只问一次，
   * 换了一场（sinceTurn 变了、或者对手换了）才重新问。
   */
  const askCombatEnter = useCallback((pc) => {
    setPending(pc || null)
    if (!pc) {
      announcedRef.current = null
      return
    }

    const key = `${pc.sinceTurn ?? '?'}|${pc.enemyName}|${pc.intervention || ''}`
    if (announcedRef.current === key) {
      // 问过了：只把选项摆回去，不再插一块询问
      setChoices([
        { id: 'fight', label: '迎战', kind: 'combat-enter' },
        { id: 'evade', label: '尝试脱离（按速度判定，可能失败）', kind: 'combat-evade' },
      ])
      return
    }
    announcedRef.current = key

    setEntries((prev) => [...prev, {
      kind: 'inquiry',
      inquiry: {
        tag: '遭遇',
        title: pc.enemyGrade ? `${pc.enemyName}（${pc.enemyGrade}）` : pc.enemyName,
        lines: [pc.reason || '', pc.enemyTechnique ? `对方术式：${pc.enemyTechnique}` : ''].filter(Boolean),
        hint: '可以打，也可以试着甩掉它 —— 脱离不一定成功。',
        tone: 'danger',
      },
    }])
    setChoices([
      { id: 'fight', label: '迎战', kind: 'combat-enter' },
      { id: 'evade', label: '尝试脱离（按速度判定，可能失败）', kind: 'combat-evade' },
    ])
  }, [])

  /**
   * 把一块战斗回合面板翻译成演出。
   *
   * 面板是引擎算完的结果（伤害、暴击、连击、领域），这里只决定"闪什么、震什么"。
   * 用递增的 token 触发重挂载来重播 CSS 动画 —— 比手写计时器可靠得多，
   * 而且连打两回合时不会因为上一次的动画没结束就不播。
   */
  const playPanelFx = useCallback((cp) => {
    if (!cp) return
    const n = ++fxSeq.current

    /*
     * 飘出来的数字用"这一回合总共掉了多少"，不是"这一手打了多少"。
     * 领域追斩也算进去 —— 玩家的血条就是掉了这么多，飘字和血条得是同一个数，
     * 否则血条短了一截、飘字只报了其中一半，看起来像是引擎算错了。
     * 想拆开看的话，左边那行交手机读里是分了笔的。
     */
    const my = cp.beat?.player || {}
    const foe = cp.beat?.enemy || {}
    const dealt = (my.damage || 0) + (my.tickDamage || 0)
    const taken = (foe.damage || 0) + (foe.tickDamage || 0)
    const healed = (my.healed || 0) + (my.tickHealed || 0)
    // 自己这边飘净变化：回的血减去挨的打。两笔都发生时不飘两个数，反而看不清
    const selfNet = healed - taken

    setFx({
      dmgToken: dealt ? `d${n}` : null,
      dmgValue: dealt,
      dmgKind: cp.sureHit ? 'sure' : cp.crit === 'player' ? 'crit' : 'hit',
      selfDmgToken: selfNet ? `sd${n}` : null,
      selfDmgValue: Math.abs(selfNet),
      selfDmgKind: selfNet > 0 ? 'heal' : 'hit',
      hpFlash: `e${n}`,
      selfHpFlash: `s${n}`,
      ceFlash: `c${n}`,
      // 我方打出暴击 → 敌方卡抖；敌方打出暴击 → 我方卡抖
      shake: cp.crit === 'player' ? 'hit' : null,
      selfShake: cp.crit === 'enemy' ? 'taken' : null,
      combo: cp.combo || 0,
      enemyCombo: cp.enemyCombo || 0,
      selfDomain: cp.domainState?.player,
      enemyDomain: cp.domainState?.enemy,
    })

    /*
     * 全屏冲击的强度：这一下占了多少血条。
     *
     * 用比例不用绝对值 —— 血条 800 的对手挨 300 和血条 300 的挨 300
     * 不是一回事，屏幕上该是两种反应。两边取强的那个：
     * 自己挨了一记狠的，屏幕也该有反应，那一记在观感上和自己打出去的一样重。
     */
    const dealtRatio = cp.enemy?.hpMax > 0 ? dealt / cp.enemy.hpMax : 0
    const takenRatio = cp.player?.hpMax > 0 ? taken / cp.player.hpMax : 0
    const heavy = Math.max(dealtRatio, takenRatio)
    const level = heavy >= 0.25 ? 'brutal' : heavy >= 0.1 ? 'heavy' : heavy >= 0.03 ? 'graze' : null

    setImpact(level ? {
      token: `i${n}`,
      // 震屏靠它翻面：连着两记重击之间必须换一个 keyframes 名，动画才会重播
      seq: n,
      level,
      // 这一记主要是谁挨的：决定光从哪一侧炸开、以及是不是血色
      side: dealtRatio >= takenRatio ? 'enemy' : 'self',
      tone: dealtRatio >= takenRatio
        ? (cp.sureHit ? 'sure' : cp.crit === 'player' ? 'crit' : 'hit')
        : 'taken',
    } : null)

    if (cp.domainOpened) pushCutin(cp.domainOpened)
    if (cp.crit === 'player') toast('暴击！抓住了破绽', { tone: 'blood' })
    else if (cp.staggered === 'enemy') toast('对方被打断，这一手没能还手', { tone: 'blood' })
    // 对面的规则型领域：这是"你的招从下一回合起全都作废"，值得单独喊一声
    else if (cp.domainOpened?.side === 'enemy' && cp.domainOpened.type === '规则型') {
      toast('规则改写完毕：你的术式、反转术式与领域都被封住', { tone: 'blood', title: '领域' })
    }
  }, [toast, pushCutin])

  // ---------------------------------------------------------- 开局

  /** 第零步：开一局，列出可选故事线 */
  const boot = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { sessionId: id } = await api.newSession()
      setSessionId(id)
      const [{ storylines: lines }, modeRes] = await Promise.all([
        api.listStorylines(),
        api.listPlayModes(),
      ])
      setStorylines(lines || [])
      setPlayModes(modeRes.modes || [])
      setMode(modeRes.default || 'story')
      setPhase('storyline')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * 选定故事线 → 才开始掷属性档案。
   * 顺序不能反：原作节点表、可交互角色、穿越时间候选全由故事线决定。
   */
  const pickStoryline = useCallback(async (sid) => {
    setBusy(true)
    setError(null)
    try {
      const r0 = await api.chooseStoryline(sessionId, sid, playMode)
      takeUsage(r0.usage)
      const { profiles, usage: u } = await api.genAttributes(sessionId)
      takeUsage(u) // 掷属性是真花钱的，漏了这一步用量表就不动
      setAttrProfiles(profiles)
      setPhase('attributes')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, takeUsage])

  const pickAttribute = useCallback(async (slot) => {
    setBusy(true)
    setError(null)
    try {
      const { identities, usage: u1 } = await api.chooseAttributes(sessionId, slot)
      setCustomBrief('') // 换阶段了，清掉上一阶段的输入
      setCustomIdent(null)
      takeUsage(u1)
      setIdentProfiles(identities)
      setPhase('identity')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  /** 自主定义：生成一份属于自己的属性 / 身份档案 */
  const generateCustom = useCallback(async (kind) => {
    setBusy(true)
    setError(null)
    try {
      const brief = customBrief.trim()
      if (kind === 'attribute') {
        const r = await api.customAttribute(sessionId, brief)
        takeUsage(r.usage)
        setCustomAttr(r.profile)
      } else {
        const r = await api.customIdentity(sessionId, brief)
        takeUsage(r.usage)
        setCustomIdent(r.identity)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, customBrief, takeUsage])

  /**
   * 改数值。等级由服务端按数字反推 —— 客户端只负责把框里的数字送过去。
   * 返回值里可能带着重新生成的领域（数字跨进特级时），所以整体替换掉本地那份。
   */
  const tuneCustomAttr = useCallback(async (numbers) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.tuneAttribute(sessionId, numbers)
      takeUsage(r.usage)
      setCustomAttr(r.profile)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, takeUsage])

  const pickIdentity = useCallback(async (slot) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.chooseIdentity(sessionId, slot)
      takeUsage(res.usage)
      setTimeProfiles(res.times || [])
      setCustomBrief('') // 换阶段了，清掉上一阶段的输入
      setSuddenName('')
      setSuddenBrief('')
      setPhase('time')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, takeUsage])

  /**
   * 第五个身份：突然出现的人。
   *
   * 两步走：先让服务端把这份档案造出来（纯引擎，不走模型），再走和另外四张卡
   * 完全相同的选定流程 —— 后面的开局、时间线、提示词组装都不需要为它开分支，
   * 它只是一个 kind 不同的普通档案。必须定义在 pickIdentity 之后：
   * 依赖数组里引用了它，声明在前面会 TDZ 白屏。
   */
  const submitSudden = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.suddenIdentity(sessionId, {
        name: suddenName.trim(),
        age: suddenAge,
        brief: suddenBrief.trim(),
      })
      await pickIdentity(SUDDEN_SLOT)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, suddenName, suddenAge, suddenBrief, pickIdentity])

  /** 自主定义穿越时间 */
  const generateCustomT = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.customTime(sessionId, customBrief.trim())
      takeUsage(r.usage)
      setCustomTime(r.point)
      // 把它并进候选列表，选定时就能按 id 找到
      setTimeProfiles((prev) => [...prev.filter((t) => t.id !== '自定义'), r.point])
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, customBrief, takeUsage])

  /** 第三步：选定穿越时间 → 生成最终档案与开局情境 */
  const pickTime = useCallback(async (id) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.chooseTime(sessionId, id)
      takeUsage(res.usage)
      setEntries([{ kind: 'turn', turn: 1, narration: res.narration, dialogue: res.dialogue, notes: res.notes, recap: res.recap }])
      setRecap(res.recap || '')
      setChoices(res.choices || [])
      setPanel(res.panel)
      setWheel(res.wheel || null)
      setWheelGate(res.wheelGate || null)
      askCombatEnter(res.combat)
      setPhase('playing')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, takeUsage, askCombatEnter])

  /**
   * 走「自主定义」时档案已经存在服务端了，直接按 slot 选。
   * 必须定义在 pickAttribute / pickIdentity 之后 —— 提前引用会触发 TDZ。
   */
  const pickCustom = useCallback((slot) => {
    if (phase === 'attributes') return pickAttribute(slot)
    return pickIdentity(slot)
  }, [phase, pickAttribute, pickIdentity])

  // ---------------------------------------------------------- 错误恢复

  /**
   * 出错时以服务端为准重建界面。必须定义在 submit / 战斗回调之前 ——
   * 它们把 resync 写进了 useCallback 的依赖数组，声明在后面的会触发 TDZ 白屏
   * （`tests/ui.test.mjs` 里有一条专门守这个）。
   *
   * 战斗流程里有好几处"先把本地状态清掉、再等接口返回"，
   * 一旦接口挂了，本地就少了半截状态（行动栏没了、弹窗没了），
   * 玩家会卡在既不能出招也不能推进剧情的死局里。
   */
  const resync = useCallback(async () => {
    if (!sessionId) return
    try {
      const r = await api.getState(sessionId)
      if (r.panel) setPanel(r.panel)
      if (r.choices?.length) setChoices(r.choices)
      // 轮盘和疗伤入口也一并捞回来 —— 报错重同步后它们不能凭空消失
      if (r.wheel !== undefined) setWheel(r.wheel || null)
      if (r.wheelGate !== undefined) setWheelGate(r.wheelGate || null)
      if (r.growth) setGrowth(r.growth)
      if (r.freeActions !== undefined) setFreeActions(r.freeActions || [])
      askCombatEnter(r.combat)
      setLiveCombat(
        r.inCombat
          ? { mode: r.inCombat.mode, panel: r.inCombat.panel, narration: '', actions: r.inCombat.actions }
          : null,
      )
      // 面板由服务端回放，别让本地再归档一次
      if (r.inCombat) livePanelRef.current = null
    } catch {
      // 同步也失败就保持现状，至少错误横幅还在
    }
  }, [sessionId])

  /**
   * 重新问一遍轮盘和它的闸门。
   *
   * 只在该问的时候问：一场仗开打的那一下。轮盘在打架时不再摘掉
   * （见下面 .side 那段说明），可它那两个按钮得当场变灰 —— "为什么按不动"
   * 这句话是服务端闸门给的（「战斗还没打完」「有一场遭遇还没处理」），
   * 本地不自己编一句，免得两边说的不一样。
   *
   * 打完之后不用管：收工会顺着 submit 走一次回合，那一份响应里带着新的
   * 轮盘和闸门。
   */
  const refreshWheel = useCallback(async () => {
    try {
      const r = await api.getWheel(sessionId)
      setWheel(r.wheel || null)
      setWheelGate(r.gate || null)
    } catch {
      // 拉不到就维持原样。轮盘是读数，不值得为它弹一条错误横幅
    }
  }, [sessionId])

  // ---------------------------------------------------------- 回合

  const submit = useCallback(async (text, { silent = false } = {}) => {
    setBusy(true)
    setError(null)
    tw.begin()
    setChoices([])
    if (!silent) setEntries((prev) => [...prev, { kind: 'player', text }])

    let acc = ''
    await api.streamTurn(sessionId, text, {
      onNarration: (t) => {
        acc += t          // acc 是完整正文（最终写进条目）
        tw.feed(t)        // 显示由打字机控制节奏
      },
      // 服务端判定正文为空要重来时，丢掉已收到的半截，避免两次输出拼在一起
      onReset: () => {
        acc = ''
        tw.reset()
      },
      onUsage: takeUsage,
      onDone: (data) => {
        tw.flush() // 把缓冲里剩下的字立刻吐完，避免和下面的条目之间出现跳变
        takeUsage(data.usage)
        setRecap(data.recap || '')
        setEntries((prev) => [
          ...prev,
          { kind: 'turn', turn: data.turn, narration: acc, dialogue: data.dialogue, notes: data.notes, recap: data.recap },
        ])
        setChoices(data.choices || [])
        setPanel(data.panel)
        // 这一轮剧情可能把日期往前推了，轮盘上的倒计时要跟着变
        if (data.wheel !== undefined) setWheel(data.wheel || null)
        if (data.wheelGate !== undefined) setWheelGate(data.wheelGate || null)
        if (data.freeActions !== undefined) setFreeActions(data.freeActions || [])
        askCombatEnter(data.combat)
        setBusy(false)
      },
      onError: (e) => {
        tw.flush()
        setError(e.message)
        setBusy(false)
        resync() // choices 已经被清空了，捞回服务端的最后一批选项
      },
    })
  }, [sessionId, resync, takeUsage, tw])


  const doTraining = useCallback(async (item) => {
    setBusy(true)
    try {
      const res = await api.train(sessionId, item)
      takeUsage(res.usage)
      setEntries((prev) => [...prev, { kind: 'training', ...res }])
      setPanel(res.panel)
      // 修炼推进了一天，接下来让模型接着演
      await submit(`（跳过当天，进行${item}修炼）`)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }, [sessionId, submit])

  // ---------------------------------------------------------- 战斗

  const archiveLive = useCallback(() => {
    const cur = livePanelRef.current
    if (!cur) return
    livePanelRef.current = null
    setEntries((prev) => [...prev, { kind: 'combat', panel: cur.panel, narration: cur.narration }])
  }, [])

  const askCombatMode = useCallback(() => {
    setEntries((prev) => [...prev, {
      kind: 'inquiry',
      inquiry: {
        tag: '战斗',
        title: '选择战斗模式',
        lines: [
          '手动模式 —— 每回合出牌，节奏由你掌控',
          '跳过模式 —— 直接结算胜负，只给简要过程',
          '剧情描述式 —— 自动演出全程，描写更细',
        ],
        hint: '一旦选定，本次战斗采用该模式。',
        tone: 'battle',
      },
    }])
    setChoices([
      { id: 'm1', label: '手动模式（回合制）', kind: 'combat-mode', mode: 'manual' },
      { id: 'm2', label: '跳过模式（快速结算）', kind: 'combat-mode', mode: 'skip' },
      { id: 'm3', label: '剧情描述式（自动演出）', kind: 'combat-mode', mode: 'narrative' },
    ])
  }, [])

  /** 只接受非空数组，避免 undefined / null 把行动栏冲掉 */
  const applyActions = useCallback((actions) => {
    if (!Array.isArray(actions) || actions.length === 0) return
    setLiveCombat((prev) => (prev ? { ...prev, actions } : prev))
  }, [])

  const startCombat = useCallback(async (mode) => {
    setPending(null)
    setBusy(true)
    setError(null)
    let acc = ''
    tw.begin()

    await api.combatStart(sessionId, mode, {
      onPanel: ({ panel: cp, snapshot }) => {
        archiveLive()
        livePanelRef.current = { panel: cp, narration: '' }
        if (snapshot) setPanel(snapshot)
        setLiveCombat({ mode, panel: cp, narration: '', actions: null })
        playPanelFx(cp)
      },
      onAwaiting: ({ actions }) => applyActions(actions),
      /*
       * 战斗向的正文有 400 字预算，超了服务端会在结算演出结束后截短并重置一次。
       * 不接这个事件的话，手里那份长文不会被丢掉，屏幕上就成了"长文 + 截短版"
       * 两段叠在一起 —— 比不截还难看。
       */
      onReset: () => {
        acc = ''
        if (livePanelRef.current) livePanelRef.current.narration = ''
        if (mode === 'manual') setLiveCombat((prev) => (prev ? { ...prev, narration: '' } : prev))
        else tw.reset()
      },
      // 跳过 / 剧情模式不逐回合推面板，但领域展开那一场得让玩家看见。
      // 整场只给一次"高光回顾"，所以顺带把暴击数报出来 ——
      // 不然这两种模式的战斗读起来就是一大段平铺直叙的文字
      onHighlight: ({ domainOpened, crits, rounds }) => {
        if (domainOpened) pushCutin(domainOpened)
        if (crits > 0) toast(`本场打出 ${crits} 次暴击（共 ${rounds} 回合）`, { tone: 'blood', title: '战况' })
      },
      onNarration: (t) => {
        acc += t
        if (livePanelRef.current) livePanelRef.current.narration = acc
        // 手动模式每回合只有两三句，直接用；跳过/剧情是长篇，交给打字机
        if (mode === 'manual') setLiveCombat((prev) => (prev ? { ...prev, narration: acc } : prev))
        else tw.feed(t)
      },
      onDone: (data) => {
        tw.flush()
        takeUsage(data.usage)
        if (!data.over) {
          // 只在服务端确实给了行动列表时才覆盖，否则会把行动栏清空
          applyActions(data.actions)
          setFreeActions(data.freeActions || [])
          if (data.snapshot) setPanel(data.snapshot) // 角色快照，不是战斗回合面板
          // 这一场开打了：轮盘留着读数，但按钮该灰了
          refreshWheel()
          setBusy(false)
          return
        }
        // 打完了
        if (mode !== 'manual' && acc) {
          setEntries((prev) => [...prev, { kind: 'turn', narration: acc, dialogue: [], notes: [] }])
        }
        archiveLive()
        setLiveCombat(null) // 收工时整块清掉，streaming 标志随之消失
        setFreeActions([])
        // 升级 / 战果这种"打完才结算"的东西，弹一下比埋在日志里更有分量
        toastOutcome(data.outcome, data.summary, data.ups || [])
        for (const u of data.ups || []) toast(u, { tone: 'blood', big: true, title: '战果' })
        setEntries((prev) => [
          ...prev,
          { kind: 'combatResult', outcome: data.outcome, summary: data.summary, rewards: data.rewards, ups: data.ups },
        ])
        setPanel(data.panel)
        setBusy(false)
        // 战斗结束了，让主循环接着往下演
        submit('（战斗已结算完毕，继续推进剧情）', { silent: true })
      },
      onError: (e) => {
        tw.flush()
        setError(e.message)
        setBusy(false)
        resync() // 弹窗已经关掉了，把待结算的战斗重新捞回来
      },
    })
  }, [sessionId, submit, archiveLive, resync, applyActions, playPanelFx, toast, toastOutcome, takeUsage, tw, refreshWheel])

  /** 尝试脱离遭遇战 */
  const tryEvade = useCallback(async () => {
    setBusy(true)
    setError(null)
    setChoices([])
    try {
      const r = await api.combatEvade(sessionId)
      takeUsage(r.usage)
      setPanel(r.panel)
      setEntries((prev) => [...prev, {
        kind: 'inquiry',
        inquiry: {
          tag: r.success ? '脱离' : '被迫应战',
          title: r.note,
          lines: [r.success
            ? '你没有交手就离开了。对方没追上来。'
            : '它咬得太紧，甩不掉 —— 这一架躲不过去。'],
          tone: r.success ? 'calm' : 'danger',
        },
      }])
      setBusy(false)
      if (r.success) {
        setPending(null)
        submit('（已脱离遭遇，继续推进剧情）', { silent: true })
      } else {
        // 脱离失败：战斗仍在，直接进入模式选择
        setPending(r.combat)
        askCombatMode()
      }
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }, [sessionId, takeUsage, submit, askCombatMode])

  const doAction = useCallback(async (type) => {
    setBusy(true)
    setError(null)
    let acc = ''
    setLiveCombat((prev) => (prev ? { ...prev, actions: null, narration: '', freeLines: [] } : prev))

    await api.combatAction(sessionId, type, {
      onPanel: ({ panel: cp, snapshot }) => {
        archiveLive()
        livePanelRef.current = { panel: cp, narration: '' }
        if (snapshot) setPanel(snapshot)
        setLiveCombat((prev) => (prev ? { ...prev, panel: cp, narration: '' } : { mode: 'manual', panel: cp, narration: '', actions: null }))
        playPanelFx(cp)
      },
      onNarration: (t) => {
        acc += t
        if (livePanelRef.current) livePanelRef.current.narration = acc
        setLiveCombat((prev) => (prev ? { ...prev, narration: acc, streaming: true } : prev))
      },
      // 同上：这一回合的演出被截短时，丢掉先前那份长的
      onReset: () => {
        acc = ''
        if (livePanelRef.current) livePanelRef.current.narration = ''
        setLiveCombat((prev) => (prev ? { ...prev, narration: '' } : prev))
      },
      onDone: (data) => {
        takeUsage(data.usage)
        if (!data.over) {
          setLiveCombat((prev) => (prev ? { ...prev, streaming: false } : prev))
          applyActions(data.actions)
          setFreeActions(data.freeActions || [])
          // 只在真的带了快照时才覆盖 —— 直接把 undefined 写进去的话，
          // 右侧状态栏和战斗栏里的"我方"会一起变空，看起来像角色没了
          if (data.panel) setPanel(data.panel)
          setBusy(false)
          return
        }
        archiveLive()
        setLiveCombat(null) // 收工时整块清掉，streaming 标志随之消失
        setFreeActions([])
        // 升级 / 战果这种"打完才结算"的东西，弹一下比埋在日志里更有分量
        toastOutcome(data.outcome, data.summary, data.ups || [])
        for (const u of data.ups || []) toast(u, { tone: 'blood', big: true, title: '战果' })
        setEntries((prev) => [
          ...prev,
          { kind: 'combatResult', outcome: data.outcome, summary: data.summary, rewards: data.rewards, ups: data.ups },
        ])
        setPanel(data.panel)
        setBusy(false)
        submit('（战斗已结算完毕，继续推进剧情）', { silent: true })
      },
      onError: (e) => {
        setError(e.message)
        setBusy(false)
        resync() // 行动栏已被清空，重新同步才能继续打
      },
    })
  }, [sessionId, submit, archiveLive, resync, applyActions, playPanelFx, toast, toastOutcome, takeUsage, tw])

  // ------------------------------------------------- 战斗向：轮盘

  /**
   * 转一天 / 一路练到剧情当天。
   *
   * 引擎全算完再回来，所以这里不用等模型 —— 数字立刻落在日志里，
   * 玩家看得见每天练到了哪儿。练到剧情当天时服务端顺手把这一仗挂上，
   * 走的是和遭遇战同一条"要不要打"的询问流程。
   */
  const doWheel = useCallback(async (mode) => {
    setBusy(true)
    setError(null)
    try {
      const r = mode === 'advance' ? await api.wheelAdvance(sessionId) : await api.wheelSpin(sessionId)
      takeUsage(r.usage)
      /*
       * 转一天之后，上一轮剧情留下的选项就过期了 —— 世界已经往前走了一天。
       * 更要紧的是里面还混着带引擎语义的那些（"迎战""修炼""疗伤"），
       * 它们会按当时的局面去执行，按下去就是重复触发一场已经结束的遭遇。
       * 服务端那边 state.choices 也已经清掉了，这里跟着清，两边保持一致。
       * 选项栏底部的自定义行动一直在，玩家想干什么仍然可以写。
       */
      setChoices([])

      if (mode === 'advance') {
        // 一天都没推（已经在当天了）就不留空条目
        if (r.summary?.days > 0) {
          // 注意顺序：summary 自带 kind:'advance'，摊在后面会把分派用的 'wheel' 冲掉
          setEntries((prev) => [...prev, { ...r.summary, kind: 'wheel', mode: 'advance' }])
        }
      } else {
        const rep = r.report || {}
        setEntries((prev) => [...prev, {
          ...rep,
          kind: 'wheel',
          mode: rep.kind,
          // 单天的升级是一句话，整段的是一串 —— 统一成数组给日志渲染
          gradeUps: rep.gradeUp ? [rep.gradeUp] : undefined,
        }])
      }

      // 数值真的跳了才弹提示。
      // 轮盘转一天涨的那几个百分点是"过程"，进度条满了跳属性才是"结果" ——
      // 玩家练到第十几天才会遇到一次，埋在日志的一堆"· 进度 +6.2%"里太可惜了
      const ups = mode === 'advance' ? (r.summary?.ups || []) : (r.report?.ups || [])
      for (const u of ups) toast(u, { tone: 'gold', title: '突破' })
      const gradeUps = mode === 'advance'
        ? (r.summary?.gradeUps || [])
        : (r.report?.gradeUp ? [r.report.gradeUp] : [])
      for (const g of gradeUps) toast(g, { tone: 'blood', big: true, title: '等级提升' })
      if (mode === 'spin' && r.report?.kind === 'blocked') {
        toast(r.report.notes?.[0] || '这一天要留给那场仗', { tone: 'blood' })
      }

      setWheel(r.wheel)
      setPanel(r.panel)
      // 闸门必须跟着刷新：这一天可能正好走到剧情节点当天了，
      // 不刷的话轮盘会继续摆着可点的"转一天"，一按就把节点那天转过去了
      if (r.gate) setWheelGate(r.gate)
      if (r.combat) askCombatEnter(r.combat)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, takeUsage, askCombatEnter, toast])

  // ------------------------------------------------- 疗伤

  /**
   * 处理身上的伤。
   *
   * 数值由引擎直接结算（不走模型）—— 玩家按下"反转术式"要的是当场看见血条动。
   * 结算完再补一个静默回合规剧情，和修炼一样。
   */
  const doRecovery = useCallback(async (id) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.recovery(sessionId, id)
      takeUsage(res.usage)
      setEntries((prev) => [...prev, { ...res, kind: 'recovery' }])
      setPanel(res.panel)
      await submit('（处理身上的伤）', { silent: true })
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }, [sessionId, submit, takeUsage])

  // ------------------------------------------------- 不占回合的行动

  /**
   * 反转术式。
   *
   * 和服务端约定好：这条接口**不推进回合** —— 敌方不动，玩家接着出招。
   * 返回里带角色快照，拿到就立刻刷右侧状态栏（这正是之前"用了技能血条不动"的修法）。
   */
  const doFreeAction = useCallback(async (type) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.combatFreeAction(sessionId, type)
      takeUsage(r.usage)
      if (r.snapshot) setPanel(r.snapshot)
      applyActions(r.actions)
      setFreeActions(r.freeActions || [])
      if (r.lines?.length) {
        setLiveCombat((prev) => (prev ? { ...prev, freeLines: [...(prev.freeLines || []), ...r.lines] } : prev))
      }
    } catch (e) {
      setError(e.message)
      // 按钮状态可能已经过期（比如上一回合用过了），重新问一次服务端
      resync()
    } finally {
      setBusy(false)
    }
  }, [sessionId, takeUsage, applyActions, resync])

  const onPick = useCallback(async (choice) => {
    // 遭遇战：先问要不要打
    if (choice.kind === 'combat-enter') return askCombatMode()
    if (choice.kind === 'combat-evade') return tryEvade()
    if (choice.kind === 'combat-mode') return startCombat(choice.mode)

    // 修炼：把六个项目做成询问块里的选项，不再弹窗
    if (choice.kind === 'training') {
      try {
        const opts = await api.trainingOptions(sessionId)
        if (!opts.gate.ok) {
          setError(opts.gate.reason)
          return
        }
        setEntries((prev) => [...prev, {
          kind: 'inquiry',
          inquiry: {
            tag: '修炼',
            title: '跳过当天 · 修炼',
            lines: [
              '将当天全部时间投入一项修炼，剧情按原作时间线自然推进，',
              '可能错过当天的互动与事件。连续跳过 3 天后本选项会失效一次。',
            ],
            hint: '选一项开始。',
            tone: 'calm',
          },
        }])
        setChoices(opts.items.map((it) => ({
          id: `t-${it.name}`,
          label: `${it.name}（${it.range}｜消耗${it.cost}｜当前 ${it.progress}%）`,
          kind: 'training-item',
          item: it.name,
        })))
      } catch (e) {
        setError(e.message)
      }
      return
    }
    if (choice.kind === 'training-item') return doTraining(choice.item)

    // 疗伤：和修炼一样先在日志里问一句，再把这几个方法摆成选项
    if (choice.kind === 'recovery') {
      try {
        const opts = await api.recoveryOptions(sessionId)
        if (!opts.items?.length) {
          setError('现在没有可用的疗伤手段')
          return
        }
        setEntries((prev) => [...prev, {
          kind: 'inquiry',
          inquiry: {
            tag: '疗伤',
            title: '处理身上的伤',
            lines: [
              '反转术式当场就能用，但吃咒力；静养和找家入硝子要花掉一天。',
              '花掉的那一天，剧情会按原作时间线自己往前走。',
            ],
            hint: '选一种。',
            tone: 'calm',
          },
        }])
        setChoices(opts.items.map((it) => ({
          id: `r-${it.id}`,
          label: `${it.name}（${it.desc}）`,
          kind: 'recovery-item',
          item: it.id,
          disabled: !it.enabled,
          reason: it.reason || '',
        })))
      } catch (e) {
        setError(e.message)
      }
      return
    }
    if (choice.kind === 'recovery-item') return doRecovery(choice.item)

    // 自己写的行动要带标记 —— 模型得能分辨"玩家点了选项"和"玩家自己写了指令"，
    // 后者在契约里是最高优先级
    const isCustom = choice.id === 'free'
    submit(isCustom ? `【我的行动】${choice.label}` : choice.label)
  }, [sessionId, submit, askCombatMode, tryEvade, startCombat, doTraining, doRecovery])

  /** 开局后也能换模式 —— 点顶栏那个徽章即可 */
  const togglePlayMode = useCallback(async () => {
    const next = playMode === 'combat' ? 'story' : 'combat'
    setMode(next) // 先改本地，界面立刻响应
    try {
      await api.setPlayMode(sessionId, next)
      // 切进战斗向要立刻把轮盘拉出来，否则得等下一次出招才看得见
      const r = await api.getWheel(sessionId)
      setWheel(r.wheel || null)
      setWheelGate(r.gate || null)
      if (r.panel) setPanel(r.panel)
      // 切回剧情向就把轮盘收掉，免得挂着一块不生效的操作台
      if (next !== 'combat') { setWheel(null); setWheelGate(null) }
    } catch (e) {
      setMode(playMode) // 失败就退回去
      setError(e.message)
    }
  }, [sessionId, playMode])

  /** 打开跨篇界面（走完本线衔接节点后才可用） */
  const openCrossover = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.getCrossover(sessionId)
      if (!data.gate?.ok) { setError(data.gate?.reason || '当前不能跨篇'); return }
      setXo(data)
      setXoStep(data.done || 0)
      setXoOpen(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  /** 走一段历练 */
  const advanceCrossover = useCallback(async (focus) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.crossoverAdvance(sessionId, focus)
      takeUsage(r.usage)
      // ups 是 result 的兄弟字段，不是一个整体 —— 合起来再交给界面，
      // 否则 CrossoverScreen 里 lastResult.ups 是 undefined，渲染直接崩
      setXoLast({ ...r.result, ups: r.ups })
      setPanel(r.panel)

      if (r.finished) {
        // 三段走完 → 已经跨到新篇
        setXoOpen(false)
        setXo(null)
        setEntries((prev) => [...prev, { kind: 'crossover', result: r.crossover, panel: r.panel }])
        // 让主循环接着在新篇里演下去
        await submit('（跨越数年，进入新的篇章）', { silent: true })
      } else {
        setXoStep(r.done)
        setXo((prev) => (prev ? { ...prev, done: r.done } : prev))
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId, takeUsage, submit])


  // ---------------------------------------------------------- 快捷键

  /**
   * 键盘直接出招。
   *
   * 原来整局只能靠鼠标点：手动战斗一场三四十回合，每回合都要把光标
   * 挪到左下角那个按钮上点一下，久了非常累手。数字键是这里最自然的映射 ——
   * 选项和战斗行动本来就编了号。
   *
   * 不去维护一份"当前有哪些选项"的镜像，而是直接点 DOM 里那排按钮：
   * 选项栏和行动栏用的是同一套 .choice 结构，点了就走它们各自原本的通路，
   * 不会出现"快捷键走了一条和鼠标不一样的逻辑"这种最难查的分叉。
   */
  useEffect(() => {
    if (phase !== 'playing') return undefined

    const onKey = (e) => {
      // 正在输入（自定义行动、存档名）时数字键就是数字键
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'Escape') {
        if (error) { setError(null); return }
        setShowSaves(false)
        setXoOpen(false)
        setShowSide(false)
        setShowCombat(false)
        return
      }

      if (busy) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 9) return

      // 按"屏幕上印着的编号"找，而不是按数组下标。
      // 修炼项显示的是「※」不是数字，自由行动那一行也根本没有编号 ——
      // 用下标去数的话，屏幕写着 1 的那一格和按下 1 打到的那一格会对不上。
      let target = null
      for (const group of document.querySelectorAll('.act-grid, .choices-list')) {
        for (const b of group.querySelectorAll('button.choice')) {
          if (b.disabled) continue
          const shown = b.querySelector('.idx')?.textContent?.replace(/[^0-9]/g, '')
          if (shown === String(n)) { target = b; break }
        }
        if (target) break
      }
      if (!target) return
      e.preventDefault()
      target.click()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, busy, error])

  /**
   * 轮盘收不收，**只由玩家决定**。
   *
   * 早先这里有一套自动收放：选项栏空着就展开、选项回来就收起。那是因为
   * 两个操作台（剧情选项 / 轮盘）都长在正文下面抢同一块地方，必须替玩家分个先后。
   * 现在轮盘挪进了右侧状态栏，不跟正文抢位置了，这套自动逻辑就只剩坏处 ——
   * 它会在玩家没动过手的情况下把他的选择掰回去。点开就开着，点收就收着。
   */

  /**
   * 特写盖住屏幕的时候，打字机先停一拍。
   *
   * 「領域展開」那 2.6 秒是全屏的，正文要是在背后照常吐，等特写撤掉，
   * 玩家看到的已经是半句话的尾巴 —— 最该看的那几个字正好错过。
   * 按住不丢字，只是把节奏让给演出。
   */
  useEffect(() => {
    tw.hold(cutins.length > 0)
    return () => tw.hold(false)
  }, [cutins.length, tw.hold])

  // ---------------------------------------------------------- 渲染

  /**
   * 出错不再整屏接管。
   *
   * 原来 error 一旦有值就把整个界面换成一张"出错了"的卡片 —— 打着打着模型
   * 抖一下，正文、行动栏、角色数值全部消失，只剩一个"知道了"。玩家点掉之后
   * 还得靠 resync 把现场拼回来，拼不回来就卡死。改成一条角落里的横幅：
   * 说清楚出了什么事，但手里的局面一直在。
   */
  const errBanner = error ? (
    <div className="err-banner" role="alert">
      <span className="eb-mark">!</span>
      <span className="eb-text">{error}</span>
      <button className="eb-close" onClick={() => setError(null)} aria-label="关闭">×</button>
    </div>
  ) : null

  /**
   * 开局那几屏没有顶栏，本来是一条道走到黑 —— 选错了故事线、掷出三份都不想要的
   * 属性，只能硬着头皮往下点。给一个统一的出口，撤回主页再来。
   */
  const homeLink = (
    <button className="home-link" onClick={goHome} disabled={busy}>
      ← 返回主页
    </button>
  )

  if (phase === 'start') {
    return (
      <div className="pick">
        {/* 开局这几屏没有顶栏，但开局生成是最花钱的一步，用量表得跟着走 */}
        <div className="meter-fixed"><UsageMeter usage={usage} /></div>
        {errBanner}
        <div className="pick-inner">
          <h1>回战 · 宿傩篇</h1>
          <div className="sub">2018 年 6 月 · 虎杖悠仁吞下第一根宿傩手指</div>
          <div className="cards">
            <div className="pcard">
              <h2>开局</h2>
              <div className="tech">穿越者模拟</div>
              <div className="tech-eff">
                引擎将掷出三份属性档案与三份身份档案，由你各自三选一，
                组合成最终角色后直接切入主线。
              </div>
              <div className="divider" />
              <div className="kv"><span>数值</span><span>引擎计算，AI 不参与</span></div>
              <div className="kv"><span>叙事</span><span>AI 实时推演</span></div>
              {/*
                有局在手就先给「继续上次」——从主页回来的人第一眼要找的就是它。
                只有 开局 / 读取存档 的话，玩家会以为刚才那局被扔掉了。
              */}
              {sessionId && (
                <button
                  className="pick-btn"
                  onClick={() => setResumeTick((v) => v + 1)}
                  disabled={busy}
                >
                  继续上次
                </button>
              )}
              <button
                className="pick-btn"
                style={sessionId ? { marginTop: 7, borderColor: 'var(--line)', color: 'var(--ink-dim)' } : undefined}
                onClick={boot}
                disabled={busy}
              >
                {busy ? '正在掷骰…' : '开始生成'}
              </button>
              <button
                className="pick-btn"
                style={{ marginTop: 7, borderColor: 'var(--line)', color: 'var(--ink-dim)' }}
                onClick={() => setShowSaves(true)}
                disabled={busy}
              >
                读取存档
              </button>
              {/*
                清空数据。放在最下面、颜色最暗 —— 它是这一屏唯一不可逆的操作。
                点一次只把确认条亮出来：直接删的话，误触一下就是几十回合没了。
              */}
              {!wipeAsk ? (
                <button
                  className="pick-btn wipe-btn"
                  onClick={() => { setWipeAsk(true); setWipeDone(null) }}
                  disabled={busy}
                >
                  清空全部数据
                </button>
              ) : (
                <div className="wipe-ask">
                  <div className="wipe-note">
                    进行中的局面和全部存档都会删掉，不能撤销。没存过档的那一局会直接消失。
                  </div>
                  <div className="wipe-row">
                    <button className="pick-btn wipe-ok" onClick={wipeAll} disabled={wiping || busy}>
                      {wiping ? '正在清空…' : '确认清空'}
                    </button>
                    <button
                      className="pick-btn wipe-cancel"
                      onClick={() => setWipeAsk(false)}
                      disabled={wiping}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {wipeDone && <div className="wipe-done">{wipeDone}</div>}
            </div>
          </div>
          {busy && (
            <div className="loading">
              <div className="spinner" />
              正在生成三份属性档案，大约需要十几秒…
            </div>
          )}
        </div>
        {showSaves && (
          <SaveModal
            sessionId={sessionId}
            onLoad={onLoadSave}
            onClose={() => setShowSaves(false)}
          />
        )}
      </div>
    )
  }

  // 第零步：故事线
  if (phase === 'storyline') {
    return (
      <div className="pick">
        <div className="meter-fixed"><UsageMeter usage={usage} /></div>
        {errBanner}
        <div className="pick-inner">
          {homeLink}
          <h1>选择故事线</h1>
          <div className="sub">
            先定玩法，再选线 —— 选定后才会掷属性与身份
          </div>

          <PlayModePicker modes={playModes} value={playMode} onChange={setMode} />
          <div className="cards">
            {storylines.map((s) => (
              <StorylineCard key={s.id} s={s} onPick={pickStoryline} busy={busy} />
            ))}
          </div>
          {busy && (
            <div className="loading">
              <div className="spinner" />
              正在掷出属性档案…
            </div>
          )}
        </div>
      </div>
    )
  }

  // 第三步：穿越时间
  if (phase === 'time') {
    return (
      <div className="pick">
        <div className="meter-fixed"><UsageMeter usage={usage} /></div>
        {errBanner}
        <div className="pick-inner">
          {homeLink}
          <h1>第三步 · 穿越时间</h1>
          <div className="sub">
            你在这个世界醒来的时刻 —— 决定哪些原作事件已成定局、哪些还来得及改变
          </div>
          <div className="cards">
            {/* 自定义那份单独用 CustomTimeCard 渲染，不重复出卡 */}
            {timeProfiles.filter((p) => p.id !== '自定义').map((p) => (
              <TimeCard key={p.id} p={p} onPick={pickTime} busy={busy} />
            ))}
            <CustomTimeCard
              brief={customBrief}
              setBrief={setCustomBrief}
              generated={customTime}
              onGenerate={generateCustomT}
              onPick={pickTime}
              busy={busy}
            />
          </div>
          {busy && (
            <div className="loading">
              <div className="spinner" />
              正在生成开局情境…
            </div>
          )}
        </div>
      </div>
    )
  }

  if (phase === 'attributes' || phase === 'identity') {
    const list = phase === 'attributes' ? attrProfiles : identProfiles
    return (
      <div className="pick">
        <div className="meter-fixed"><UsageMeter usage={usage} /></div>
        {errBanner}
        <div className="pick-inner">
          {homeLink}
          <h1>{phase === 'attributes' ? '第一步 · 属性' : '第二步 · 身份'}</h1>
          <div className="sub">
            {phase === 'attributes'
              ? '三份由引擎掷出；想要自己定数值，用下面的「自主定义」'
              : '属性已锁定。三份身份 + 自定义，或者干脆以「突然出现的人」进场'}
          </div>
          <div className="cards">
            {/* 预设的三份里不含"自定义"（它可能还没生成） */}
            {list.filter((p) => p.slot !== '自定义').map((p) =>
              phase === 'attributes' ? (
                <AttributeCard key={p.slot} p={p} onPick={pickAttribute} busy={busy} />
              ) : (
                <IdentityCard key={p.slot} p={p} onPick={pickIdentity} busy={busy} />
              ),
            )}

            {/* 第四项：自主定义 */}
            <CustomCard
              kind={phase === 'attributes' ? 'attribute' : 'identity'}
              brief={customBrief}
              setBrief={setCustomBrief}
              generated={phase === 'attributes' ? customAttr : customIdent}
              onGenerate={() => generateCustom(phase === 'attributes' ? 'attribute' : 'identity')}
              onReroll={() => generateCustom(phase === 'attributes' ? 'attribute' : 'identity')}
              onTune={tuneCustomAttr}
              onPick={pickCustom}
              busy={busy}
            />

            {/*
              第五项：突然出现的人。只在身份这一步出现 ——
              它是个身份，不是属性，不该在第一步占一个格子。
            */}
            {phase === 'identity' && (
              <SuddenArrivalCard
                name={suddenName}
                setName={setSuddenName}
                age={suddenAge}
                setAge={setSuddenAge}
                brief={suddenBrief}
                setBrief={setSuddenBrief}
                onSudden={submitSudden}
                busy={busy}
              />
            )}
          </div>
          {busy && (
            <div className="loading">
              <div className="spinner" />
              推演中…
            </div>
          )}
        </div>
      </div>
    )
  }

  /*
   * 震屏挂在整块界面上，不是挂在演出层上 —— 只有背景在闪的话，
   * 那是"屏幕上蒙了一层东西"，不是"这一下打在这间屋子里"。
   *
   * 值里带 seq 的奇偶：连着两记重击时把动画名换成另一条同款的，
   * 否则类名不变，第二下不会重播。擦到（graze）不震 ——
   * 每一下都震的话，震本身就不值钱了。
   */
  const shake = impact?.level === 'brutal' ? 'hard' : impact?.level === 'heavy' ? 'soft' : null
  const shakeAttr = shake ? `${shake}-${impact.seq % 2}` : undefined

  return (
    <div className="shell" data-shake={shakeAttr}>
      <div className="topbar">
        <UsageMeter usage={usage} />
        <span className="brand">回战 <em>·</em> 宿傩篇</span>
        {panel?.time && <span className="date">{panel.time.date}　第 {panel.time.day} 天</span>}
        <span className="spacer" />
        {panel?.grade && <span className="date">{panel.grade}</span>}
        <button
          className="mode-badge"
          onClick={togglePlayMode}
          title="点击切换游玩模式"
        >
          {/* 模式列表还没拉回来时也别谎报成"剧情向" —— 战斗向的玩家会看到错的 */}
          {playModes.find((m) => m.id === playMode)?.name
            || (playMode === 'combat' ? '战斗向' : '剧情向')}
        </button>
        <button className="top-btn" onClick={openCrossover} title="跨越两篇之间的时间空白">跨篇</button>
        <button className="top-btn" onClick={() => setShowSaves(true)}>存档</button>
        {/* 回主页不是结束这一局：进度在服务端，回来点「继续上次」就接着走 */}
        <button
          className="top-btn"
          onClick={goHome}
          disabled={busy}
          title={busy ? '这一回合还在生成…' : '回到主页（进度已自动保存）'}
        >
          主页
        </button>
        <button className="top-btn only-narrow" onClick={() => { setShowCombat((v) => !v); setShowSide(false) }}>
          战斗
        </button>
        <button className="top-btn only-narrow" onClick={() => { setShowSide((v) => !v); setShowCombat(false) }}>
          状态
        </button>
      </div>

      <CombatSidebar panel={panel} liveCombat={liveCombat} busy={busy} open={showCombat} fx={fx} />

      <div className="main">
        <NarrativeLog
          entries={entries}
          streaming={tw.shown}
          busy={busy && tw.shown === null}
          liveCombat={liveCombat}
          onSkip={tw.skip}
        />

        {/*
          战斗向的日常轮盘现在长在右侧状态栏里（见下面 .side），
          不再占正文和选项之间的位置 —— 那一栏要留给最该读的东西。
        */}

        {liveCombat?.mode === 'manual' && liveCombat.actions?.length ? (
          <ActionBar
            actions={liveCombat.actions}
            freeActions={freeActions}
            onAct={(type, opts) => (opts?.free ? doFreeAction(type) : doAction(type))}
            disabled={busy}
          />
        ) : (
          <ChoiceList
            choices={choices}
            recap={recap}
            onPick={onPick}
            disabled={busy || tw.shown !== null || !!liveCombat}
          />
        )}
      </div>

      <div className={`side${showSide ? ' open' : ''}`}>
        {/*
          日常轮盘（仅战斗向）。放在状态栏最上面是因为它是这一栏里唯一
          **能按**的东西 —— 下面几张都是读数的。默认收成一条窄条，点开才展开。

          打起来之后也**不摘掉**。原来这里挂着 !liveCombat / !pending，
          那是它还在正文里时的规矩 —— 那会儿战斗面板要占走那一栏，收走是对的。
          搬进状态栏之后再收，就只剩"轮盘凭空消失了"：玩家正打着，眼角那
          一行「距「涩谷事变」还有 12 天」没了，还以为玩法坏了。
          按不按得动交给闸门说（wheelGate 会给出「战斗还没打完」），
          但"还有几天到下一个节点"这句读数在打架的时候照样是玩家要看的。
        */}
        {playMode === 'combat' && wheel && (
          <WheelPanel
            wheel={wheel}
            gate={wheelGate}
            busy={busy || tw.shown !== null}
            onSpin={() => doWheel('spin')}
            onAdvance={() => doWheel('advance')}
            open={wheelOpen}
            onToggle={() => setWheelOpen((v) => !v)}
          />
        )}
        <StatusPanel panel={panel} onEdit={() => setEditOpen(true)} />
        <GrowthPanel rows={growth} training={panel?.training} days={wheel?.days} />
        <RelationPanel relations={panel?.relations} />
        <SukunaPanel sukuna={panel?.sukuna} />
        {/* 战果压在时间线上面：打完一场先看战果，再看它动了哪一天 */}
        <BattleLogPanel battles={panel?.battles} />
        <TimelinePanel timeline={panel?.timeline} />
        <button className="top-btn only-narrow" style={{ width: '100%', marginTop: 4 }} onClick={() => setShowSide(false)}>
          收起状态栏
        </button>
      </div>

      {(showSide || showCombat) && (
        <div className="side-scrim" onClick={() => { setShowSide(false); setShowCombat(false) }} />
      )}

      {xoOpen && xo && (
        <CrossoverScreen
          data={xo}
          step={xoStep}
          lastResult={xoLast}
          onChoose={advanceCrossover}
          onClose={() => setXoOpen(false)}
          busy={busy}
        />
      )}

      {showSaves && (
        <SaveModal sessionId={sessionId} onLoad={onLoadSave} onClose={() => setShowSaves(false)} />
      )}

      {editOpen && panel && (
        <EditPlayerModal
          panel={panel}
          onClose={() => setEditOpen(false)}
          onSave={async (numbers) => {
            const r = await api.editPlayer(sessionId, numbers)
            /*
             * 改完立刻重同步：面板上差不多每一项都跟着变了
             * （等级、领域档位、术式消耗都是派生量），
             * 靠本地改一改拼出新面板只会拼出半份。
             */
            await resync()
            return r
          }}
        />
      )}

      {/* 演出层：领域展开过场、数值跳动的轻提示。挂在最外层，覆盖整屏 */}
      <Impact data={impact} />
      <DomainCutin data={cutins[0] || null} onDone={() => setCutins((q) => q.slice(1))} />
      <Toasts items={toaster.items} onClose={toaster.remove} />
      {errBanner}

      {/* 遭遇战与修炼都不再弹窗，改成日志里的询问块 + 底部选项栏 */}
    </div>
  )
}
