import { GRADES, isTier } from './tables.js'

/**
 * NPC 视角滤镜。
 * 设定第二节：NPC 只能感知"等级"，看不到数值，也分不清特级内部的强弱。
 * 凡是喂给模型扮演 NPC 的信息，都要先过这里。
 */

/** NPC 眼中的等级：特级一律只显示"特级" */
export function npcGrade(grade) {
  if (isTier(grade)) return '特级'
  return GRADES.includes(grade) ? grade : '不明'
}

/** NPC 眼中的一个战斗单位：只有等级和肉眼可见的状态 */
export function npcView(unit) {
  return {
    等级: npcGrade(unit.grade),
    状态: visibleCondition(unit),
    伤势: visibleWounds(unit),
    领域: unit.domain?.active ? '展开中' : '未展开',
  }
}

function visibleCondition(unit) {
  const r = unit.hp.cur / unit.hp.max
  if (unit.hp.cur <= 0) return '倒下'
  if (r < 0.2) return '摇摇欲坠'
  if (r < 0.6) return '负伤'
  return '尚有余力'
}

function visibleWounds(unit) {
  const r = unit.hp.cur / unit.hp.max
  if (r > 0.9) return '无明显外伤'
  if (r > 0.6) return '身上有几道口子'
  if (r > 0.3) return '血流不止'
  return '重伤，站都站不稳'
}

/** 关系值 → NPC 表现出的态度（第九节：NPC 只体现态度，不见数值） */
export function npcAttitude(value) {
  if (value >= 80) return '推心置腹'
  if (value >= 50) return '信任'
  if (value >= 20) return '友善'
  if (value >= 0) return '客气'
  if (value >= -30) return '疏远'
  if (value >= -60) return '戒备'
  return '敌意'
}

/** 宿傩觉醒度 → 态度标签（第九节第 2 小节） */
export function sukunaAttitude(awakening) {
  if (awakening >= 80) return '敌意'
  if (awakening >= 60) return '警惕'
  if (awakening >= 40) return '感兴趣'
  if (awakening >= 20) return '好奇'
  return '无视'
}
