/**
 * 穿越时间点。
 *
 * 玩家选的不只是一个日期 —— 它决定三件事：
 *   1. 游戏起始日期（state.time.date）
 *   2. 原作节点的进度（哪些已经发生、哪些还没）
 *   3. 开局情境的处境（世界有多危险、谁认识你、什么事正在发生）
 *
 * nodesDone 是「到这个时点为止已经发生的原作节点」，
 * 选定时会写进 timeline.nodes，后续剧情就基于这些既定事实推演。
 */

export const TIME_POINTS = [
  {
    id: 'start',
    date: '2018-06-05',
    label: '2018年6月 · 宿傩手指',
    when: '虎杖悠仁吞下第一根宿傩手指前后',
    situation: '一切的开端。你比所有人都早知道结局，但这个世界里没人认识你。',
    hook: '你清楚接下来会发生什么 —— 问题是，说了也没人信。',
    nodesDone: [],
    danger: 1,
    dangerLabel: '序章',
  },
  {
    id: 'juvenile',
    date: '2018-06-24',
    label: '2018年6月下旬 · 少年院',
    when: '少年院任务，宿傩首次夺舍虎杖',
    situation: '虎杖刚入学不久就被派去少年院，特级咒胎在那里等着。你可以在场，也可以不在。',
    hook: '你知道那一晚会死一个人。救不救，是你自己的事。',
    nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学'],
    danger: 2,
    dangerLabel: '险局',
  },
  {
    id: 'sisters',
    date: '2018-07-12',
    label: '2018年7月 · 京都姊妹校交流',
    when: '京都姊妹校交流战，宿傩与真人初次接触',
    situation: '两校交流战期间，咒灵侧开始试探。虎杖已经能部分借用宿傩的力量。',
    hook: '真人会在这场交流里第一次注意到宿傩的容器。',
    nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍'],
    danger: 3,
    dangerLabel: '暗流',
  },
  {
    id: 'shibuya-eve',
    date: '2018-08-20',
    label: '2018年8月 · 涩谷前夜',
    when: '五条悟正被一步步设计入局',
    situation: '表面上一切照旧，实际上咒灵侧已经布好了针对五条悟的局。你还有两个月。',
    hook: '你要不要提前告诉五条悟？说了会改变很多事 —— 也可能什么都不改变。',
    nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流'],
    danger: 3,
    dangerLabel: '暗流',
  },
  {
    id: 'shibuya',
    date: '2018-10-31',
    label: '2018年10月31日 · 涩谷事变',
    when: '五条悟被封印，宿傩展开领域，涩谷化为地狱',
    situation: '你睁眼时，涩谷已经封场。广播在念条件，人群在尖叫，五条悟还没进场。',
    hook: '这一天之后，咒术界的天平彻底翻了。而你都还没和任何人说过一句话。',
    nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流', '涩谷事变前夜'],
    danger: 4,
    dangerLabel: '地狱',
  },
  {
    id: 'culling',
    date: '2018-11-20',
    label: '2018年11月 · 死灭回游',
    when: '五条悟已被封印，死灭回游开始',
    situation: '结界封锁全国，泳者互相猎杀。没有规则，只有分数。',
    hook: '在这个阶段，最强的活下来，最聪明的活得久。你选哪个。',
    nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流', '涩谷事变前夜', '涩谷事变'],
    danger: 5,
    dangerLabel: '绝境',
  },
  {
    id: 'final',
    date: '2019-03-10',
    label: '2019年 · 最终决战',
    when: '宿傩完全体，与残留的术师们最后对峙',
    situation: '该倒的都已经倒了。剩下的人凑在一起，准备最后一搏。',
    hook: '你知道结局。但这一次，赌桌上多了一个不该存在的人 —— 你。',
    nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流', '涩谷事变前夜', '涩谷事变', '死灭回游'],
    danger: 5,
    dangerLabel: '终局',
  },
]

export const byId = (id) => TIME_POINTS.find((t) => t.id === id)

/** 主线时间线节点名（和 state.timeline.nodes 的键一致） */
export const NODE_ORDER = [
  '虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍',
  '京都姊妹校交流', '涩谷事变前夜', '涩谷事变', '死灭回游', '最终决战',
]

/** 把某个时间点的进度写进 timeline.nodes */
export function applyTimeline(state, point) {
  const done = new Set(point.nodesDone)
  for (const node of NODE_ORDER) {
    if (state.timeline.nodes[node] === undefined) continue
    // 已发生的保持已发生（玩家可能改过），未发生的按时间点推进
    if (state.timeline.nodes[node] === '已发生') continue
    state.timeline.nodes[node] = done.has(node) ? '已发生' : '未发生'
  }
  state.time.date = point.date
  state.time.day = 1
}
