import { callTool, models } from '../llm.js'
import { rollAttributeProfile, rollIdentity, rollIdentityKind, TALENT_POOL } from './rolls.js'
import { CORE_RULES, CONTRACT, attributeFlavorPrompt, identityFlavorPrompt } from '../prompts.js'
import { submitAttributeFlavor, submitIdentityFlavor, submitOpeningScene } from './schemas.js'
import { buildPlayer } from './state.js'
import { npcAttitude } from './visibility.js'

const baseSystem = () =>
  [
    CORE_RULES,
    CONTRACT,
    `## 可选天赋标签池\n${TALENT_POOL.join('、')}`,
  ].join('\n\n---\n\n')

/**
 * 模型偶尔会交回一份空壳（正文 0 字、选项 0 个），实测端到端自检时撞到过一次。
 * 关键输出不能就这么交给玩家 —— 重试一轮，并把"上次哪里不合格"讲清楚。
 */
const RETRY_HINT = '上一次的提交不合格：narration 是空的，或者 choices 少于 3 个。请重新提交一份完整的输出。'

export function acceptable(input, { minNarration = 80, minChoices = 3 } = {}) {
  return (
    typeof input?.narration === 'string' &&
    input.narration.trim().length >= minNarration &&
    Array.isArray(input.choices) &&
    input.choices.filter((c) => String(c || '').trim()).length >= minChoices
  )
}

/**
 * 三份档案是否都填齐了。
 *
 * 每个字段的长度门槛不一样 —— 姓名本来就只有两三个字。
 * 早先给所有字段统一要求 ≥8 字，结果**每次开局的正常输出都会被判不合格**，
 * 白白重试三次，成本直接三倍。这个坑是单元测试抓到的。
 */
export function allFilled(list, spec) {
  if (!Array.isArray(list) || list.length < 3) return false
  return list.every((x) =>
    Object.entries(spec).every(([f, min]) => typeof x?.[f] === 'string' && x[f].trim().length >= min),
  )
}

/** 字段 → 最短长度。姓名门槛低，其余要求是成句的描述 */
export const IDENTITY_FIELDS = {
  name: 2, background: 10, mainlineRelation: 8, openingSituation: 8, hook: 10,
}
export const ATTRIBUTE_FIELDS = {
  techniqueName: 2, techniqueEffect: 10, playstyle: 6,
}

/**
 * 带校验的重试。
 *
 * 这个端点（实测 flash）偶尔会交回残件 —— 正文 0 字、选项 0 个、
 * 或者身份档案漏掉钩子。关键输出不能就这么交给玩家，重试一轮并说明哪里不合格。
 * 每次重试都是真花钱的，所以 onUsage 每次都要调。
 */
async function callWithRetry({ system, messages, tool, model, maxTokens, attempts = 3, validate, hint = RETRY_HINT, onUsage }) {
  let last = null
  let convo = messages
  for (let i = 0; i < attempts; i++) {
    const { input, usage } = await callTool({ system, messages: convo, tool, model, maxTokens })
    onUsage?.(usage)
    last = input
    if (validate(input)) return input
    convo = [...messages, { role: 'assistant', content: '（上一次提交不合格，需要重做）' }, { role: 'user', content: hint }]
  }
  return last // 重试都用光了就先用着，至少别把玩家卡死
}

/** 第一步：引擎掷三份属性 → 模型补创意字段 */
export async function generateAttributeProfiles(rng, { onUsage } = {}) {
  const rolled = ['A', 'B', 'C'].map((s) => rollAttributeProfile(rng, s))
  const input = await callWithRetry({
    system: baseSystem(),
    messages: [{ role: 'user', content: attributeFlavorPrompt(rolled) }],
    tool: submitAttributeFlavor,
    model: models.pro,
    maxTokens: 3500,
    onUsage,
    validate: (x) => allFilled((x?.profiles || []).filter((p) => rolled.some((r) => r.slot === p.slot)), ATTRIBUTE_FIELDS),
    hint: '上一次提交的三份属性档案不完整：slot / techniqueName / techniqueEffect / playstyle 都必须填，且文字不能太短。请重新提交完整的三份。',
  })
  const bySlot = Object.fromEntries((input.profiles || []).map((p) => [p.slot, p]))
  return rolled.map((r) => {
    const f = bySlot[r.slot] || {}
    return {
      ...r,
      techniqueName: f.techniqueName || '未命名术式',
      techniqueEffect: f.techniqueEffect || '',
      techniqueCooldown: clampInt(f.techniqueCooldown, 0, 5, 1),
      // 领域是否解锁由引擎决定，模型只填名字与效果
      domain: r.domainUnlocked
        ? {
            unlocked: true,
            name: f.domain?.name || '未命名领域',
            sureHit: f.domain?.sureHit || '',
            cost: f.domain?.cost || '',
            tierName: r.domainTierName,
          }
        : { unlocked: false },
      talents: (f.talents || []).filter((t) => TALENT_POOL.includes(t)).slice(0, 3),
      playstyle: f.playstyle || '',
      tool: r.toolCount > 0 ? f.tool || null : null,
    }
  })
}

/** 第二步：引擎定身份骨架 → 模型补创意字段 */
export async function generateIdentityProfiles(rng, { onUsage } = {}) {
  const rolled = [0, 1, 2].map((i) => rollIdentity(rng, ['甲', '乙', '丙'][i], rollIdentityKind(rng, i)))
  const input = await callWithRetry({
    system: baseSystem(),
    messages: [{ role: 'user', content: identityFlavorPrompt(rolled) }],
    tool: submitIdentityFlavor,
    model: models.pro,
    maxTokens: 3000,
    onUsage,
    validate: (x) => allFilled((x?.identities || []).filter((p) => rolled.some((r) => r.slot === p.slot)), IDENTITY_FIELDS),
    hint: '上一次提交的三份身份档案不完整：name / background / mainlineRelation / openingSituation / hook 都必须填，且每条至少 8 个字。请重新提交完整的三份。',
  })
  const bySlot = Object.fromEntries((input.identities || []).map((p) => [p.slot, p]))
  return rolled.map((r) => {
    const f = bySlot[r.slot] || {}
    return {
      ...r,
      name: f.name || '无名',
      background: f.background || r.backgroundTemplate,
      mainlineRelation: f.mainlineRelation || '',
      openingSituation: f.openingSituation || '',
      hook: f.hook || '',
    }
  })
}

/** 第三步：组合成最终角色并生成开局情境 */
export async function buildCharacterAndOpening(state, attrProfile, identityProfile, { onUsage } = {}) {
  const player = buildPlayer(attrProfile, attrProfile, identityProfile, identityProfile)
  state.player = player
  state.relations = { ...identityProfile.initialRelations }
  state.sukuna.fingersEaten = 1

  const relationsForModel = Object.fromEntries(
    Object.entries(state.relations)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => [k, `${npcAttitude(v)}`]),
  )

  const input = await callWithRetry({
    system: baseSystem(),
    tool: submitOpeningScene,
    model: models.pro,
    maxTokens: 4000,
    onUsage,
    validate: (x) => acceptable(x),
    messages: [
      {
        role: 'user',
        content: `穿越者最终档案已确定：

姓名：${player.name}　年龄：${player.age}
背景类型：${player.backgroundType}
背景：${player.background}
综合等级：${player.grade}
生得术式：${player.technique.name}（${player.technique.effect}）
领域：${player.domain.unlocked ? `${player.domain.name}（${player.domain.tierName}）必中效果：${player.domain.sureHit}　代价：${player.domain.cost}` : '未领悟'}
反转术式：${player.reverseCursedTechnique.level}
咒具：${player.tools.map((t) => t.name).join('、') || '无'}
天赋标签：${player.talents.join('、') || '无'}
与主线关系：${player.mainlineRelation}
开局处境：${player.openingSituation}
特殊钩子：${player.hook}

NPC 当前对他的态度（NPC 只知道态度，不知道好感度数值）：
${JSON.stringify(relationsForModel, null, 2)}

现在是 2018 年 6 月 5 日，虎杖悠仁即将（或刚刚）吞下第一根宿傩手指。

请生成开局情境：**直接切入战斗或高张力冲突，不要铺垫、不要介绍世界设定。** 让玩家一上来就处在必须立刻做决定的位置。`,
      },
    ],
  })

  return input
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(v) ? Math.round(v) : dflt
  return Math.max(lo, Math.min(hi, n))
}
