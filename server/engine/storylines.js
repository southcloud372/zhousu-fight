/**
 * 故事线。
 *
 * 每条线自成一套：原作节点、可选穿越时间点、可交互角色、起止年份。
 * 引擎里凡是"和作品时间有关"的东西都必须从这里取，不能写死 ——
 * 否则换一条线，时间线追踪器、关系网、穿越时间候选会全部串味。
 *
 * 数值体系（九级、压制、伤害公式）是跨线共用的，不在这里重复。
 */

/** 宿傩篇：原作 2018 年主线 */
const SUKUNA = {
  id: 'sukuna',
  name: '宿傩篇',
  subtitle: '2018 · 诅咒之王',
  era: '2018 — 2019',
  tagline: '虎杖悠仁吞下第一根宿傩手指之后',
  desc: '你是穿越者，落到一个已经很糟的局里。你知道结局，但没人认识你。',
  startDate: '2018-06-05',
  dateRange: ['2018-06-05', '2019-12-31'],
  next: 'future',
  crossoverNode: '最终决战',
  // 2019 打完最终决战，跳到十年后
  crossoverGap: {
    from: '2019', to: '2029',
    stages: [
      { from: '2019', to: '2022', years: 3, label: '最初的三年' },
      { from: '2022', to: '2026', years: 4, label: '中间四年' },
      { from: '2026', to: '2029', years: 3, label: '最后的三年' },
    ],
  },
  accent: 'blood',

  /**
   * 原作节点排期 —— 时间线追踪器照这个列，战斗向的轮盘也按它停。
   *
   * 每个节点都是**自己那一天的一场仗**。早先轮盘只在 timePoints（穿越时间点）
   * 那七站停，于是「虎杖吞手指」「死刑缓期」「高专入学」「宿傩夺舍」这四个
   * 夹在两个时间点中间的节点，无论玩家练多久都不会触发 —— 追踪器上永远挂着
   * "未发生"。危险度决定介入战的对手等级（见 wheel.interventionGrade）。
   *
   * 日期必须和 timePoints 的 nodesDone 对得上：某个时间点的 nodesDone 里列出的
   * 节点，日期一定要早于那个时间点。constants.test.mjs 有一条专门守这个。
   */
  nodeSchedule: [
    { node: '虎杖吞手指', date: '2018-06-08', danger: 1, dangerLabel: '序章' },
    { node: '死刑缓期', date: '2018-06-12', danger: 2, dangerLabel: '险局' },
    { node: '高专入学', date: '2018-06-15', danger: 2, dangerLabel: '险局' },
    { node: '少年院任务', date: '2018-06-24', danger: 3, dangerLabel: '暗流' },
    // 宿傩夺舍就在少年院那一晚 —— 同一天连着两场，轮盘打完第一场会立刻指着第二场
    { node: '宿傩夺舍', date: '2018-06-24', danger: 4, dangerLabel: '地狱' },
    { node: '京都姊妹校交流', date: '2018-07-12', danger: 3, dangerLabel: '暗流' },
    { node: '涩谷事变前夜', date: '2018-08-20', danger: 3, dangerLabel: '暗流' },
    { node: '涩谷事变', date: '2018-10-31', danger: 4, dangerLabel: '地狱' },
    { node: '死灭回游', date: '2018-11-20', danger: 5, dangerLabel: '绝境' },
    { node: '最终决战', date: '2019-03-10', danger: 5, dangerLabel: '终局' },
  ],

  /** 登场角色：关系网的初始名单，也是模型该用的人 */
  characters: [
    '虎杖悠仁', '伏黑惠', '钉崎野蔷薇', '五条悟', '七海建人',
    '宿傩', '禅院真希', '狗卷棘', '熊猫', '夜蛾正道',
    // 高专的校医。她不在名单里的话，"去高专找家入硝子疗伤"这条恢复路线
    // 在本线永远灰着 —— 而这是本条时间线上最顺理成章的一条
    '家入硝子',
  ],

  /** 可拜师的对象（写进提示词，避免模型乱找不存在的人） */
  mentors: ['五条悟', '七海建人', '虎杖悠仁', '伏黑惠', '钉崎野蔷薇', '禅院真希', '狗卷棘', '熊猫', '夜蛾正道', '宿傩'],

  timePoints: [
    {
      id: 'start', date: '2018-06-05', label: '2018年6月 · 宿傩手指',
      when: '虎杖悠仁吞下第一根宿傩手指前后',
      situation: '一切的开端。你比所有人都早知道结局，但这个世界里没人认识你。',
      hook: '你清楚接下来会发生什么 —— 问题是，说了也没人信。',
      nodesDone: [], danger: 1, dangerLabel: '序章',
    },
    {
      id: 'juvenile', date: '2018-06-24', label: '2018年6月下旬 · 少年院',
      when: '少年院任务，宿傩首次夺舍虎杖',
      situation: '虎杖刚入学不久就被派去少年院，特级咒胎在那里等着。你可以在场，也可以不在。',
      hook: '你知道那一晚会死一个人。救不救，是你自己的事。',
      nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学'], danger: 2, dangerLabel: '险局',
    },
    {
      id: 'sisters', date: '2018-07-12', label: '2018年7月 · 京都姊妹校交流',
      when: '京都姊妹校交流战，宿傩与真人初次接触',
      situation: '两校交流战期间，咒灵侧开始试探。虎杖已经能部分借用宿傩的力量。',
      hook: '真人会在这场交流里第一次注意到宿傩的容器。',
      nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍'], danger: 3, dangerLabel: '暗流',
    },
    {
      id: 'shibuya-eve', date: '2018-08-20', label: '2018年8月 · 涩谷前夜',
      when: '五条悟正被一步步设计入局',
      situation: '表面上一切照旧，实际上咒灵侧已经布好了针对五条悟的局。你还有两个月。',
      hook: '你要不要提前告诉五条悟？说了会改变很多事 —— 也可能什么都不改变。',
      nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流'], danger: 3, dangerLabel: '暗流',
    },
    {
      id: 'shibuya', date: '2018-10-31', label: '2018年10月31日 · 涩谷事变',
      when: '五条悟被封印，宿傩展开领域，涩谷化为地狱',
      situation: '你睁眼时，涩谷已经封场。广播在念条件，人群在尖叫，五条悟还没进场。',
      hook: '这一天之后，咒术界的天平彻底翻了。而你都还没和任何人说过一句话。',
      nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流', '涩谷事变前夜'], danger: 4, dangerLabel: '地狱',
    },
    {
      id: 'culling', date: '2018-11-20', label: '2018年11月 · 死灭回游',
      when: '五条悟已被封印，死灭回游开始',
      situation: '结界封锁全国，泳者互相猎杀。没有规则，只有分数。',
      hook: '在这个阶段，最强的活下来，最聪明的活得久。你选哪个。',
      nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流', '涩谷事变前夜', '涩谷事变'], danger: 5, dangerLabel: '绝境',
    },
    {
      id: 'final', date: '2019-03-10', label: '2019年 · 最终决战',
      when: '宿傩完全体，与残留的术师们最后对峙',
      situation: '该倒的都已经倒了。剩下的人凑在一起，准备最后一搏。',
      hook: '你知道结局。但这一次，赌桌上多了一个不该存在的人 —— 你。',
      nodesDone: ['虎杖吞手指', '死刑缓期', '高专入学', '少年院任务', '宿傩夺舍', '京都姊妹校交流', '涩谷事变前夜', '涩谷事变', '死灭回游'], danger: 5, dangerLabel: '终局',
    },
  ],
}

/** 怀玉篇：原作 2006 年，五条与夏油的高专时代 */
const KAIGYOKU = {
  id: 'kaigyoku',
  name: '怀玉篇',
  subtitle: '2006 · 最强二人',
  era: '2006 — 2007',
  tagline: '五条悟与夏油杰还是高专二年级的时候',
  desc: '天内理子将被交给天元，而有人已经接了杀她的委托。这年夏天之后，一切都会变。',
  startDate: '2006-06-01',
  dateRange: ['2006-06-01', '2007-12-31'],
  // 走完「玉折」之后可以跨到宿傩篇 —— 中间隔着十一年
  next: 'sukuna',
  crossoverNode: '玉折',
  crossoverGap: {
    from: '2007', to: '2018',
    stages: [
      { from: '2007', to: '2010', years: 3, label: '最初的三年' },
      { from: '2010', to: '2014', years: 4, label: '中间四年' },
      { from: '2014', to: '2018', years: 4, label: '最后的四年' },
    ],
  },
  accent: 'tier',

  /** 原作节点排期 —— 见宿傩篇同名注释 */
  nodeSchedule: [
    { node: '天内理子护卫', date: '2006-06-05', danger: 1, dangerLabel: '序章' },
    { node: '冲绳之行', date: '2006-07-10', danger: 2, dangerLabel: '险局' },
    { node: '盘星教袭击', date: '2006-08-05', danger: 4, dangerLabel: '地狱' },
    { node: '理子之死', date: '2006-08-15', danger: 5, dangerLabel: '绝境' },
    // 甚尔之战与五条觉醒是同一个晚上 —— 原作里他刚咽气就睁眼了
    { node: '甚尔之战', date: '2006-08-20', danger: 5, dangerLabel: '绝境' },
    { node: '五条觉醒', date: '2006-08-20', danger: 4, dangerLabel: '地狱' },
    { node: '夏油叛逃', date: '2007-06-15', danger: 4, dangerLabel: '地狱' },
    { node: '玉折', date: '2007-09-01', danger: 5, dangerLabel: '终局' },
  ],

  characters: [
    '五条悟', '夏油杰', '家入硝子', '天内理子', '伏黑甚尔',
    '七海建人', '灰原雄', '夜蛾正道', '黑井美里', '天元',
  ],

  mentors: ['五条悟', '夏油杰', '家入硝子', '七海建人', '灰原雄', '夜蛾正道', '天元'],

  timePoints: [
    {
      id: 'escort', date: '2006-06-01', label: '2006年6月 · 护卫委托',
      when: '天内理子刚被确认为星浆体，护卫任务即将开始',
      situation: '高专还没派出护卫。天元同化的期限在一个月后，诅咒师那边的悬赏已经挂出去了。',
      hook: '这一年的五条悟还没学会反转术式，夏油杰还相信咒术师该保护非术师。',
      nodesDone: [], danger: 1, dangerLabel: '序章',
    },
    {
      id: 'okinawa', date: '2006-07-10', label: '2006年7月 · 冲绳',
      when: '护卫小队带着理子在冲绳暂避',
      situation: '表面上是一次休假。海很蓝，理子在笑 —— 而追杀的人已经在路上了。',
      hook: '这几天是理子这辈子最开心的时候。你知道之后会发生什么。',
      nodesDone: ['天内理子护卫'], danger: 2, dangerLabel: '险局',
    },
    {
      id: 'amass', date: '2006-08-05', label: '2006年8月 · 盘星教',
      when: '盘星教与诅咒师的伏击即将收网',
      situation: '理子被带到盘星教本部。守卫、结界、仪式 —— 还有那个接了委托的男人。',
      hook: '伏黑甚尔不需要咒力就能杀掉最强。这一点，现在只有你知道。',
      nodesDone: ['天内理子护卫', '冲绳之行'], danger: 4, dangerLabel: '地狱',
    },
    {
      id: 'riko', date: '2006-08-15', label: '2006年8月 · 理子之死',
      when: '天内理子在天元面前被枪杀',
      situation: '她跑向天元的那几步，是这一篇的转折点。之后的一切都从这里开始坏掉。',
      hook: '你能不能改写这几秒钟？改写了，五条就不会觉醒 —— 也可能就不会有后来的夏油。',
      nodesDone: ['天内理子护卫', '冲绳之行', '盘星教袭击'], danger: 5, dangerLabel: '绝境',
    },
    {
      id: 'toji', date: '2006-08-20', label: '2006年8月 · 甚尔之战',
      when: '伏黑甚尔单方面屠杀，五条悟在死亡边缘觉醒',
      situation: '最强的男人第一次被杀。然后他从血里站起来，学会了反转术式。',
      hook: '此刻的五条悟正在"醒来"。站错位置，你会死；站对位置，你能改变一整条时间线。',
      nodesDone: ['天内理子护卫', '冲绳之行', '盘星教袭击', '理子之死'], danger: 5, dangerLabel: '绝境',
    },
    {
      id: 'yuzuki', date: '2007-02-01', label: '2007年 · 玉折前夜',
      when: '夏油杰的信念正在崩塌，屠村事件尚未发生',
      situation: '任务还在继续，但夏油开始一个人出勤、一个人回来。他还没做出那个决定。',
      hook: '你现在说的话，可能救下几百条人命 —— 也可能推他更早走上那条路。',
      nodesDone: ['天内理子护卫', '冲绳之行', '盘星教袭击', '理子之死', '甚尔之战', '五条觉醒'], danger: 4, dangerLabel: '地狱',
    },
  ],
}

/**
 * 未来篇：原作完结之后的原创延伸。
 *
 * 这一篇**没有原作依据** —— 原作停在 2018–2019，再往后是空白。
 * 所以节点与穿越时间点是按世界观推演的原创内容，不是考据。
 * 玩家在宿傩篇里改了什么，这里就该长出什么后果。
 */
const FUTURE = {
  id: 'future',
  name: '未来篇',
  subtitle: '2029 · 之后的事',
  era: '2029 — 2031',
  tagline: '原作结束了，但你改出来的那条线还在往前走',
  desc: '十年前的那场仗打完了，也把该碎的都碎了。咒术界在废墟上重建，而废墟下面还有东西在动。',
  startDate: '2029-04-01',
  dateRange: ['2029-04-01', '2031-12-31'],
  accent: 'cursed',
  next: null,
  crossoverGap: null,
  crossoverNode: null,

  /** 原作节点排期 —— 见宿傩篇同名注释。本线是原创推演，日期没有原作依据 */
  nodeSchedule: [
    { node: '咒术界重组', date: '2029-04-05', danger: 2, dangerLabel: '险局' },
    { node: '残秽扩散', date: '2029-08-15', danger: 3, dangerLabel: '暗流' },
    { node: '新容器现身', date: '2030-02-01', danger: 4, dangerLabel: '地狱' },
    { node: '第二座涩谷', date: '2030-10-31', danger: 5, dangerLabel: '绝境' },
    { node: '因果清算', date: '2031-06-01', danger: 5, dangerLabel: '终局' },
    { node: '终局', date: '2031-09-01', danger: 5, dangerLabel: '终局' },
  ],

  characters: [
    '虎杖悠仁', '伏黑惠', '钉崎野蔷薇', '禅院真希', '家入硝子',
    '天元', '宿傩残秽', '新容器', '夜蛾正道', '五条悟',
  ],

  mentors: ['虎杖悠仁', '伏黑惠', '钉崎野蔷薇', '禅院真希', '家入硝子', '天元'],

  timePoints: [
    {
      id: 'rebuild', date: '2029-04-01', label: '2029年4月 · 咒术界重组',
      when: '新的咒术总监部刚挂牌，旧势力还在争席位',
      situation: '名义上恢复了秩序。实际上各地结界年久失修，祓除委托堆积如山，人手只有十年前的一半。',
      hook: '你是少数还记得十年前那场仗怎么打的人。他们需要你 —— 也可能想让你闭嘴。',
      nodesDone: [], danger: 2, dangerLabel: '险局',
    },
    {
      id: 'residue', date: '2029-08-15', label: '2029年8月 · 残秽扩散',
      when: '宿傩死后留下的咒力残秽开始异变',
      situation: '当年被斩碎的东西没有真正消失。残秽在旧战场聚成人形，不攻击人，只是在原地站着。',
      hook: '残秽不杀人，它在等。等什么，没人知道 —— 但你也许猜得到。',
      nodesDone: ['咒术界重组'], danger: 3, dangerLabel: '暗流',
    },
    {
      id: 'vessel', date: '2030-02-01', label: '2030年2月 · 新容器现身',
      when: '一个能承载残秽的孩子被找到了',
      situation: '和当年虎杖一样的年纪，一样能吃下不该吃的东西。高层想直接处决，有人想再利用一次。',
      hook: '这一幕你见过。上一次做决定的人，后来用了十年后悔。',
      nodesDone: ['咒术界重组', '残秽扩散'], danger: 4, dangerLabel: '地狱',
    },
    {
      id: 'shibuya2', date: '2030-10-31', label: '2030年10月31日 · 第二座涩谷',
      when: '同一天，同一套手法，换了一座城市',
      situation: '遮断帷幕落下来的时候，广播的女声和十年前一模一样。这不是模仿，是有人在照着抄。',
      hook: '抄的人很熟悉这套流程。熟悉到，你怀疑他当时就站在现场。',
      nodesDone: ['咒术界重组', '残秽扩散', '新容器现身'], danger: 5, dangerLabel: '绝境',
    },
    {
      id: 'reckoning', date: '2031-06-01', label: '2031年 · 因果清算',
      when: '十年前每一个被改变的选择，开始收账',
      situation: '当年救下的人、放过的人、杀掉的人 —— 他们留下的后果在这几年陆续回来了。',
      hook: '这一篇没有原作给你兜底。你改的东西，现在由你自己承担。',
      nodesDone: ['咒术界重组', '残秽扩散', '新容器现身', '第二座涩谷'], danger: 5, dangerLabel: '终局',
    },
  ],
}

export const STORYLINES = { sukuna: SUKUNA, kaigyoku: KAIGYOKU, future: FUTURE }
export const STORYLINE_LIST = [SUKUNA, KAIGYOKU, FUTURE]
export const DEFAULT_STORYLINE = 'sukuna'

/**
 * 节点名从排期里推出来 —— 两者手抄两份迟早会对不上：
 * 加了节点忘了补排期，那一站轮盘就永远不停，追踪器上却挂着一条"未发生"。
 * 顺序也归排期管：排期是按原作时间先后写的。
 */
for (const line of STORYLINE_LIST) line.nodes = line.nodeSchedule.map((n) => n.node)

export const storylineOf = (id) => STORYLINES[id] || STORYLINES[DEFAULT_STORYLINE]

/** 供前端选线用的精简信息 */
export function storylineBriefs() {
  return STORYLINE_LIST.map((s) => ({
    id: s.id,
    name: s.name,
    subtitle: s.subtitle,
    era: s.era,
    tagline: s.tagline,
    desc: s.desc,
    startDate: s.startDate,
    accent: s.accent,
    nodeCount: s.nodes.length,
    characters: s.characters.slice(0, 6),
  }))
}
