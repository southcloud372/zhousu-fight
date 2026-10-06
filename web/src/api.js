const J = { 'content-type': 'application/json' }

async function req(url, opts = {}) {
  const r = await fetch(url, opts)
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(t.slice(0, 300) || `HTTP ${r.status}`)
  }
  return r.json()
}

export const newSession = () => req('/api/session', { method: 'POST' })
export const listStorylines = () => req('/api/storylines')
export const listPlayModes = () => req('/api/play-modes')
export const setPlayMode = (id, mode) =>
  req(`/api/session/${id}/play-mode`, { method: 'POST', headers: J, body: JSON.stringify({ mode }) })
export const chooseStoryline = (id, sid, playMode) =>
  req(`/api/session/${id}/choose-storyline`, { method: 'POST', headers: J, body: JSON.stringify({ id: sid, playMode }) })

export const genAttributes = (id) => req(`/api/session/${id}/attributes`, { method: 'POST' })
export const customAttribute = (id, brief) =>
  req(`/api/session/${id}/attributes/custom`, { method: 'POST', headers: J, body: JSON.stringify({ brief }) })
// 玩家逐项改数值。等级由服务端按数字反推，客户端不自己算
export const tuneAttribute = (id, numbers) =>
  req(`/api/session/${id}/attributes/custom/tune`, { method: 'POST', headers: J, body: JSON.stringify({ numbers }) })

export const customIdentity = (id, brief) =>
  req(`/api/session/${id}/identities/custom`, { method: 'POST', headers: J, body: JSON.stringify({ brief }) })
// 第五个身份：突然出现的人。纯引擎构造，不走模型，所以没有 usage
export const suddenIdentity = (id, payload) =>
  req(`/api/session/${id}/identities/sudden`, { method: 'POST', headers: J, body: JSON.stringify(payload) })

export const chooseAttributes = (id, slot) =>
  req(`/api/session/${id}/choose-attributes`, { method: 'POST', headers: J, body: JSON.stringify({ slot }) })
export const chooseIdentity = (id, slot) =>
  req(`/api/session/${id}/choose-identity`, { method: 'POST', headers: J, body: JSON.stringify({ slot }) })
export const customTime = (id, brief) =>
  req(`/api/session/${id}/time/custom`, { method: 'POST', headers: J, body: JSON.stringify({ brief }) })
export const getCrossover = (id) => req(`/api/session/${id}/crossover`)
export const crossoverAdvance = (id, focus) =>
  req(`/api/session/${id}/crossover/advance`, { method: 'POST', headers: J, body: JSON.stringify({ focus }) })

export const chooseTime = (id, pointId) =>
  req(`/api/session/${id}/choose-time`, { method: 'POST', headers: J, body: JSON.stringify({ id: pointId }) })

export const getState = (id) => req(`/api/session/${id}/state`)
export const train = (id, item) =>
  req(`/api/session/${id}/train`, { method: 'POST', headers: J, body: JSON.stringify({ item }) })
export const trainingOptions = (id) => req(`/api/session/${id}/training-options`)

// 疗伤：受伤时选项栏里的【疗伤】。纯引擎结算，不走模型，点完立刻能看到血条变化
export const recoveryOptions = (id) => req(`/api/session/${id}/recovery-options`)
export const recovery = (id, item) =>
  req(`/api/session/${id}/recovery`, { method: 'POST', headers: J, body: JSON.stringify({ id: item }) })

// 战斗向的日常轮盘：两段剧情之间一天一转，练到节点当天再介入
export const getWheel = (id) => req(`/api/session/${id}/wheel`)
export const wheelSpin = (id) => req(`/api/session/${id}/wheel/spin`, { method: 'POST' })
export const wheelAdvance = (id) => req(`/api/session/${id}/wheel/advance`, { method: 'POST' })

// 不占回合的自由行动（反转术式）：回合数不变，敌方不动，回来之后照常出招
export const combatFreeAction = (id, action) =>
  req(`/api/session/${id}/combat/free-action`, { method: 'POST', headers: J, body: JSON.stringify({ action }) })

/**
 * 通用的 SSE 推流。服务端每吐一段事件就回调一次，
 * 前端直接把 narration 追加进去，不需要额外的打字机动画。
 */
async function streamPost(url, body, handlers) {
  const { onNarration, onStatus, onDone, onError, onPanel, onAwaiting, onReset, onUsage, onHighlight } = handlers
  const res = await fetch(url, {
    method: 'POST',
    headers: J,
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    onError?.(new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`))
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    const blocks = carry.split('\n\n')
    carry = blocks.pop() ?? ''
    for (const block of blocks) {
      const evLine = block.split('\n').find((l) => l.startsWith('event:'))
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
      if (!evLine || !dataLine) continue
      const event = evLine.slice(6).trim()
      let data
      try {
        data = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      if (event === 'narration') onNarration?.(data.text)
      else if (event === 'reset') onReset?.()
      else if (event === 'status') onStatus?.(data.text)
      else if (event === 'panel') onPanel?.(data)
      else if (event === 'awaiting') onAwaiting?.(data)
      else if (event === 'highlight') onHighlight?.(data)
      else if (event === 'usage_live') onUsage?.(data)
      else if (event === 'done') onDone?.(data)
      else if (event === 'error') onError?.(new Error(data.message))
    }
  }
}

export const listSaves = () => req('/api/saves')
export const saveGame = (id, name) =>
  req(`/api/session/${id}/save`, { method: 'POST', headers: J, body: JSON.stringify({ name }) })
export const loadSave = (sid) => req(`/api/saves/${sid}/load`, { method: 'POST' })
export const deleteSave = (sid) => req(`/api/saves/${sid}`, { method: 'DELETE' })
export const getLog = (id) => req(`/api/session/${id}/log`)
export const getUsage = (id) => req(`/api/session/${id}/usage`)

/**
 * 清空本机所有数据（进行中的会话 + 全部存档）。
 *
 * 这个字面量必须和服务端 server/engine/wipe.js 里的 WIPE_CONFIRM 一致 ——
 * 构建产物没法和 server/ 共用模块，所以是手抄的一份，改一边要记得改另一边。
 * 服务端不带这个口令会直接 400，不会动手删。
 */
export const WIPE_CONFIRM = '清除'
export const wipeAllData = () =>
  req('/api/data', { method: 'DELETE', headers: J, body: JSON.stringify({ confirm: WIPE_CONFIRM }) })

export const streamTurn = (id, input, h) => streamPost(`/api/session/${id}/turn`, { input }, h)
export const combatStart = (id, mode, h) => streamPost(`/api/session/${id}/combat/start`, { mode }, h)
export const combatAction = (id, action, h) => streamPost(`/api/session/${id}/combat/action`, { action }, h)

export const combatEvade = (id) => req(`/api/session/${id}/combat/evade`, { method: 'POST' })
