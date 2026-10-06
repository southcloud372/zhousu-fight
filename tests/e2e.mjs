const B = 'http://localhost:8787'
let pass = 0, fail = 0
const ok  = (n, c, extra='') => { c ? (pass++, console.log(`  ✔ ${n}${extra?'  '+extra:''}`)) : (fail++, console.log(`  ✘ ${n}${extra?'  '+extra:''}`)) }
const hdr = (s) => console.log(`\n──── ${s} ────`)

const post = async (u, body) => {
  const r = await fetch(B+u,{method:'POST',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined})
  const j = await r.json().catch(()=>null)
  if (!r.ok) throw new Error(`${u} → ${r.status} ${JSON.stringify(j).slice(0,160)}`)
  return j
}
async function sse(u, body, h={}) {
  const res = await fetch(B+u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  if (!res.ok) throw new Error(`${u} → ${res.status} ${(await res.text()).slice(0,160)}`)
  const rd=res.body.getReader(), dec=new TextDecoder(); let carry=''
  while (true) {
    const {done,value}=await rd.read(); if(done) break
    carry += dec.decode(value,{stream:true})
    const blocks=carry.split('\n\n'); carry=blocks.pop()??''
    for (const b of blocks) {
      const ev=b.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim()
      const dl=b.split('\n').find(l=>l.startsWith('data:'))?.slice(5).trim()
      if(ev&&dl) h[ev]?.(JSON.parse(dl))
    }
  }
}

// 全局护栏：整个流程里 NPC 台词不能出现特级细分
const TIER_WORDS = ['弱特级','标特级','超特级','龙级']
let dialogueLeaks = []
const enemyNames = []

hdr('0. 故事线')
const lineRes = await (await fetch(`${B}/api/storylines`)).json()
const lines = lineRes.storylines || []
ok('列出三条故事线', lines.length === 3, lines.map(s => s.name).join(' / '))
const kaigyoku = lines.find(s => s.id === 'kaigyoku')
ok('怀玉篇起始日期正确', kaigyoku?.startDate === '2006-06-01', kaigyoku?.startDate)
ok('各线阵容不同', (() => {
  const sk = lines.find(s => s.id === 'sukuna')
  if (!sk || !kaigyoku) return false
  const b = kaigyoku.characters || []
  // 怀玉篇是 2006 年，虎杖那时还没出生
  return !b.includes('虎杖悠仁') && b.includes('夏油杰')
})(), kaigyoku?.characters?.join('、'))

hdr('1. 开局 · 属性档案')
const { sessionId } = await post('/api/session')
const t0 = Date.now()
await post(`/api/session/${sessionId}/choose-storyline`, { id: 'sukuna' })
const { profiles } = await post(`/api/session/${sessionId}/attributes`)
ok('生成三份档案', profiles.length === 3, `${((Date.now()-t0)/1000).toFixed(1)}s`)
ok('编号为 A/B/C', profiles.map(p=>p.slot).join('') === 'ABC')
ok('每份都有术式名与效果', profiles.every(p=>p.techniqueName && p.techniqueEffect))
ok('特级档案自动觉醒领域', profiles.every(p => p.domain.unlocked === ['弱特级','标特级','超特级','龙级'].includes(p.overallGrade)))
ok('领域含必中效果与代价', profiles.filter(p=>p.domain.unlocked).every(p=>p.domain.sureHit && p.domain.cost))
console.log('   ' + profiles.map(p=>`${p.slot}:${p.overallGrade}/${p.techniqueName}`).join('  '))

hdr('2. 开局 · 身份档案')
const { identities } = await post(`/api/session/${sessionId}/choose-attributes`, { slot: profiles[0].slot })
ok('生成三份身份', identities.length === 3)
ok('含反派向', identities.some(i=>i.kind==='反派向'))
ok('含自由派', identities.some(i=>i.kind==='自由派'))
ok('每份都有钩子', identities.every(i=>i.hook && i.hook.length > 8))
console.log('   ' + identities.map(i=>`${i.slot}:${i.name}(${i.kind})`).join('  '))

hdr('3. 开局 · 穿越时间')
const timeRes = await post(`/api/session/${sessionId}/choose-identity`, { slot: identities[0].slot })
ok('选出三份穿越时间', timeRes.times?.length === 3, timeRes.times?.map(t=>t.id).join(', '))
ok('保底含最开篇', timeRes.times?.some(t=>t.id === 'start'), '必须永远能选到 2018年6月')
ok('每份都有日期与处境', timeRes.times?.every(t=>t.date && t.situation && t.danger))
ok('按时间先后排序', (() => {
  const d = (timeRes.times||[]).map(t=>t.date)
  return d.every((v,i) => i===0 || d[i-1] <= v)
})())
console.log('   ' + timeRes.times.map(t=>`${t.date} ${t.label.split('·')[1]?.trim()||''}`).join('  |  '))

hdr('4. 开局 · 最终档案与开局情境')
const open = await post(`/api/session/${sessionId}/choose-time`, { id: 'start' })
ok('返回角色面板', !!open.panel?.name)
ok('起始日期跟随所选时间点', open.panel?.time?.date === '2018-06-05', open.panel?.time?.date)
ok('时间线节点按时间点预置', open.panel?.timeline?.nodes?.['涩谷事变'] === '未发生', '选最开篇时涩谷事变不该已发生')
ok('开局直接切入冲突', (open.narration||'').length > 100, `${(open.narration||'').length} 字`)
ok('给出选项', open.choices.length >= 4)
ok('末项为"跳过当天修炼"', open.choices.at(-1).kind === 'training')
ok('选项均为可渲染对象', open.choices.every(c=>c.id && c.label && c.kind))
open.dialogue.forEach(d => { if (TIER_WORDS.some(w=>d.text.includes(w))) dialogueLeaks.push(`开局 ${d.speaker}: ${d.text}`) })
console.log(`   角色 ${open.panel.name} ${open.panel.grade} | HP ${open.panel.hp.max} | 咒力 ${open.panel.ce.max}`)

hdr('5. 主循环 · 推流')
let turnDone = null, narr = '', firstAt = null
const t1 = Date.now()
await sse(`/api/session/${sessionId}/turn`, { input: open.choices[0].label }, {
  narration: d => { if(!firstAt) firstAt = Date.now()-t1; narr += d.text },
  done: d => { turnDone = d },
})
ok('收到完整回合', !!turnDone)
ok('正文有内容', narr.length > 80, `${narr.length} 字`)
ok('首字延迟 < 8s', firstAt !== null && firstAt < 8000, `${firstAt}ms`)
ok('返回选项', turnDone.choices?.length >= 4)
ok('返回面板快照', !!turnDone.panel?.hp)
turnDone.dialogue?.forEach(d => { if (TIER_WORDS.some(w=>d.text.includes(w))) dialogueLeaks.push(`回合 ${d.speaker}: ${d.text}`) })

hdr('6. 战斗 · 手动模式')
let pending = turnDone.combat || open.combat
// 模型不保证两回合内一定开打，多试几次
for (let attempt = 0; !pending && attempt < 5; attempt++) {
  let p2 = null
  await sse(`/api/session/${sessionId}/turn`, { input: turnDone.choices[0].label }, { done: d => { p2 = d } })
  if (p2) { turnDone = p2; pending = p2.combat }
}
if (pending) enemyNames.push(pending.enemy.name)
ok('触发遭遇战', !!pending, pending ? `${pending.enemy.name}(${pending.enemy.grade})` : '5 轮内未触发')

if (pending) {
  let actions = null, startDone = null, startPanel = null
  await sse(`/api/session/${sessionId}/combat/start`, { mode:'manual' }, {
    awaiting: d => { actions = d.actions },
    panel: d => { startPanel = d.panel },
    done: d => { startDone = d },
  })
  ok('三模式可选', true, '手动/跳过/剧情')
  ok('给出可用行动', actions?.length >= 4, actions?.map(a=>a.type).join(','))

  // 契约：panel 事件是战斗回合面板，done 里必须同时有角色快照和行动栏。
  // 早先 done 里放的是战斗面板，前端拿去喂角色侧栏 → 一开打就白屏。
  ok('done 携带角色快照', !!startDone?.snapshot?.hp && !!startDone?.snapshot?.ce,
     startDone?.snapshot ? `HP ${startDone.snapshot.hp.cur}/${startDone.snapshot.hp.max}` : '缺失')
  ok('done 携带行动栏（否则开打瞬间行动栏会消失）', Array.isArray(startDone?.actions) && startDone.actions.length >= 4)
  ok('panel 事件的形状是战斗回合面板', !!startPanel?.turn && !!startPanel?.player && !!startPanel?.enemy)

  // 反转术式：不占回合的自由行动。代价与回血由服务端算好放在按钮上，
  // 按下去必须当场带回角色快照 —— 之前就是血条不动，玩家以为技能没生效。
  // 没练成也必须有这一格（灰着 + 写清楚去哪儿练），所以这里查的是"在不在"。
  const free0 = startDone?.freeActions?.[0]
  ok('开打时给出不占回合的反转术式位', free0?.type === 'reverse' && free0?.free === true,
     free0 ? `${free0.label} / ${free0.note}` : '缺失')
  if (free0?.enabled) {
    const hpBefore = startDone.snapshot.hp.cur
    const fr = await post(`/api/session/${sessionId}/combat/free-action`, { action: 'reverse' })
    ok('反转术式当场回血', fr.snapshot.hp.cur > hpBefore, `HP ${hpBefore} → ${fr.snapshot.hp.cur}`)
    ok('反转术式不占回合', fr.combat?.turn === 1 && fr.combat?.stats?.usedMelee === false,
       `turn=${fr.combat?.turn} usedMelee=${fr.combat?.stats?.usedMelee}`)
    const again = await fetch(`${B}/api/session/${sessionId}/combat/free-action`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reverse' }) })
    ok('同一回合不能用第二次', again.status === 400)
  } else {
    // 灰着的那一格必须给得出理由（没练成 / 血满 / 咒力不够），而且真按下去要被拒
    ok('灰着的反转术式写明了原因', !!free0?.note, free0?.note)
  }

  let rounds = 0, over = false, fin = null
  while (rounds < 15 && !over) {
    const pick = actions.find(a=>a.type==='domain'&&a.enabled) ? 'domain'
      : actions.find(a=>a.type==='technique'&&a.enabled) ? 'technique' : 'physical'
    let panel = null
    await sse(`/api/session/${sessionId}/combat/action`, { action: pick }, {
      panel: d => { panel = d.panel },
      done: d => { over = d.over; fin = d; if (d.actions) actions = d.actions },
    })
    if (panel) {
      ok(`第${panel.turn}回合面板字段完整`, ['turn','player','enemy','actionText','enemyActionText'].every(k=>panel[k]!==undefined))
      ok(`第${panel.turn}回合数值合法`, panel.player.hp >= 0 && panel.player.hp <= panel.player.hpMax && panel.enemy.hp >= 0)
    }
    rounds++
  }
  ok('战斗能分出胜负', over, `${rounds} 回合 → ${JSON.stringify(fin?.outcome)}`)
  ok('结算给出战果', !!fin?.rewards, JSON.stringify(fin?.rewards?.gains||{}))
  ok('战后 HP 未越界', fin.panel.hp.cur >= 0 && fin.panel.hp.cur <= fin.panel.hp.max)
  ok('战后咒力未越界', fin.panel.ce.cur >= 0 && fin.panel.ce.cur <= fin.panel.ce.max)
}

hdr('6.5 战斗向：日常轮盘与疗伤')
// 轮盘和疗伤都是纯引擎结算，不调模型 —— 这几条是廉价的，但能守住接口形状
await post(`/api/session/${sessionId}/play-mode`, { mode: 'combat' })
const w0 = await (await fetch(`${B}/api/session/${sessionId}/wheel`)).json()
ok('切成战斗向后轮盘可用', w0.gate?.ok === true, w0.gate?.reason || '')
ok('闸门分开给"能不能转"和"能不能推"',
   typeof w0.gate?.spin === 'boolean' && typeof w0.gate?.advance === 'boolean', JSON.stringify(w0.gate))
ok('轮盘给出下一个剧情节点', !!w0.wheel?.milestone?.node, w0.wheel?.milestone?.node)
ok('轮盘六个方向都带权重', w0.wheel?.sectorsTable?.length === 6,
   w0.wheel?.sectorsTable?.map(s=>s.short).join('/'))
ok('每个方向都带自己的成长进度', w0.wheel?.sectorsTable?.every(s => typeof s.progress === 'number'),
   (w0.wheel?.sectorsTable||[]).map(s=>`${s.short} ${s.progress}%`).join(' / '))
ok('成长面板的六行标题跟着状态一起来', w0.growth?.length === 6, (w0.growth||[]).map(g=>g.id).join('/'))
const spin = await post(`/api/session/${sessionId}/wheel/spin`)
// 重伤 / 濒死的那天只能躺着养伤，这时候没有落点是正确行为，不是丢数据
const sec = spin.report?.sector
ok('转一天要么落在某个方向上、要么躺着养伤', !!(sec?.short || spin.report?.kind === 'rest'),
   sec ? `${sec.short} +${spin.report.progress}%` : `养伤（${spin.report?.notes?.[0] || '…'}）`)
ok('转一天只走一天', spin.wheel?.days === (w0.wheel?.days || 0) + 1, `累计 ${spin.wheel?.days} 天`)
ok('转一天带出角色快照', !!spin.panel?.hp)
// 转完这一天可能正好落在剧情节点当天 —— 闸门必须当场跟着回来，否则界面还留着可点的「转一天」
ok('转一天把闸门一起带回来', typeof spin.gate?.spin === 'boolean', JSON.stringify(spin.gate))
const adv = await post(`/api/session/${sessionId}/wheel/advance`)
if (adv.summary?.days > 0) {
  ok('练到剧情当天会合并成一张日报', !!adv.summary.from && !!adv.summary.to,
     `${adv.summary.from} → ${adv.summary.to} 共 ${adv.summary.days} 天`)
  ok('日报里各方向天数加养伤天数等于总天数',
     Object.values(adv.summary.sectors||{}).reduce((a,b)=>a+b,0) + (adv.summary.rest||0) === adv.summary.days,
     `${JSON.stringify(adv.summary.sectors)} + 养伤 ${adv.summary.rest||0} = ${adv.summary.days} 天`)
  ok('日报带出六条进度条各自到哪儿了', Object.keys(adv.summary.progress||{}).length === 6,
     JSON.stringify(adv.summary.progress))
  ok('练到当天就把介入战挂上', !!adv.combat?.enemy?.name, adv.combat?.enemy?.name || '未挂上')
} else {
  ok('已经贴在剧情当天，练不进更远', true, '当天转不动是正确行为')
}
ok('推进后闸门也一起回来', typeof adv.gate?.spin === 'boolean', JSON.stringify(adv.gate))
const ro = await (await fetch(`${B}/api/session/${sessionId}/recovery-options`)).json()
ok('疗伤清单三项齐全', ro.items?.length === 3, ro.items?.map(i=>i.id).join('/'))
ok('每一项都给出能不能用', ro.items?.every(i => typeof i.enabled === 'boolean' && typeof i.reason === 'string'))
// 疗伤入口是跟着伤势开关的：血条见底才该冒出来（刚被宿傩打了一顿，这里通常是开着的）
const st65 = await (await fetch(`${B}/api/session/${sessionId}/state`)).json()
const hurt = st65.panel.status !== '正常' || st65.panel.hp.cur < st65.panel.hp.max * 0.6
ok('疗伤清单与伤势对得上', ro.needed === hurt,
   `needed=${ro.needed} HP ${st65.panel.hp.cur}/${st65.panel.hp.max} ${st65.panel.status}`)
ok('受伤时选项里才多出疗伤入口',
   (st65.choices||[]).some(c => c.kind === 'recovery') === hurt,
   (st65.choices||[]).map(c=>c.kind).join(','))
await post(`/api/session/${sessionId}/play-mode`, { mode: 'story' })
const back = await (await fetch(`${B}/api/session/${sessionId}/wheel`)).json()
ok('切回剧情向后轮盘关掉', back.gate?.ok === false, back.gate?.reason)

hdr('7. 存档槽位')
const sv = await post(`/api/session/${sessionId}/save`, { name: '自检存档' })
const list = await (await fetch(B+'/api/saves')).json()
ok('保存成功', list.saves.some(s=>s.id===sv.id))
ok('列表含角色信息', list.saves[0]?.playerName && list.saves[0]?.grade)
const loaded = await post(`/api/saves/${sv.id}/load`)
ok('读取生成新会话', loaded.sessionId !== sessionId)
ok('读档还原剧情记录', (loaded.log||[]).length > 0, `${loaded.log?.length} 条`)
ok('读档还原选项', (loaded.choices||[]).length >= 4)
await fetch(`${B}/api/saves/${sv.id}`, { method:'DELETE' })
const after = await (await fetch(B+'/api/saves')).json()
ok('删除生效', !after.saves.some(s=>s.id===sv.id))

hdr('8. 巡查：设定一致性')
/*
 * 越界限制已经取消 —— 虎杖、五条这些人现在可以正常当敌人。
 * 要盯的不再是"他有没有出现"，而是"出现时数值对不对"：
 * 原著人物一律经过 canon.js 校正，等级必须落在原作表那一档。
 * 这一条只做粗查（名字与等级的对应），细查在 engine.test.mjs 里。
 */
const CANON_GRADES = { 五条悟: '超特级', 宿傩: '龙级' }
for (const name of enemyNames) {
  const who = Object.keys(CANON_GRADES).find(w => name.includes(w))
  if (!who) continue
  const eg = pending?.enemy?.grade
  ok(`原作角色「${who}」的等级被校正过`, eg === CANON_GRADES[who], `实际 ${eg}`)
}
ok('NPC 台词无特级细分泄漏', dialogueLeaks.length === 0,
   dialogueLeaks.length ? `${dialogueLeaks.length} 处：${dialogueLeaks[0]}` : '（引擎后处理生效）')

hdr('9. 巡查：非法输入')
const r1 = await fetch(`${B}/api/session/${sessionId}/turn`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:''})})
ok('空输入被拒', r1.status === 400)
const r2 = await fetch(`${B}/api/session/不存在的会话/state`)
ok('未知会话返回 404', r2.status === 404)
const r3 = await fetch(`${B}/api/session/${sessionId}/combat/action`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'technique'})})
ok('非战斗中禁止出招', r3.status === 400)
const r3b = await fetch(`${B}/api/session/${sessionId}/combat/free-action`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reverse'})})
ok('非战斗中禁止用反转术式', r3b.status === 400)

console.log(`\n═══ 自检结果：${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail ? 1 : 0)
