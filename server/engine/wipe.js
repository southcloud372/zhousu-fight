/**
 * 清空本机数据：进行中的会话 + 全部手动存档。
 *
 * 为什么值得做一个按钮：**每一回合都要把整份状态喂给模型**，
 * 而状态里塞着编年史、关系表、完整日志 —— 越往后越厚。
 * 攒下十几局旧会话之后，"继续上次"接回来的可能是一周前那局，
 * 你只是想开个新角色，却先为一段早就忘了的剧情付了第一回合的钱。
 * 清干净再开局，是用量唯一能预期的做法。
 *
 * 三条边界，都是刻意的：
 *   1. **只删 .json**。目录本身留着 —— 删掉再建会在某些平台上撞权限，
 *      而且 saves/ 以后可能放别的东西（配置、索引），不该被一个清缓存按钮带走。
 *   2. **删不掉的文件跳过，不中断整次清理**。一个被别的进程占住的文件
 *      不该让玩家点了按钮却什么都没清掉。
 *   3. **内存里的会话一起清**。只删磁盘的话，服务端缓存还认那些 id，
 *      下一次请求照样能拿到"已经删掉"的那一局。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 二次确认用的口令。
 *
 * 这个接口没有撤销键，一次误点就会抹掉几十回合的存档，
 * 所以要求调用方把"确认清除"这件事显式说出来 —— 布尔值太容易在
 * 拼接请求时不小心带上，一个明确的词不会。
 * 前端 web/src/api.js 里抄了同一个字面量（构建产物进不了 server/），改这里要一起改。
 */
export const WIPE_CONFIRM = '清除'

/**
 * @param {{ saveDir?: string, slotDir?: string, sessions?: Map<string, unknown> }} o
 * @returns {{ files: number, sessions: number }} 实际清掉的存档文件数与内存会话数
 */
export function wipeLocalData({ saveDir, slotDir, sessions } = {}) {
  let files = 0

  // 槽位排在前面：它在 saveDir 里面，先清空再列 saveDir 更直观
  for (const dir of [slotDir, saveDir]) {
    if (!dir || !fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        fs.unlinkSync(path.join(dir, name))
        files++
      } catch {
        // 占住了、权限不够 —— 跳过，别让一个文件毁掉整次清理
      }
    }
  }

  const dropped = sessions?.size ?? 0
  sessions?.clear?.()

  return { files, sessions: dropped }
}
