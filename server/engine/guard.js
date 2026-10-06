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
 * 原作主要角色不得凭空变成敌人。
 * 模型很容易为了制造冲突把虎杖、伏黑这些人写成敌人，但那需要对应的原作节点
 * 已经发生（比如虎杖被宿傩夺舍要等到少年院任务）。
 * 这里做一次硬拦截：条件不满足就把敌人换成无名咒灵。
 */
export const PROTECTED_CHARACTERS = {
  虎杖悠仁: '宿傩夺舍',
  伏黑惠: '涩谷事变',
  钉崎野蔷薇: '涩谷事变',
  五条悟: '涩谷事变',
  七海建人: '涩谷事变',
  禅院真希: '涩谷事变',
  狗卷棘: '涩谷事变',
  熊猫: '涩谷事变',
  夜蛾正道: '涩谷事变',
}

export function checkEnemyLegality(enemyName, timeline, playerInput = '') {
  for (const [who, requiredNode] of Object.entries(PROTECTED_CHARACTERS)) {
    if (!String(enemyName || '').includes(who)) continue

    // 玩家自己点名要打的，一律放行。
    // 这道护栏是防"模型自作主张把同伴派成敌人"的，不是用来否决玩家的 ——
    // 玩家有权改写任何人的命运，包括原作主角。之前没做这个区分，
    // 导致玩家写"我要杀了虎杖"时敌人被偷偷换成无名咒灵，行动等于没执行。
    //
    // 匹配要宽松：玩家写"杀了虎杖"时不会写全名"虎杖悠仁"，
    // 所以姓氏（前两字）也要认。
    const input = String(playerInput || '')
    if (input && (input.includes(who) || input.includes(who.slice(0, 2)))) {
      return { ok: true, playerInitiated: true }
    }

    const nodeState = timeline?.nodes?.[requiredNode]
    if (nodeState === '已发生' || nodeState === '已改变') {
      return { ok: true } // 对应节点已发生，站在对立面是合理的
    }
    return {
      ok: false,
      reason: `「${who}」不能在这个时间点成为敌人（需要「${requiredNode}」已发生，当前为「${nodeState || '未发生'}」）—— 模型自作主张，玩家没点名`,
    }
  }
  return { ok: true }
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

  const awakeningDelta = Math.max(-10, Math.min(10, num(p.sukunaAwakeningDelta)))

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
    sukunaAwakeningDelta: awakeningDelta,
    deaths,
    flags: Array.isArray(p.flags) ? p.flags.slice(0, 8).map(String) : [],
    timeAdvance: time.value,
    notes,
  }
}
