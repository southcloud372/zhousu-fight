/**
 * 覆盖率审计：列出从没被任何测试引用过的导出。
 * 不是精确的行覆盖率，只回答一个问题 —— "这个模块有没有人碰过"。
 *
 * 用法：node tests/coverage-audit.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const testSrc = fs.readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8'))
  .join('\n')

const targets = [
  ...fs.readdirSync(path.join(ROOT, 'server/engine')).map((f) => `server/engine/${f}`),
  'server/llm.js',
  'server/prompts.js',
].filter((f) => f.endsWith('.js'))

let total = 0
let untestedTotal = 0

for (const rel of targets) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const names = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/g)].map((m) => m[1])
  if (!names.length) continue
  const untested = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(testSrc))
  total += names.length
  untestedTotal += untested.length
  const pct = (((names.length - untested.length) / names.length) * 100).toFixed(0)
  const mark = untested.length === 0 ? '✔' : '·'
  console.log(`${mark} ${rel.replace('server/', '').padEnd(24)} ${pct.padStart(3)}%  ${untested.length ? '未覆盖: ' + untested.join(', ') : ''}`)
}

console.log(`\n合计 ${total - untestedTotal} / ${total} 个导出被测试引用`)
