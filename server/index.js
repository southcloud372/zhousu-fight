import 'dotenv/config'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { streamTool, streamText, models } from './llm.js'
import { makeRng } from './engine/dice.js'
import { blankState, applyProposal, panelSnapshot, modelStateView } from './engine/state.js'
import { scrubTurn, clampProposal, noteNarrationLeak, checkEnemyLegality } from './engine/guard.js'
import {
  generateAttributeProfiles, generateIdentityProfiles, buildCharacterAndOpening,
  generateCustomAttribute, generateCustomIdentity, rollTimeProfiles, generateCustomTime,
} from './engine/opening.js'
import { CORE_RULES, CONTRACT, turnStatePrompt } from './prompts.js'
import { accumulate, usageSnapshot, estimateTokens } from './pricing.js'
import { submitTurn } from './engine/schemas.js'
import { rollEnemy } from './engine/rolls.js'
import { byId, TIME_POINTS } from './engine/timeline.js'
import { canTrain, rollTraining, applyTraining, TRAINING_TABLE } from './engine/commands.js'
import {
  COMBAT_MODES, MODE_LABELS, initCombat, runRound, simulateCombat,
  summarizeRounds, computeRewards, applyRewards, finishCombat,
  buildPanel, renderPanelText, unitSpeed,
} from './engine/combat.js'

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

app.post('/api/session', (req, res) => {
  const rng = makeRng()
  const state = blankState(rng)
  state.id = crypto.randomUUID().slice(0, 8)
  state.rngSeed = state.seed
  sessions.set(state.id, state)
  persist(state)
  res.json({ sessionId: state.id, phase: state.phase })
})

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

/** 自主定义身份：同理，模型自己判定身份类型，引擎据此重掷关系值 */
app.post('/api/session/:id/identities/custom', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const brief = String(req.body?.brief || '').trim().slice(0, 500)
  if (brief.length < 2) return res.status(400).json({ error: '请先描述你想要的背景' })

  const rng = makeRng(state.seed + state.turn + brief.length * 13)
  const identity = await generateCustomIdentity(rng, brief, { onUsage: meter(state, models.pro) })

  state.identityProfiles = [
    ...state.identityProfiles.filter((p) => p.slot !== '自定义'),
    identity,
  ]
  persist(state)
  res.json(withUsage(state, { identity }))
}))

/** 全部可选时间点（自主定义穿越时间时给玩家做参考） */
app.get('/api/time-points', (req, res) => {
  res.json({ points: TIME_POINTS.map(({ id, date, label, when, dangerLabel }) => ({ id, date, label, when, dangerLabel })) })
})

app.post('/api/session/:id/choose-attributes', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const { slot } = req.body || {}
  const picked = state.attributeProfiles.find((p) => p.slot === slot)
  if (!picked) return res.status(400).json({ error: '档案不存在' })

  state.chosenAttributeSlot = slot
  const rng = makeRng(state.seed + 1000 + state.turn)
  const identities = await generateIdentityProfiles(rng, { onUsage: meter(state, models.pro) })
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
  const times = rollTimeProfiles(makeRng(state.seed + 991))
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

  const point = await generateCustomTime(brief, { onUsage: meter(state, models.pro) })
  // 替换上一次的自定义时间点，避免反复重掷越堆越多
  state.timeProfiles = [
    ...(state.timeProfiles || []).filter((t) => t.id !== '自定义'),
    point,
  ]
  persist(state)
  res.json(withUsage(state, { point }))
}))

/** 第三步：选定穿越时间 → 组合最终档案 → 生成开局情境 */
app.post('/api/session/:id/choose-time', asyncRoute(async (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })
  const { id } = req.body || {}
  const attr = state.attributeProfiles.find((p) => p.slot === state.chosenAttributeSlot)
  const ident = state.identityProfiles.find((p) => p.slot === state.chosenIdentitySlot)
  if (!attr || !ident) return res.status(400).json({ error: '前置档案不存在' })

  // 从这一局自己的候选里找 —— 自定义那份只存在于 state 里，不在全局表
  const point = (state.timeProfiles || []).find((t) => t.id === id) || byId(id)
  if (!point) return res.status(400).json({ error: '未知的穿越时间' })

  state.chosenTimeId = id
  state.turn = 1 // 先置位，否则 postProcess 写进日志的回合号是 0
  const opening = await buildCharacterAndOpening(state, attr, ident, point, { onUsage: meter(state, models.pro) })

  const cleaned = postProcess(state, opening, { isOpening: true })
  state.phase = 'playing'
  persist(state)

  res.json(withUsage(state, {
    ...cleaned,
    choices: withTrainingOption(cleaned.choices, state),
    panel: panelSnapshot(state),
    combat: state.pendingCombat,
  }))
}))

// ---------------------------------------------------------------- 回合

/**
 * 所有模型输出都要过这一关：
 * 清洗 NPC 台词里的特级细分 → 夹紧数值提议 → 应用 → 写入日志。
 */
function postProcess(state, raw, { isOpening = false } = {}) {
  const leaked = scrubTurn(raw)
  const prop = clampProposal(raw.proposal, state)
  const notes = applyProposal(state, prop)

  if (leaked) notes.push('已拦截 NPC 台词中的特级细分用词')

  const narrationLeaks = noteNarrationLeak(raw.narration)
  if (narrationLeaks.length) notes.push(`旁白使用了细分刻度：${narrationLeaks.join('、')}（合规）`)

  const entry = {
    turn: state.turn,
    narration: raw.narration || '',
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

    // 原作主要角色不能凭空变成敌人 —— 需要对应节点已发生
    const legal = checkEnemyLegality(raw.combatRequest.enemyName, state.timeline)
    if (!legal.ok) {
      entry.notes.push(`已拦截越界敌人：${legal.reason}`)
      raw.combatRequest.enemyName = '无名咒灵'
      raw.combatRequest.enemyTechniqueName = raw.combatRequest.enemyTechniqueName || '未知术式'
      raw.combatRequest.enemyDomainName = null
    }

    enemy.name = raw.combatRequest.enemyName || '咒灵'
    enemy.technique.name = raw.combatRequest.enemyTechniqueName || '未知术式'
    enemy.technique.effect = raw.combatRequest.enemyTechniqueEffect || ''
    // 领域只有特级才有；模型没给名字就留个可辨认的占位
    if (enemy.domain?.unlocked) {
      enemy.domain.name = raw.combatRequest.enemyDomainName || `${enemy.name}的领域`
    } else if (raw.combatRequest.enemyDomainName) {
      // 模型给非特级敌人编了领域 —— 按设定不该有，去掉
      entry.notes.push('非特级敌人不应持有领域，已忽略模型给出的领域名')
    }
    state.pendingCombat = {
      enemy,
      reason: raw.combatRequest.reason,
      mode: null,
      sinceTurn: state.turn,
    }
  }
  // 待结算的遭遇不在这里清 —— 它是"玩家还没决定打不打"，
  // 只能由 /combat/start（迎战）或 /combat/evade（脱离）结清。
  // 详见 state.js 里 applyProposal 的注释。

  // 关键剧情节点当天锁定"跳过修炼"
  const NODE_LOCK = ['少年院任务', '涩谷事变', '死灭回游', '宿傩夺舍']
  state.storyLock = NODE_LOCK.find((n) => entry.proposal.flags.includes(`${n}_开始`)) || null

  return entry
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

    // 模型偶尔会交回空壳正文；空就重来一次，别让玩家对着一片空白选行动
    let raw = null
    let streamedText = ''   // 本次流式已产出的正文，用于实时估算
    let lastLiveAt = 0
    for (let attempt = 0; attempt < 3; attempt++) {
      for await (const ev of streamTool({
        system: turnSystem(state),
        messages: attempt === 0
          ? messages
          : [...messages, { role: 'assistant', content: '（上一次提交的正文为空，需要重做）' },
             { role: 'user', content: '上一次的 narration 是空的。请重新提交一份完整的本回合输出。' }],
        tool: submitTurn,
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
      const ok = typeof raw?.narration === 'string' && raw.narration.trim().length >= 60
      if (ok) break
      if (attempt < 2) {
        // 重试前必须让前端把已收到的半截正文丢掉，否则两次输出会拼在一起
        send('reset', {})
        send('status', { text: '正文为空，重试中…' })
        // 重试时估算值要从头算，否则会把上一版的正文也算进去
        streamedText = ''
      }
    }

    const entry = postProcess(state, raw)
    persist(state)

    send('done', {
      turn: state.turn,
      dialogue: entry.dialogue,
      choices: withTrainingOption(entry.choices, state),
      notes: entry.notes,
      panel: panelSnapshot(state),
      combat: state.pendingCombat,
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

/** 第八节第 8 小节：这个选项永远作为最后一个出现 */
function withTrainingOption(choices, state) {
  const gate = canTrain(state)
  return [
    ...choices.map((c, i) => ({ id: String(i + 1), label: c, kind: 'story' })),
    {
      id: 'T',
      label: gatingLabel(gate),
      kind: 'training',
      disabled: !gate.ok,
      reason: gate.reason || '',
    },
  ]
}

function gatingLabel(gate) {
  return gate.ok ? '【跳过当天，进行修炼】' : `【跳过当天，进行修炼】（${gate.reason}）`
}

function turnSystem(state) {
  const parts = [CORE_RULES, CONTRACT, turnStatePrompt(modelStateView(state))]
  if (state.chronicle) parts.push(`## 前情提要\n${state.chronicle}`)
  if (state.pendingCombat) {
    parts.push(
      `## 当前存在未结算的战斗\n${JSON.stringify(state.pendingCombat, null, 2)}\n玩家尚未选择战斗模式，本回合优先处理战斗。`,
    )
  }
  if (!modelStateView(state).宿傩.可在意识中对话) {
    parts.push('## 注意\n宿傩目前**不会**在玩家意识中对话（觉醒度不足或态度未达"感兴趣"）。不要让宿傩说话。')
  }
  return parts.join('\n\n---\n\n')
}

// ---------------------------------------------------------------- 战斗

function combatSystem(state, extra) {
  return [
    CORE_RULES,
    CONTRACT,
    turnStatePrompt(modelStateView(state)),
    `## 战斗叙事规则
- 面板已经显示了所有数值。**你在叙事里绝对不要重复任何数字**（不要写"造成 340 点伤害"）。
- 写动作、术式碰撞、咒力流动、伤口、表情。分镜感优先于心理描写。
- NPC 台词只说"特级"，不准说细分刻度。
- 不要改写战斗结果 —— 胜负、伤害、生死都由引擎算定了，你只负责把它写好看。`,
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
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const rng = makeRng(state.seed + state.turn * 101)
  const { enemy, reason } = state.pendingCombat
  initCombat(state, rng, { mode, enemy, reason })
  state.lastEnemyName = enemy.name

  try {
    if (mode === 'manual') {
      const roundPanel = buildPanel(state, [], [])
      persist(state)
      // ⚠️ 约定：panel 事件里的是"战斗回合面板"，done 里的 panel 永远是"角色快照"。
      // 早先 done 里两种形状混用，前端拿它去喂角色侧栏，一开打就崩。
      send('panel', { panel: roundPanel, text: renderPanelText(roundPanel), mode })
      send('awaiting', { actions: availableActions(state) })
      // actions 必须在 done 里也带一份：前端会用 done.actions 覆盖本地状态，
      // 漏掉就会把刚渲染出来的行动栏清成 undefined。
      send('done', {
        over: false,
        snapshot: panelSnapshot(state),
        actions: availableActions(state),
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

    const prompt = mode === 'skip'
      ? `以下是引擎结算出的战斗过程与结果，请用一两段话写出战斗经过与结局。不要重复数字，不要改写结果。\n\n${JSON.stringify(brief, null, 2)}`
      : `以下是引擎结算出的战斗全过程。请用长篇分镜演出这场战斗，参考原作战斗分镜的节奏：关键回合放慢、普通回合一笔带过。不要重复数字，不要改写结果。\n\n${JSON.stringify(brief, null, 2)}`

    // 演出失败不能吃掉结算结果 —— 数值早已落盘，done 必须照发
    let narration = ''
    try {
      for await (const chunk of streamText({
        system: combatSystem(state, null),
        messages: combatMessages(state, prompt),
        model: mode === 'narrative' ? models.pro : models.fast,
        maxTokens: mode === 'narrative' ? 3000 : 900,
        onUsage: meter(state, mode === 'narrative' ? models.pro : models.fast),
      })) {
        narration += chunk
        send('narration', { text: chunk })
      }
    } catch (e) {
      send('status', { text: `战斗已结算，但演出生成失败：${e.message}` })
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

    send('panel', { panel, text: renderPanelText(panel) })

    // 模型只写这一回合的演出
    const prompt = `第 ${panel.turn} 回合刚结算完。请用 2~4 句写出这一回合的交锋，分镜感要强。不要重复数字。

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
  let note
  if (success) {
    note = `避开了与${enemyLabel}的正面冲突`
    state.timeline.newEvents.push(note)
    if (state.timeline.newEvents.length > 40) state.timeline.newEvents.shift()
    state.pendingCombat = null
    state.history.push({ role: 'assistant', content: `【遭遇·脱离成功】${note}。玩家没有交手就离开了。` })
  } else {
    note = `${enemyLabel}咬得太紧，没能甩掉`
    state.history.push({ role: 'assistant', content: `【遭遇·脱离失败】${note}。战斗无法避免。` })
  }
  state.turn += 1
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

/** 玩家在当前局面下实际能用的行动 */
function availableActions(state) {
  const p = state.player
  const out = [{ type: 'physical', label: '体术攻击', enabled: true }]

  const techOk = p.technique.cdLeft === 0
  out.push({
    type: 'technique', label: `生得术式·${p.technique.name}`,
    enabled: techOk, note: techOk ? '' : `冷却剩 ${p.technique.cdLeft} 回合`,
  })

  out.push({ type: 'defend', label: '防御（回复咒力）', enabled: true })

  if (p.domain.unlocked) {
    out.push({
      type: 'domain', label: `领域展开·${p.domain.name}`,
      enabled: !p.domain.active, note: p.domain.active ? '已在展开中' : '',
      usage: usageSnapshot(state.usage),
    })
  }
  if (p.reverseCursedTechnique.level !== '未掌握') {
    out.push({ type: 'reverse', label: `反转术式（${p.reverseCursedTechnique.level}）`, enabled: true })
  }
  out.push({ type: 'flee', label: '脱离战斗', enabled: true })
  return out
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

// ---------------------------------------------------------------- 状态

app.get('/api/session/:id/state', (req, res) => {
  const state = load(req.params.id)
  if (!state) return res.status(404).json({ error: '会话不存在' })

  const lastTurn = [...(state.log || [])].reverse().find((e) => e.type === 'turn' || e.type === 'opening')

  res.json(withUsage(state, {
    phase: state.phase,
    attributeProfiles: state.attributeProfiles,
    identityProfiles: state.identityProfiles,
    timeProfiles: state.timeProfiles || [],
    log: state.log,
    panel: panelSnapshot(state),
    choices: state.phase === 'playing' && lastTurn ? withTrainingOption(lastTurn.choices || [], state) : [],
    actions: state.combat && !state.combat.over ? availableActions(state) : null,
    combat: state.pendingCombat,
    inCombat: state.combat && !state.combat.over
      ? { mode: state.combat.mode, panel: state.combat.log.at(-1) || null, actions: availableActions(state) }
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

  // 读档后要能把最后一批选项还原出来，否则玩家只能靠自由输入继续
  const lastTurn = [...(state.log || [])].reverse().find((e) => e.type === 'turn' || e.type === 'opening')

  res.json(withUsage(state, {
    sessionId: newId,
    phase: state.phase,
    log: state.log,
    choices: lastTurn ? withTrainingOption(lastTurn.choices || [], state) : [],
    panel: panelSnapshot(state),
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
