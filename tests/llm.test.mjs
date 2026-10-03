import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractPartialString } from '../server/llm.js'

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
