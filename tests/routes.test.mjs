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
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { blankState, buildPlayer } = await import('../server/engine/state.js')
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

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`)
cleanup()
process.exit(fail === 0 ? 0 : 1)
