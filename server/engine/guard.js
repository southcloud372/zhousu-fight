import { TIER_GRADES } from './tables.js'
import { nextMilestone } from './timeline.js'

/**
 * 设定铁律（第七节第 257 行）：NPC 永远只说"特级"，
 * 弱特级/标特级/超特级/龙级 只能出现在玩家可见的面板与旁白里。
 *
 * 模型迟早会犯这个错，所以每次回复都过后处理。
 */

const LEAK_RE = new RegExp(TIER_GRADES.join('|'), 'g')

/** NPC 台词里的特级细分一律降级为"特级" */
export function scrubDialogue(text) {
  if (typeof text !== 'string' || !text) return { text, changed: false }
  if (!LEAK_RE.test(text)) return { text, changed: false }
  LEAK_RE.lastIndex = 0
  return { text: text.replace(LEAK_RE, '特级'), changed: true }
}

/** 旁白允许使用细分，这里只做记录，方便调 prompt 时观察模型倾向 */
export function noteNarrationLeak(text) {
  const m = typeof text === 'string' ? text.match(LEAK_RE) : null
  return m ? [...new Set(m)] : []
}

/** 对整份回合输出做清洗，返回是否改动过 */
export function scrubTurn(turn) {
  let changed = false
  for (const d of turn.dialogue || []) {
    const r = scrubDialogue(d.text)
    if (r.changed) {
      changed = true
      d.text = r.text
    }
  }
  return changed
}

/**
 * 这一手是不是奔着要命去的。
 *
 * 只决定战后那句结算是「击杀」还是「击退」（见 combat.js 的 finishCombat），
 * 不参与掷骰，也不影响伤害 —— 判错顶多是战报措辞不准，不会改写胜负。
 *
 * 两条规则：正面词表命中就算要命，否定说法一票否决。
 * 为什么需要否定词：玩家写「别杀他」时"杀"也在里面，只看正面词就会把一句
 * 求饶读成杀令，战报上于是写着他杀了人 —— 那是引擎替玩家编造他没做过的事。
 *
 * 这里是宽松匹配，不做句法分析。真判错了也不要紧：玩家手里的编辑按钮
 * 能改数值，模型那边也能把"我本来只是打晕"说清楚。
 */
const LETHAL_RE = /杀|宰|干掉|弄死|斩|捅死|毙|取他性命|要他的命|结果了他/
const SPARE_RE = /不要杀|别杀|别下杀手|留他.{0,2}(命|活)|留活口|饶|放他.{0,2}命|不必杀|别弄死/

export function hasLethalIntent(text) {
  const s = String(text || '')
  if (!s) return false
  if (SPARE_RE.test(s)) return false
  return LETHAL_RE.test(s)
}

const TIME_RANK = { 0: 0, '1d': 1, '3d': 3, '1w': 7 }

/**
 * 时间推进的闸门：**不许跨过还没发生的剧情节点**。
 *
 * 战斗向的时间只有一个时钟 —— 轮盘，一天一转。可是剧情回合自己也会带回
 * timeAdvance（模型觉得"这段日子过去了"就写个 1w），日期一旦被推过节点那一天，
 * nextMilestone() 就再也看不到它，missedNodes() 转手把它记成「已发生」——
 * 玩家在轮盘上等了半天的那场仗，就这么无声无息地没了。这是"剧情和轮盘出现的
 * 时机别扭"最伤人的一种：不是时机不对，是内容直接蒸发。
 *
 * 所以按"离下一个节点还有几天"把推进量夹住：走得再快，也只能停在节点当天。
 * 到了当天（daysLeft = 0）一律夹成 0 —— 这一天是留给那场仗的。
 */
function clampTimeAdvance(raw, state) {
  const want = ['1d', '3d', '1w'].includes(raw) ? raw : '0'
  if (want === '0') return { value: '0', clamped: false }

  const ms = nextMilestone(state)
  if (!ms) return { value: want, clamped: false }

  const left = ms.daysLeft
  // 今天就是剧情当天：原地不动，先把这一场打完
  if (left <= 0) return { value: '0', clamped: true }

  const allowed = left >= 7 ? '1w' : left >= 3 ? '3d' : '1d'
  if (TIME_RANK[want] <= TIME_RANK[allowed]) return { value: want, clamped: false }
  return { value: allowed, clamped: true }
}

/**
 * 把模型提议的数值变更夹到合法范围内。
 * 模型可能返回 -99999 的 hpDelta 或超出 ±100 的好感度，这里兜住。
 */
export function clampProposal(proposal, state) {
  const notes = []
  const p = proposal || {}
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  const hpDelta = num(p.hpDelta)
  const ceDelta = num(p.ceDelta)

  // 单回合的擦伤/消耗不该超过总量的 60%，超出说明模型在乱来
  const maxHpSwing = state.player.hp.max * 0.6
  const maxCeSwing = state.player.ce.max * 0.6
  const hp = Math.max(-maxHpSwing, Math.min(maxHpSwing, hpDelta))
  const ce = Math.max(-maxCeSwing, Math.min(maxCeSwing, ceDelta))
  if (Math.abs(hp) !== Math.abs(hpDelta)) notes.push('hpDelta 超限已夹紧')
  if (Math.abs(ce) !== Math.abs(ceDelta)) notes.push('ceDelta 超限已夹紧')

  const relationDelta = {}
  for (const [k, v] of Object.entries(p.relationDelta || {})) {
    const d = Math.max(-15, Math.min(15, num(v))) // 单回合好感度变动上限
    if (d !== 0) relationDelta[k] = d
    if (d !== num(v)) notes.push(`关系值 ${k} 变动超限已夹紧`)
  }

  // 手指是极稀有的事：全篇二十根。一回合最多到手三根、被吞下一根（谁吞的都算），
  // 放宽了模型会拿它当日常奖励发，宿傩的复苏就没了分量。
  const fingersCollected = Math.max(0, Math.min(3, num(p.sukunaFingersCollectedDelta)))
  const fingersEaten = Math.max(0, Math.min(1, num(p.sukunaFingersEatenDelta)))
  const fingersPlayerEaten = Math.max(0, Math.min(1, num(p.sukunaFingersPlayerEatenDelta)))
  if (fingersCollected !== num(p.sukunaFingersCollectedDelta)) notes.push('本回合到手的手指超限已夹紧')
  if (fingersEaten !== num(p.sukunaFingersEatenDelta)) notes.push('本回合容器吞下的手指超限已夹紧')
  if (fingersPlayerEaten !== num(p.sukunaFingersPlayerEatenDelta)) notes.push('本回合玩家吞下的手指超限已夹紧')

  // 死亡是永久事实，引擎自己记一份 —— 光靠模型记住迟早会让人复活
  const deaths = Array.isArray(p.deaths)
    ? p.deaths.slice(0, 5).map((x) => String(x).trim()).filter((x) => x.length >= 2 && x.length <= 12)
    : []

  const time = clampTimeAdvance(p.timeAdvance, state)
  if (time.clamped) {
    notes.push(`时间推进被节点挡住：「${nextMilestone(state)?.node}」就在前面，已改为 ${time.value}`)
  }

  return {
    hpDelta: Math.round(hp),
    ceDelta: Math.round(ce),
    relationDelta,
    sukunaFingersCollectedDelta: fingersCollected,
    sukunaFingersEatenDelta: fingersEaten,
    sukunaFingersPlayerEatenDelta: fingersPlayerEaten,
    deaths,
    flags: Array.isArray(p.flags) ? p.flags.slice(0, 8).map(String) : [],
    timeAdvance: time.value,
    notes,
  }
}
