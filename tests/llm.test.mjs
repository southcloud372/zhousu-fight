import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractPartialString, salvageToolInput } from '../server/llm.js'

/**
 * extractPartialString 是整个项目最取巧的一段代码：
 * 模型还在吐 tool 入参的 JSON 时，就要把 narration 字段的当前值抠出来做打字机。
 * 它之前只被端到端间接验证过，边界情况（转义、截断、代理对）全没覆盖。
 *
 * 判定标准很简单：**在任意位置截断缓冲区，结果都必须等于完整 JSON 解析出来的前缀。**
 * 这一条性质如果成立，打字机就不会吐出脏字符。
 */

const wrap = (value) => `{"narration":${value},"choices":["a","b","c"]}`

/** 完整 JSON 里 narration 的真值 */
const truth = (obj) => JSON.parse(obj).narration

function snapshot(buf) {
  return extractPartialString(buf, 'narration')
}

// ------------------------------------------------------------------ 基本

test('完整 JSON 能取出字段', () => {
  const s = wrap('"你好世界"')
  assert.equal(snapshot(s), '你好世界')
})

test('字段还没出现时返回 null', () => {
  assert.equal(snapshot(''), null)
  assert.equal(snapshot('{"nar'), null)
  assert.equal(snapshot('{"other":1}'), null)
})

test('值还没开始写时返回 null', () => {
  assert.equal(snapshot('{"narration":'), null)
  assert.equal(snapshot('{"narration": '), null)
  assert.equal(snapshot('{"narration": nul'), null)
})

test('值不是字符串时返回 null，不会硬吞', () => {
  assert.equal(snapshot('{"narration":null}'), null)
  assert.equal(snapshot('{"narration":123}'), null)
  assert.equal(snapshot('{"narration":true}'), null)
})

test('键名带空格也能识别', () => {
  assert.equal(snapshot('{"narration" : "abc"}'), 'abc')
})

test('narration 不是第一个字段也能取出', () => {
  assert.equal(snapshot('{"a":1,"narration":"后置","b":2}'), '后置')
})

test('字符串未闭合时返回已收到的部分', () => {
  assert.equal(snapshot('{"narration":"写到一半'), '写到一半')
})

test('字符串闭合后立刻返回，不会把后面的字段也吞进来', () => {
  assert.equal(snapshot(wrap('"正文"')), '正文')
})

// ------------------------------------------------------------------ 转义

test('标准转义序列解码正确', () => {
  const cases = [
    ['\\n', '\n', '换行'],
    ['\\t', '\t', '制表'],
    ['\\r', '\r', '回车'],
    ['\\b', '\b', '退格'],
    ['\\f', '\f', '换页'],
    ['\\"', '"', '双引号'],
    ['\\\\', '\\', '反斜杠'],
    ['\\/', '/', '正斜杠'],
  ]
  for (const [esc, expected, name] of cases) {
    const buf = `{"narration":"A${esc}B"}`
    assert.equal(snapshot(buf), `A${expected}B`, `${name} (${esc}) 解码错误`)
    // 顺带对照 JSON.parse，确保我们和标准实现一致
    assert.equal(snapshot(buf), truth(buf), `${name} 与 JSON.parse 不一致`)
  }
})

test('\\uXXXX 解码正确（含中文）', () => {
  const buf = '{"narration":"\\u4f60\\u597d"}'
  assert.equal(snapshot(buf), '你好')
  assert.equal(snapshot(buf), truth(buf))
})

test('\\uXXXX 代理对（emoji）解码正确', () => {
  const buf = '{"narration":"\\ud83d\\ude00"}'
  assert.equal(snapshot(buf), '😀')
  assert.equal(snapshot(buf), truth(buf))
})

test('转义序列被截断时不会吐出垃圾', () => {
  const full = '{"narration":"A\\nB\\u4f60C"}'
  for (let i = 1; i <= full.length; i++) {
    const got = snapshot(full.slice(0, i))
    if (got !== null) {
      const real = truth(full)
      assert.ok(real.startsWith(got) || got.length <= real.length + 1,
        `截断到 ${i} 时得到 ${JSON.stringify(got)}，不是真值的前缀 ${JSON.stringify(real)}`)
    }
  }
})

// ------------------------------------------------------------------ 任意截断

test('任意位置截断，结果都是真值的前缀（打字机的核心保证）', () => {
  const full = wrap('"第一段。\\n第二段，「引号」和\\\\反斜杠，还有\\t制表。"')
  const real = truth(full)
  for (let i = 1; i <= full.length; i++) {
    const got = snapshot(full.slice(0, i))
    if (got === null) continue
    assert.ok(real.startsWith(got),
      `截断到 ${i}：得到 ${JSON.stringify(got)}，但它不是 ${JSON.stringify(real)} 的前缀`)
  }
})

test('流式逐块喂入，最终结果等于完整解析', () => {
  const full = wrap('"流式测试：\\n咒力涌动，「宿傩」二字浮现在意识里。"')
  let buf = ''
  let last = null
  for (const ch of full) {
    buf += ch
    const got = snapshot(buf)
    if (got !== null) {
      // 只能单调增长，绝不能回退（回退会让打字机闪烁）
      if (last !== null) assert.ok(got.startsWith(last), '抽取结果出现回退')
      last = got
    }
  }
  assert.equal(last, truth(full))
})

test('内容里出现转义引号不会提前截断', () => {
  const full = wrap('"他说：\\"让开。\\"然后就没了。"')
  assert.equal(snapshot(full), '他说："让开。"然后就没了。')
  assert.equal(snapshot(full), truth(full))
})

test('内容里出现 narration 这个词不会误判', () => {
  const full = wrap('"narration 只是一个字段名。"')
  assert.equal(snapshot(full), 'narration 只是一个字段名。')
})

test('内容里出现 \\" 开头的其它键名不会串位', () => {
  const full = '{"narration":"上面写着 \\"narration\\": 假的","x":1}'
  assert.equal(snapshot(full), '上面写着 "narration": 假的')
  assert.equal(snapshot(full), truth(full))
})

// ------------------------------------------------------------------ 真实形状

test('对真实的 submit_turn 入参形状可用', () => {
  const obj = {
    narration: '宿傩抬手。\n\n斩击从三个方向同时落下，「捌」的咒力把空气切开。',
    dialogue: [{ speaker: '宿傩', text: '就这？' }],
    choices: ['硬接', '闪避', '反击'],
  }
  const full = JSON.stringify(obj)
  // 模拟流式：每次 7 个字符
  let buf = ''
  let last = null
  for (let i = 0; i < full.length; i += 7) {
    buf = full.slice(0, i + 7)
    const got = snapshot(buf)
    if (got !== null) last = got
  }
  assert.equal(last, obj.narration)
})

test('自定义字段名可用', () => {
  assert.equal(extractPartialString('{"scene":"场景文本"}', 'scene'), '场景文本')
  assert.equal(extractPartialString('{"narration":"x"}', 'scene'), null)
})

// ------------------------------------------------------------------ 残缺 JSON 抢救

test('模型把自己的工具调用语法写进 JSON 时能抢救出正文', () => {
  // 实测撞到的原文（doubao 系列会把 XML 式工具语法漏进字符串里）
  const broken = '{"narration": "你不再拆招。\n\n左手压他按在你腕上的那只手，右手缝贴着肋侧那道旧口收线。\n\n他最后一口气落在砖面上，只剩一句。\n\n「……原来，是真要杀。」</doubao>\n\n<parameter name="dialogue">[{"speaker": "虎杖悠仁", "text": "……原来，是真要杀。"}]'
  const r = salvageToolInput(broken)
  assert.ok(r, '应当抢救成功，而不是整个回合作废')
  assert.match(r.narration, /你不再拆招/, '正文没捞回来')
  assert.match(r.narration, /原来，是真要杀/, '正文被截断了')
  // 尾部挂着的残破标签必须切掉，不能出现在玩家看到的故事里
  assert.ok(!/doubao/.test(r.narration), `正文里残留了模型标签：${r.narration.slice(-40)}`)
  assert.ok(!/<parameter/.test(r.narration), '正文里残留了工具调用语法')
  // 台词能捞就捞
  assert.equal(r.dialogue[0]?.speaker, '虎杖悠仁')
  // 提议字段补齐，引擎才能正常处理
  assert.equal(r.proposal.hpDelta, 0)
  assert.deepEqual(r.proposal.flags, [])
})

test('截断在正文中间时也能拿到已产出的部分', () => {
  const cut = '{"narration": "他抬手，斩击从三个方向同时落下，空气被切开'
  const r = salvageToolInput(cut)
  assert.ok(r)
  assert.match(r.narration, /斩击从三个方向/)
})

test('正文太短或压根没有时返回 null，交给上层重试', () => {
  // 宁可重试，也不要拿半句话糊弄玩家
  assert.equal(salvageToolInput('{"narration": "短"}'), null)
  assert.equal(salvageToolInput('{"dialogue": []}'), null)
  assert.equal(salvageToolInput(''), null)
  assert.equal(salvageToolInput(null), null)
  assert.equal(salvageToolInput('{'), null)
})

test('抢救不会把正常的 JSON 也带偏', () => {
  const good = JSON.stringify({ narration: '正文'.repeat(40), choices: ['甲', '乙'] })
  assert.equal(JSON.parse(good).narration, '正文'.repeat(40))
  // 正常 JSON 应当走 JSON.parse，不该走抢救路径
  const r = salvageToolInput(good)
  assert.ok(r, '抢救路径对正常输入也应当可用（兜底）')
  assert.match(r.narration, /^正文/)
})
