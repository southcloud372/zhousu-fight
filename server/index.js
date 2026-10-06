import 'dotenv/config'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { streamTool, streamText, models } from './llm.js'
import { makeRng } from './engine/dice.js'
import { blankState, applyProposal, panelSnapshot, modelStateView } from './engine/state.js'
import { scrubTurn, clampProposal, noteNarrationLeak, hasLethalIntent } from './engine/guard.js'
import { applyCanon } from './engine/canon.js'
import {
  generateAttributeProfiles, generateIdentityProfiles, buildCharacterAndOpening,
  generateCustomAttribute, generateCustomIdentity, rollTimeProfiles, generateCustomTime,
  flavorAttributeProfile,
} from './engine/opening.js'
import { CORE_RULES, CONTRACT, turnStatePrompt, suddenArrivalRulesFor } from './prompts.js'
import { accumulate, usageSnapshot, estimateTokens } from './pricing.js'
import { submitTurnFor } from './engine/schemas.js'
import { NARRATION_MIN, visibleLength, overflowBy, clampNarration } from './engine/narration.js'
import { rollEnemy, tuneAttributeProfile, suddenArrivalIdentity } from './engine/rolls.js'
import { tunePlayer } from './engine/editor.js'
import { byId, pointsFor, initialNodes, nextMilestone } from './engine/timeline.js'
import { DEFAULT_STORYLINE, STORYLINES, storylineBriefs, storylineOf } from './engine/storylines.js'
import { wipeLocalData, WIPE_CONFIRM } from './engine/wipe.js'
import { PLAY_MODES, playModeOf, playModeBriefs, DEFAULT_PLAY_MODE } from './engine/playmodes.js'
import { canTrain, rollTraining, applyTraining, TRAINING_TABLE } from './engine/commands.js'
import {
  stagesFor, FOCUSES, focusById, rollStage, applyStage, completeCrossover, crossoverReady,
} from './engine/crossover.js'
import {
  COMBAT_MODES, MODE_LABELS, initCombat, runRound, simulateCombat,
  summarizeRounds, computeRewards, applyRewards, finishCombat,
  buildPanel, renderPanelText, unitSpeed, freeReverse, reversePreview, FREE_REVERSE_PER_ROUND,
} from './engine/combat.js'
import {
  wheelSnapshot, spinWheel, advanceToMilestone, startIntervention,
  WHEEL_SECTORS, MAX_DAYS_PER_CALL,
} from './engine/wheel.js'
import { recoveryOptions, applyRecovery, needsRecovery } from './engine/recovery.js'
import { normalizeDomainType, sealOf } from './engine/domains.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SAVE_DIR = path.join(HERE, 'saves')
fs.mkdirSync(SAVE_DIR, { recursive: true })

const app = express()
app.use(express.json({ limit: '2mb' }))

// ---------------------------------------------------------------- 会话

const sessions = new Map()

function savePath(id) {
  return path.join(SAVE_DIR, `${id}.json`)
}

function persist(state) {
  fs.mkdirSync(SAVE_DIR, { recursive: true })
  fs.writeFileSync(savePath(state.id), JSON.stringify(state, null, 2), 'utf8')
}

function load(id) {
  if (sessions.has(id)) return sessions.get(id)
  const f = savePath(id)
  if (!fs.existsSync(f)) return null
  const state = JSON.parse(fs.readFileSync(f, 'utf8'))
  sessions.set(id, state)
  return state
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/**
 * 把某次调用的用量记到这一局账上。
 * 每个调用点都要接 —— 包括后台跑的编年史压缩和失败重试的每一次，
 * 那些也是真花钱的，漏掉账就不准了。
 */
function meter(state, model) {
  return (usage) => {
    state.usage = accumulate(state.usage, usage, model)
  }
}

/** 所有返回给前端的响应都带上当前累计用量 */
const withUsage = (state, payload) => ({ ...payload, usage: usageSnapshot(state.usage) })

// ---------------------------------------------------------------- 开局

/** 可选故事线（开局第一屏用） */
app.get('/api/play-modes', (req, res) => {
  res.json({ modes: playModeBriefs(), default: DEFAULT_PLAY_MODE })
})

app.get('/api/storylines', (req, res) => {
  res.json({ storylines: storylineBriefs() })
})

app.post('/api/session', (req, res) => {
  const rng = makeRng()
  // 默认开宿傩篇；故事线由第一屏选定后可以用 choose-storyline 改
  const state = blankState(rng, DEFAULT_STORYLINE)
  state.id = crypto.randomUUID().slice(0, 8)
  state.rngSeed = state.seed
  state.phase = 'storyline'
  sessions.set(state.id, state)
  persist(state)
  res.json({ sessionId: state.id, phase: state.phase, storyline: state.storyline })
})

/**
 * 选定故事线。
 *
 * 必须在生成任何档案之前定下来 —— 原作节点表、可交互角色、穿越时间候选
 * 全部由它决定。换线等于重开一局，所以这里会把已生成的内容清掉。
 */
app.post('/api/session/:id/choose-storyline', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const id = String(req.body?.id || '')
  const line = STORYLINES[id]
  if (!line) return res.status(400).json({ error: '未知的故事线' })
  // 游玩模式和故事线在同一屏选，一起提交
  const mode = String(req.body?.playMode || '')
  if (mode && PLAY_MODES[mode]) state.playMode = mode
  if (state.attributeProfiles?.length && state.storyline !== id) {
    return res.status(409).json({ error: '已经生成过档案了，换线请重新开一局' })
  }

  state.storyline = id
  state.timeline.nodes = initialNodes(id)
  state.time.date = line.startDate
  state.phase = 'attributes'
  persist(state)
  res.json(withUsage(state, { storyline: id, startDate: line.startDate }))
}))

app.post('/api/session/:id/attributes', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const rng = makeRng(state.seed + state.turn)
  const profiles = await generateAttributeProfiles(rng, { onUsage: meter(state, models.pro) })
  state.attributeProfiles = profiles
  state.phase = 'identities-pending'
  persist(state)
  res.json(withUsage(state, { profiles }))
}))

/**
 * 自主定义属性：玩家写一段想要的风格，引擎重掷数值，模型按描述生成术式。
 * 生成的档案存进 attributeProfiles，之后走和 A/B/C 完全相同的选定流程。
 */
app.post('/api/session/:id/attributes/custom', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const brief = String(req.body?.brief || '').trim().slice(0, 500)
  if (brief.length < 2) return res.status(400).json({ error: '请先描述你想要的战斗风格' })

  const rng = makeRng(state.seed + state.turn + brief.length * 7)
  const profile = await generateCustomAttribute(rng, brief, { onUsage: meter(state, models.pro) })

  // 替换掉上一次的自定义档案，避免反复重掷时越堆越多
  state.attributeProfiles = [
    ...state.attributeProfiles.filter((p) => p.slot !== '自定义'),
    profile,
  ]
  persist(state)
  res.json(withUsage(state, { profile }))
}))

/**
 * 调数值：玩家在自定义属性卡上逐项改数字。
 *
 * 等级由数字反推（见 rolls.js 的 tuneAttributeProfile），所以这里不需要模型参与 ——
 * 除非改动的结果**跨进了特级**：那一档开局自带领域，而领域名/必中/代价
 * 是模型的活。不补这一步，玩家就会带着一个"未命名领域"进游戏。
 */
app.post('/api/session/:id/attributes/custom/tune', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })

  const cur = (state.attributeProfiles || []).find((p) => p.slot === '自定义')
  if (!cur) return res.status(400).json({ error: '还没有自定义档案可以调，先生成一份' })

  const next = tuneAttributeProfile(cur, req.body?.numbers || {})

  /*
   * 只在"领域刚觉醒、还没有名字"时问模型。
   * 每次拖一下滑块都打一次模型，既慢又费钱，而绝大多数调整（加血、加伤害）
   * 根本不改变领域的存在与否。
   */
  const needDomain = next.domainUnlocked && !next.domain?.name
  const profile = needDomain
    ? await flavorAttributeProfile(next, cur.brief || '', {
        onUsage: meter(state, models.pro),
        playerTuned: true,
      })
    : next

  state.attributeProfiles = [
    ...state.attributeProfiles.filter((p) => p.slot !== '自定义'),
    profile,
  ]
  persist(state)
  res.json(withUsage(state, { profile }))
}))

/** 自主定义身份：同理，模型自己判定身份类型，引擎据此重掷关系值 */
app.post('/api/session/:id/identities/custom', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const brief = String(req.body?.brief || '').trim().slice(0, 500)
  if (brief.length < 2) return res.status(400).json({ error: '请先描述你想要的背景' })

  const rng = makeRng(state.seed + state.turn + brief.length * 13)
  const identity = await generateCustomIdentity(rng, brief, { onUsage: meter(state, models.pro), storyline: state.storyline })

  state.identityProfiles = [
    ...state.identityProfiles.filter((p) => p.slot !== '自定义'),
    identity,
  ]
  persist(state)
  res.json(withUsage(state, { identity }))
}))

/**
 * 第五个身份：「突然出现的人」。
 *
 * **不走模型**，是有意的。这个身份的全部价值就是它是空白的 ——
 * 让模型写背景，它一定会补出"你其实是XX的亲戚""你身上有宿傩的另一根手指"
 * 这类设定，那就又变回预设身份了，玩家要的"没有身份"当场作废。
 * 所以这里只有玩家自己填的名字和一句话，其余交给开局情境现场发挥。
 * 顺带也没有 token 开销，点一下就到。
 */
app.post('/api/session/:id/identities/sudden', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (!state.identityProfiles?.length) {
    return res.status(409).json({ error: '还没到选身份这一步' })
  }

  const identity = suddenArrivalIdentity({
    name: req.body?.name,
    age: req.body?.age,
    brief: String(req.body?.brief || '').trim().slice(0, 500),
  }, state.storyline)

  state.identityProfiles = [
    ...state.identityProfiles.filter((p) => p.slot !== identity.slot),
    identity,
  ]
  persist(state)
  res.json({ identity })
})

/** 全部可选时间点（自主定义穿越时间时给玩家做参考） */
app.get('/api/time-points', (req, res) => {
  const sid = String(req.query.storyline || DEFAULT_STORYLINE)
  res.json({ points: pointsFor(sid).map(({ id, date, label, when, dangerLabel }) => ({ id, date, label, when, dangerLabel })) })
})

app.post('/api/session/:id/choose-attributes', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const { slot } = req.body || {}
  const picked = state.attributeProfiles.find((p) => p.slot === slot)
  if (!picked) return res.status(400).json({ error: '档案不存在' })

  state.chosenAttributeSlot = slot
  const rng = makeRng(state.seed + 1000 + state.turn)
  const identities = await generateIdentityProfiles(rng, { onUsage: meter(state, models.pro), storyline: state.storyline })
  state.identityProfiles = identities
  state.phase = 'identity'
  persist(state)
  res.json(withUsage(state, { identities }))
}))

app.post('/api/session/:id/choose-identity', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const { slot } = req.body || {}
  const attr = state.attributeProfiles.find((p) => p.slot === state.chosenAttributeSlot)
  const ident = state.identityProfiles.find((p) => p.slot === slot)
  if (!attr || !ident) return res.status(400).json({ error: '档案不存在' })

  state.chosenIdentitySlot = slot
  // 第三步：穿越时间。开局情境要等时间点定了才生成 ——
  // 同一个角色穿到 6 月和穿到涩谷事变，开局处境完全不是一回事。
  const times = rollTimeProfiles(makeRng(state.seed + 991), state.storyline)
  state.timeProfiles = times
  state.phase = 'time'
  persist(state)

  res.json(withUsage(state, { times }))
}))

/** 自主定义穿越时间：玩家写想穿到什么时候，模型解析成合法时间点 */
app.post('/api/session/:id/time/custom', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const brief = String(req.body?.brief || '').trim().slice(0, 300)
  if (brief.length < 2) return res.status(400).json({ error: '请先描述你想穿越到的时机' })

  const point = await generateCustomTime(brief, { onUsage: meter(state, models.pro), storyline: state.storyline })
  // 替换上一次的自定义时间点，避免反复重掷越堆越多
  state.timeProfiles = [
    ...(state.timeProfiles || []).filter((t) => t.id !== '自定义'),
    point,
  ]
  persist(state)
  res.json(withUsage(state, { point }))
}))

/** 随时切换游玩模式 */
app.post('/api/session/:id/play-mode', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const mode = String(req.body?.mode || '')
  if (!PLAY_MODES[mode]) return res.status(400).json({ error: '未知的游玩模式' })
  state.playMode = mode
  persist(state)
  res.json(withUsage(state, { playMode: mode }))
})

/** 第三步：选定穿越时间 → 组合最终档案 → 生成开局情境 */
app.post('/api/session/:id/choose-time', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const { id } = req.body || {}
  const attr = state.attributeProfiles.find((p) => p.slot === state.chosenAttributeSlot)
  const ident = state.identityProfiles.find((p) => p.slot === state.chosenIdentitySlot)
  if (!attr || !ident) return res.status(400).json({ error: '前置档案不存在' })

  // 从这一局自己的候选里找 —— 自定义那份只存在于 state 里，不在全局表
  const point = (state.timeProfiles || []).find((t) => t.id === id) || byId(id, state.storyline)
  if (!point) return res.status(400).json({ error: '未知的穿越时间' })

  state.chosenTimeId = id
  state.turn = 1 // 先置位，否则 postProcess 写进日志的回合号是 0
  const opening = await buildCharacterAndOpening(state, attr, ident, point, { onUsage: meter(state, models.pro) })

  const cleaned = postProcess(state, opening, { isOpening: true })
  state.phase = 'playing'
  persist(state)

  res.json(withUsage(state, {
    ...cleaned,
    recap: cleaned.recap,
    choices: state.choices,
    panel: panelSnapshot(state),
    // 选战斗向开局的话，第一屏就该看见轮盘倒数
    wheel: state.playMode === 'combat' ? wheelSnapshot(state) : null,
    wheelGate: state.playMode === 'combat' ? wheelGate(state) : null,
    // 成长面板的六行标题。轮盘一转就得出进度条，不能等玩家刷新页面才认得这几行
    growth: state.playMode === 'combat' ? GROWTH_ROWS : null,
    combat: state.pendingCombat,
  }))
}))

// ---------------------------------------------------------------- 回合

/**
 * 所有模型输出都要过这一关：
 * 清洗 NPC 台词里的特级细分 → 夹紧数值提议 → 应用 → 写入日志。
 */
function postProcess(state, raw, { isOpening = false, playerInput = '' } = {}) {
  const leaked = scrubTurn(raw)
  const prop = clampProposal(raw.proposal, state)
  const notes = applyProposal(state, prop)

  if (leaked) notes.push('已拦截 NPC 台词中的特级细分用词')

  const narrationLeaks = noteNarrationLeak(raw.narration)
  if (narrationLeaks.length) notes.push(`旁白使用了细分刻度：${narrationLeaks.join('、')}（合规）`)

  const entry = {
    turn: state.turn,
    narration: raw.narration || '',
    // 选项上方那句概括。模型偶尔会漏，兜底截正文第一句，界面不至于空着
    recap: (typeof raw.recap === 'string' && raw.recap.trim())
      || (raw.narration || '').split(/[。！？\n]/)[0].slice(0, 60),
    dialogue: raw.dialogue || [],
    choices: (raw.choices || []).slice(0, 4),
    notes,
    proposal: prop,
  }

  state.log.push({ type: isOpening ? 'opening' : 'turn', ...entry })
  state.history.push({ role: 'assistant', content: compactForHistory(entry) })
  if (state.history.length > 40) state.history = state.history.slice(-40)

  // 战斗触发：引擎按等级表掷数值，模型只提供名字、术式、领域
  if (raw.combatRequest) {
    const rng = makeRng(state.seed + state.turn * 7)
    const enemy = rollEnemy(rng, raw.combatRequest.enemyGrade)

    enemy.name = raw.combatRequest.enemyName || '咒灵'
    enemy.technique.name = raw.combatRequest.enemyTechniqueName || '未知术式'
    enemy.technique.effect = raw.combatRequest.enemyTechniqueEffect || ''

    /*
     * 原著人物一律按原作表校正：等级、数值、生得术式、领域以表为准，
     * 模型给的名字只决定"谁上场"。
     *
     * 越界限制已经取消 —— 谁想在什么时候打谁就打谁，模型不必再避讳主角团。
     * 代价是自找的：龙级对一级是秒杀，引擎不会为了"合理"偷偷把对手调弱。
     * 表外的人（无名咒灵、路人诅咒师）不受影响，照旧由模型自由发挥。
     */
    const canon = applyCanon(enemy, enemy.name, { storyline: state.storyline, date: state.time.date })
    if (canon) {
      enemy.name = canon.name
      entry.notes.push(`已按原作校正「${canon.name}」${canon.notes.length ? `：${canon.notes.join('、')}` : ''}`)
    }

    // 领域只有特级才有；模型没给名字就留个可辨认的占位
    if (enemy.domain?.unlocked) {
      if (canon?.domain) {
        // 原著人物的领域名不容模型改写 —— 无量空处就是无量空处
        enemy.domain.name = canon.domain.name
      } else {
        enemy.domain.name = raw.combatRequest.enemyDomainName || `${enemy.name}的领域`
        /*
         * 类型允许模型覆盖 rollEnemy 掷出来的那一型（模型更清楚这个敌人
         * 该是什么路数），但认不出来的词一律丢掉 —— 放着它不管，最后会
         * 一路兜成伤害型，等于模型写错一个字就改了整场打法。
         */
        const typed = normalizeDomainType(raw.combatRequest.enemyDomainType)
        if (typed) enemy.domain.type = typed
      }
    } else if (raw.combatRequest.enemyDomainName) {
      // 模型给非特级敌人编了领域 —— 按设定不该有，去掉
      entry.notes.push('非特级敌人不应持有领域，已忽略模型给出的领域名')
    }
    state.pendingCombat = {
      enemy,
      reason: raw.combatRequest.reason,
      mode: null,
      sinceTurn: state.turn,
      // 这一手是不是奔着要命去的 —— 战后结算「击杀」还是「击退」看它（见 combat.js）
      lethalIntent: hasLethalIntent(playerInput),
      // 介入战的节点名由轮盘那条路给（wheel.js 的 startIntervention）；
      // 剧情回合触发的只是遭遇战，打完不改写时间线
      intervention: null,
    }
  }
  // 待结算的遭遇不在这里清 —— 它是"玩家还没决定打不打"，
  // 只能由 /combat/start（迎战）或 /combat/evade（脱离）结清。
  // 详见 state.js 里 applyProposal 的注释。

  // 关键剧情节点当天锁定"跳过修炼"
  const NODE_LOCK = ['少年院任务', '涩谷事变', '死灭回游', '宿傩夺舍']
  state.storyLock = NODE_LOCK.find((n) => entry.proposal.flags.includes(`${n}_开始`)) || null

  // 当前这一批选项跟着状态一起存。
  //
  // 以前 /state 是"回头去 log 里翻最后一条剧情回合"重建选项的 —— 于是
  // 只要在这之后发生了不产生剧情回合的事（转轮盘、修炼、疗伤），刷新页面
  // 就会把**上一场戏**的选项重新摆出来。玩家在战斗向里连转十天轮盘，
  // 一刷新又看见十天前那三个选项，点了还会真的按那句话再演一遍。
  //
  // 有了 pendingCombat 就不给选项：这时该问的是"打不打"，那是前端的询问块。
  state.choices = state.pendingCombat ? [] : withExtras(entry.choices, state)

  return entry
}

/**
 * 选项失效。
 *
 * 任何"不产生剧情回合"的操作（转轮盘、修炼、疗伤、开打、脱离）都该把
 * 手上这批选项作废 —— 场景已经往前走了，还留着上一场的按钮只会让玩家
 * 点到已经不存在的东西。刷新页面也拿不到它们（/state 直接读 state.choices）。
 */
function clearChoices(state) {
  state.choices = []
}

/**
 * 界面此刻该摆哪一批选项。
 *
 * 优先用状态里存着的那一份（postProcess 写的）；只有老存档没这个字段时，
 * 才退回"去 log 里翻最后一条剧情回合"的老办法 —— 那是给已经存下来的进度兜底，
 * 新流程不会再走到那一步。
 */
function liveChoices(state) {
  if (state.phase !== 'playing') return []
  if (Array.isArray(state.choices)) return state.choices
  const lastTurn = [...(state.log || [])].reverse().find((e) => e.type === 'turn' || e.type === 'opening')
  return lastTurn ? withExtras(lastTurn.choices || [], state) : []
}

function compactForHistory(entry) {
  const lines = [entry.narration]
  for (const d of entry.dialogue || []) lines.push(`${d.speaker}：「${d.text}」`)
  return lines.join('\n')
}

app.post('/api/session/:id/turn', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (state.combat && !state.combat.over) {
    return res.status(409).json({ error: '战斗尚未结算，请先打完这一场' })
  }
  const input = String(req.body?.input || '').trim()
  if (!input) return res.status(400).json({ error: '输入为空' })

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const rng = makeRng(state.seed + state.turn * 13)
  state.turn += 1
  state.history.push({ role: 'user', content: input })

  try {
    send('status', { text: '推演中…' })
    // 编年史走 system prompt（见 turnSystem），不要再往 messages 里塞一份，否则重复计费
    const messages = state.history.slice(-16).map((h) => ({ role: h.role, content: h.content }))

    /*
     * 模型偶尔会交回空壳正文；空就重来一次，别让玩家对着一片空白选行动。
     *
     * 战斗向还要多一条重试理由：写超了字数。见 engine/narration.js 的说明 ——
     * 配比管得住"写什么"，管不住"写多少"，写长了打斗就被日常稀释。
     * 长度重写只做一次：再多就是拿玩家的等待和 API 费用换几百字，不划算。
     */
    const cap = playModeOf(state.playMode).narrationCap
    const tool = submitTurnFor(state.playMode)
    let raw = null
    let retryWhy = ''       // 上一轮为什么被打回：'empty' | 'long'
    let lengthRetried = false
    // 越改越长是常事，留一份目前最接近预算的，别让重写把结果变差
    let fallback = null
    let fallbackOver = Infinity
    let streamedText = ''   // 本次流式已产出的正文，用于实时估算
    let lastLiveAt = 0
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      // 每次尝试单独兜错：模型偶尔会交回残缺的 JSON，
      // 重试一次通常就好了，不该让一次解析失败把整个回合打断
      try {
      for await (const ev of streamTool({
        system: turnSystem(state),
        messages: attempt === 0 ? messages : [...messages, ...retryMessages(retryWhy, cap)],
        tool,
        model: models.fast,
        maxTokens: 4000,
        onUsage: meter(state, models.fast),
      })) {
        if (ev.type === 'delta') {
          send('narration', { text: ev.text })
          // 生成过程中给个跳动的估算值，让用量表看起来是"实时"的。
          // 这只是 character→token 的粗估，真正的账以 done 里的 usage 为准。
          streamedText += ev.text
          const now = Date.now()
          if (now - lastLiveAt > 400) {
            lastLiveAt = now
            const snap = usageSnapshot(state.usage)
            send('usage_live', {
              ...snap,
              output: snap.output + estimateTokens(streamedText),
              total: snap.total + estimateTokens(streamedText),
              estimated: true,
            })
          }
        } else if (ev.type === 'done') raw = ev.input
      }
      } catch (err) {
        lastErr = err
        send('status', { text: `本回合生成异常，重试中…（${attempt + 1}/3）` })
        send('reset', {})
        streamedText = ''
        continue
      }

      const empty = !(typeof raw?.narration === 'string' && raw.narration.trim().length >= NARRATION_MIN)
      const over = empty ? 0 : overflowBy(raw, cap)

      // 留档：目前写超得最少的那一份
      if (!empty && over > 0 && over < fallbackOver) {
        fallback = raw
        fallbackOver = over
      }
      if (!empty && !over) break // 合格
      if (attempt >= 2) break

      retryWhy = empty ? 'empty' : 'long'
      // 长度问题只给一次机会，空正文则可以一直试到用完
      if (retryWhy === 'long' && lengthRetried) break
      if (retryWhy === 'long') lengthRetried = true

      // 重试前必须让前端把已收到的半截正文丢掉，否则两次输出会拼在一起。
      // 估算值也要从头算，不然会把上一版的正文也算进去
      send('reset', {})
      send('status', { text: retryWhy === 'empty' ? '正文为空，重试中…' : '写超了字数，正在压短…' })
      streamedText = ''
    }

    // 两次都超预算：用短一点的那一份，别让"重写"把结果变差
    let adjusted = false
    if (retryWhy === 'long' && fallback && overflowBy(raw, cap) > fallbackOver) {
      raw = fallback
      adjusted = true
    }

    // 兜底：到这一步还超，就只能截。截在句号上，不留半句话
    if (cap && raw && typeof raw.narration === 'string') {
      const spoken = visibleLength({ dialogue: raw.dialogue })
      const clipped = clampNarration(raw.narration, Math.max(120, cap - spoken))
      if (clipped !== raw.narration) {
        raw.narration = clipped
        adjusted = true
      }
    }

    /*
     * 服务端改过正文，就得把改完的那一份推给前端。
     *
     * 前端写进日志的是它**流式收到**的文字（见 App.jsx 的 acc），不是服务端
     * 存下来的那一份 —— 不推的话，屏幕上留着长版，存档里是短版，
     * 刷新一次正文就变了样。走 reset + narration 是现成的路子，
     * 重试时本来就用它清掉半截正文。
     */
    if (adjusted) {
      send('reset', {})
      send('narration', { text: raw.narration })
    }

    const entry = postProcess(state, raw, { playerInput: input })
    persist(state)

    send('done', {
      turn: state.turn,
      dialogue: entry.dialogue,
      recap: entry.recap,
      choices: state.choices,
      notes: entry.notes,
      panel: panelSnapshot(state),
      combat: state.pendingCombat,
      // 战斗向：这一轮剧情可能推进了日期，轮盘上"还差几天"要跟着变
      wheel: state.playMode === 'combat' ? wheelSnapshot(state) : null,
      wheelGate: state.playMode === 'combat' ? wheelGate(state) : null,
      freeActions: freeActions(state),
      chronicleReady: state.history.length > HISTORY_LIMIT,
      usage: usageSnapshot(state.usage),
    })

    // 后台压缩历史，不阻塞玩家
    compressHistory(state).catch(() => {})
  } catch (e) {
    send('error', { message: e.message })
  } finally {
    res.end()
  }
}))

/**
 * 长线记忆压缩。
 * 对话历史不能无限增长，否则每回合的输入 token 会线性膨胀。
 * 超过阈值时把最老的一批压缩成编年史，只保留最近若干轮原文。
 * 在回合结束后后台跑，不阻塞玩家。
 */
const HISTORY_LIMIT = 24
const HISTORY_KEEP = 12

async function compressHistory(state) {
  if (state.history.length <= HISTORY_LIMIT) return
  const old = state.history.slice(0, state.history.length - HISTORY_KEEP)
  const recent = state.history.slice(-HISTORY_KEEP)

  const transcript = old
    .map((h) => `${h.role === 'user' ? '玩家行动' : '剧情'}：${h.content}`)
    .join('\n')
    .slice(0, 12000)

  let summary = ''
  try {
    for await (const chunk of streamText({
      system: `你在维护一部《咒术回战》同人文字游戏的编年史。
把给你的剧情片段压缩成简明的编年史，要求：
- 只保留对后续剧情有影响的事实：谁做了什么、发生了什么、立场与关系如何变化、谁受伤或死亡、玩家改变了哪些原作事件。
- 不要文学描写，不要心理活动，不要重复的日常。
- 按时间顺序排列，每条一句话。
- **同一件事反复出现时合并成一条，不要罗列流水账。** 编年史越短越好，控制在 300 字以内。
- 如果给了"先前的提要"，把你的新内容接在它后面，合并成一份完整编年史，不要另起一份。`,
      messages: [{
        role: 'user',
        content: `${state.chronicle ? `先前的提要：\n${state.chronicle}\n\n` : ''}需要压缩的剧情片段：\n${transcript}`,
      }],
      model: models.fast,
      maxTokens: 900,
      onUsage: meter(state, models.fast),
    })) summary += chunk
  } catch {
    return // 压缩失败就保持原样，下次再试
  }

  if (!summary.trim()) return
  state.chronicle = summary.trim().slice(0, 4000)
  state.history = recent
  persist(state)
}

/**
 * 模型给的选项 + 引擎追加的固定项。
 *
 * 追加项永远排在最后：修炼（第八节第 8 小节），以及受伤时才出现的疗伤。
 * 疗伤是有条件出现的 —— 满血的时候挂一个"疗伤"在那里只会占地方。
 */
function withExtras(choices, state) {
  const out = choices.map((c, i) => ({ id: String(i + 1), label: c, kind: 'story' }))

  // 战斗向的修炼走轮盘（每天随机一个方向），不该再挂一个"指定方向练一天"的按钮 ——
  // 两个入口并存的话，指定方向永远更划算，轮盘就没人转了
  if (state.playMode !== 'combat') {
    const gate = canTrain(state)
    out.push({
      id: 'T',
      label: gatingLabel(gate),
      kind: 'training',
      disabled: !gate.ok,
      reason: gate.reason || '',
    })
  }
  if (needsRecovery(state)) {
    out.push({
      id: 'R',
      label: '【疗伤】处理身上的伤（反转术式 / 静养 / 家入硝子）',
      kind: 'recovery',
    })
  }
  return out
}

function gatingLabel(gate) {
  return gate.ok ? '【跳过当天，进行修炼】' : `【跳过当天，进行修炼】（${gate.reason}）`
}

/**
 * 「突然出现的人」的专属规则块。
 *
 * 拼在最后 —— 契约和游玩模式都在它前面，而它要盖过契约里那套
 * "3~4 个有战术分歧的选项"的默认要求（见 prompts.js 的说明）。
 */
const suddenBlock = (state) => suddenArrivalRulesFor(state.player)

function turnSystem(state) {
  // 游玩模式放在契约之后 —— 越靠后的内容对模型的约束越强，
  // 而战斗向的配比是要盖过设定原文那套默认比例的
  const parts = [CORE_RULES, CONTRACT, playModeOf(state.playMode).rules, turnStatePrompt(modelStateView(state))]
  if (state.chronicle) parts.push(`## 前情提要\n${state.chronicle}`)
  if (state.pendingCombat) {
    parts.push(
      `## 当前存在未结算的战斗\n${JSON.stringify(state.pendingCombat, null, 2)}\n玩家尚未选择战斗模式，本回合优先处理战斗。`,
    )
  }
  if (!modelStateView(state).宿傩.可在意识中对话) {
    parts.push('## 注意\n宿傩目前**不会**在玩家意识中对话（手指吞得还太少，他还没把玩家当回事）。不要让宿傩说话。')
  }
  parts.push(suddenBlock(state))
  return parts.filter(Boolean).join('\n\n---\n\n')
}

/**
 * 被打回重写时，补在对话末尾的纠正说明。
 *
 * 说明不能停在"太长了"上 —— 只说长度，模型会再交一份同样长的。
 * 得告诉它**删什么**（环境、心理、铺垫）和**留什么**（交锋的动作与结果），
 * 它才知道这几百字该省在哪儿。
 */
function retryMessages(why, cap) {
  if (why === 'long') {
    return [
      { role: 'assistant', content: '（上一次提交的正文超了字数预算，需要重写）' },
      { role: 'user', content:
        `上一次的正文太长了，超过本模式 ${cap} 字的预算。请重写一份：只留交锋的动作与结果，`
        + '把环境、天气、心理活动、气氛铺垫和所有与打斗无关的描写全部删掉，台词也要短。'
        + 'recap、choices、proposal 照常给全。' },
    ]
  }
  return [
    { role: 'assistant', content: '（上一次提交的正文为空，需要重做）' },
    { role: 'user', content: '上一次的 narration 是空的。请重新提交一份完整的本回合输出。' },
  ]
}

// ---------------------------------------------------------------- 战斗

function combatSystem(state, extra) {
  return [
    CORE_RULES,
    CONTRACT,
    playModeOf(state.playMode).rules,
    turnStatePrompt(modelStateView(state)),
    `## 战斗叙事规则
- 面板已经显示了所有数值。**你在叙事里绝对不要重复任何数字**（不要写"造成 340 点伤害"）。
- 写动作、术式碰撞、咒力流动、伤口、表情。分镜感优先于心理描写。
- NPC 台词只说"特级"，不准说细分刻度。
- 不要改写战斗结果 —— 胜负、伤害、生死都由引擎算定了，你只负责把它写好看。`,
    suddenBlock(state),
    extra,
  ].filter(Boolean).join('\n\n---\n\n')
}

function combatMessages(state, prompt) {
  return [...state.history.slice(-8).map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: prompt }]
}

app.get('/api/session/:id/combat', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  res.json({ combat: state.combat, pending: state.pendingCombat })
})

/** 开始战斗：选定模式。手动模式返回第一回合面板；另两种直接跑完并演出。 */
app.post('/api/session/:id/combat/start', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const mode = String(req.body?.mode || '')
  if (!COMBAT_MODES.includes(mode)) return res.status(400).json({ error: '未知战斗模式' })
  // 这一仗的正文预算（战斗向 400 字，剧情向不限）—— 后面两处演出都要用
  const cap = playModeOf(state.playMode).narrationCap

  // 两种进入方式：
  //   1. pendingCombat 存在 —— 正常流程，玩家第一次选模式
  //   2. combat 存在但没打完 —— 上一轮已经 initCombat 了却中途报错/玩家掉线，
  //      pendingCombat 已被清空。这时必须能重新初始化，否则整局卡死。
  // 打完的架无法重开：finishCombat 会把 state.combat 置空，所以"已结算"的
  // 情况会直接落进下面这个判断，不需要单独分支。
  if (!state.pendingCombat && !state.combat) {
    return res.status(400).json({ error: '当前没有待结算的战斗' })
  }
  // 复用尚未打完的这场战斗的敌人，不要重新掷骰换一个对手
  if (!state.pendingCombat && state.combat) {
    state.pendingCombat = {
      enemy: state.combat.enemy,
      reason: state.combat.reason,
      mode: null,
      sinceTurn: state.turn,
      // 介入标记要跟着一起捡回来，否则中途重开这一场，
      // 打完之后"这一天"就记不进时间线了
      intervention: state.combat.intervention || null,
      // 杀意同理：丢了这个，玩家点名要杀的人打完之后会被记成"击退"
      lethalIntent: !!state.combat.lethalIntent,
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const rng = makeRng(state.seed + state.turn * 101)
  const { enemy, reason, intervention, lethalIntent } = state.pendingCombat
  initCombat(state, rng, { mode, enemy, reason, intervention, lethalIntent })
  state.lastEnemyName = enemy.name
  // 打起来了，场上那批剧情选项作废（两边本来就不该同时出现）
  clearChoices(state)

  try {
    if (mode === 'manual') {
      const roundPanel = buildPanel(state, [], [])
      persist(state)
      // ⚠️ 约定：panel 事件里的是"战斗回合面板"，done 里的 panel 永远是"角色快照"。
      // 早先 done 里两种形状混用，前端拿它去喂角色侧栏，一开打就崩。
      // snapshot 跟着 panel 一起发：角色侧栏要在这一回合判定的当下就更新，
      // 而不是等模型把演出写完（那要好几秒，看起来就像"状态栏没反应"）。
      send('panel', {
        panel: roundPanel, snapshot: panelSnapshot(state),
        text: renderPanelText(roundPanel), mode,
      })
      send('awaiting', { actions: availableActions(state), freeActions: freeActions(state) })
      // actions 必须在 done 里也带一份：前端会用 done.actions 覆盖本地状态，
      // 漏掉就会把刚渲染出来的行动栏清成 undefined。
      send('done', {
        over: false,
        snapshot: panelSnapshot(state),
        actions: availableActions(state),
        freeActions: freeActions(state),
        text: renderPanelText(roundPanel),
        usage: usageSnapshot(state.usage),
      })
      return
    }

    // 跳过 / 剧情描述：引擎先跑完
    send('status', { text: '结算中…' })
    const { rounds, outcome } = simulateCombat(state, rng)
    const won = outcome.winner === 'player'
    const crossLevel = gradeIndexOf(enemy.grade) > gradeIndexOf(state.player.grade)
    const rewards = computeRewards(state, rng, { won, crossLevel })
    const ups = applyRewards(state, rewards)
    const summary = finishCombat(state, outcome)
    pushCombatHistory(state, summary, outcome, mode)
    persist(state)

    const brief = {
      敌方: `${enemy.name}（${enemy.grade}）`,
      结果: { player: '玩家胜', enemy: '玩家败', fled: '玩家脱离', draw: '未分胜负' }[outcome.winner],
      回合数: rounds.length,
      玩家剩余HP占比: `${Math.round((state.player.hp.cur / state.player.hp.max) * 100)}%`,
      关键节点: summarizeRounds(rounds),
    }

    /*
     * 跳过 / 剧情模式不逐回合推面板，但还是把整场里最值得看的那一下告诉前端：
     * 有领域展开就放「領域展開」过场，有暴击就让战报闪一下。
     * 不给的话，这两种模式打起来真的只剩一段文字 —— 手动模式那套演出全浪费了。
     */
    const domRound = rounds.find((r) => r.domainOpened)
    send('highlight', {
      domainOpened: domRound?.domainOpened || null,
      crits: rounds.filter((r) => r.crit).length,
      rounds: rounds.length,
    })

    // 战斗向整场也只给一屏：一仗的正文按同样的预算来，别写成中篇小说
    const capText = cap ? `**全文不超过 ${cap} 字。**描写只围绕交锋本身：谁出了什么招、` +
      '打中了哪里、伤成什么样、局势怎么变。环境、天气、回忆、心理活动一律不写。' : ''
    const prompt = mode === 'skip'
      ? `以下是引擎结算出的战斗过程与结果，请用一两段话写出战斗经过与结局。不要重复数字，不要改写结果。${capText}\n\n${JSON.stringify(brief, null, 2)}`
      : `以下是引擎结算出的战斗全过程。请用分镜演出这场战斗，参考原作战斗分镜的节奏：关键回合放慢、普通回合一笔带过。不要重复数字，不要改写结果。${capText}\n\n${JSON.stringify(brief, null, 2)}`

    // 演出失败不能吃掉结算结果 —— 数值早已落盘，done 必须照发
    let narration = ''
    try {
      for await (const chunk of streamText({
        system: combatSystem(state, null),
        messages: combatMessages(state, prompt),
        model: mode === 'narrative' ? models.pro : models.fast,
        // 有字数预算时把输出上限一起收窄，省得模型写到一半才想起要短
        maxTokens: cap ? 800 : (mode === 'narrative' ? 3000 : 900),
        onUsage: meter(state, mode === 'narrative' ? models.pro : models.fast),
      })) {
        narration += chunk
        send('narration', { text: chunk })
      }
    } catch (e) {
      send('status', { text: `战斗已结算，但演出生成失败：${e.message}` })
    }

    /*
     * 这一路没有工具调用，拿不到"退回重写"的机会，所以超了只能截
     * —— 截在句号上，还得告诉前端换掉它手里那份。
     */
    if (cap) {
      const clipped = clampNarration(narration, cap)
      if (clipped !== narration) {
        narration = clipped
        send('reset', {})
        send('narration', { text: narration })
      }
    }

    send('done', {
      over: true,
      outcome,
      summary,
      rewards: { gains: rewards.gains, notes: rewards.notes },
      ups,
      panel: panelSnapshot(state),
      combat: null,
      usage: usageSnapshot(state.usage),
    })
  } catch (e) {
    send('error', { message: e.message })
  } finally {
    res.end()
  }
}))

/** 手动模式：玩家出一手，引擎判定，模型演出这一回合 */
app.post('/api/session/:id/combat/action', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (!state.combat || state.combat.over) return res.status(400).json({ error: '当前不在战斗中' })
  if (state.combat.mode !== 'manual') return res.status(400).json({ error: '当前不是手动模式' })

  const type = String(req.body?.action || '')
  const allowed = availableActions(state).map((a) => a.type)
  if (!allowed.includes(type)) return res.status(400).json({ error: `无法执行该行动：${type}` })

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const rng = makeRng(state.seed + state.turn * 101 + state.combat.turn * 17)

  try {
    const enemyGradeBefore = state.combat.enemy.grade
    const { panel, over, outcome } = runRound(state, rng, { type })

    send('panel', { panel, snapshot: panelSnapshot(state), text: renderPanelText(panel) })

    // 模型只写这一回合的演出
    const prompt = `第 ${panel.turn} 回合刚结算完。请用 2~4 句写出这一回合的交锋，分镜感要强。不要重复数字。
${panel.freeActionText ? `\n（这一回合玩家还先用了反转术式，且没有占用出手机会：${panel.freeActionText}）\n` : ''}
${renderPanelText(panel)}`

    let narration = ''
    try {
      for await (const chunk of streamText({
        system: combatSystem(state, null),
        messages: combatMessages(state, prompt),
        model: models.fast,
        maxTokens: 500,
        onUsage: meter(state, models.fast),
      })) {
        narration += chunk
        send('narration', { text: chunk })
      }
    } catch {
      narration = ''
    }
    // 战斗向的回合演出同样算进 400 字的预算里（对齐"每次输出"的口径）。
    // 这一路是流式纯文本，没有工具调用可以退回重写，超了就地截。
    const cap = playModeOf(state.playMode).narrationCap
    if (cap) {
      const clipped = clampNarration(narration, cap)
      if (clipped !== narration) {
        narration = clipped
        send('reset', {})
        send('narration', { text: narration })
      }
    }
    panel.narration = narration.trim()

    if (over) {
      const won = outcome.winner === 'player'
      const crossLevel = gradeIndexOf(enemyGradeBefore) > gradeIndexOf(state.player.grade)
      const rewards = computeRewards(state, rng, { won, crossLevel })
      const ups = applyRewards(state, rewards)
      const summary = finishCombat(state, outcome)
      pushCombatHistory(state, summary, outcome, 'manual')
      persist(state)
      send('done', {
        over: true, outcome, summary,
        rewards: { gains: rewards.gains, notes: rewards.notes },
        ups, panel: panelSnapshot(state), combat: null,
        usage: usageSnapshot(state.usage),
      })
    } else {
      persist(state)
      // 同上：done.panel 只能是角色快照，战斗回合面板已经由 panel 事件发过了
      send('done', {
        over: false,
        panel: panelSnapshot(state),
        combat: state.combat,
        actions: availableActions(state),
        freeActions: freeActions(state),
        usage: usageSnapshot(state.usage),
      })
    }
  } catch (e) {
    send('error', { message: e.message })
  } finally {
    res.end()
  }
}))

/**
 * 不占回合的自由行动 —— 目前只有反转术式。
 *
 * 关键点：**不跑 runRound**。玩家按一下，只结算治疗，回合数不变、敌方不动，
 * 之后照常出招。返回值里带上角色快照，前端拿到就立刻刷右侧状态栏 ——
 * 之前治疗混在普通行动里，玩家按下去要么因为咒力不够静默失败，
 * 要么要等模型把这一回合的演出写完（好几秒）才看到血条变化。
 */
app.post('/api/session/:id/combat/free-action', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (!state.combat || state.combat.over) return res.status(400).json({ error: '当前不在战斗中' })
  if (state.combat.mode !== 'manual') return res.status(400).json({ error: '只有手动模式需要逐回合操作' })

  const type = String(req.body?.action || '')
  if (type !== 'reverse') return res.status(400).json({ error: `未知的自由行动：${type}` })

  const r = freeReverse(state)
  if (!r.ok) return res.status(400).json({ error: r.reason })

  // 不进战斗历史：freeLog 已经记了这一笔，下一回合的 buildPanel 会把它
  // 作为"本回合行动"的一部分带给模型和界面。往 log 里塞会多出一行同回合的记录。
  persist(state)

  res.json(withUsage(state, {
    ok: true,
    healed: r.healed,
    cost: r.cost,
    lines: r.lines,
    snapshot: panelSnapshot(state),
    actions: availableActions(state),
    freeActions: freeActions(state),
    combat: state.combat,
  }))
}))

/**
 * 进战斗前先问"要不要打"，玩家可以尝试脱离。
 *
 * 脱离成功率按速度比算，和战斗里"脱离战斗"用的是同一套口径
 * （速度由体术伤害与咒力效率判定，见第一节）。
 * 失败则被迫应战 —— 保留 pendingCombat，由前端直接进入模式选择。
 */
app.post('/api/session/:id/combat/evade', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (!state.pendingCombat) return res.status(400).json({ error: '当前没有待结算的战斗' })

  const rng = makeRng(state.seed + state.turn * 211)
  const p = state.player
  const e = state.pendingCombat.enemy
  const ps = unitSpeed(p)
  const es = unitSpeed(e)
  const chance = Math.max(0.1, Math.min(0.85, ps / (ps + es)))
  const success = rng() < chance

  const enemyLabel = `${e.name}（${e.grade}）`
  // 战斗向的介入战：脱离了就等于这一天没赶上，节点照常发生（不是被改写了）
  const missed = state.pendingCombat.intervention || null
  let note
  if (success) {
    note = `避开了与${enemyLabel}的正面冲突`
    if (missed && state.timeline.nodes[missed] === '未发生') {
      state.timeline.nodes[missed] = '已发生'
      note += `。「${missed}」如期发生，你不在场`
    } else if (missed && state.timeline.nodes[missed] === '已改写') {
      // 这一天早就被改写了（撑起它的人没了），但照旧会来 —— 只是你不在场
      note += `。已经被改写的「${missed}」照旧来了，你不在场`
    }
    state.timeline.newEvents.push(note)
    if (state.timeline.newEvents.length > 40) state.timeline.newEvents.shift()
    state.pendingCombat = null
    state.history.push({ role: 'assistant', content: `【遭遇·脱离成功】${note}。玩家没有交手就离开了。` })
  } else {
    note = `${enemyLabel}咬得太紧，没能甩掉`
    state.history.push({ role: 'assistant', content: `【遭遇·脱离失败】${note}。战斗无法避免。` })
  }
  state.turn += 1
  // 脱离成功 / 被迫应战，两种结局都会换掉场上的按钮，先作废
  clearChoices(state)
  persist(state)

  res.json(withUsage(state, {
    success,
    note,
    chance: Number(chance.toFixed(3)),
    // 失败时战斗仍在，前端直接进入模式选择
    combat: success ? null : state.pendingCombat,
    panel: panelSnapshot(state),
  }))
}))

// ---------------------------------------------------------------- 跨篇衔接

/**
 * 从怀玉篇（2007）跨到宿傩篇（2018）。
 *
 * 中间十一年不跳过 —— 做成三段历练，玩家每段选一个方向，引擎结算成长。
 * 走完三段正好落在 2018 年 6 月，带着一身本事进新篇。
 */
app.get('/api/session/:id/crossover', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const gate = crossoverReady(state)
  res.json({
    gate,
    stages: stagesFor(state.storyline),
    focuses: FOCUSES.map((f) => ({ id: f.id, name: f.name, desc: f.desc })),
    done: state.crossover?.done || 0,
    target: storylineOf(storylineOf(state.storyline).next)?.name || null,
  })
})

app.post('/api/session/:id/crossover/advance', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const gate = crossoverReady(state)
  if (!gate.ok) return res.status(400).json({ error: gate.reason })

  const focusId = String(req.body?.focus || '')
  if (!focusById(focusId)) return res.status(400).json({ error: '未知的历练方向' })

  state.crossover ||= { done: 0, log: [] }
  const idx = state.crossover.done
  if (idx >= stagesFor(state.storyline).length) return res.status(400).json({ error: '历练已经走完了' })

  const rng = makeRng(state.seed + state.turn * 97 + idx * 31)
  const result = rollStage(state, focusId, idx, rng)
  const ups = applyStage(state, result)

  state.crossover.done = idx + 1
  state.crossover.log.push({ stage: idx, focus: result.focusName, ups })
  state.turn += 1

  // 三段走完 → 跨篇
  if (state.crossover.done >= stagesFor(state.storyline).length) {
    const done = completeCrossover(state, rng)
    persist(state)
    return res.json(withUsage(state, { finished: true, result, ups, crossover: done, panel: panelSnapshot(state) }))
  }

  persist(state)
  res.json(withUsage(state, {
    finished: false,
    result,
    ups,
    done: state.crossover.done,
    panel: panelSnapshot(state),
  }))
}))

/** 玩家在当前局面下实际能用的行动。这些都会推进一个回合。 */
function availableActions(state) {
  const p = state.player
  // 对方的领域正开着且是规则型 —— 手上这几格能不能用就由它说了算
  const seal = state.combat?.enemy ? sealOf(p, state.combat.enemy) || {} : {}
  const out = [{ type: 'physical', label: '体术攻击', enabled: true }]

  const techOk = p.technique.cdLeft === 0
  out.push({
    type: 'technique', label: `生得术式·${p.technique.name}`,
    enabled: techOk && !seal.technique,
    note: seal.technique ? '领域规则封住了术式'
      : techOk ? '' : `冷却剩 ${p.technique.cdLeft} 回合`,
  })

  /*
   * 被封住的技能**留在栏里**、只是灰掉。直接从列表里删掉的话，
   * 玩家看到的是"我的术式按钮不见了"，不知道是被规则压住了；
   * 灰着 + 写明原因才是可读的 —— 也顺带告诉玩家这领域该怎么破。
   * 后端的 allowed 校验不看 enabled，所以旧客户端照样点得下去，
   * 那一下会由引擎按"被规则封住"结算掉，不会 400。
   */
  out.push({
    type: 'defend', label: '防御（回复咒力）',
    enabled: !seal.defense, note: seal.defense ? '领域规则之下防御不成立' : '',
  })

  if (p.domain.unlocked) {
    out.push({
      type: 'domain', label: `领域展开·${p.domain.name}`,
      enabled: !p.domain.active && !seal.domain,
      note: p.domain.active ? '已在展开中'
        : seal.domain ? '对方的领域压着，展不开' : '',
    })
  }
  out.push({ type: 'flee', label: '脱离战斗', enabled: true })
  return out
}

/**
 * 不占回合的自由行动 —— 目前只有反转术式。
 *
 * 它和上面那批的区别是：按下去之后**回合不会推进**，敌方不会动，
 * 玩家照样出招。所以它得单独一条接口，也单独渲染在行动栏上方。
 * 咒力不够/本回合用过了都要在这里说清楚，不能等玩家点了才知道。
 */
function freeActions(state) {
  const p = state.player
  const c = state.combat
  if (!c || c.over) return []

  const pv = reversePreview(p)
  // 还没练成也把这一格摆出来。技能栏里空着的话，玩家不会知道"有个不占回合的
  // 技能存在、只是我还没学会"，只会以为战斗栏就只有那五个按钮。灰着 + 写清楚
  // 去哪儿练，比什么都不显示有用。
  if (!pv) {
    return [{
      type: 'reverse',
      label: '反转术式·未掌握',
      free: true,
      enabled: false,
      note: '先修炼「反转术式修习」，练到初步就能用',
      cost: 0,
      heal: 0,
    }]
  }

  const usedUp = (c.freeUsed || 0) >= FREE_REVERSE_PER_ROUND
  const full = p.hp.cur >= p.hp.max
  const poor = p.ce.cur < pv.cost
  // 规则型领域里反转术式用不出来 —— 治疗这一栏整条是废的，先说清楚
  const sealed = !!sealOf(p, c.enemy)?.reverse
  const note = sealed ? '领域规则封住了治疗'
    : usedUp ? '本回合已用过'
      : full ? '血条已满'
        : poor ? `咒力不足（需 ${pv.cost}）`
          : `消耗 ${pv.cost} 咒力，回复 ${pv.heal} 生命`

  return [{
    type: 'reverse',
    label: `反转术式·${pv.level}`,
    free: true,
    enabled: !usedUp && !full && !poor && !sealed,
    note,
    cost: pv.cost,
    heal: pv.heal,
  }]
}

function gradeIndexOf(g) {
  return ['四级', '三级', '二级', '准一级', '一级', '弱特级', '标特级', '超特级', '龙级'].indexOf(g)
}

/** 把战斗结果写进对话历史，好让主循环接着往下演 */
function pushCombatHistory(state, summary, outcome, mode) {
  const lines = [`【战斗结算·${MODE_LABELS[mode]}】`, summary]
  state.history.push({ role: 'assistant', content: lines.join('\n') })
  if (state.history.length > 40) state.history = state.history.slice(-40)
}

// ---------------------------------------------------------------- 修炼

app.post('/api/session/:id/train', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const item = String(req.body?.item || '')
  if (!TRAINING_TABLE[item]) return res.status(400).json({ error: '未知修炼项目' })

  const gate = canTrain(state)
  if (!gate.ok) return res.status(400).json({ error: gate.reason })

  const rng = makeRng(state.seed + state.turn * 31 + item.length)
  const result = rollTraining(state, item, rng)
  const ups = applyTraining(state, result)
  state.turn += 1
  // 修炼这一天的选项作废；前端随后会补一个静默回合规剧情，新选项由那一轮给出
  clearChoices(state)
  persist(state)

  // 一两句话的过程描写，按设定不展开
  let flavor = ''
  try {
    for await (const chunk of streamText({
      system: '你是《咒术回战》世界观文字游戏的叙事模块。只输出一到两句话的修炼过程描写，不要对话，不要数值，不要心理独白。风格干脆利落。',
      messages: [{ role: 'user', content: `角色（${state.player.grade}）进行「${item}」修炼。用一到两句话描写过程。` }],
      model: models.fast,
      maxTokens: 200,
      onUsage: meter(state, models.fast),
    })) flavor += chunk
  } catch {
    flavor = ''
  }

  const entry = {
    type: 'training',
    item,
    progress: Number((result.progress * 100).toFixed(1)),
    ups,
    notes: result.notes,
    hpDelta: result.hpDelta,
    flavor: flavor.trim(),
  }
  state.log.push(entry)
  persist(state)

  res.json(withUsage(state, { ...entry, panel: panelSnapshot(state) }))
}))

// ---------------------------------------------------------------- 疗伤

app.get('/api/session/:id/recovery-options', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  res.json({ needed: needsRecovery(state), items: recoveryOptions(state) })
})

/**
 * 疗伤。不走模型 —— 这是纯数值操作，玩家要的是立刻看到血条动。
 * 之后前端会补一个静默回合让剧情接上（和修炼一样）。
 */
app.post('/api/session/:id/recovery', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (state.combat && !state.combat.over) {
    return res.status(400).json({ error: '战斗中请用行动栏上的反转术式（不占回合）' })
  }

  const id = String(req.body?.id || '')
  const r = applyRecovery(state, id)
  if (!r) {
    const opt = recoveryOptions(state).find((o) => o.id === id)
    return res.status(400).json({ error: opt?.reason || '这个方法现在用不了' })
  }

  state.turn += 1
  clearChoices(state)
  const entry = { type: 'recovery', ...r }
  state.log.push(entry)
  persist(state)
  res.json(withUsage(state, { ...entry, panel: panelSnapshot(state) }))
}))

// ---------------------------------------------------------------- 战斗向：日常轮盘

/**
 * 战斗向的循环：两段剧情之间的空闲时间，一天转一次轮盘。
 * 见 engine/wheel.js 顶部的说明。
 *
 * 返回值除了 ok 还带 spin / advance：**到剧情当天时"不能再往后转"不等于
 * "什么都干不了"** —— 那天要打的那一场正等着你。早先只有一个 ok，
 * 界面只好把两个按钮一起禁用，玩家就卡在节点当天动不了了。
 */
function wheelGate(state) {
  const no = (reason) => ({ ok: false, reason, spin: false, advance: false })
  if (state.phase !== 'playing') return no('游戏还没开始')
  if (state.playMode !== 'combat') return no('日常轮盘只在战斗向里跑')
  if (state.combat && !state.combat.over) return no('战斗还没打完')
  if (state.pendingCombat) return no('有一场遭遇还没处理 —— 先决定打还是走')

  const ms = nextMilestone(state)
  // 排期走完就该换篇了。早先这里不拦，玩家在最后一场打完可以无限地转下去：
  // 一天一天地练，什么都不会发生，也没有任何提示
  if (!ms) return no('这条线上排到的剧情节点都打完了 —— 点顶栏「跨篇」接着走，或切回剧情向自由发挥')
  // 今天就是节点当天：再往后转一天，这一天就没了（节点会被记成"错过"）
  if (ms.daysLeft <= 0) {
    return { ok: true, spin: false, advance: true, reason: `「${ms.node}」就是今天 —— 先打完这一场` }
  }
  return { ok: true, spin: true, advance: true, reason: '' }
}

/** 右侧状态栏的成长面板用：六个方向的名字与它们练满之后给什么 */
const GROWTH_ROWS = WHEEL_SECTORS.map(({ id, short, effect }) => ({ id, short, effect }))

app.get('/api/session/:id/wheel', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  res.json(withUsage(state, {
    enabled: state.playMode === 'combat',
    gate: wheelGate(state),
    wheel: wheelSnapshot(state),
    panel: panelSnapshot(state),
    growth: state.playMode === 'combat' ? GROWTH_ROWS : null,
  }))
})

app.post('/api/session/:id/wheel/spin', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const gate = wheelGate(state)
  if (!gate.spin) return res.status(400).json({ error: gate.reason })

  // 种子带上已经转过的天数：同一天不会因为重放而转出两个结果
  const rng = makeRng(state.seed + state.turn * 977 + (state.wheel?.days || 0) * 13)
  const report = spinWheel(state, rng)
  state.turn += 1
  state.log.push({ type: 'wheel', ...report })
  clearChoices(state)

  // 正好落在剧情当天就把仗挂上，前端会弹"要不要打"的询问
  const combat = startIntervention(state, rng)
  persist(state)

  res.json(withUsage(state, {
    report, wheel: wheelSnapshot(state), combat, panel: panelSnapshot(state),
    growth: GROWTH_ROWS,
    // 闸门要跟着回来：转完这一天可能就到节点当天了，
    // 前端不刷新它的话，轮盘会继续摆着可点的"转一天"
    gate: wheelGate(state),
  }))
}))

/** 一口气练到剧情当天 —— 逐天算，但只返回合并后的日报 */
app.post('/api/session/:id/wheel/advance', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const gate = wheelGate(state)
  if (!gate.advance) return res.status(400).json({ error: gate.reason })

  const rng = makeRng(state.seed + state.turn * 613 + (state.wheel?.days || 0) * 13)
  const summary = advanceToMilestone(state, rng)
  if (summary.days > 0) {
    state.turn += 1
    state.log.push({ type: 'wheel', ...summary })
  }
  clearChoices(state)
  const combat = startIntervention(state, rng)
  persist(state)

  res.json(withUsage(state, {
    summary, wheel: wheelSnapshot(state), combat, panel: panelSnapshot(state), limit: MAX_DAYS_PER_CALL,
    growth: GROWTH_ROWS,
    gate: wheelGate(state),
  }))
}))

app.get('/api/session/:id/training-options', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  res.json({
    gate: canTrain(state),
    items: Object.entries(TRAINING_TABLE).map(([name, row]) => ({
      name,
      range: `${Math.round(row.range[0] * 100)}%~${Math.round(row.range[1] * 100)}%`,
      cost: row.cost,
      progress: Math.round(state.player?.training?.[name] || 0),
    })),
  })
})

// ---------------------------------------------------------------- 改自己

/**
 * 随时改自己的数值。
 *
 * 纯引擎结算，不走模型：等级、领域觉醒、术式消耗全是从数字反推的，
 * 没有什么需要模型拿主意的地方。改完回一句"改了什么"，
 * 界面拿它写回执 —— 静默生效的话玩家会怀疑自己有没有点中。
 */
app.post('/api/session/:id/edit', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (!state.player) return res.status(400).json({ error: '还没有角色可以改' })

  const notes = tunePlayer(state, req.body?.numbers || {})
  persist(state)
  res.json(withUsage(state, { notes, panel: panelSnapshot(state) }))
})

// ---------------------------------------------------------------- 状态

app.get('/api/session/:id/state', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })

  res.json(withUsage(state, {
    phase: state.phase,
    attributeProfiles: state.attributeProfiles,
    identityProfiles: state.identityProfiles,
    timeProfiles: state.timeProfiles || [],
    playMode: state.playMode,
    log: state.log,
    recap: [...(state.log || [])].reverse().find((e) => e.recap)?.recap || '',
    panel: panelSnapshot(state),
    choices: liveChoices(state),
    actions: state.combat && !state.combat.over ? availableActions(state) : null,
    freeActions: state.combat && !state.combat.over ? freeActions(state) : null,
    // 战斗向的轮盘面板刷新后要能立刻恢复，不能等玩家点一下才拉
    wheel: state.playMode === 'combat' ? wheelSnapshot(state) : null,
    wheelGate: state.playMode === 'combat' ? wheelGate(state) : null,
    // 成长面板的六行标题。进度条本身在 panel.training 里（0~100），
    // 少了这张表，界面就不知道该拿这几个数字去对应哪条属性
    growth: GROWTH_ROWS,
    combat: state.pendingCombat,
    inCombat: state.combat && !state.combat.over
      ? {
          mode: state.combat.mode,
          panel: state.combat.log.at(-1) || null,
          actions: availableActions(state),
          freeActions: freeActions(state),
        }
      : null,
  }))
})

app.get('/api/health', asyncRoute(async (req, res) => {
  const { ping } = await import('./llm.js')
  res.json({ ok: true, model: models.fast, pro: models.pro, pong: await ping() })
}))

// ---------------------------------------------------------------- 存档槽位

const SLOT_DIR = path.join(SAVE_DIR, 'slots')

/**
 * 每次访问前确保目录存在。
 * 只在启动时建一次是不够的 —— 目录被外部删掉后，存档接口会直接 500。
 */
function ensureDirs() {
  fs.mkdirSync(SLOT_DIR, { recursive: true })
  fs.mkdirSync(SAVE_DIR, { recursive: true })
}

const slotPath = (sid) => path.join(SLOT_DIR, `${sid}.json`)

/** 槽位列表：按最后保存时间倒序 */
app.get('/api/saves', (req, res) => {
  ensureDirs()
  const rows = fs.readdirSync(SLOT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SLOT_DIR, f), 'utf8'))
        return {
          id: f.replace(/\.json$/, ''),
          name: s.slotName || '未命名存档',
          playerName: s.player?.name || '—',
          grade: s.player?.grade || '—',
          date: s.time?.date || '—',
          day: s.time?.day ?? 0,
          turn: s.turn ?? 0,
          savedAt: s.savedAt || null,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))
  res.json({ saves: rows })
})

app.post('/api/session/:id/save', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  if (!state.player) return res.status(400).json({ error: '还没创建角色，无法存档' })

  ensureDirs()
  const name = String(req.body?.name || '').trim().slice(0, 40) || `${state.player.name} 第${state.turn}回合`
  const sid = `slot-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`
  const snapshot = { ...state, slotName: name, savedAt: new Date().toISOString() }
  // 存档里不保留进行中的战斗现场，避免读档后卡在半个回合里
  snapshot.combat = null
  fs.writeFileSync(slotPath(sid), JSON.stringify(snapshot, null, 2), 'utf8')
  res.json({ id: sid, name })
})

app.post('/api/saves/:sid/load', (req, res) => {
  const f = slotPath(req.params.sid)
  if (!fs.existsSync(f)) return res.status(404).json({ error: '存档不存在' })
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'))

  // 读档 = 复制成一份新会话，原会话不受影响
  const newId = crypto.randomUUID().slice(0, 8)
  const state = { ...saved, id: newId, combat: null }
  sessions.set(newId, state)
  persist(state)

  res.json(withUsage(state, {
    sessionId: newId,
    phase: state.phase,
    playMode: state.playMode,
    log: state.log,
    // 读档后要能把最后一批选项还原出来，否则玩家只能靠自由输入继续
    choices: liveChoices(state),
    panel: panelSnapshot(state),
    // 读档后轮盘和疗伤入口要立刻回来，否则玩家得先随便点一下才看得见
    wheel: state.playMode === 'combat' ? wheelSnapshot(state) : null,
    wheelGate: state.playMode === 'combat' ? wheelGate(state) : null,
    growth: GROWTH_ROWS,
    combat: state.pendingCombat,
  }))
})

/** 实时用量：前端定时拉一次，兜住后台调用（比如编年史压缩）的账 */
app.get('/api/session/:id/usage', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  res.json(usageSnapshot(state.usage))
})

app.delete('/api/saves/:sid', (req, res) => {
  const f = slotPath(req.params.sid)
  if (!fs.existsSync(f)) return res.status(404).json({ error: '存档不存在' })
  fs.unlinkSync(f)
  res.json({ ok: true })
})

/**
 * 清空本机所有数据：进行中的会话 + 全部手动存档。
 *
 * 和 DELETE /api/saves/:sid 的区别是**它没有撤销键**：那一局如果没存过档，
 * 清掉就是真的没了。所以要求调用方把确认口令写在 body 里 ——
 * 界面上是按钮点两次，第二次的结果就是这个字符串。
 * 没带口令一律 400，且一个文件都不动：一个可以被误调的清库接口比没有更糟。
 */
app.delete('/api/data', (req, res) => {
  if (req.body?.confirm !== WIPE_CONFIRM) {
    return res.status(400).json({
      error: `清除全部数据不可撤销，需要二次确认（body 里带 { "confirm": "${WIPE_CONFIRM}" }）`,
    })
  }
  const r = wipeLocalData({ saveDir: SAVE_DIR, slotDir: SLOT_DIR, sessions })
  console.log(`  清理        会话 ${r.sessions} 个 · 存档文件 ${r.files} 个`)
  res.json({ ok: true, ...r })
})

/** 战斗/剧情日志重放用：把已发生的事整段读回来 */
app.get('/api/session/:id/log', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  res.json({ log: state.log, chronicle: state.chronicle })
})

// ---------------------------------------------------------------- 静态资源

const DIST = path.join(ROOT, 'dist')
if (fs.existsSync(DIST)) app.use(express.static(DIST))

app.use((err, req, res, _next) => {
  console.error('[error]', err)
  if (res.headersSent) return res.end()
  res.status(500).json({ error: err.message })
})

const PORT = Number(process.env.PORT || 8787)

const server = app.listen(PORT, () => {
  console.log(`\n  引擎已启动  http://localhost:${PORT}`)
  console.log(`  模型        ${models.fast} / ${models.pro}`)
  console.log(`  前端地址    以 Vite 输出的 Local 为准（5173 被占用时会自动顺延）`)
  console.log(`  按 Ctrl+C 停止\n`)
})

/**
 * 端口占用是最常见的启动失败，但默认行为是甩一坨 stack trace，
 * 而 Vite 会静默换到 5174 —— 结果是"页面能打开、但所有请求都失败"，
 * 比直接报错更难排查。这里给一句人话，并说清怎么处理。
 */
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✘ 端口 ${PORT} 已被占用。`)
    console.error(`    多半是上一次的 dev 还开着，或者另一个终端也在跑这个项目。\n`)
    // 别写死 Windows 命令 —— 别人在 macOS/Linux 上 clone 下来也要能用
    console.error(`    Windows：  netstat -ano | findstr :${PORT}   然后 taskkill /PID <PID> /F`)
    console.error(`    macOS/Linux：  lsof -ti :${PORT} | xargs kill`)
    console.error(`    或者换个端口：  在 .env 里改 PORT=8788\n`)
    console.error(`    注意：后端没起来的话，前端页面能打开但所有请求都会失败。\n`)
    process.exit(1)
  }
  throw e
})
