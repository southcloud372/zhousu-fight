import fs from 'node:fs'
import path from 'node:path'

/**
 * 删掉 dist。
 *
 * 为什么不用 fs.rmSync —— 它在某些 Windows 环境下**什么都不做也不报错**：
 * 不抛异常、不删文件，调用方以为清干净了，其实旧的 bundle 还在。
 * 而 vite 的 outDir 是 ../dist（在 root 之外），它自己不会清空输出目录，
 * 于是 dist/assets 里会躺着好几份不同哈希的 bundle。
 *
 * 后果不是"多占几 MB"，是测试可能在对着半小时前的旧代码跑：
 * 全绿，但什么都没验证到。测试里那条"dist 里没有残留的旧 bundle"
 * 就是为这事立的 —— 它当时报的正是这个脚本没生效。
 *
 * unlinkSync / rmdirSync 是好的，所以自己递归删。全程 best-effort：
 * 删不掉就留着，让那条守卫测试去报，别在这里崩掉整个构建。
 */
function rmrf(target) {
  let st
  try {
    st = fs.lstatSync(target)
  } catch {
    return // 本来就不存在
  }

  if (!st.isDirectory()) {
    try { fs.unlinkSync(target) } catch {}
    return
  }

  for (const name of fs.readdirSync(target)) rmrf(path.join(target, name))
  try { fs.rmdirSync(target) } catch {}
}

const dir = process.argv[2] || 'dist'
rmrf(path.resolve(process.cwd(), dir))
process.exit(0)
