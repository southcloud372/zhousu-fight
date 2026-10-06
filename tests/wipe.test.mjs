/**
 * 「清空全部数据」的纯函数部分。
 *
 * 这条在临时目录里跑，**不碰 server/saves/** —— 那是玩家真实的进度，
 * 一个测试没有资格顺手删掉它。路由那层由 tests/routes.test.mjs 覆盖。
 *
 * 免费、可重复、不打模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { wipeLocalData, WIPE_CONFIRM } from '../server/engine/wipe.js'

/**
 * 自己递归删临时目录。
 *
 * 不用 fs.rmSync —— 它在某些 Windows 环境下什么都不做也不报错
 * （见 tools/clean-dist.mjs 的注释），临时目录会一直堆在 %TEMP% 里。
 * unlinkSync / rmdirSync 是好的。
 */
function rmrf(target) {
  let st
  try { st = fs.lstatSync(target) } catch { return }
  if (!st.isDirectory()) { try { fs.unlinkSync(target) } catch {} ; return }
  for (const name of fs.readdirSync(target)) rmrf(path.join(target, name))
  try { fs.rmdirSync(target) } catch {}
}

/** 造一份"目录里有东西"的现场，返回 { dir, slotDir, files } */
function fixture(sessions = ['a', 'b']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunuo-wipe-'))
  const slotDir = path.join(dir, 'slots')
  fs.mkdirSync(slotDir, { recursive: true })
  const files = []
  for (const id of sessions) {
    const p = path.join(dir, `${id}.json`)
    fs.writeFileSync(p, '{}', 'utf8')
    files.push(p)
  }
  for (const id of ['slot-1', 'slot-2', 'slot-3']) {
    const p = path.join(slotDir, `${id}.json`)
    fs.writeFileSync(p, '{}', 'utf8')
    files.push(p)
  }
  return { dir, slotDir, files }
}

const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : [])

test('会话文件和存档槽位一起清掉', () => {
  const { dir, slotDir } = fixture()
  const sessions = new Map([['a', {}], ['b', {}], ['c', {}]])

  const r = wipeLocalData({ saveDir: dir, slotDir, sessions })

  assert.equal(r.files, 5, `2 个会话 + 3 个存档，实际清了 ${r.files}`)
  assert.equal(r.sessions, 3)
  assert.equal(ls(dir).filter((f) => f.endsWith('.json')).length, 0)
  assert.equal(ls(slotDir).length, 0)
  rmrf(dir)
})

test('内存里的会话跟着一起清 —— 只删磁盘的话缓存还认那些 id', () => {
  const { dir, slotDir } = fixture()
  const sessions = new Map([['a', {}], ['b', {}]])
  wipeLocalData({ saveDir: dir, slotDir, sessions })
  assert.equal(sessions.size, 0, '内存里的会话没清，下一次请求还能拿到"已经删掉"的那一局')
  rmrf(dir)
})

test('只删 .json，别的东西一概不碰', () => {
  const { dir, slotDir } = fixture()
  // 目录以后可能放配置或索引，一个"清缓存"按钮不该顺手把它们带走
  fs.writeFileSync(path.join(dir, 'README.md'), '别删我', 'utf8')
  fs.writeFileSync(path.join(dir, 'index.sqlite'), 'x', 'utf8')

  wipeLocalData({ saveDir: dir, slotDir, sessions: new Map() })

  assert.deepEqual(ls(dir).sort(), ['README.md', 'index.sqlite', 'slots'])
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '别删我')
  rmrf(dir)
})

test('空目录、不存在的目录都不报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunuo-wipe-'))
  assert.deepEqual(wipeLocalData({ saveDir: dir, slotDir: path.join(dir, 'nope'), sessions: new Map() }),
    { files: 0, sessions: 0 })
  assert.deepEqual(wipeLocalData({}), { files: 0, sessions: 0 })
  rmrf(dir)
})

test('口令是个明确的词，不是一个容易顺手带上的布尔值', () => {
  // 这个接口没有撤销键。布尔值在拼请求时太容易被动带上，
  // 一个明确的词则要求调用方真的写了"清除"这两个字。
  assert.equal(WIPE_CONFIRM, '清除')
  assert.equal(typeof WIPE_CONFIRM, 'string')
})
