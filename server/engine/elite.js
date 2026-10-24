/**
 * 精英词缀敌人。
 *
 * 同级敌人的战斗打多了是同一个味道 —— 数值表给的是区间，手感是平的。
 * 词缀是给无名敌人（咒灵 / 咒胎 / 诅咒师……）的**战斗性格放大器**：
 * 小概率出现，带一条可读的特殊规则，逼玩家换打法。
 *
 * 两条铁律：
 *   1. **原著人物不吃词缀** —— 五条悟就是五条悟，无下限术式不需要「狂暴」
 *      来加强。canon 校正之后的人，名字和规则都不许再动。
 *   2. 词缀只改**战斗表现**（combat.js 读表生效），不改等级与数值区间
 *      —— 平衡的地基还是 tables.js，词缀是乘在结算上的手感层。
 */

import { gradeIndex } from './tables.js'

export const AFFIXES = {
  狂暴: { desc: '造成的伤害提高 25%' },
  坚壳: { desc: '受到的伤害降低 25%' },
  嗜血: { desc: '攻击命中后，按伤害的三成回复自身' },
  迅捷: { desc: '身法远快于同级：先手与脱离判定占优' },
  再生: { desc: '每一回合结束都缓慢回复自身' },
  御咒: { desc: '受到的术式伤害降低 25%' },
}

export const ELITE_CHANCE = 0.15
export const DUAL_AFFIX_CHANCE = 0.2

/**
 * 战力预估：开打之前的三档判断（占优 / 胶着 / 劣势）。
 *
 * 粗估，不是预言 —— 只把「等级差」和「几轮互换能撂倒谁」的方向性说清，
 * 帮玩家决定打还是跑；真打起来还有暴击、连击、领域、词缀的变数。
 * 词缀的乘区方向与 combat.js 的结算一致（狂暴加敌方输出、坚壳减玩家输出、
 * 嗜血拉长敌方耐受）。
 */
export function battleForecast(player, enemy) {
  const diff = gradeIndex(player?.grade) - gradeIndex(enemy?.grade)
  let pOut = (player?.cursedDamage?.value || 0) * 1.5 + (player?.physicalDamage?.value || 0)
  let eOut = (enemy?.cursedDamage?.value || 0) * 1.5 + (enemy?.physicalDamage?.value || 0)
  if (enemy?.affixes?.includes('狂暴')) eOut *= 1.25
  if (enemy?.affixes?.includes('坚壳')) pOut *= 0.75

  let eTtk = (player?.hp?.cur || 1) / Math.max(1, eOut)
  if (enemy?.affixes?.includes('嗜血')) eTtk *= 1.15
  const pTtk = (enemy?.hp?.max || 1) / Math.max(1, pOut)
  const ratio = eTtk / Math.max(0.01, pTtk)

  let verdict, tone
  if (ratio >= 1.6 || diff >= 1) { verdict = '占优'; tone = 'ok' }
  else if (ratio <= 0.6 || diff <= -1) { verdict = '劣势'; tone = 'danger' }
  else { verdict = '胶着'; tone = 'warn' }
  return { verdict, tone, ratio: Number(ratio.toFixed(2)), levelDiff: diff, barrier: enemy?.barrier || null }
}

/**
 * 掷一次精英化。不是精英就原样返回（同一引用，调用方无感）。
 * 必须在 canon 校正**之后**调用：canon 敌人直接跳过，无名敌人在名字定下后
 * 再挂前缀 —— 顺序反了会被 applyCanon 把名字改回去。
 */
export function maybeElite(rng, enemy) {
  if (!enemy || enemy.canon) return enemy
  if (rng() >= ELITE_CHANCE) return enemy

  const pool = Object.keys(AFFIXES)
  const pick = () => pool[Math.floor(rng() * pool.length) % pool.length]
  const first = pick()
  enemy.affixes = [first]
  if (rng() < DUAL_AFFIX_CHANCE) {
    const second = pick()
    if (second !== first) enemy.affixes.push(second)
  }

  enemy.name = `${enemy.affixes.join('')}·${enemy.name}`
  enemy.affixDesc = enemy.affixes.map((a) => `${a}（${AFFIXES[a].desc}）`).join('、')
  return enemy
}

/** 词缀的战力修正方向（给预估用的乘区，与 combat.js 的结算同一套系数） */
export const AFFIX_COMBAT = {
  狂暴: { outMul: 1.25 },
  坚壳: { inMul: 0.75 },
  嗜血: { sustain: 1.15 },
}
