import { rfloat } from './dice.js'
import { advanceTime } from './state.js'

/**
 * "跳过当天，进行修炼"（第八节第 8 小节）。
 * 进度区间照抄第八节第 1 小节的表；判定由引擎掷，模型只写一两句过程描写。
 */
export const TRAINING_TABLE = {
  体能训练: { range: [0.15, 0.25], targets: ['hp', 'physicalDamage'], cost: '体力' },
  咒力冥想: { range: [0.10, 0.20], targets: ['ce', 'efficiency'], cost: '时间', needQuiet: true },
  术式演练: { range: [0.10, 0.18], targets: ['cursedDamage', 'techniqueMastery'], cost: '咒力', needTechnique: true },
  反转术式修习: { range: [0.08, 0.15], targets: ['reverseCursedTechnique'], cost: '大量咒力', needReverse: true },
  领域雏形冥想: { range: [0.05, 0.12], targets: ['domainProgress'], cost: '大量咒力+精神', needDomainShard: true },
  体术实战: { range: [0.12, 0.20], targets: ['physicalDamage'], cost: '体力+可能受伤', needPartner: true },
}

/** 天赋标签带来的额外加成（第八节第 1 小节）。轮盘也按这张表加权，别改坏了 */
export const TALENT_BONUS = {
  战斗直觉: ['体术实战', '体能训练'],
  咒力感知异常: ['咒力冥想', '领域雏形冥想'],
  命硬: ['体术实战', '体能训练'],
  咒力操作精细: ['术式演练', '咒力冥想'],
  体术天赋: ['体能训练', '体术实战'],
  抗痛性强: ['体能训练', '体术实战'],
  临战冷静: ['术式演练'],
  爆发型: ['术式演练'],
  续航型: ['咒力冥想'],
  反转适性: ['反转术式修习'],
  领域感知: ['领域雏形冥想'],
}

export function canTrain(state) {
  const p = state.player
  if (!p) return { ok: false, reason: '还没有角色' }
  if (['濒死', '重伤'].includes(p.status)) return { ok: false, reason: `${p.status}状态下无法修炼` }
  if (state.time.skipStreak >= 3) return { ok: false, reason: '已连续跳过 3 天，今天必须参与剧情或任务' }
  // 设定里只有"关键剧情节点当天"禁用（少年院任务、涩谷事变、死灭回游等）。
  // 普通遭遇战不在此列 —— 早先按 pendingCombat 禁用是过度限制。
  if (state.storyLock) return { ok: false, reason: `关键节点「${state.storyLock}」当天无法跳过` }
  if (state.sukuna?.possession) return { ok: false, reason: '宿傩夺舍期间无法修炼' }
  return { ok: true }
}

/**
 * 掷一次修炼。返回值只是提议，applyTraining 才会真正改数值。
 */
export function rollTraining(state, item, rng) {
  const row = TRAINING_TABLE[item]
  if (!row) return null

  let [lo, hi] = row.range
  const notes = []

  // 天赋加成
  const bonusTalents = (state.player.talents || []).filter((t) => (TALENT_BONUS[t] || []).includes(item))
  if (bonusTalents.length) {
    lo += 0.03
    hi += 0.03
    notes.push(`天赋「${bonusTalents.join('、')}」提供额外进度`)
  }

  // 连续修炼同一项递减（第八节第 1 小节）
  const repeats = state.player.training[item] > 60 ? 1 : 0
  if (repeats) {
    lo *= 0.85
    hi *= 0.85
    notes.push('连续修炼同一项目，效果递减')
  }

  // 重伤未愈会拖慢进度
  if (state.player.status === '轻伤') {
    lo *= 0.9
    hi *= 0.9
    notes.push('带伤修炼，效率下降')
  }

  const progress = Number(rfloat(rng, lo, hi).toFixed(4))

  // 体术实战有受伤风险
  let hpDelta = 0
  if (item === '体术实战' && rng() < 0.3) {
    hpDelta = -Math.round(state.player.hp.max * rfloat(rng, 0.02, 0.08))
    notes.push('对练中挨了结实的一下')
  }

  return { item, progress, hpDelta, notes, targets: row.targets }
}

/** 进度满 100% 时数值 +10%。等级本身没有突破门槛，堆够了就升 */
export function applyTraining(state, result) {
  const p = state.player
  const ups = []
  const add = (p.training[result.item] || 0) + result.progress * 100
  p.training[result.item] = Math.round(add * 10) / 10 // 保留一位小数，避免 25.009999999999998 这种显示

  while (p.training[result.item] >= 100) {
    p.training[result.item] -= 100
    for (const t of result.targets) {
      if (t === 'hp') {
        p.hp.max = Math.round(p.hp.max * 1.1)
        p.hp.cur = Math.min(p.hp.max, Math.round(p.hp.cur * 1.1))
        ups.push(`血条上限 → ${p.hp.max}`)
      } else if (t === 'ce') {
        p.ce.max = Math.round(p.ce.max * 1.1)
        p.ce.cur = Math.min(p.ce.max, Math.round(p.ce.cur * 1.1))
        ups.push(`咒力上限 → ${p.ce.max}`)
      } else if (t === 'cursedDamage') {
        p.cursedDamage.value = Math.round(p.cursedDamage.value * 1.1)
        ups.push(`咒术伤害 → ${p.cursedDamage.value}`)
      } else if (t === 'physicalDamage') {
        p.physicalDamage.value = Math.round(p.physicalDamage.value * 1.1)
        ups.push(`体术伤害 → ${p.physicalDamage.value}`)
      } else if (t === 'efficiency') {
        p.efficiency.value = Number((p.efficiency.value * 1.05).toFixed(2))
        ups.push(`咒力效率 → ${(p.efficiency.value * 100).toFixed(0)}%`)
      } else if (t === 'techniqueMastery') {
        p.technique.mastery = Math.min(1, (p.technique.mastery || 0) + 0.1)
        ups.push(`术式熟练度 → ${Math.round(p.technique.mastery * 100)}%`)
      } else if (t === 'domainProgress') {
        // 这条以前是空的：领域雏形冥想练满 100% 也不会有任何变化，
        // 等于白花一天。改成推进 domain.progress（只到 99%，领悟仍走第五节的四种契机）。
        const d = p.domain
        if (d.unlocked) {
          ups.push('领域已领悟，冥想只能算温养')
        } else {
          d.progress = Math.min(99, (d.progress || 0) + 10)
          ups.push(d.progress >= 90
            ? `领域雏形进度 ${d.progress}%（只差一次契机）`
            : `领域雏形进度 → ${d.progress}%`)
        }
      } else if (t === 'reverseCursedTechnique') {
        p.reverseCursedTechnique.progress = Math.min(100, p.reverseCursedTechnique.progress + 10)
        if (p.reverseCursedTechnique.progress >= 100 && p.reverseCursedTechnique.level === '未掌握') {
          p.reverseCursedTechnique.level = '初步'
          p.reverseCursedTechnique.progress = 0
          ups.push('反转术式 → 初步')
        } else {
          ups.push(`反转术式进度 → ${p.reverseCursedTechnique.progress}%`)
        }
      }
    }
  }

  if (result.hpDelta) {
    p.hp.cur = Math.max(0, Math.min(p.hp.max, p.hp.cur + result.hpDelta))
  }

  state.time.skipStreak += 1
  advanceTime(state, '1d')
  return ups
}

