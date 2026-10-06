import { callTool, models } from '../llm.js'
import {
  rollAttributeProfile, rollIdentity, rollIdentityKind, rollInitialRelations, TALENT_POOL,
  SUDDEN_ARRIVAL_KIND,
} from './rolls.js'
import {
  CORE_RULES, CONTRACT, attributeFlavorPrompt, identityFlavorPrompt, customTimePrompt,
} from '../prompts.js'
import {
  submitAttributeFlavor, submitIdentityFlavor, submitOpeningScene, submitCustomTime,
} from './schemas.js'
import { buildPlayer, GAME_START_DATE } from './state.js'
import { pointsFor, nodesFor, applyTimeline, byId, firstPoint } from './timeline.js'
import { storylineOf, DEFAULT_STORYLINE } from './storylines.js'
import { playModeOf } from './playmodes.js'
import { npcAttitude } from './visibility.js'
import { normalizeDomainType, defaultDomainTypeFor } from './domains.js'

const baseSystem = (playMode) =>
  [
    CORE_RULES,
    CONTRACT,
    // 开局情境也要遵守游玩模式：战斗向就该一上来就在打
    playMode ? playModeOf(playMode).rules : null,
    `## 可选天赋标签池\n${TALENT_POOL.join('、')}`,
  ].filter(Boolean).join('\n\n---\n\n')

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
  return rolled.map((r) => decorateAttributeFlavor(r, bySlot[r.slot] || {}))
}

/**
 * 数值定好之后，让模型补创意字段（术式名 / 领域 / 天赋 / 玩法提示）。
 *
 * 单独抽出来是因为有两条路径要它：
 *   1. 自定义属性 —— 引擎先掷一份底子，模型按描述写创意部分；
 *   2. 玩家改完数字之后 —— 数字变了等级就可能变，跨进特级还得当场觉醒领域，
 *      这时候必须再问一次模型，否则玩家会带着一个没有名字的领域进游戏。
 *
 * 数字一律是已经定死的，模型只负责写。playerTuned 会把这个事实写进提示词 ——
 * 不写的话，模型会拿"三级不该有这么高的咒术伤害"这套脑补去往回圆。
 */
export async function flavorAttributeProfile(profile, brief, { onUsage, playerTuned = false } = {}) {
  const input = await callWithRetry({
    system: baseSystem(),
    messages: [{ role: 'user', content: attributeFlavorPrompt([profile], { brief, playerTuned }) }],
    tool: submitAttributeFlavor,
    model: models.pro,
    maxTokens: 2500,
    onUsage,
    validate: (x) => allFilled((x?.profiles || []).filter((p) => p.slot === profile.slot), ATTRIBUTE_FIELDS),
    hint: '提交不合格：需要且只需要一份 slot 为「自定义」的档案，techniqueName / techniqueEffect / playstyle 都要填满。请重新提交。',
  })
  const f = (input.profiles || []).find((p) => p.slot === profile.slot) || (input.profiles || [])[0] || {}
  return decorateAttributeFlavor(profile, f, brief)
}

/** 把模型给的创意字段贴回数值档案上。领域解锁与否由引擎决定，模型只填名字与效果 */
function decorateAttributeFlavor(r, f, brief) {
  return {
    ...r,
    techniqueName: f.techniqueName || '未命名术式',
    techniqueEffect: f.techniqueEffect || '',
    techniqueCooldown: clampInt(f.techniqueCooldown, 0, 5, r.techniqueCooldown ?? 1),
    domain: r.domainUnlocked
      ? {
          unlocked: true,
          name: f.domain?.name || '未命名领域',
          sureHit: f.domain?.sureHit || '',
          cost: f.domain?.cost || '',
          tierName: r.domainTierName,
          // 三型之一；模型漏填就按等级名兜（见 domains.js）
          type: normalizeDomainType(f.domain?.type) || defaultDomainTypeFor(r.domainTierName),
        }
      : { unlocked: false },
    talents: (f.talents || []).filter((t) => TALENT_POOL.includes(t)).slice(0, 3),
    playstyle: f.playstyle || '',
    tool: r.toolCount > 0 ? f.tool || null : null,
    ...(brief ? { brief } : {}),
  }
}

/**
 * 自主定义（属性）：玩家写一段想要的风格，引擎掷一份数值底子，
 * 模型按玩家描述生成术式 / 领域 / 天赋。
 *
 * 掷出来的这份不是最终结果 —— 它是**每个数值输入框的默认值**。
 * 玩家可以在界面上逐项改写（见 rolls.js 的 tuneAttributeProfile），
 * 改完的数字会被反推成等级，再回来重走这里补创意字段。
 */
export async function generateCustomAttribute(rng, brief, { onUsage } = {}) {
  return flavorAttributeProfile(rollAttributeProfile(rng, '自定义'), brief, { onUsage })
}

/** 第二步：引擎定身份骨架 → 模型补创意字段 */
export async function generateIdentityProfiles(rng, { onUsage, storyline = DEFAULT_STORYLINE } = {}) {
  const rolled = [0, 1, 2].map((i) => rollIdentity(rng, ['甲', '乙', '丙'][i], rollIdentityKind(rng, i), storyline))
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

/**
 * 自主定义（身份）：玩家写背景，模型按描述写，并自己判定身份类型。
 *
 * 身份类型决定初始关系值（反派向对宿傩有好感、对五条是负的），
 * 所以不能让预设的随机类型卡住玩家的设定 —— 让模型按描述判定，
 * 引擎再按它选的类型重掷关系。
 */
export async function generateCustomIdentity(rng, brief, { onUsage, storyline = DEFAULT_STORYLINE } = {}) {
  // 骨架给一份随机的，模型可以完全改写；kind 由模型按玩家描述重新判定
  const skeleton = rollIdentity(rng, '自定义', rollIdentityKind(rng, 2), storyline)
  const input = await callWithRetry({
    system: baseSystem(),
    messages: [{ role: 'user', content: identityFlavorPrompt([skeleton], { brief, allowKindChoice: true }) }],
    tool: submitIdentityFlavor,
    model: models.pro,
    maxTokens: 2500,
    onUsage,
    validate: (x) => allFilled(
      (x?.identities || []).filter((p) => p.slot === '自定义'),
      IDENTITY_FIELDS,
    ),
    hint: '提交不合格：需要且只需要一份 slot 为「自定义」的身份档案，name / background / mainlineRelation / openingSituation / hook 都要填满（每条至少 8 个字），并给出 kind（原作关联 / 反派向 / 自由派）。请重新提交。',
  })

  const f = (input.identities || []).find((p) => p.slot === '自定义') || (input.identities || [])[0] || {}
  const kind = ['原作关联', '反派向', '自由派'].includes(f.kind) ? f.kind : skeleton.kind

  return {
    slot: '自定义',
    kind,
    age: skeleton.age,
    // 换了类型就按新类型重掷关系值，别让预设类型的关系残留
    initialRelations: rollInitialRelations(rng, kind, storyline),
    name: f.name || '无名',
    background: f.background || brief,
    mainlineRelation: f.mainlineRelation || '',
    openingSituation: f.openingSituation || '',
    hook: f.hook || '',
    brief,
  }
}

/**
 * 第三步：穿越时间三选一。
 * 保底有一份是最开篇（2018年6月·宿傩手指）—— 那是"从零开始"的基准线，
 * 任何时候都得能选到它。另两份从其余时点里随机。
 */
export function rollTimeProfiles(rng, storyline = DEFAULT_STORYLINE) {
  const [first, ...rest] = pointsFor(storyline)
  const picked = []
  const pool = [...rest]
  while (picked.length < 2 && pool.length) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0])
  }
  // 按时间先后排序，读起来更自然
  return [first, ...picked].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 自主定义穿越时间。
 *
 * 关键约束：日期可以自定义，但**原作进度必须继承自某个既有锚点** ——
 * 否则"哪些事件已经发生"就无从算起，整个时间线追踪器会失真。
 * 所以模型同时给出 date（玩家的实际落点）和 anchorId（决定进度与危险度）。
 */
export async function generateCustomTime(brief, { onUsage, storyline = DEFAULT_STORYLINE } = {}) {
  const { input, usage } = await callTool({
    system: baseSystem(),
    messages: [{ role: 'user', content: customTimePrompt(brief, pointsFor(storyline), storylineOf(storyline)) }],
    tool: submitCustomTime,
    model: models.pro,
    maxTokens: 1200,
  })
  onUsage?.(usage)

  // 锚点必须合法，否则退回最开篇 —— 宁可保守也不能让进度状态悬空
  const anchor = byId(input.anchorId, storyline) || firstPoint(storyline)
  const r = storylineOf(storyline).dateRange

  // 日期做范围校验：模型偶尔会算出 2017 或 2020 这种越界值
  let date = String(input.date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    date = anchor.date
  } else if (date < r[0] || date > r[1]) {
    date = anchor.date
  }

  return {
    id: '自定义',
    date,
    label: input.label || `${date} · ${anchor.label.split('·')[1]?.trim() || '自定义'}`,
    when: input.note || anchor.when,
    situation: input.situation || anchor.situation,
    hook: input.hook || anchor.hook,
    nodesDone: [...anchor.nodesDone], // 进度继承自锚点
    danger: anchor.danger,
    dangerLabel: anchor.dangerLabel,
    anchorLabel: anchor.label, // 界面上标明进度取自哪里
    brief,
  }
}

/** 第三步：组合成最终角色并生成开局情境 */
export async function buildCharacterAndOpening(state, attrProfile, identityProfile, timePoint, { onUsage } = {}) {
  const player = buildPlayer(attrProfile, attrProfile, identityProfile, identityProfile)
  state.player = player
  state.relations = { ...identityProfile.initialRelations }
  // 穿越时间决定起始日期与原作进度 —— 不写进去的话这个选择就只是装饰
  if (timePoint) applyTimeline(state, timePoint)
  state.sukuna.fingersEaten = 1

  const relationsForModel = Object.fromEntries(
    Object.entries(state.relations)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => [k, `${npcAttitude(v)}`]),
  )

  /*
   * 「突然出现的人」的开局和其余四个身份不是一回事：他没有处境，只有"出现"。
   * 不写这一段的话，模型会顺手给他补一个来历 —— 那正是玩家选这个身份时要避开的。
   */
  const sudden = identityProfile.kind === SUDDEN_ARRIVAL_KIND
  const suddenBlock = sudden ? `
## 这个身份是「突然出现的人」（必须遵守）

他是**凭空出现的**，不是这条线里的任何一个人：没有户籍、没有咒术界档案、
没有任何人见过他、和所有人关系值为 0（上面那张关系表是空的，那不是漏填）。

- **不要给他编来历。** 不要写他其实是某人的弟子/亲戚/转世/被谁派来的。
  他是谁、从哪来，是这一局的悬念，不是你要在这一段里填掉的坑。
- 开局情境写他**刚落地的那几十秒**：身体还没适应、身上只有原本带着的东西、
  周围的一切都是陌生的。他不知道这里的规矩，这里也不知道有他这个人。
- 场上的人对他的第一反应是**警惕或不解**，不是"你终于来了"。
- 但**不要**写得他只能挨打：他是外来者，不是弱者。他的力量照档案来，
  只是这个世界没有他的名字。
` : ''

  const input = await callWithRetry({
    system: baseSystem(state.playMode),
    tool: submitOpeningScene,
    model: models.pro,
    maxTokens: 4000,
    onUsage,
    validate: (x) => acceptable(x),
    messages: [
      {
        role: 'user',
        content: `## 故事线

**${storylineOf(state.storyline).name}**（${storylineOf(state.storyline).era}）—— ${storylineOf(state.storyline).tagline}

这条线里会出场的角色：${storylineOf(state.storyline).characters.join('、')}
**开局情境里出现的人物必须是这个名单里的人。** 别的时代的人此刻还不存在，或者根本不在场。

## 穿越者最终档案已确定：

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
${suddenBlock}

NPC 当前对他的态度（NPC 只知道态度，不知道好感度数值）：
${JSON.stringify(relationsForModel, null, 2)}

穿越时间：${timePoint ? `${timePoint.label}（${timePoint.date}）` : GAME_START_DATE}
${timePoint ? `此时此刻：${timePoint.when}。${timePoint.situation}\n已经发生：${timePoint.nodesDone.length ? timePoint.nodesDone.join('、') : '（什么都没有，一切尚未开始）'}\n尚未发生：${nodesFor(state.storyline).filter((n) => !timePoint.nodesDone.includes(n)).join('、')}` : '虎杖悠仁即将（或刚刚）吞下第一根宿傩手指。'}

**开局情境必须贴合这个时间点。** 已经发生的事是不可更改的既定事实，
玩家醒来时那些事已经过去了；还没发生的事可以被他改变。
危险度参考：${timePoint ? `${timePoint.dangerLabel}（${timePoint.danger} / 5）` : '序章'}。

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
