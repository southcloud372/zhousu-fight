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
export const chooseStoryline = (id, sid) =>
  req(`/api/session/${id}/choose-storyline`, { method: 'POST', headers: J, body: JSON.stringify({ id: sid }) })

export const genAttributes = (id) => req(`/api/session/${id}/attributes`, { method: 'POST' })
export const customAttribute = (id, brief) =>
  req(`/api/session/${id}/attributes/custom`, { method: 'POST', headers: J, body: JSON.stringify({ brief }) })
export const customIdentity = (id, brief) =>
  req(`/api/session/${id}/identities/custom`, { method: 'POST', headers: J, body: JSON.stringify({ brief }) })

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

/**
 * 通用的 SSE 推流。服务端每吐一段事件就回调一次，
 * 前端直接把 narration 追加进去，不需要额外的打字机动画。
 */
async function streamPost(url, body, handlers) {
  const { onNarration, onStatus, onDone, onError, onPanel, onAwaiting, onReset, onUsage } = handlers
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

export const streamTurn = (id, input, h) => streamPost(`/api/session/${id}/turn`, { input }, h)
export const combatStart = (id, mode, h) => streamPost(`/api/session/${id}/combat/start`, { mode }, h)
export const combatAction = (id, action, h) => streamPost(`/api/session/${id}/combat/action`, { action }, h)

export const combatEvade = (id) => req(`/api/session/${id}/combat/evade`, { method: 'POST' })
