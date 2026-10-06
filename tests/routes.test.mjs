/**
 * HTTP 层联调探针：临时造几份存档文件塞给跑着的服务端，逐条打新接口
 * （日常轮盘 / 疗伤 / 不占回合的反转术式），**全程不调模型**。
 *
 * 和 e2e.mjs 的分工：
 *   e2e      真 API、真模型，验的是"整条链路通不通"，慢且花钱
 *   routes   假存档、真路由，验的是"接口形状对不对"，秒级、免费、可重复
 *
 * 用法：先起服务端（npm run server），再 npm run test:routes。
 * 会往 server/saves/ 写五个临时存档，跑完自己删掉。
 *
 * 会话 id 每次运行都换（RUN 后缀）：服务端把会话缓存在内存里，磁盘只在新会话时读。
 * 复用同一个 id 重跑的话，第二次拿到的是上一轮跑完的状态（反转术式已经用过了），
 * 断言会莫名其妙地红。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { blankState, buildPlayer, TECH_COST_RATIO } = await import('../server/engine/state.js')
const { makeRng } = await import('../server/engine/dice.js')
const { rollAttributeProfile, rollIdentity, rollIdentityKind, rollEnemy } = await import('../server/engine/rolls.js')
const { initCombat } = await import('../server/engine/combat.js')

const B = 'http://localhost:8787'
const SAVES = fileURLToPath(new URL('../server/saves', import.meta.url))
let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  ✔ ${n}${extra ? '  ' + extra : ''}`)) : (fail++, console.log(`  ✘ ${n}  ${extra}`)) }

const RUN = Date.now().toString(36).slice(-5)
const S = {
  wheel: `rt-${RUN}-wheel`,
  due: `rt-${RUN}-due`,
  story: `rt-${RUN}-story`,
  hurt: `rt-${RUN}-hurt`,
  free: `rt-${RUN}-free`,
  norev: `rt-${RUN}-norev`,
  choices: `rt-${RUN}-choices`,
  oldsave: `rt-${RUN}-oldsave`,
  tune: `rt-${RUN}-tune`,
  tuneEmpty: `rt-${RUN}-tuneblank`,
  edit: `rt-${RUN}-edit`,
  editNone: `rt-${RUN}-editblank`,
  sudden: `rt-${RUN}-sudden`,
  suddenNone: `rt-${RUN}-suddennone`,
}

const J = { 'content-type': 'application/json' }
const post = async (u, body) => {
  const r = await fetch(B + u, { method: 'POST', headers: J, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, j: await r.json().catch(() => null) }
}
const get = async (u) => {
  const r = await fetch(B + u)
  return { status: r.status, j: await r.json().catch(() => null) }
}
const del = async (u, body) => {
  const r = await fetch(B + u, { method: 'DELETE', headers: J, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, j: await r.json().catch(() => null) }
}

// 连不上就说人话，别甩一串 ECONNREFUSED 堆栈
try {
  const h = await fetch(`${B}/api/health`)
  if (!h.ok) throw new Error(String(h.status))
} catch {
  console.error(`\n连不上 ${B} —— 先把服务端跑起来（npm run server，或 npm run dev），再跑这条。\n`)
  process.exit(1)
}

function mkState(id, { mode = 'combat', hpRatio = 1, inCombat = false, reverse = '初步', date = null } = {}) {
  const s = blankState(makeRng(7))
  const a = rollAttributeProfile(makeRng(11), 'A')
  Object.assign(a, { techniqueName: '测试术式', techniqueEffect: 'e', techniqueCooldown: 2, talents: [], playstyle: '', domain: { unlocked: false } })
  const ident = rollIdentity(makeRng(13), '甲', rollIdentityKind(makeRng(17), 0))
  Object.assign(ident, { name: '联调者', background: 'b', mainlineRelation: 'm', openingSituation: 'o', hook: 'h', initialRelations: { 家入硝子: 20 } })
  s.player = buildPlayer(a, a, ident, ident)
  s.id = id
  s.phase = 'playing'
  s.playMode = mode
  s.turn = 3
  s.choices = []
  s.log = [{ type: 'turn', turn: 1, narration: '测试。', choices: ['前进'] }]
  s.relations = { 家入硝子: 20 }
  s.player.reverseCursedTechnique = { level: reverse, progress: 0 }
  s.player.hp.cur = Math.round(s.player.hp.max * hpRatio)
  s.player.status = hpRatio >= 1 ? '正常' : hpRatio >= 0.6 ? '轻伤' : hpRatio >= 0.25 ? '重伤' : '濒死'
  // 直接把人放到某一天（用来验"就站在剧情节点当天"的那一档闸门）
  if (date) s.time.date = date
  if (inCombat) {
    initCombat(s, makeRng(23), { mode: 'manual', enemy: rollEnemy(makeRng(29), s.player.grade), reason: '联调' })
  }
  fs.writeFileSync(path.join(SAVES, `${id}.json`), JSON.stringify(s, null, 2), 'utf8')
  return s
}

const cleanup = () => {
  for (const id of Object.values(S)) {
    try { fs.unlinkSync(path.join(SAVES, `${id}.json`)) } catch {}
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

console.log('\n──── 战斗向：轮盘 ────')
mkState(S.wheel)
const st = (await get(`/api/session/${S.wheel}/state`)).j
ok('/state 带出轮盘快照', !!st?.wheel, `milestone=${st?.wheel?.milestone?.node}`)
ok('第一个停的是小节点「虎杖吞手指」，不是最近的大节点', st?.wheel?.milestone?.node === '虎杖吞手指',
  `${st?.wheel?.milestone?.node} @ ${st?.wheel?.milestone?.date}`)
ok('/state 带出轮盘闸门', st?.wheelGate?.ok === true, JSON.stringify(st?.wheelGate))
ok('闸门分开给"能不能转"和"能不能推"', st?.wheelGate?.spin === true && st?.wheelGate?.advance === true,
  JSON.stringify(st?.wheelGate))
ok('/state 带出成长面板的六行', st?.growth?.length === 6, JSON.stringify((st?.growth || []).map((g) => g.id)))
ok('成长进度能对上修炼表', st?.wheel?.sectorsTable?.every((s) => typeof s.progress === 'number'),
  JSON.stringify((st?.wheel?.sectorsTable || []).map((s) => s.progress)))
ok('/state 带出自由行动位（不在战斗时为 null）', st?.freeActions === null, JSON.stringify(st?.freeActions))
ok('选项里没有"跳过当天·修炼"（轮盘取代了它）', !(st?.choices || []).some((c) => c.kind === 'training'), JSON.stringify((st?.choices || []).map((c) => c.kind)))

const spin = await post(`/api/session/${S.wheel}/wheel/spin`)
ok('转一天返回 200', spin.status === 200, JSON.stringify(spin.j).slice(0, 120))
ok('转一天有落点与进度', !!spin.j?.report?.sector && typeof spin.j.report.progress === 'number', JSON.stringify(spin.j?.report?.sector))
ok('转一天告诉玩家这条进度到哪儿了', spin.j?.report?.progressNow > 0, `progressNow=${spin.j?.report?.progressNow}`)
ok('转一天后轮盘天数 +1', spin.j?.wheel?.days === 1, `days=${spin.j?.wheel?.days}`)
ok('转一天不会开出战斗（还没到当天）', spin.j?.combat === null, JSON.stringify(spin.j?.combat))
ok('转完把闸门一起带回来（前端要立刻跟着刷）', spin.j?.gate?.ok === true, JSON.stringify(spin.j?.gate))
const due = (await get(`/api/session/${S.wheel}/state`)).j
ok('剧情节点有排期', !!due?.wheel?.milestone, JSON.stringify(due?.wheel?.milestone?.node))
const adv = await post(`/api/session/${S.wheel}/wheel/advance`)
ok('练到剧情当天返回 200', adv.status === 200, JSON.stringify(adv.j).slice(0, 120))
ok('合并日报带日期区间与天数', !!adv.j?.summary && adv.j.summary.days > 0,
  `${adv.j?.summary?.from} → ${adv.j?.summary?.to} (${adv.j?.summary?.days} 天)`)
ok('日报各方向天数 + 养伤天数 = 总天数',
  !!adv.j?.summary && Object.values(adv.j.summary.sectors).reduce((a, b) => a + b, 0) + (adv.j.summary.rest || 0) === adv.j.summary.days,
  adv.j?.summary && `${JSON.stringify(adv.j.summary.sectors)} + 养伤 ${adv.j.summary.rest || 0} = ${adv.j.summary.days}`)
ok('日报带出六条进度条的结果', !!adv.j?.summary?.progress, JSON.stringify(adv.j?.summary?.progress))
ok('落到当天就把这场仗挂上', !!adv.j?.combat?.enemy, adv.j?.combat?.enemy?.name)
ok('介入标记记的是那个剧情节点', adv.j?.combat?.intervention === '虎杖吞手指', adv.j?.combat?.intervention)
ok('介入理由说得清是哪一天、哪一场', /虎杖吞手指/.test(adv.j?.combat?.reason || ''), adv.j?.combat?.reason)
const gateAfter = (await get(`/api/session/${S.wheel}/wheel`)).j
ok('闸门当场关掉（有遭遇没处理）', gateAfter?.gate?.ok === false, JSON.stringify(gateAfter?.gate))
const blocked = await post(`/api/session/${S.wheel}/wheel/spin`)
ok('有遭遇没处理时不许再转', blocked.status === 400, blocked.j?.error)

console.log('\n──── 战斗向：站在剧情节点当天 ────')
// 玩家正好穿到节点当天（选涩谷开场就是这样）：不能让他再往后转一天，
// 但那一场必须打得成 —— 两个按钮一起禁掉的话人就卡在这儿了
mkState(S.due, { date: '2018-06-08' })
const dn = (await get(`/api/session/${S.due}/wheel`)).j
ok('节点当天：闸门仍然"可用"', dn?.gate?.ok === true, JSON.stringify(dn?.gate))
ok('节点当天：不许再转一天', dn?.gate?.spin === false, JSON.stringify(dn?.gate))
ok('节点当天：那一场必须打得成', dn?.gate?.advance === true, JSON.stringify(dn?.gate))
ok('闸门把原因写清楚了', /虎杖吞手指/.test(dn?.gate?.reason || ''), dn?.gate?.reason)
const spinOnDay = await post(`/api/session/${S.due}/wheel/spin`)
ok('硬转一天会被明确拒绝', spinOnDay.status === 400, spinOnDay.j?.error)
const dBefore = (await get(`/api/session/${S.due}/state`)).j?.panel?.time?.date
ok('被拒之后日期没动', dBefore === '2018-06-08', dBefore)
const advOnDay = await post(`/api/session/${S.due}/wheel/advance`)
ok('当天直接推进 = 开打', advOnDay.status === 200 && !!advOnDay.j?.combat?.enemy, JSON.stringify(advOnDay.j).slice(0, 140))
ok('一天都没推，日报为空', advOnDay.j?.summary?.days === 0, `days=${advOnDay.j?.summary?.days}`)
ok('开的是当天那个节点', advOnDay.j?.combat?.intervention === '虎杖吞手指', advOnDay.j?.combat?.intervention)

console.log('\n──── 剧情向：轮盘不该出现 ────')
mkState(S.story, { mode: 'story' })
const st2 = (await get(`/api/session/${S.story}/state`)).j
ok('剧情向不带轮盘', st2?.wheel === null && st2?.wheelGate === null, `${st2?.wheel} / ${st2?.wheelGate}`)
const w2 = await get(`/api/session/${S.story}/wheel`)
ok('剧情向请求轮盘被拒', w2.j?.gate?.ok === false, w2.j?.gate?.reason)

console.log('\n──── 疗伤 ────')
mkState(S.hurt, { mode: 'story', hpRatio: 0.4 })
const opts = (await get(`/api/session/${S.hurt}/recovery-options`)).j
ok('受伤时列出疗伤手段', opts?.items?.length >= 2, JSON.stringify((opts?.items || []).map((o) => o.id)))
ok('受伤时 needed 为真', opts?.needed === true, `needed=${opts?.needed}`)
const revOpt = (opts?.items || []).find((o) => o.id === 'reverse')
ok('反转术式的代价与回血都在明处', String(revOpt?.desc).includes('生命'), revOpt?.desc)
const before = (await get(`/api/session/${S.hurt}/state`)).j?.panel?.hp?.cur
const rec = await post(`/api/session/${S.hurt}/recovery`, { id: 'reverse' })
ok('反转术式疗伤返回 200', rec.status === 200, JSON.stringify(rec.j).slice(0, 140))
ok('血条当场涨了', rec.j?.panel?.hp?.cur > before, `${before} → ${rec.j?.panel?.hp?.cur}`)
ok('不占时间的方案 days 是 0', rec.j?.days === 0, `days=${rec.j?.days}`)
ok('日志里留下一条 recovery', (await get(`/api/session/${S.hurt}/state`)).j?.log?.some((e) => e.type === 'recovery'))
const shoko = await post(`/api/session/${S.hurt}/recovery`, { id: 'shoko' })
ok('家入硝子这条路能走（关系够）', shoko.status === 200, shoko.j?.error || shoko.j?.name)
ok('疗伤后状态被重算', shoko.j?.status !== undefined, shoko.j?.status)

console.log('\n──── 反转术式：不占回合 ────')
mkState(S.free, { mode: 'combat', hpRatio: 0.5, inCombat: true })
const fa = (await get(`/api/session/${S.free}/state`)).j
ok('战斗中给出自由行动', fa?.freeActions?.[0]?.type === 'reverse', JSON.stringify(fa?.freeActions))
ok('自由行动标明不占回合并给出代价', fa?.freeActions?.[0]?.free === true && fa.freeActions[0].cost > 0,
  `${fa?.freeActions?.[0]?.label} / cost=${fa?.freeActions?.[0]?.cost} / heal=${fa?.freeActions?.[0]?.heal}`)
const hpBefore = fa?.panel?.hp?.cur
const f1 = await post(`/api/session/${S.free}/combat/free-action`, { action: 'reverse' })
ok('反转术式返回 200', f1.status === 200, JSON.stringify(f1.j).slice(0, 140))
ok('带回了角色快照（状态栏立刻能刷）', !!f1.j?.snapshot?.hp, JSON.stringify(f1.j?.snapshot?.hp))
ok('快照里的血条确实涨了', f1.j?.snapshot?.hp?.cur > hpBefore, `${hpBefore} → ${f1.j?.snapshot?.hp?.cur}`)
ok('回合数没动', f1.j?.combat?.turn === 1, `turn=${f1.j?.combat?.turn}`)
ok('只回血、不出手（stats 没记成进攻）', f1.j?.combat?.stats?.usedMelee === false, JSON.stringify(f1.j?.combat?.stats))
ok('这一笔记进了 freeLog', f1.j?.combat?.freeLog?.length === 1, JSON.stringify(f1.j?.combat?.freeLog))
ok('用掉之后按钮变成"本回合已用过"', f1.j?.freeActions?.[0]?.enabled === false, f1.j?.freeActions?.[0]?.note)
const f2 = await post(`/api/session/${S.free}/combat/free-action`, { action: 'reverse' })
ok('同一回合不能用第二次', f2.status === 400, f2.j?.error)
const nonManual = await post(`/api/session/${S.free}/combat/free-action`, { action: 'nope' })
ok('未知自由行动被拒', nonManual.status === 400, nonManual.j?.error)

// 没练成的角色：这一格也得在，只是灰着 —— 按钮凭空消失等于玩家不知道有这个技能
console.log('\n──── 反转术式：还没练成 ────')
mkState(S.norev, { mode: 'combat', hpRatio: 0.5, inCombat: true, reverse: '未掌握' })
const nv = (await get(`/api/session/${S.norev}/state`)).j
const nvSlot = nv?.freeActions?.[0]
ok('没练成也留着那一格', nvSlot?.type === 'reverse', JSON.stringify(nv?.freeActions))
ok('灰着，并写明去哪儿练', nvSlot?.enabled === false && /反转术式修习/.test(nvSlot?.note || ''), nvSlot?.note)
const nvTry = await post(`/api/session/${S.norev}/combat/free-action`, { action: 'reverse' })
ok('真按下去会被明确拒绝', nvTry.status === 400, nvTry.j?.error)

// 选项的生命周期：什么时候该交出来、什么时候必须清掉
console.log('\n──── 剧情选项：过期就得清掉 ────')
{
  const write = (id, mutate) => {
    const s = mkState(id)
    mutate(s)
    fs.writeFileSync(path.join(SAVES, `${id}.json`), JSON.stringify(s, null, 2), 'utf8')
  }

  write(S.choices, (s) => {
    s.choices = [
      { id: '1', label: '前进', kind: 'story' },
      { id: '9', label: '迎战', kind: 'combat-enter' },
    ]
  })
  const c1 = (await get(`/api/session/${S.choices}/state`)).j
  ok('/state 交得出当前可选项', c1?.choices?.length === 2, JSON.stringify(c1?.choices))

  /*
   * 转一天之后世界往前走了，上一轮的选项过期 —— 里面还混着"迎战"这种
   * 带引擎语义的，留着就会被重复触发：玩家会再打一遍已经打完的那场遭遇。
   */
  await post(`/api/session/${S.choices}/wheel/spin`)
  const c2 = (await get(`/api/session/${S.choices}/state`)).j
  ok('转完一天，陈旧选项不再被交出来', (c2?.choices || []).length === 0, JSON.stringify(c2?.choices))

  // 老存档（写这次改动之前存的）没有 choices 字段，得从日志里捞回来
  write(S.oldsave, (s) => {
    delete s.choices
    s.log = [
      { type: 'turn', turn: 1, narration: '一。', choices: ['前进'] },
      { type: 'turn', turn: 2, narration: '二。', choices: ['回头', '继续走'] },
    ]
  })
  const c3 = (await get(`/api/session/${S.oldsave}/state`)).j
  ok('老存档从日志里捞回最后一批选项',
    c3?.choices?.length === 2 && c3.choices[1].label === '继续走',
    JSON.stringify(c3?.choices))

  // 战斗挂起时选项栏必须空着 —— 这里摆着剧情选项，玩家会以为可以绕开这一仗
  write(S.choices, (s) => {
    s.choices = [{ id: '1', label: '前进', kind: 'story' }]
    initCombat(s, makeRng(31), { mode: 'manual', enemy: rollEnemy(makeRng(37), s.player.grade), reason: '联调' })
  })
  const c4 = (await get(`/api/session/${S.choices}/state`)).j
  ok('有遭遇没处理时，选项栏是空的', (c4?.choices || []).length === 0, JSON.stringify(c4?.choices))
}

// ---------------------------------------------------------------- 开局自由度
/*
 * 两条新接口都是**纯引擎**的：
 *   /attributes/custom/tune   等级由数字反推，不调模型
 *   /identities/sudden        故意不调模型（让模型写背景，它一定会补出一个身份）
 *
 * 唯一会打到模型的分支是"改完跨进了特级、而这份档案还没有领域名"——
 * 那一步在这里**不测**：它要花钱，而它的判据（needDomain）是纯函数，
 * tests/creation.test.mjs 已经从两边夹住了。
 * 这里给出去的那份档案预先带好领域名，于是走的仍是免费分支。
 *
 * 每一种起始状态都用一个**自己的会话 id**：服务端把会话缓存在内存里，
 * 同一个 id 第二次请求拿的是缓存，往磁盘上重写存档是无效的。
 */
console.log('\n──── 自定义属性：玩家直接填数字 ────')
{
  const { RANGES, ATTR_GRADE_CAP } = await import('../server/engine/tables.js')
  const { charactersFor } = await import('../server/engine/timeline.js')

  // 一份已经写好领域的自定义档案 —— 名字在，所以调数值永远不会触发模型
  const withDomain = () => {
    const p = rollAttributeProfile(makeRng(2025), '自定义')
    return {
      ...p,
      ce: { ...p.ce, value: 500, grade: '三级' },
      hp: { ...p.hp, value: 150, grade: '三级' },
      cursedDamage: { ...p.cursedDamage, value: 30, grade: '三级' },
      physicalDamage: { ...p.physicalDamage, value: 15, grade: '三级' },
      efficiency: { ...p.efficiency, value: 0.6, grade: '三级' },
      overallGrade: '三级',
      domainUnlocked: false,
      domainTierName: null,
      domain: { unlocked: false, name: '伏魔御厨子·残', sureHit: '必中斩击', cost: '咒力见底', tierName: '完整领域', type: '伤害型' },
      brief: '近身格斗',
    }
  }

  const seed = (id, mutate) => {
    const s = mkState(id)
    mutate(s)
    fs.writeFileSync(path.join(SAVES, `${id}.json`), JSON.stringify(s, null, 2), 'utf8')
    return s
  }
  const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(SAVES, `${id}.json`), 'utf8'))

  seed(S.tune, (s) => { s.attributeProfiles = [withDomain()] })

  const t1 = await post(`/api/session/${S.tune}/attributes/custom/tune`, { numbers: { ce: 5000, hp: 1200 } })
  const p1 = t1.j?.profile
  ok('填了的项按玩家给的数走', p1?.ce?.value === 5000 && p1?.hp?.value === 1200,
    `ce=${p1?.ce?.value} hp=${p1?.hp?.value}`)
  ok('没填的项保持原样', p1?.cursedDamage?.value === 30 && p1?.physicalDamage?.value === 15,
    `cd=${p1?.cursedDamage?.value} pd=${p1?.physicalDamage?.value}`)
  ok('等级由数字反推，不是玩家点单的', p1?.ce?.grade === '一级' && p1?.hp?.grade === '一级',
    `ce=${p1?.ce?.grade} hp=${p1?.hp?.grade}`)

  /*
   * 跨进特级要**五项一起顶**：综合等级取的是五项的中位数，
   * 只把咒力拉满、其余四项还在三级，中位数仍然是三级 —— 那是设计如此。
   */
  const t2 = await post(`/api/session/${S.tune}/attributes/custom/tune`, {
    numbers: {
      ce: 1e15, hp: 1e15, cursedDamage: 1e15, physicalDamage: 1e15, efficiency: 1e15,
    },
  })
  ok('越界的数字夹到开局上限（超特级）', t2.j?.profile?.ce?.value === RANGES[ATTR_GRADE_CAP].ce[1],
    String(t2.j?.profile?.ce?.value))
  ok('五项全顶格就当场觉醒，档位名跟着综合等级走',
    t2.j?.profile?.overallGrade === '超特级' && t2.j?.profile?.domainUnlocked === true &&
      t2.j?.profile?.domain?.tierName === '规则级领域',
    `${t2.j?.profile?.overallGrade} / ${t2.j?.profile?.domainTierName} / ${t2.j?.profile?.domain?.tierName}`)
  ok('已经有名字的领域不会被重写', t2.j?.profile?.domain?.name === '伏魔御厨子·残', t2.j?.profile?.domain?.name)

  const t3 = await post(`/api/session/${S.tune}/attributes/custom/tune`, { numbers: { ce: 'abc', hp: null, efficiency: '' } })
  ok('脏数据当作没填，不会把数值打成 0',
    t3.j?.profile?.ce?.value === t2.j?.profile?.ce?.value && t3.j?.profile?.hp?.value === t2.j?.profile?.hp?.value,
    `ce=${t3.j?.profile?.ce?.value} hp=${t3.j?.profile?.hp?.value}`)

  const saved = onDisk(S.tune).attributeProfiles?.[0]
  ok('调完落了盘（服务端重启也读得到）', saved?.ce?.value === t3.j?.profile?.ce?.value,
    String(saved?.ce?.value))

  seed(S.tuneEmpty, (s) => { s.attributeProfiles = [] })
  const t4 = await post(`/api/session/${S.tuneEmpty}/attributes/custom/tune`, { numbers: { ce: 1 } })
  ok('没生成过自定义档案时，说清楚要先做什么', t4.status === 400, t4.j?.error)
  ok('会话不存在时给 404，不是 500',
    (await post('/api/session/nope-xyz/attributes/custom/tune', { numbers: {} })).status === 404)

  console.log('\n──── 局内改数值：右侧面板那个「编辑」 ────')
  /*
   * 和开局那张卡的区别只有一处：封顶。开局封在超特级（龙级该靠成长走到），
   * 局内封在龙级 —— 已经站在那儿的人，不该因为动了一下输入框就被拽回来。
   * 其余（等级反推、领域觉醒、术式消耗）走的都是同一份 tuneAttributeProfile。
   */
  seed(S.edit, () => {})

  const e1 = await post(`/api/session/${S.edit}/edit`, { numbers: { ce: 1e15, hp: 1e15 } })
  ok('越界的数字夹到局内上限（龙级），不是开局那张卡的超特级',
    e1.j?.panel?.ce?.max === RANGES['龙级'].ce[1] && e1.j?.panel?.hp?.max === RANGES['龙级'].hp[1],
    `ce=${e1.j?.panel?.ce?.max} hp=${e1.j?.panel?.hp?.max}`)
  ok('回执说得清改了什么', Array.isArray(e1.j?.notes) && e1.j.notes.some((n) => /咒力上限/.test(n)),
    JSON.stringify(e1.j?.notes))
  ok('回执里直接带最新面板，界面不用再拉一次', e1.j?.panel?.name === '联调者', e1.j?.panel?.name)

  const e2 = await post(`/api/session/${S.edit}/edit`, { numbers: { ce: RANGES['四级'].ce[0] } })
  ok('往下调也一样生效', e2.j?.panel?.ce?.max === RANGES['四级'].ce[0], String(e2.j?.panel?.ce?.max))
  ok('污染数据当作没填，数值不被打成 0',
    (await post(`/api/session/${S.edit}/edit`, { numbers: { ce: 'abc', hp: null } })).j?.panel?.ce?.max
      === RANGES['四级'].ce[0])

  const eDisk = onDisk(S.edit).player
  ok('改完落了盘（服务端重启也读得到）', eDisk?.ce?.max === RANGES['四级'].ce[0], String(eDisk?.ce?.max))
  ok('术式消耗跟着咒力上限重算',
    eDisk?.technique?.cost === Math.max(1, Math.round(eDisk.ce.max * TECH_COST_RATIO)),
    String(eDisk?.technique?.cost))

  seed(S.editNone, (s) => { s.player = null })
  const e3 = await post(`/api/session/${S.editNone}/edit`, { numbers: { hp: 100 } })
  ok('还没建角色时说清楚，不是 500', e3.status === 400, e3.j?.error)
  ok('会话不存在时给 404',
    (await post('/api/session/nope-xyz/edit', { numbers: {} })).status === 404)

  console.log('\n──── 第五个身份：突然出现的人 ────')
  seed(S.suddenNone, (s) => { s.identityProfiles = [] })
  const s0 = await post(`/api/session/${S.suddenNone}/identities/sudden`, {})
  ok('还没到选身份这一步就拒绝，而不是凭空造一份', s0.status === 409, s0.j?.error)

  seed(S.sudden, (s) => { s.identityProfiles = [{ slot: '甲', kind: '原作关联' }] })
  const s1 = await post(`/api/session/${S.sudden}/identities/sudden`, { name: '  林岸  ', age: 23, brief: '从便利店走出来的' })
  const id1 = s1.j?.identity
  ok('槽位与类型都标成「穿越者」', id1?.slot === '穿越者' && id1?.kind === '穿越者', `${id1?.slot}/${id1?.kind}`)
  ok('名字去掉首尾空白', id1?.name === '林岸', JSON.stringify(id1?.name))
  ok('年龄按玩家填的走', id1?.age === 23, String(id1?.age))

  const names = charactersFor(onDisk(S.sudden).storyline)
  const rel = id1?.initialRelations || {}
  ok('关系值整张留 0 —— 这条线上没有人认识他',
    Object.keys(rel).length === names.length && Object.values(rel).every((v) => v === 0),
    JSON.stringify(rel))
  ok('没有身份、没有立场，这三条不是模型发挥的地方',
    /没有任何关系/.test(id1?.mainlineRelation || '') && !!id1?.openingSituation && !!id1?.hook)

  const s2 = await post(`/api/session/${S.sudden}/identities/sudden`, { name: '   ', age: 999 })
  ok('什么都不填也成立：无名之客', s2.j?.identity?.name === '无名之客', JSON.stringify(s2.j?.identity?.name))
  ok('年龄夹在 10~80', s2.j?.identity?.age === 80, String(s2.j?.identity?.age))

  const kept = onDisk(S.sudden).identityProfiles
  ok('落盘了，且不把预设那份挤掉',
    kept?.length === 2 && kept.some((p) => p.slot === '甲') && kept.some((p) => p.slot === '穿越者'),
    JSON.stringify(kept?.map((p) => p.slot)))

  ok('会话不存在时给 404', (await post('/api/session/nope-xyz/identities/sudden', {})).status === 404)
}

/*
 * 清空全部数据。
 *
 * ⚠️ 这是全套测试里唯一会**真的删东西**的一条 —— 它删的就是 server/saves/。
 * 所以先整份备份到临时目录，跑完（哪怕中途抛了）再放回去。
 * 备份是必要的：这里躺着的可能是玩家真实的进度，一个测试没有资格把它抹掉。
 *
 * 不存在"只在一份假目录上测"的取巧办法：这个接口的价值恰恰在于
 * 它动的是真目录；用一个假目录去验，验的是另一样东西。
 */
console.log('\n──── 清空全部数据 ────')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunuo-backup-'))
  const snapshot = []
  const takeBackup = () => {
    for (const rel of ['', 'slots']) {
      const d = path.join(SAVES, rel)
      if (!fs.existsSync(d)) continue
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.json')) continue
        const src = path.join(d, f)
        const dst = path.join(tmp, rel || '.', f)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
        snapshot.push([src, dst])
      }
    }
  }
  const restore = () => {
    for (const [src, dst] of snapshot) {
      try {
        fs.mkdirSync(path.dirname(src), { recursive: true })
        fs.copyFileSync(dst, src)
      } catch {}
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
  takeBackup()
  process.on('exit', restore)

  const before = fs.readdirSync(SAVES).filter((f) => f.endsWith('.json')).length

  // 没带口令一律不动手，且一个文件都不许少
  const noConfirm = await del('/api/data', {})
  ok('不带确认口令就拒绝', noConfirm.status === 400, noConfirm.j?.error)
  const wrongWord = await del('/api/data', { confirm: true })
  ok('布尔值不算确认（那太容易顺手带上）', wrongWord.status === 400)
  ok('拒绝的时候一个文件都没动',
    fs.readdirSync(SAVES).filter((f) => f.endsWith('.json')).length === before,
    `${before} → ${fs.readdirSync(SAVES).filter((f) => f.endsWith('.json')).length}`)

  // 确认之后真删，并且报出删了多少
  const wiped = await del('/api/data', { confirm: '清除' })
  ok('确认之后清空', wiped.status === 200 && wiped.j?.ok === true, JSON.stringify(wiped.j))
  ok('报出了清掉的会话数（界面要拿它写回执）', typeof wiped.j?.sessions === 'number', String(wiped.j?.sessions))
  ok('会话文件一个不剩', fs.readdirSync(SAVES).filter((f) => f.endsWith('.json')).length === 0)
  ok('存档槽位也清了（目录本身留着）',
    !fs.existsSync(path.join(SAVES, 'slots')) || fs.readdirSync(path.join(SAVES, 'slots')).length === 0)

  // 内存缓存必须一起清：只删磁盘的话，旧 id 还能拿到"已经删掉"的那一局
  const gone = await get(`/api/session/${S.wheel}/state`)
  ok('清掉之后旧会话 id 立刻失效（内存缓存也清了）', gone.status === 404, String(gone.status))

  restore()
  ok('备份放回去了（这条测试不该带走真实进度）',
    fs.readdirSync(SAVES).filter((f) => f.endsWith('.json')).length === before,
    `${fs.readdirSync(SAVES).filter((f) => f.endsWith('.json')).length} / ${before}`)
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`)
cleanup()
process.exit(fail === 0 ? 0 : 1)
