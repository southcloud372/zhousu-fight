import { storylineOf } from './storylines.js'
import { nextMilestone } from './timeline.js'

/**
 * 终局与谢幕。
 *
 * 一个没有结局的游戏留不住「打完」的记忆 —— 排期走完之后，玩家只能
 * 在空档循环里永远转下去。这里补上最后一幕：排期尽头给一个正式的谢幕，
 * 文案从这一局真实打出来的战绩（career 的事实源）里长出来，
 * 而不是一段谁玩都一样的通用贺词。
 *
 * 谢幕不是锁：演完之后世界照常可玩（自由发挥），只是这一局有了句点。
 */

/** 还能不能谢幕：角色在场、在局中、且这条线的排期已全部走完 */
export function endingReady(state) {
  return !!(
    state.player
    && state.phase === 'playing'
    && !nextMilestone(state)
    && !state.ended
  )
}

/**
 * 组装谢幕：标题 + 收束文案 + 战绩。
 * 文案分层落笔 —— 先给「这条线走完了」的定场，再按玩家做过的事各给一句，
 * 一件没做也不硬编（没有改写就说没有改写，诚实也是一种结局）。
 */
export function buildEnding(state) {
  const p = state.player
  const line = storylineOf(state.storyline)
  const battles = state.battles || []
  const kills = battles.filter((b) => b.killed)
  const changed = state.timeline.changed || []
  const interventions = battles.filter((b) => b.ground === '介入战')
  const flash = p._blackFlash || 0

  const parts = []
  parts.push(
    `「${line.name}」的排期走到了尽头。${p.name}（${p.grade}）站在这条时间线的末尾，`
    + `${line.name === '未来篇' ? '再往后，是没有原作可依的空白 —— 而那空白现在写着你的名字。' : '往后的事，账本上没有记 —— 因为记账的人，此刻就站在这里。'}`,
  )

  if (changed.length > 0) {
    parts.push(`你改写了 ${changed.length} 个原作节点。这条世界线的后面，再没有人知道该按哪一本演 —— 他们只能按你演过的来。`)
  } else {
    parts.push('你没有改写任何一天。原作照旧演完，而你站在每一场的边上，一路活到了落幕。')
  }

  if (kills.length > 0) {
    const names = [...new Set(kills.map((b) => b.enemy?.name).filter(Boolean))]
    parts.push(`倒在这条路上的人：${names.join('、')}。${names.length > 2 ? '每一笔都有代价，每一笔也都算数。' : ''}`)
  }

  if (interventions.length > 0) {
    parts.push(`${interventions.length} 个「正日子」，你一天不落地站在了场内。`)
  }

  if (flash > 0) {
    parts.push(`黒闪 ${flash} 颗。身体记得的，比脑子多 —— 往后的每一拳都带着这份记忆。`)
  }

  parts.push(`${battles.length} 场交手、第 ${state.turn} 回合。故事在这里收束，世界还在往前走。`)

  return {
    title: '終劇',
    name: p.name,
    grade: p.grade,
    lineName: line.name,
    date: state.time?.date || '',
    text: parts.filter(Boolean).join('\n\n'),
    career: {
      turns: state.turn,
      battles: battles.length,
      kills: kills.length,
      interventions: interventions.length,
      blackFlash: flash,
      changedNodes: changed.length,
    },
  }
}
