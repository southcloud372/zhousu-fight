import { canonFor } from './canon.js'
import { REWRITTEN, isSettled } from './timeline.js'

/**
 * 剧情依赖表：谁死了，哪一天就再也不是原来那一天。
 *
 * 越界限制取消之后，玩家可以在任何时间点杀掉任何人 —— 包括虎杖、五条、
 * 理子这些"后面还有一大段戏"的人。杀完就完了吗？不是。按玩家的要求，
 * "如果杀的是之后关键剧情的关键人物，则对应剧情也进行相应变化"。
 *
 * 引擎的做法**不是把那个节点删掉**，而是把它标成「已改写」：
 *   那一天照旧会来（轮盘照旧为它停下，玩家照旧能介入），
 *   只是它已经不是原著里那件事了 —— 少了一个本该在场的人，
 *   剩下的戏得按新的局面重演。
 *
 * 为什么不是"跳过"：跳过等于告诉玩家"你杀了一个人，于是世界上少了一天"。
 * 那既不真实，也让玩家失去了在那一天做点什么的机会。改写的世界更难看，
 * 也更值得看。
 */

/**
 * 每条线的关键人物 → 他撑着的那个节点 + 他不在了以后那天变成什么样。
 *
 * `rewrite` 是写给模型看的指令，不是旁白：它要说清"什么没了、现在是什么局面"，
 * 剩下的交给模型推演。所以写成陈述句，不写成文学描写。
 */
export const PLOT_ANCHORS = {
  sukuna: {
    虎杖悠仁: {
      node: '宿傩夺舍',
      rewrite: '虎杖已经不在了 —— 没有人能给宿傩当容器。这一晚照旧会来，来的却不是原著里那件事：宿傩要么另找一具身体，要么继续封在手指里。',
    },
    伏黑惠: {
      node: '涩谷事变',
      rewrite: '伏黑惠死在了涩谷之前。这一天照样会来，只是那个本该站在咒灵侧对面的人缺了席。',
    },
    钉崎野蔷薇: {
      node: '涩谷事变',
      rewrite: '钉崎野蔷薇死在了涩谷之前。这一天照样会来，少了一个冲在最前面的人。',
    },
    五条悟: {
      node: '涩谷事变',
      rewrite: '五条悟死了 —— 涩谷那整套"封住最强"的局从一开始就不成立。帷幕照落，但天平整个翻了过来：剩下的人要自己撑住这一天。',
    },
    七海建人: {
      node: '涩谷事变',
      rewrite: '七海建人不在了。涩谷这一天照样会来，只是场上少了一个把局面看得最清楚的人。',
    },
    禅院真希: {
      node: '涩谷事变',
      rewrite: '禅院真希不在了。涩谷的乱局里少了一把握在最前面的刀。',
    },
    狗卷棘: {
      node: '涩谷事变',
      rewrite: '狗卷棘不在了。少了他那张嘴，很多本来能一句话解决的场面都得用命去填。',
    },
    熊猫: {
      node: '涩谷事变',
      rewrite: '熊猫被打坏了 —— 三核咒骸没能撑到涩谷。夜蛾那边也少了一个"儿子"。',
    },
    夜蛾正道: {
      node: '涩谷事变',
      rewrite: '夜蛾正道死了，高专少了一整代人的主心骨。涩谷这一天照样会来，只是再没有人替这些学生兜底。',
    },
    家入硝子: {
      node: '涩谷事变',
      rewrite: '家入硝子死了 —— 咒术界再没有第二个人能给别人治伤。涩谷之后每一个重伤的人，都只能靠自己撑过去。',
    },
    宿傩: {
      node: '最终决战',
      rewrite: '宿傩提前退场了。最终决战照样会来，但它不再是"所有人围攻诅咒之王"—— 剩下的敌人是谁，得重新算。',
    },
  },

  kaigyoku: {
    天内理子: {
      node: '理子之死',
      rewrite: '理子已经死了，同化没有发生，天元没能重写肉体。这一天照旧会来，但它不再是"她跑向天元的那几步"。',
    },
    伏黑甚尔: {
      node: '甚尔之战',
      rewrite: '没有人来杀五条悟。这一晚没有最强的人倒下的那一刻，也就没有他从血里爬起来学会反转术式的那一次。',
    },
    五条悟: {
      node: '五条觉醒',
      rewrite: '五条悟死了，觉醒没有发生。往后所有人、所有局，都要在一个"最强已经不在了"的世界里重排。',
    },
    夏油杰: {
      node: '夏油叛逃',
      rewrite: '夏油杰已经不在了，那一场叛逃没有发生。他会不会走上那条路这个问题失去了意义 —— 但咒术界少了一个人，也少了一场清算。',
    },
    天元: {
      node: '玉折',
      rewrite: '天元不在了，同化与结界的体系随之崩坏。这一年的结尾不会按原来的方式到来。',
    },
    黑井美里: {
      node: '理子之死',
      rewrite: '黑井美里死了 —— 理子身边再没有替她挡枪的人。这一天照旧会来。',
    },
  },
  // 未来篇是本作推演出来的线，没有"原作节点"可被改写
}

/**
 * 这个人在本线是不是"有用的"。
 * 判据是原作表里有他，或者他在这条线的登场名单里 ——
 * 用来区分"杀了一个有名有姓的人"和"打散了一只咒灵"。
 */
export function isKnownCharacter(name, storylineId = 'sukuna', characters = []) {
  if (canonFor(name, storylineId)) return true
  const n = String(name || '').trim()
  if (!n) return false
  return characters.some((c) => n.includes(c) || c.includes(n))
}

/**
 * 查这个人的死会改写下哪一天。
 *
 * 先用原作表把名字归一（「五条」→「五条悟」），查不到再退回到直接比对 ——
 * 表里有人不在 canon.js 里（比如未来篇的推演角色），那也得认。
 */
export function plotAnchorFor(storylineId, name) {
  const table = PLOT_ANCHORS[storylineId]
  if (!table) return null

  const hit = canonFor(name, storylineId)
  const who = hit?.name || String(name || '').trim()
  if (!who) return null
  if (table[who]) return { who, node: table[who].node, rewrite: table[who].rewrite }

  for (const [key, v] of Object.entries(table)) {
    if (who.includes(key) || key.includes(who)) return { who: key, node: v.node, rewrite: v.rewrite }
  }
  return null
}

/**
 * 记一个人的死，顺带把被牵连的节点标成「已改写」。
 *
 * 返回 { node, line, rewrite, already }：
 *   line 为 null 表示那个节点已经过去了，改不动了（该发生的早发生了），
 *   但这个人确实没了，后事仍然要按新的局面推 —— already 就是这种情况。
 * 表里查不到这个人（无名咒灵、路人）返回 null，什么都不会发生。
 */
export function noteDeath(state, name) {
  if (!state?.timeline?.nodes) return null
  const anchor = plotAnchorFor(state.storyline, name)
  if (!anchor) return null

  const cur = state.timeline.nodes[anchor.node]
  // 已经发生 / 已改变 / 已改写的一天，再死一个人也改不动它
  if (isSettled(cur)) return { node: anchor.node, line: null, rewrite: null, already: true }

  state.timeline.nodes[anchor.node] = REWRITTEN
  // 存的是**理由本身**（"谁死了、那天变成了什么样"），不是整句话 ——
  // 面板要在节点行下面原样显示它，模型那边也按节点名取用
  state.timeline.rewrites ||= {}
  state.timeline.rewrites[anchor.node] = anchor.rewrite
  const line = `「${anchor.node}」已改写 —— ${anchor.rewrite}`
  state.timeline.newEvents.push(line)
  if (state.timeline.newEvents.length > 40) state.timeline.newEvents.shift()
  return { node: anchor.node, line, rewrite: anchor.rewrite, already: false }
}
