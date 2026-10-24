import { PRESETS, presetOf, presetProfile, presetIdentity } from './localpresets.js'
import { buildPlayer } from './state.js'
import { applyTimeline, initialNodes, nextMilestone, byId, firstPoint, charactersFor, REWRITTEN } from './timeline.js'
import { PLAY_MODES } from './playmodes.js'
import { nodeDescOf } from './storylines.js'
import { canonFlavorFor } from './canon.js'
import { GRADES } from './tables.js'
import { interventionGrade } from './wheel.js'
import { hpStatus } from './formula.js'
import { rint, weightedPick } from './dice.js'

/**
 * 本地叙事引擎。
 *
 * token 模式里「叙事」归模型；本地模式把这一层换成三样东西：
 *   1. 预设剧情的节拍机（localpresets.js 的四拍 arc）
 *   2. 自由行动的意图识别（关键词 → 少量几种引擎化的回应）
 *   3. 程序化续写（arc 走完之后，按原作节点排期一天天把大戏推到面前）
 *
 * 数值一概不在这里算：所有效果都以「提议」的形式交给 postProcess →
 * clampProposal → applyProposal，和模型提议走同一条管线、同一套夹紧。
 * 本地模式没有权限绕过护栏 —— 它只是另一个「提建议的」。
 *
 * 输出形状刻意与模型的回合输出（submitTurn 的 schema）一致，
 * 所以 index.js 里两个模式只差「raw 从哪来」，后面的处理完全共用。
 */

// ---------------------------------------------------------------- 开局

/**
 * 用一套预设直接组装整局：故事线、角色、关系、时间线进度一次到位。
 * 等价于 token 模式的「选线 → 掷属性 → 补身份 → 选时间点 → 生成开局」五步，
 * 只是每一步的答案都已经写在预设里 —— 也就没有一次模型调用。
 */
export function startPresetSession(state, presetId, playMode) {
  const preset = presetOf(presetId)
  if (!preset) return null
  const point = byId(preset.at, preset.line) || firstPoint(preset.line)
  if (PLAY_MODES[playMode]) state.playMode = playMode

  state.storyline = preset.line
  state.timeline.nodes = initialNodes(preset.line)
  const profile = presetProfile(preset)
  const identity = presetIdentity(preset)
  state.player = buildPlayer(profile, profile, identity, identity)
  state.relations = { ...identity.initialRelations }
  applyTimeline(state, point)

  state.local = { presetId: preset.id, beat: 0, improv: 0, arcDone: false, pending: null }
  state.phase = 'playing'
  state.turn = 1
  return openingRaw(state)
}

/** 开局正文：时间点的处境压在第一拍正文前面 —— 一句话定场，再进戏 */
function openingRaw(state) {
  const preset = presetOf(state.local.presetId)
  const point = byId(preset.at, preset.line) || firstPoint(preset.line)
  const beat = preset.beats[0]
  return {
    narration: `${point.situation}\n\n${beat.n}`,
    recap: beat.r,
    dialogue: beat.d,
    choices: beat.c.map((c) => c.label),
    proposal: emptyProposal(),
  }
}

function emptyProposal() {
  return {
    hpDelta: 0, ceDelta: 0, relationDelta: {},
    sukunaFingersCollectedDelta: 0, sukunaFingersEatenDelta: 0, sukunaFingersPlayerEatenDelta: 0,
    deaths: [], flags: [], timeAdvance: '0',
  }
}

// ---------------------------------------------------------------- 回合

/** 本地模式的回合推演：输入玩家的行动文本，产出与模型同形状的 raw */
export function localTurn(state, input, rng) {
  const text = String(input || '').replace(/^【我的行动】/, '').trim()

  // 前端在战斗结算 / 修炼 / 疗伤 / 脱离 / 跨篇之后会补一个静默回合规剧情（括号开头）。
  // 这些是「世界继续走」的信号，不是玩家的行动 —— 单独分流。
  if (text.startsWith('（')) return bridgeTurn(state, text, rng)
  if (!state.local.arcDone) return arcTurn(state, text, rng)
  return proceduralTurn(state, text, rng)
}

// ---------------- 预设剧情：节拍机

function arcTurn(state, text, rng) {
  const L = state.local
  const preset = presetOf(L.presetId)
  const beat = preset.beats[L.beat]
  const hit = matchChoice(beat.c, text)

  if (hit) {
    // 战斗选项：先挂遭遇（postProcess 会掷敌人、弹"要不要打"），节拍停住——
    // 打完的桥接回合再翻页。和 token 模式里"模型本回合带 combatRequest"同构。
    if (hit.k) {
      const speech = canonDialogue(hit.k.n, rng)
      return {
        narration: clashNarration(hit.k),
        recap: `${hit.k.n}（${hit.k.g}）拦在面前`,
        dialogue: speech.length ? speech : beat.d.slice(0, 1),
        choices: [],
        proposal: proposalOf(hit),
        combatRequest: combatRequestOf(hit.k),
      }
    }
    L.beat += 1
    L.improv = 0
    // 最后一拍的选项选完 = 预设剧情落幕，程序化续写从这儿接手。
    // 注意这一手的效果（尤其是 timeAdvance）不能跟着落幕被丢掉 ——
    // 预设的收尾选项常常自带几天推进，丢了它，节点倒计时就会凭空多出几天。
    if (L.beat >= preset.beats.length) {
      L.arcDone = true
      return proceduralTurn(state, '', rng, '', proposalOf(hit))
    }
    return beatRaw(state, preset.beats[L.beat], proposalOf(hit))
  }

  return improvise(state, beat, text, rng)
}

/** 匹配选项：全等 > 选项包含输入 > 输入包含选项的开头。自由文本不受此限 */
function matchChoice(choices, text) {
  if (!text) return null
  return choices.find((c) => c.label === text)
    || choices.find((c) => c.label.includes(text) && text.length >= 2)
    || choices.find((c) => text.includes(c.label.slice(0, 8)) && c.label.length >= 8)
}

function beatRaw(state, beat, proposal) {
  return {
    narration: beat.n,
    recap: beat.r,
    dialogue: beat.d,
    choices: beat.c.map((c) => c.label),
    proposal,
  }
}

function proposalOf(choice) {
  return {
    ...emptyProposal(),
    hpDelta: choice.hp || 0,
    ceDelta: choice.ce || 0,
    relationDelta: choice.rel || {},
    sukunaFingersCollectedDelta: choice.fg?.col || 0,
    sukunaFingersEatenDelta: choice.fg?.eaten || 0,
    sukunaFingersPlayerEatenDelta: choice.fg?.mine || 0,
    flags: choice.flags || [],
    timeAdvance: choice.time || '0',
  }
}

function combatRequestOf(k) {
  return {
    enemyGrade: k.g,
    enemyName: k.n,
    enemyTechniqueName: k.t,
    enemyTechniqueEffect: k.e || '',
    reason: k.why || `${k.n}挡在面前`,
    // 介入的节点名：打完由 finishCombat/completeIntervention 把那一天记进时间线
    intervention: k.node || null,
  }
}

/** 开打那一拍的正文 */
function clashNarration(k) {
  return [
    `${k.why}。`,
    `${k.n}（${k.g}）没有留出绕开的余地——${k.t}的预兆已经在空气里拧紧。`,
    '脚下的影子先动了半步。这一仗，躲不过去了。',
  ].join('')
}

/**
 * 原作对手的开口：从声线卡里抽一句。
 * 本地模式没有模型替原作人物找腔调 —— 名字是五条悟，话就得像五条悟。
 * 不是原作人物（或没配声线）就闭嘴，别硬编。
 */
function canonDialogue(name, rng) {
  const f = canonFlavorFor(name)
  if (!f || !f.lines?.length) return []
  return [{ speaker: f.name, text: f.lines[rint(rng, 0, f.lines.length - 1)] }]
}

// ---------------- 自由行动：意图识别

const INTENT = {
  // 「打出去」「打一场」这类口语也算攻击意图；单纯一个「打」字太宽，不放进来
  fight: /杀|斩|砍|攻击|出手|动手|揍|交手|迎战|开打|挑衅|袭|打[它他她出去一场]/,
  talk: /问|说|谈|告诉|劝|打听|聊|喊|叫|套话/,
  flee: /逃|离开|撤退|躲开|绕开|绕过/,
  train: /修炼|锻炼|训练|练一/,
  look: /看|观察|调查|搜|侦查|查|探|翻/,
}

/**
 * 玩家自己写的行动。本地模式没有模型替他圆场，所以只做四件事：
 * 识别意图 → 套模板 → 给一点**有节制**的数值回应 → 把当前选项摆回去。
 * 连续两次自由行动后自动翻页：本地剧情只有四拍，故事不能永远停在原地
 * 等一个「正确的按钮」——翻页时这一手的回响接在下一拍正文前面。
 */
function improvise(state, beat, text, rng) {
  const L = state.local
  const p = state.player
  const pick = (arr) => arr[rint(rng, 0, arr.length - 1)]

  // 想修炼的，指去正规入口（下面的选项栏里挂着「跳过当天·修炼」）
  if (INTENT.train.test(text)) {
    return {
      narration: '这个念头值得认真对待——但修炼不是顺手的插曲。下面的选项栏里有一项「跳过当天，进行修炼」，那里才是把一整天沉进去的地方。',
      recap: '想修炼：走修炼入口',
      dialogue: [],
      choices: beat.c.map((c) => c.label),
      proposal: emptyProposal(),
    }
  }

  // 对着带战斗选项的节拍直接写「动手」：等同选了那一项
  if (INTENT.fight.test(text)) {
    const target = beat.c.find((c) => c.k)
    if (target) {
      return {
        narration: `你不再等选项里的措辞——${text}。${target.k.why}，${target.k.n}（${target.k.g}）接下了这一手，剩下的只能用手上功夫说清楚。`,
        recap: `主动向${target.k.n}出手`,
        dialogue: canonDialogue(target.k.n, rng),
        choices: [],
        proposal: { ...emptyProposal(), hpDelta: -Math.round(p.hp.max * 0.02) },
        combatRequest: combatRequestOf(target.k),
      }
    }
  }

  // 其余意图：各给一套模板与一点数值回应
  let line, recap, dialogue = [], proposal = emptyProposal()
  if (INTENT.fight.test(text)) {
    line = pick([
      `你照着念头出了手。${text}——空气被咒力划开，但没有东西接招。招式落在空处，反而把周围蛰伏的气息惊动了一圈，有什么东西记下了你这一手。`,
      `${text}。手比脑子快，出手之后你才发现眼前没有敌人——只有被搅乱的咒力尘埃缓缓落回地面，和远处一道一闪而逝的注视。`,
    ])
    recap = '出手，但落空了'
    proposal = { ...proposal, ceDelta: -Math.round(p.ce.max * 0.04), hpDelta: -Math.round(p.hp.max * 0.01) }
  } else if (INTENT.talk.test(text)) {
    const relNames = Object.keys(state.relations)
    const who = relNames.length ? relNames[rint(rng, 0, relNames.length - 1)] : null
    line = pick([
      `你把话递了出去。${text}——对方听完，神色松了一线，又警惕了一线：这条线上愿意听你说话的人，本来就不多，所以每一个字都算数。`,
      `${text}。话说出口才意识到轻重，但对方接住了，还回了一句你没想到的话。这段对话的分量，往后还会显出来。`,
    ])
    recap = '一场对话'
    dialogue = who ? [{ speaker: who, text: pick(['「……你的话，我记下了。」', '「说完了？那就轮到我了。」', '「这种事，别在外面讲。」']) }] : []
    proposal = { ...proposal, relationDelta: who ? { [who]: rint(rng, 1, 4) } : {} }
  } else if (INTENT.flee.test(text)) {
    line = pick([
      `你收了势，从眼前的局里抽身。${text}——街角的灯次第熄灭，身后的气息没有追来，但也没有散：这一手只是把账期往后挪了挪。`,
      `${text}。退开的每一步都数得清楚，等呼吸落回胸腔，你已经站在了两条街之外。事情没解决，但你在。`,
    ])
    recap = '暂时抽身'
    proposal = { ...proposal, timeAdvance: '1d' }
  } else if (INTENT.look.test(text)) {
    line = pick([
      `你压低身形，把眼前的一切重新过了一遍。${text}——看出来的东西不多，但有一条有用：这里的布局，是给「之后」准备的，而「之后」不远了。`,
      `${text}。细节一层层剥开：痕迹、位置、留白，还有不该出现在这里的东西留下的那点余温。拼不出全貌，但足够确定一件事——下一步踩错，代价不小。`,
    ])
    recap = '查勘一线'
    proposal = { ...proposal, ceDelta: -Math.round(p.ce.max * 0.02) }
  } else {
    line = pick([
      `${text}——你做了。这个世界没有替你圆场的旁白，只有被你的动作惊起的一圈涟漪：有人停了半步，有什么东西记下了这一手，包括你自己。`,
      `你按自己的意思动了。${text}。结果落在预料和意外之间，但至少，这一手是你自己的——这条线上，这样的事不多见。`,
    ])
    recap = '自行其是的一手'
    proposal = { ...proposal, ceDelta: -Math.round(p.ce.max * 0.01) }
  }

  // 第二次自由行动：故事翻页，这一手的回响接在下一拍前面
  L.improv += 1
  const preset = presetOf(L.presetId)
  if (L.improv >= 2) {
    L.improv = 0
    L.beat += 1
    if (L.beat >= preset.beats.length) {
      L.arcDone = true
      return proceduralTurn(state, '', rng, line, proposal)
    }
    const nextBeat = preset.beats[L.beat]
    return {
      narration: `${line}\n\n${nextBeat.n}`,
      recap: nextBeat.r,
      dialogue: nextBeat.d,
      choices: nextBeat.c.map((c) => c.label),
      proposal,
    }
  }
  return { narration: line, recap, dialogue, choices: beat.c.map((c) => c.label), proposal }
}

// ---------------- 桥接回合（静默输入）

const BRIDGE = {
  combat: '（战斗已结算完毕',      // 打完一场，主循环接着演
  evade: '（已脱离遭遇',          // 没打就走了
  train: '（跳过当天，进行',      // 修炼了一天
  heal: '（处理身上的伤',         // 疗了伤
  crossover: '（跨越数年，进入新的篇章', // 跨篇了
}

function bridgeTurn(state, text, rng) {
  const L = state.local
  const preset = presetOf(L.presetId)

  if (text.startsWith(BRIDGE.train)) {
    const item = text.replace(BRIDGE.train, '').replace('修炼）', '') || '修炼'
    return {
      narration: `一整天沉进了「${item}」。等你再抬头，日光已经斜了——汗水落地的声音之外，这条线上的事没有一件停下来。眼前的问题还在原地等你。`,
      recap: '修炼了一天',
      dialogue: [],
      choices: currentChoices(state, preset),
      proposal: emptyProposal(),
    }
  }

  if (text.startsWith(BRIDGE.heal)) {
    return {
      narration: '伤处理完了。血止住的那一刻，呼吸重新变得完整——眼前的局面也跟着清楚了几分。',
      recap: '疗伤完毕',
      dialogue: [],
      choices: currentChoices(state, preset),
      proposal: emptyProposal(),
    }
  }

  if (text.startsWith(BRIDGE.evade)) {
    L.improv = 0
    // 没打就走了也算翻页：那一拍的对峙结束了
    return advanceOrProcedural(state, preset, '你从那场对峙边上走了过去。身后没有追击，但也没有解释——世界照它的记性记下了这一笔。', rng)
  }

  if (text.startsWith(BRIDGE.crossover)) {
    L.arcDone = true
    L.pending = null
    return proceduralTurn(state, '', rng, '数年过去。旧篇的人和事都沉成了骨头里的东西——新的时间线上，你的名字还在，欠的账也还在。')
  }

  // 战斗结算（以及其他以（开头的推进信号）：翻到下一拍
  L.improv = 0
  return advanceOrProcedural(state, preset, '', rng)
}

/** 当前局面上该摆的选项（桥接回合不翻页时用） */
function currentChoices(state, preset) {
  if (!state.local.arcDone && preset) return preset.beats[state.local.beat].c.map((c) => c.label)
  return []
}

function advanceOrProcedural(state, preset, leadIn, rng) {
  const L = state.local
  if (!L.arcDone) {
    L.beat += 1
    if (L.beat >= preset.beats.length) {
      L.arcDone = true
      return proceduralTurn(state, '', rng, leadIn || preset.beats.at(-1).n)
    }
    const beat = preset.beats[L.beat]
    return {
      narration: leadIn ? `${leadIn}\n\n${beat.n}` : beat.n,
      recap: beat.r,
      dialogue: beat.d,
      choices: beat.c.map((c) => c.label),
      proposal: emptyProposal(),
    }
  }
  return proceduralTurn(state, '', rng, leadIn)
}

// ---------------- 程序化续写

/** 节点战的对手名池：泛用咒灵系命名，等级由危险度对玩家偏移决定（同轮盘口径） */
const NODE_ENEMIES = ['咒灵', '咒胎', '诅咒师', '蚀咒傀儡', '受咒物侵蚀者', '咒骸']

/** 各线可切磋的人：只列原作表里真实存在的名字（canon.js 会按表校正等级与术式） */
const SPARRING = {
  sukuna: ['七海建人', '禅院真希', '钉崎野蔷薇', '伏黑惠'],
  kaigyoku: ['夏油杰', '七海建人', '灰原雄', '黑井美里'],
  future: null, // 未来线没有原作表，切磋走泛用对手
}

/**
 * 预设四拍走完之后的世界：不再是写死的剧情，而是按原作节点排期
 * （storylines.js 的 nodeSchedule，和战斗向轮盘同一张表）把日子一天天
 * 推到大戏面前。三种节拍：
 *   countdown —— 离下一个节点还有日子：侦查 / 切磋 / 静待
 *   node day  —— 今天就是那一天：介入（介入战）或避开
 *   epilogue  —— 排期走完：切磋与日常的循环，等跨篇或自由发挥
 *
 * proposal 参数：arc 落幕那一手的效果要跟着带进来（见 arcTurn 的注释），
 * 其余调用方不传就按空提议走。
 */
function proceduralTurn(state, text, rng, leadIn = '', proposal = null) {
  const L = state.local
  const preset = presetOf(L.presetId)

  // 上一轮摆出去的程序化选项先对上号
  if (L.pending && text) {
    const hit = matchChoice(L.pending.c, text)
    if (hit) {
      L.pending = null
      if (hit.k) {
        return {
          narration: clashNarration(hit.k),
          recap: `${hit.k.n}（${hit.k.g}）拦在面前`,
          dialogue: canonDialogue(hit.k.n, rng),
          choices: [],
          proposal: proposalOf(hit),
          combatRequest: combatRequestOf(hit.k),
        }
      }
      return proceduralNext(state, preset, proposalOf(hit), leadIn, rng)
    }
    // 没对上号：当自由行动处理，但程序化循环里没有节拍可停 —— 直接推进
    if (INTENT.fight.test(text) && L.pending.c.some((c) => c.k)) {
      const target = L.pending.c.find((c) => c.k)
      L.pending = null
      return {
        narration: `你不再等选项里的措辞——${text}。${target.k.why}，剩下的用手上的功夫说清楚。`,
        recap: `主动向${target.k.n}出手`,
        dialogue: canonDialogue(target.k.n, rng),
        choices: [],
        proposal: { ...emptyProposal(), hpDelta: -Math.round(state.player.hp.max * 0.02) },
        combatRequest: combatRequestOf(target.k),
      }
    }
  }

  return proceduralNext(state, preset, proposal || emptyProposal(), leadIn, rng)
}

/**
 * 按提议里的时间推进量"预演"下一个节点。
 *
 * 程序化节拍是在选项效果**落地之前**生成的（提议要回 postProcess 才生效），
 * 而预设收尾选项常常自带几天推进 —— 拿旧日期算倒计时，会生成一条
 * 「还有 3 天」的节拍，落地那天却已经是节点当天。这里临时把日期往前推一把
 * 再查表，查完立刻还原，不动真值。
 *
 * 推进量还得先过节点闸门（guard.js clampTimeAdvance 的同一条规矩）：
 * 时间不许跨过还没发生的节点，今天就停在节点当天 —— 不照抄这条，
 * 预演出来的日子会和真值分叉。
 */
function peekMilestone(state, advance) {
  const want = { '1d': 1, '3d': 3, '1w': 7 }[advance] ?? 0
  const cur = nextMilestone(state)
  if (!want || !cur) return cur
  // 闸门：节点当天原地不动；否则推进量夹到「节点前允许的最大步长」
  const eff = cur.daysLeft <= 0 ? 0 : Math.min(want, cur.daysLeft >= 7 ? 7 : cur.daysLeft >= 3 ? 3 : 1)
  if (!eff) return cur
  const saved = state.time.date
  const [y, m, d] = saved.split('-').map(Number)
  state.time.date = new Date(Date.UTC(y, m - 1, d + eff)).toISOString().slice(0, 10)
  try {
    return nextMilestone(state)
  } finally {
    state.time.date = saved
  }
}

function proceduralNext(state, preset, proposal, leadIn, rng) {
  const ms = peekMilestone(state, proposal?.timeAdvance)
  const raw = ms ? (ms.daysLeft > 0 ? countdownBeat(state, ms, rng) : nodeDayBeat(state, ms, rng))
    : epilogueBeat(state, rng)
  state.local.pending = { c: raw.choices.map((label) => {
    // 存下每个选项的效果，供下一轮对号（战斗选项在生成时就带着 k）
    return raw._effects.find((e) => e.label === label)
  }) }
  return { ...raw, narration: leadIn ? `${leadIn}\n\n${raw.narration}` : raw.narration, proposal }
}

function countdownBeat(state, ms, rng) {
  const p = state.player
  const days = ms.daysLeft
  const near = days <= 3
  const line = pickLine(state, [
    `日子在往前走。离「${ms.node}」还有 ${days} 天——街上的气息一天比一天紧。`,
    `「${ms.node}」还有 ${days} 天。能做的准备不多了，能查的线索还剩最后几条。`,
  ], rng)
  const time = near ? '1d' : '3d'

  const spar = sparringPartner(state, rng)
  const effects = [
    { label: '顺着线索摸过去，提前踩点', ce: -Math.round(p.ce.max * 0.05), time, flags: [`侦查·${ms.node}`] },
    spar ? { label: `约${spar}过一场手，保持手感`, hp: -Math.round(p.hp.max * 0.08), k: sparSpec(state, spar) } : null,
    { label: '按兵不动，只盯紧日期', time },
  ].filter(Boolean)

  /*
   * 随机事件（三成）：熟人偶遇 / 线头 / 背街的小遭遇。
   * 倒计时是本地模式里最常重复的节拍 —— 没有这些，每一段空档都是
   * 同三个按钮换日期。事件只加一个选项（总数保持 ≤4，postProcess 才不裁），
   * 好处给得有节制：关系 +2~5、一条剧情线头、或一场比正日子低一档的架。
   */
  let eventLine = ''
  const roll = rng()
  if (roll < 0.1) {
    /*
     * 熟人事件：这条线上的 NPC 也有自己的生活——他们会「恰好」出现在你
     * 常出没的地方。关系越好越容易遇上（权重 = 关系+10，陌生人也留一成照面），
     * 且引擎记着你们遇过几次：初见是搭话，再见是默契，老友是不用寒暄。
     * 关系网由此长出时间维度——处出来的人脉是越处越熟的。
     */
    const met = (state.local.met ||= {})
    const roster = charactersFor(state.storyline).filter((n) => (state.relations[n] ?? 0) >= 0)
    if (roster.length) {
      const weights = {}
      for (const n of roster) weights[n] = (state.relations[n] ?? 0) + 10
      const who = weightedPick(rng, weights)
      const seen = met[who] || 0
      met[who] = seen + 1
      const flavor = seen === 0
        ? `路上撞见了${who}——打过照面，但还没说过几句话`
        : seen <= 2
          ? `又是${who}。上次的事你们都还记得，一个眼神就算打过招呼`
          : `${who}看见你就笑了——老朋友之间，不用寒暄`
      eventLine = `${flavor}。这次对方先开了口。`
      effects.push({ label: `和${who}聊聊近况`, rel: { [who]: rint(rng, 2, 5) } })
    }
  } else if (roll < 0.2) {
    eventLine = '背风处有一点不属于这条街的咒力残响，若有若无——像是谁特意留下的线头。'
    effects.push({ label: '顺着线头查下去', ce: -Math.round(p.ce.max * 0.03), flags: [`线头·${ms.node}`] })
  } else if (roll < 0.3) {
    eventLine = '一股压不住的敌意从背街的方向压过来。不是今天的大戏，但也绝不是善茬。'
    effects.push({
      label: '迎上去',
      k: {
        g: interventionGrade(state, Math.max(1, ms.danger - 1)),
        n: NODE_ENEMIES[rint(rng, 0, NODE_ENEMIES.length - 1)],
        t: '未知术式', e: '',
        why: '它在背街堵住了你的去路',
      },
    })
  }

  return {
    narration: `${line}${eventLine ? `\n\n${eventLine}` : ''}\n\n空气里的咒力像潮水前的滩涂——湿、冷、静。你知道那一天来的时候不会敲门。`,
    recap: `距「${ms.node}」还有 ${days} 天`,
    dialogue: [],
    choices: effects.map((e) => e.label),
    _effects: effects,
  }
}

function nodeDayBeat(state, ms, rng) {
  const grade = interventionGrade(state, ms.danger)
  const name = NODE_ENEMIES[rint(rng, 0, NODE_ENEMIES.length - 1)]
  const effects = [
    {
      label: `介入「${ms.node}」——这一场你上`,
      hp: -Math.round(state.player.hp.max * 0.03),
      k: {
        g: grade, n: name, t: '未知术式', e: '',
        why: `「${ms.node}」（${ms.dangerLabel}）就在今天，而它挡在你和那一天之间`,
        node: ms.node,
      },
    },
    { label: '避开这一天，让它照旧发生', flags: [`${ms.node}_开始`], time: '1d' },
    { label: '远远看着，把一切记下来', ce: -Math.round(state.player.ce.max * 0.04), flags: [`${ms.node}_开始`, `旁观·${ms.node}`] },
  ]
  // 那一天的场面：节点表上备好了 desc，本地模式把它直接写进正文 ——
  // 玩家等了十几天的正日子，不能只有四个字。
  // 但被改写过的日子（撑起它的人没了）不能照原著念 —— 那一天的剧本已经换了，
  // 念错剧本比不念更出戏。改写理由就是它的新剧本
  const rewritten = state.timeline.nodes[ms.node] === REWRITTEN
  const desc = rewritten
    ? `这一天早已被改写——${state.timeline.rewrites?.[ms.node] || '那天的剧本换了，没人知道现在会演什么'}`
    : nodeDescOf(state.storyline, ms.node)
  return {
    narration: `今天就是「${ms.node}」——${ms.dangerLabel}。${desc}。清晨的空气和往常不一样：薄的，绷的，像大幕拉开前最后一秒的静。你可以走进去，把这一天攥在自己手里；也可以站在外面，让原作的剧本原样演完。哪一种都是选择，哪一种都有代价。`,
    recap: `「${ms.node}」就是今天`,
    dialogue: [],
    choices: effects.map((e) => e.label),
    _effects: effects,
  }
}

function epilogueBeat(state, rng) {
  const spar = sparringPartner(state, rng)
  const effects = [
    // 谢幕永远是第一项：排期走完的局该有个句点，而不是无限空转。
    // 界面拦截这一项（不发回合），直接走 /finish 出谢幕
    { label: '收束这一局——谢幕', flags: ['谢幕'] },
    spar ? { label: `和${spar}再切磋一场`, hp: -Math.round(state.player.hp.max * 0.08), k: sparSpec(state, spar) } : null,
    { label: '静修一段时日，让伤和咒力都回满', time: '1w', hp: Math.round(state.player.hp.max * 0.2), ce: Math.round(state.player.ce.max * 0.3) },
    { label: '复盘这一路的战果与旧账', ce: -Math.round(state.player.ce.max * 0.02), flags: ['复盘战果'] },
  ].filter(Boolean)
  return {
    narration: pickLine(state, [
      '这条线上排到的日子都走完了。时间线安静下来——不是太平了，是下一场还在酝酿。你有了一段真正属于自己的空档。',
      '排期表翻到了底。旧账、战果、改写过的那些天，都收进了你的名字里。接下来往哪走，没有节点替你决定了。',
    ], rng),
    recap: '排期走完，进入空档',
    dialogue: [],
    choices: effects.map((e) => e.label),
    _effects: effects,
  }
}

function sparringPartner(state, rng) {
  const pool = SPARRING[state.storyline]
  if (!pool || !pool.length) return null
  return pool[rint(rng, 0, pool.length - 1)]
}

/** 切磋：和玩家同级（原作表的人会被 canon 校正成真实等级），不是生死局 */
function sparSpec(state, name) {
  return {
    g: interventionGrade(state, 3),
    n: name,
    t: '未知术式',
    e: '',
    why: `${name}应下了你的切磋——点到为止，但没人会放水`,
  }
}

function pickLine(state, lines, rng) {
  return lines[rint(rng, 0, lines.length - 1)]
}

// ---------------------------------------------------------------- 战斗与修炼的本地文案

/** 跳过 / 剧情模式的整场战斗演出（替代模型的战报改写） */
export function localCombatNarration(state, brief, mode) {
  const p = state.player
  const enemy = String(brief.敌方 || '对手')
  const result = String(brief.结果 || '')
  const rounds = Number(brief.回合数 || 0)
  const keys = Array.isArray(brief.关键节点) ? brief.关键节点 : []
  // 行动文本里带着数字（面板口径），演出里整段删掉含数字的短句，只留动作
  const strip = (s) => String(s || '').split(/[，；]/).filter((seg) => !/[0-9]/.test(seg)).join('，').replace(/^[，。]+/, '')
  const myMoves = keys.map((k) => strip(k.玩家行动)).filter(Boolean)
  const foeMoves = keys.map((k) => strip(k.敌方行动)).filter(Boolean)
  const tech = p.technique.name

  const open = {
    玩家胜: `${enemy}被压到了再也起不身的位置。`,
    敌方遁走: `${enemy}遁走了——场面在你手里，但它没留下东西。`,
    玩家败: `这一场没能拿下。`,
    玩家脱离: `你从这场缠斗里抽身而出。`,
    未分胜负: `双方都到了极限，谁也没能压倒谁。`,
  }[result] || '战斗结束。'

  const mid = mode === 'narrative'
    ? `${myMoves[0] ? `开局抢下第一手——${myMoves[0]}。` : '开局的第一手抢在了前面。'}${tech}的咒力把空气拧出痕迹，${foeMoves[0] ? `对方的回应（${foeMoves[0]}）又快又狠` : '对方的回应又快又狠'}，攻守在几个呼吸之间换了三轮。${myMoves.at(-1) ? `收尾的那一手：${myMoves.at(-1)}。` : '收尾的一手落定，胜负再没有回头。'}`
    : `前后 ${rounds || '数'} 个回合：${myMoves.slice(0, 2).join('；') || '抢攻、周旋'}。${foeMoves[0] ? `对方以${foeMoves[0]}还以颜色。` : ''}`

  const tail = `${open}战后血条停在 ${brief.玩家剩余HP占比 || '—'} —— ${hpStatus(p.hp)}。`
  return `${mid}\n\n${tail}`
}

/** 手动模式的单回合演出（2~4 句，替代模型的逐回合描写） */
export function localRoundNarration(state, panel) {
  const my = panel.beat?.player || {}
  const foe = panel.beat?.enemy || {}
  const e = panel.enemy || {}
  const tech = state.player.technique.name
  const parts = []

  // 黑闪是全场最高的一拍 —— 短句、顿住、只写这一击
  if (panel.blackFlash === 'player') {
    parts.push('黑闪。咒力在命中的亿万分之一秒里与拳头完全同步——世界顿了半拍，威力按几何级炸开。')
    parts.push(`${e.name}的架势被这一击整个打散。`)
  } else if (panel.blackFlash === 'enemy') {
    parts.push(`黑闪——${e.name}的咒力与打击完全同步。那一击落下来的瞬间，你的视野红了一下。`)
    parts.push('肋骨在响。站直。')
  }

  if (panel.domainOpened) {
    const d = panel.domainOpened
    parts.push(d.side === 'player'
      ? `领域展开——「${d.name}」。 ${d.sureHit ? '必中的一刻，世界只剩你的规则。' : '结界合拢，主客易位。'}`
      : `对方展开了领域「${d.name}」。空气的质地变了——从这里开始，规矩由它定。`)
  }
  if (my.crit && !my.blackFlash) parts.push(`${tech || '出手'}撕开了破绽——这一记打得又狠又正。`)
  else if (my.blackFlash && !panel.blackFlash) parts.push('黑闪的余劲还挂在指节上。')
  else if (my.damage) parts.push(`你抢到了一个身位，${my.label || '出手'}结结实实落在${e.name}身上。`)
  else if (my.healed) parts.push('一手压制，一手回气——这一回合打得不急。')
  else if (my.fizzled) parts.push('这一手没能成形：被压住、没跟上、或者咒力没听使唤。')

  if (foe.damage) parts.push(foe.crit ? `${e.name}的反击正中要害——疼得视野边缘发白。` : `${e.name}的还手擦着护身的咒力砸了进来。`)
  else if (foe.fizzled) parts.push(`${e.name}的这一手被你打断，攻势顿了半拍。`)
  if (panel.staggered === 'enemy') parts.push(`${e.name}被压得退了半步——节奏在你这边。`)
  if (panel.staggered === 'player') parts.push('你被这一下打得失了先手，只能先稳住下盘。')

  if (!parts.length) parts.push('一个回合在互相试探里过去了——真正的招都在下一手。')
  return parts.slice(0, 4).join('')
}

/** 修炼的过程描写（一到两句，替代模型的即兴润色） */
export function localTrainingFlavor(state, item, rng) {
  const p = state.player
  const pool = {
    体能训练: ['肌肉的酸痛一层压一层，呼吸在第三十下之后变得又长又稳。', '跑到最后一组的时候，身体先于意志找到了节奏。'],
    咒力冥想: ['咒力在丹田里沉下去又浮起来，每一轮都比上一轮安静一分。', '呼吸数到两百度，体内的潮汐第一次完全跟着你的意思走。'],
    术式演练: [`${p.technique.name}起手第一百遍，指尖终于不再多余地颤。`, '同一手结印拆开重来，直到最快的那个版本留下来。'],
    体术实战: ['对练的木桩换了两批，掌心的咒力茧厚了一层。', '挨打也是课程的一部分——今天这一课学费不便宜。'],
    反转术式修习: ['负负得正的口诀念到第三十遍，伤疤底下有什么东西轻轻动了一下。', '咒力逆流的那一瞬像用左手写字——别扭，但成形了。'],
    领域雏形冥想: ['结界的边界在意识里撑开一寸，又塌回去半寸——但那一寸是真的。', '领域的手感像隔着水抓东西：抓不实，可水在让路。'],
  }[item] || ['一天就这么沉了下去。']
  return pool[rint(rng, 0, pool.length - 1)]
}

export { PRESETS }
