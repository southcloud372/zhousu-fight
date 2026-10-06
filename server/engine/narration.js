/**
 * 正文预算。
 *
 * 起因：战斗向的选择已经把配比写死了（战斗 90%、转场一句带过），可模型还是
 * 一写就是六七百字 —— 里面大半是环境、心理、回忆这类"剧情细节"。
 * 配比管的是**写什么**，管不住**写多少**；写多了，打斗就被稀释成日常。
 *
 * 所以长度由引擎来管，和数值一个道理：模型负责好不好看，引擎负责合不合规。
 * 做法分三层，一层比一层硬：
 *   1. 提示词里给出字数预算（最省事，多数情况就够了）
 *   2. 超了就退回重写一次（见 index.js 的 /turn）
 *   3. 还超就截到最后一个句末标点（兜底，保证玩家看到的永远在预算内）
 *
 * 这个文件里全是纯函数，为的是能不跑模型就把这套规则测清楚。
 */

/** 正文短于这个长度就当没写 —— 模型偶尔会交回空壳 */
export const NARRATION_MIN = 60

/**
 * 剧情框里真正显示给玩家的字数。
 *
 * 正文和台词是一起摆在剧情框里的，所以预算要算在一起 ——
 * 只卡正文的话，模型完全可以写 400 字正文再配 200 字台词绕过去。
 */
export function visibleLength(raw) {
  if (!raw) return 0
  const narration = typeof raw.narration === 'string' ? raw.narration : ''
  const dialogue = Array.isArray(raw.dialogue) ? raw.dialogue : []
  const spoken = dialogue.reduce((n, d) => n + (typeof d?.text === 'string' ? d.text.length : 0), 0)
  return narration.trim().length + spoken
}

/** 超出预算多少字。没超、或者这种模式没有预算，都返回 0 */
export function overflowBy(raw, cap) {
  if (!cap) return 0
  const over = visibleLength(raw) - cap
  return over > 0 ? over : 0
}

/**
 * 超预算时，截到最后一个句末标点。
 *
 * 兜底用，不常走到 —— 正常情况下提示词和退回重写已经解决了。
 * 真要截，也得断在句号上：断在半句话中间比长一点更让人出戏。
 * 找不到合适的断点就退回逗号；连逗号都没有才硬截。
 */
export function clampNarration(text, cap) {
  const s = typeof text === 'string' ? text : ''
  if (!cap || s.length <= cap) return s

  const head = s.slice(0, cap)
  // 断点至少要落在预算的后半段，否则等于把整段砍没了
  const floor = cap * 0.5

  const stop = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('…'), head.lastIndexOf('\n'),
  )
  if (stop >= floor) return head.slice(0, stop + 1).trimEnd()

  const comma = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('；'))
  if (comma >= floor) return head.slice(0, comma + 1).trimEnd()

  return head.trimEnd()
}
