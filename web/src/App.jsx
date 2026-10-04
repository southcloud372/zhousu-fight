import React, { useCallback, useEffect, useState } from 'react'
import * as api from './api.js'
import {
  AttributeCard, IdentityCard, CustomCard, TimeCard, CustomTimeCard, StorylineCard, PlayModePicker,
} from './components/Cards.jsx'
import { NarrativeLog, ChoiceList, useTypewriter } from './components/Narrative.jsx'
import { StatusPanel, RelationPanel, SukunaPanel, TimelinePanel } from './components/Panels.jsx'
import { ActionBar } from './components/CombatPanel.jsx'
import { SaveModal } from './components/SaveModal.jsx'
import { CombatSidebar } from './components/CombatSidebar.jsx'
import { CrossoverScreen, CrossoverResult } from './components/Crossover.jsx'
import { UsageMeter } from './components/UsageMeter.jsx'

/** 存档里的 log 还原成界面条目 */
function entriesFromLog(log) {
  return (log || []).map((e) =>
    e.type === 'training'
      ? { kind: 'training', ...e }
      : { kind: 'turn', turn: e.turn, narration: e.narration, recap: e.recap, dialogue: e.dialogue, notes: e.notes },
  )
}

export default function App() {
  const [phase, setPhase] = useState('start') // start | attributes | identity | playing
  const [sessionId, setSessionId] = useState(null)
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
  const [showSide, setShowSide] = useState(false) // 窄屏时右侧状态栏抽屉
  const [showCombat, setShowCombat] = useState(false) // 中等宽度时左侧战斗栏抽屉
  // 自主定义：玩家自己写的那份，以及重掷前的输入
  const [customBrief, setCustomBrief] = useState('')
  const [customAttr, setCustomAttr] = useState(null)
  const [customIdent, setCustomIdent] = useState(null)
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

  // 打字机：把成块到达的文字按节奏吐出来，而不是一块块往外蹦
  const tw = useTypewriter()

  // 战斗面板要等下一块面板到了才能归档（那时才拿到这一回合的完整演出）
  const livePanelRef = React.useRef(null)

  const onLoadSave = useCallback((r) => {
    try { localStorage.setItem('sunuo:session', r.sessionId) } catch {}
    setSessionId(r.sessionId)
    setEntries(entriesFromLog(r.log))
    setRecap(r.recap || '')
    setChoices(r.choices || [])
    setPanel(r.panel)
    askCombatEnter(r.combat)
    takeUsage(r.usage)
    setLiveCombat(null)
    livePanelRef.current = null
    tw.reset()
    setShowSaves(false)
    setPhase('playing')
  }, [tw])

  /** 任何响应里带了 usage 就更新计量表 */
  const takeUsage = useCallback((u) => { if (u) setUsage(u) }, [])

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
          askCombatEnter(r.combat)
          if (r.inCombat) {
            setLiveCombat({ mode: r.inCombat.mode, panel: r.inCombat.panel, narration: '', actions: r.inCombat.actions })
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
        // 会话已失效（存档被清过），安静地回到开始界面
        try { localStorage.removeItem('sunuo:session') } catch {}
      }
    })()
    return () => { cancelled = true }
  }, [takeUsage])


  /**
   * 遭遇战不再弹窗，而是在对话流里插一块询问，选项走底部那一栏。
   * 第一次问「要不要打」（可以逃），选了迎战再问用哪种战斗模式。
   */
  const askCombatEnter = useCallback((pc) => {
    setPending(pc || null)
    if (!pc) return
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

  const pickIdentity = useCallback(async (slot) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.chooseIdentity(sessionId, slot)
      takeUsage(res.usage)
      setTimeProfiles(res.times || [])
      setCustomBrief('') // 换阶段了，清掉上一阶段的输入
      setPhase('time')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [sessionId])

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

  // ---------------------------------------------------------- 回合

  const submit = useCallback(async (text, { silent = false } = {}) => {
    setBusy(true)
    setError(null)
    tw.begin()
    setChoices([])
    if (!silent) setEntries((prev) => [...prev, { kind: 'player', text }])

    let acc = ''
    tw.begin()
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
      onPanel: ({ panel: cp }) => {
        archiveLive()
        livePanelRef.current = { panel: cp, narration: '' }
        setLiveCombat({ mode, panel: cp, narration: '', actions: null })
      },
      onAwaiting: ({ actions }) => applyActions(actions),
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
          if (data.snapshot) setPanel(data.snapshot) // 角色快照，不是战斗回合面板
          setBusy(false)
          return
        }
        // 打完了
        if (mode !== 'manual' && acc) {
          setEntries((prev) => [...prev, { kind: 'turn', narration: acc, dialogue: [], notes: [] }])
        }
        archiveLive()
        setLiveCombat(null) // 收工时整块清掉，streaming 标志随之消失
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
  }, [sessionId, submit, archiveLive, resync, applyActions, takeUsage, tw])

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
    setLiveCombat((prev) => (prev ? { ...prev, actions: null, narration: '' } : prev))

    await api.combatAction(sessionId, type, {
      onPanel: ({ panel: cp }) => {
        archiveLive()
        livePanelRef.current = { panel: cp, narration: '' }
        setLiveCombat((prev) => (prev ? { ...prev, panel: cp, narration: '' } : { mode: 'manual', panel: cp, narration: '', actions: null }))
      },
      onNarration: (t) => {
        acc += t
        if (livePanelRef.current) livePanelRef.current.narration = acc
        setLiveCombat((prev) => (prev ? { ...prev, narration: acc, streaming: true } : prev))
      },
      onDone: (data) => {
        takeUsage(data.usage)
        if (!data.over) {
          setLiveCombat((prev) => (prev ? { ...prev, streaming: false } : prev))
          applyActions(data.actions)
          setPanel(data.panel)
          setBusy(false)
          return
        }
        archiveLive()
        setLiveCombat(null) // 收工时整块清掉，streaming 标志随之消失
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
  }, [sessionId, submit, archiveLive, resync, applyActions, takeUsage, tw])

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

    // 自己写的行动要带标记 —— 模型得能分辨"玩家点了选项"和"玩家自己写了指令"，
    // 后者在契约里是最高优先级
    const isCustom = choice.id === 'free'
    submit(isCustom ? `【我的行动】${choice.label}` : choice.label)
  }, [sessionId, submit, askCombatMode, tryEvade, startCombat, doTraining])

  /** 开局后也能换模式 —— 点顶栏那个徽章即可 */
  const togglePlayMode = useCallback(async () => {
    const next = playMode === 'combat' ? 'story' : 'combat'
    setMode(next) // 先改本地，界面立刻响应
    try {
      await api.setPlayMode(sessionId, next)
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


  // ---------------------------------------------------------- 渲染

  if (error) {
    return (
      <div className="err">
        <b>出错了</b>
        {error}
        <button className="choice" style={{ marginTop: 14 }} onClick={() => setError(null)}>知道了</button>
      </div>
    )
  }

  if (phase === 'start') {
    return (
      <div className="pick">
        {/* 开局这几屏没有顶栏，但开局生成是最花钱的一步，用量表得跟着走 */}
        <div className="meter-fixed"><UsageMeter usage={usage} /></div>
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
              <button className="pick-btn" onClick={boot} disabled={busy}>
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
        <div className="pick-inner">
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
        <div className="pick-inner">
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
        <div className="pick-inner">
          <h1>{phase === 'attributes' ? '第一步 · 属性' : '第二步 · 身份'}</h1>
          <div className="sub">
            {phase === 'attributes'
              ? '三份档案数值由引擎掷出，只在此处区分战斗风格'
              : '属性已锁定，三份身份只在背景、关系与处境上区分'}
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
              onPick={pickCustom}
              busy={busy}
            />
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

  return (
    <div className="shell">
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
        <button className="top-btn only-narrow" onClick={() => { setShowCombat((v) => !v); setShowSide(false) }}>
          战斗
        </button>
        <button className="top-btn only-narrow" onClick={() => { setShowSide((v) => !v); setShowCombat(false) }}>
          状态
        </button>
      </div>

      <CombatSidebar panel={panel} liveCombat={liveCombat} busy={busy} open={showCombat} />

      <div className="main">
        <NarrativeLog
          entries={entries}
          streaming={tw.shown}
          busy={busy && tw.shown === null}
          liveCombat={liveCombat}
        />

        {liveCombat?.mode === 'manual' && liveCombat.actions?.length ? (
          <ActionBar actions={liveCombat.actions} onAct={doAction} disabled={busy} />
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
        <StatusPanel panel={panel} />
        <RelationPanel relations={panel?.relations} />
        <SukunaPanel sukuna={panel?.sukuna} />
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

      {/* 遭遇战与修炼都不再弹窗，改成日志里的询问块 + 底部选项栏 */}
    </div>
  )
}
