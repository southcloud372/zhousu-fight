import { charactersFor } from './timeline.js'
import { advanceTime } from './state.js'
import { hpStatus, REVERSE_TABLE, OUT_OF_COMBAT_HEAL_MULT } from './formula.js'

/**
 * 疗伤。
 *
 * 之前的引擎只有"战斗里出一手反转术式"这一条恢复途径 ——
 * 打完一场重伤回到剧情，血条只能靠模型在旁白里说"你休养了几天"糊过去，
 * 数值一点没动。这里把恢复做成和修炼对称的一套动作：
 * 平时也能疗伤，代价明码标价（咒力 / 一整天 / 欠人情）。
 *
 * 三条路子覆盖三个等级段：
 *   反转术式自愈 —— 会反转术式的人当场解决，烧咒力，不占时间
 *   静养一天     —— 谁都能用，慢，但不要钱
 *   家入硝子     —— 治得最干净，代价是专门跑一趟高专
 */

/**
 * 反转术式的自愈量 / 咒力消耗。
 * 数值来源是 formula.js 的那张唯一档位表 —— 战斗内（combat.js）用原值，
 * 战斗外能静下心来做，回血按 OUT_OF_COMBAT_HEAL_MULT 放大，
 * 咒力消耗不变。"同一招两处不一样"是之前踩过的坑，别再分家。
 */
export const REVERSE_HEAL = Object.fromEntries(
  Object.entries(REVERSE_TABLE).map(([k, r]) => [k, Number((r.heal * OUT_OF_COMBAT_HEAL_MULT).toFixed(3))]),
)

const REST_HEAL = 0.18

/** 反转术式一次要烧多少咒力 —— 面板上要显示，所以单独给出来 */
export function reverseCeCost(player) {
  const row = REVERSE_TABLE[player?.reverseCursedTechnique?.level]
  return Math.round(player.ce.max * (row?.cost ?? 0.25))
}

export function reverseHealAmount(player) {
  const ratio = REVERSE_HEAL[player.reverseCursedTechnique?.level] || 0
  return Math.round(player.hp.max * ratio)
}

const clampHp = (p) => { p.hp.cur = Math.max(0, Math.min(p.hp.max, p.hp.cur)) }

/**
 * 可选的疗伤方式。available 决定它此刻能不能选，理由会显示给玩家 ——
 * 灰着的按钮比"点了没反应"友好得多。
 */
export const RECOVERY_ACTIONS = [
  {
    id: 'reverse',
    name: '反转术式自愈',
    cost: '大量咒力',
    time: '不占时间',
    desc: '把咒力直接转成生命力，当场愈合。',
    available(state) {
      const p = state.player
      if (p.reverseCursedTechnique?.level === '未掌握') return { ok: false, reason: '尚未掌握反转术式' }
      if (p.ce.cur < reverseCeCost(p)) return { ok: false, reason: `咒力不足（需 ${reverseCeCost(p)}）` }
      return { ok: true }
    },
    apply(state) {
      const p = state.player
      const cost = reverseCeCost(p)
      const before = p.hp.cur
      p.ce.cur = Math.max(0, p.ce.cur - cost)
      p.hp.cur = Math.min(p.hp.max, p.hp.cur + reverseHealAmount(p))
      return { healed: p.hp.cur - before, cost, days: 0, notes: ['反转术式把咒力烧成了血肉'] }
    },
  },

  {
    id: 'rest',
    name: '静养一天',
    cost: '一整天',
    time: '1 天',
    desc: '什么都不做，让身体自己长回来。慢，但不烧咒力。',
    available(state) {
      if (state.player.status === '濒死') return { ok: false, reason: '濒死状态下静养撑不过去，必须立刻治疗' }
      return { ok: true }
    },
    apply(state) {
      const p = state.player
      const before = p.hp.cur
      p.hp.cur = Math.min(p.hp.max, p.hp.cur + Math.round(p.hp.max * REST_HEAL))
      advanceTime(state, '1d')
      return { healed: p.hp.cur - before, cost: 0, days: 1, notes: ['睡了一整天，伤口收了口'] }
    },
  },

  {
    id: 'shoko',
    name: '去高专找家入硝子',
    cost: '欠人情',
    time: '1 天',
    desc: '当代最强的反转术式使用者。只要她还活着、还肯搭理你。',
    available(state) {
      if (!charactersFor(state.storyline).includes('家入硝子')) {
        return { ok: false, reason: '这条时间线上没有家入硝子' }
      }
      if ((state.relations['家入硝子'] ?? 0) < -20) return { ok: false, reason: '家入硝子不会替你治' }
      return { ok: true }
    },
    apply(state) {
      const p = state.player
      const before = p.hp.cur
      p.hp.cur = p.hp.max
      advanceTime(state, '1d')
      const cur = state.relations['家入硝子'] ?? 0
      state.relations['家入硝子'] = Math.max(-100, Math.min(100, cur - 2)) // 让她欠着人情，态度降一点
      return {
        healed: p.hp.cur - before,
        cost: 0,
        days: 1,
        notes: ['家入硝子一边抱怨一边把你缝好了', '家入硝子的人情 -2'],
      }
    },
  },
]

export const recoveryById = (id) => RECOVERY_ACTIONS.find((a) => a.id === id) || null

/** 受伤才会出现这个选项（血条低于六成 = 轻伤起） */
export function needsRecovery(state) {
  const p = state.player
  if (!p) return false
  return p.status !== '正常' || p.hp.cur < p.hp.max * 0.6
}

/** 给前端/提示词用的清单 */
export function recoveryOptions(state) {
  return RECOVERY_ACTIONS.map((a) => {
    const gate = a.available(state)
    return {
      id: a.id, name: a.name, cost: a.cost, time: a.time, desc: a.desc,
      enabled: gate.ok, reason: gate.reason || '',
    }
  })
}

/** 执行一次疗伤。数值全部落在这里，模型只写过程。 */
export function applyRecovery(state, id) {
  const action = recoveryById(id)
  if (!action) return null
  const gate = action.available(state)
  if (!gate.ok) return null

  const r = action.apply(state)
  const p = state.player
  p.status = hpStatus(p.hp)

  return {
    id: action.id,
    name: action.name,
    healed: r.healed,
    cost: r.cost,
    days: r.days,
    notes: r.notes || [],
    status: p.status,
    hp: { cur: p.hp.cur, max: p.hp.max },
    ce: { cur: p.ce.cur, max: p.ce.max },
  }
}
