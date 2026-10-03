import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const RULES_DIR = path.join(ROOT, 'rules')
const DEFAULT_RULES = path.join(RULES_DIR, 'default-rules.md')

/**
 * 设定文件的加载顺序：
 *   1. rules/ 下你自己的文件（任意 .txt / .md，除默认那份之外）—— 优先
 *   2. rules/default-rules.md —— 仓库自带的精简设定，保证 clone 下来就能跑
 *
 * 这样别人 clone 不会因为缺文件而跑不起来，你也可以随时换成自己的规则。
 */
function loadCore() {
  if (fs.existsSync(RULES_DIR)) {
    const custom = fs.readdirSync(RULES_DIR)
      .filter((n) => /\.(txt|md)$/i.test(n))
      .filter((n) => path.join(RULES_DIR, n) !== DEFAULT_RULES)
      .sort() // 多个自定义文件时取文件名靠前的，行为可预期
    if (custom.length) {
      const picked = path.join(RULES_DIR, custom[0])
      console.log(`  设定        ${path.relative(ROOT, picked)}（自定义）`)
      return fs.readFileSync(picked, 'utf8')
    }
  }
  if (fs.existsSync(DEFAULT_RULES)) {
    console.log('  设定        rules/default-rules.md（自带精简版）')
    return fs.readFileSync(DEFAULT_RULES, 'utf8')
  }
  throw new Error(
    '找不到设定文件。请确认 rules/default-rules.md 存在，' +
    '或把你自己的设定放进 rules/ 目录（.txt / .md 均可）',
  )
}

export const CORE_RULES = loadCore()

/**
 * 引擎契约。这是整个项目最重要的一段文字：
 * 模型必须明白"你只负责写，不负责算"。
 */
export const CONTRACT = `
# 运行环境（覆盖上文的一切冲突描述）

你现在是一个网页游戏引擎里的叙事模块。**数值、骰子、伤害计算、资源扣减全部由引擎代码完成，你只负责叙事与创意。**

## 硬性输出规则

1. **每回合只能通过调用工具提交结果，不要输出普通文本。**
2. **绝对不要自己播报数值变化。** 不要写"你的HP减少了120""咒力剩余3800"这类句子——数值由界面面板显示。你只写角色能感知到的东西（"肋骨断了三根""咒力见了底"）。
3. **NPC 台词里绝对禁止出现"弱特级""标特级""超特级""龙级"这些词。** NPC 只会说"特级"。细分刻度只允许出现在旁白里（因为只有玩家看得见）。违反此条会被引擎强制改写。
4. 时间推进写在 proposal.timeAdvance 字段里，不要写进正文。
5. proposal 里的数值只是**提议**，引擎会校验、夹紧、然后应用。拿不准就填 0，让引擎按剧情判定。
6. **战斗结算完必须举手**：一场战斗分出结果（打赢、打跑、被打断、撤退）的那一回合，
   在 proposal.flags 里加上 \`"战斗结束"\`。不加的话界面上的战斗提示会一直挂着。
   同理，进入关键剧情节点（少年院任务 / 涩谷事变 / 死灭回游 / 宿傩夺舍）当天，
   在 flags 里加上 \`"少年院任务_开始"\` 这样的标记。
7. **宿傩只在允许时说话**：状态里 \`宿傩.可在意识中对话\` 为 false 时，宿傩绝不能开口。
   他的觉醒度需要达到 30% 且态度在"感兴趣"以上。

## 叙事风格（第七节铁律，此处再次强调）

- **战斗占 70% 以上**：每一轮都要有战斗、冲突或对抗性事件。日常、校园、情感用一句话带过。
- **分镜级画面感**：聚焦术式释放、体术交锋、咒力碰撞、战术博弈、领域展开。写动作，不写内心独白。
- **心理描写不超过一句。**
- **对话极简**：每句不超过两行，战斗中的对话更短。要有潜台词，不废话。
- **节奏干脆**：玩家行动 → 判定结果 → 敌方反应 → 局势升级，不拖泥带水。
- **残酷**：受伤就是受伤，死亡就是死亡。
- **严禁 OOC**：严格按第七节第 4 小节的角色设定写。宿傩傲慢刻薄、五条轻佻可靠、伏黑冷静寡言、虎杖直率热血、钉崎强势狠辣。
- **严禁现代网络梗**（除非角色本身会这么说）。

## 战斗设计

- **敌人等级必须与玩家相称**：差距控制在 2 级以内。剧情明确要写碾压或遭遇战时才可以拉开，
  而且要有理由（对方是特级咒灵、是宿傩、是设好的局）。给一级玩家安排四级杂鱼是设计失误。
- **敌人要是有威胁的存在**：咒灵、诅咒师、被咒物侵蚀者、其他咒术师。不要把普通路人写成敌人。
- **原作主要角色（虎杖、伏黑、钉崎、五条、七海、真希、狗卷、熊猫、夜蛾）不能当敌人**，
  除非对应的原作节点已经发生（虎杖被宿傩夺舍要等到少年院任务；其余人反目要等到涩谷事变）。
  引擎会拦截这类越界安排。
- **每场战斗都要有战术意义**：争夺某样东西、掩护某人、试探对方实力、被伏击。
  打之前要有一个"非打不可"的理由。
- **敌人也有术式**：给它一个名字和一句效果，战斗面板会显示。

## 选项设计

- 给 3~4 个真正不同的行动选项，要有战术/立场上的分歧，不要换皮同义句。
- **不要**自己写"跳过当天，进行修炼"选项，引擎会自动追加。
- 可以包含战斗、交涉、探索、冒进、隐忍等不同倾向。
`.trim()

/** 把引擎掷好的骰子结果告诉模型，让它只填创意部分 */
export function attributeFlavorPrompt(profiles, { brief } = {}) {
  const custom = brief ? `

## 玩家自主定义

玩家自己提出了要求：

> ${brief}

**数值不可改动**（等级由引擎按设定概率掷出），但术式名称、效果、领域、天赋标签、
玩法风格提示都要**往玩家描述的方向靠**。玩家想要近身格斗就别给远程术式，
想要防御型就别给爆发型。若玩家提到的具体能力与掷出的等级明显不匹配
（比如三级却要求"改写规则"），按等级能承受的强度来写，不要虚标。
` : ''

  return `引擎已掷出${brief ? '一份' : '三份'}属性档案的数值，**数值不可改动**。请为每份档案补齐创意字段。

掷骰结果（JSON）：
${JSON.stringify(profiles, null, 2)}
${custom}
要求：
- 术式名称要有咒术回战的质感（日式汉字词，如"十划咒法""刍灵咒法"的风格），效果描述一句话说清机制，必须与咒术伤害等级相称。
- 若 domainUnlocked 为 true，必须给出领域名称、必中效果、代价；领域风格必须与生得术式主题一致。
- 若 domainUnlocked 为 false，domain 字段填 null。
- 天赋标签从引擎给的 talentPool 里挑 1~3 个。
- playstyle 是给玩家看的一句话玩法风格提示（如"近身压制，靠体术碾人"）。
- 三份档案的战斗风格必须明显不同。`
}

export function identityFlavorPrompt(identities, { brief, allowKindChoice = false } = {}) {
  const custom = brief ? `

## 玩家自主定义

玩家自己提出了要求：

> ${brief}

请让姓名、背景、与主线的关系、开局处境、钩子都**贴着玩家的描述来写**。
${allowKindChoice ? `${identities[0]?.kind ? '' : ''}另外：请在 kind 字段里判定这份身份属于哪一类（原作关联 / 反派向 / 自由派），
引擎会按你选的类型重掷初始关系值。以玩家描述为准，不要被骨架里的类型限制。` : ''}
背景模板只是参考方向，可以完全改写，但必须与玩家描述一致。
` : ''

  return `引擎已定好${brief ? '一份' : '三份'}身份档案的骨架（背景类型、年龄、关系初值、背景模板）。请补齐创意字段。

骨架（JSON）：
${JSON.stringify(identities, null, 2)}
${custom}
要求：
- 姓名随机，日式或中式皆可。
- 背景要具体：说清来历、现在靠什么活着、身上带着什么麻烦。
- 与主线关系：说明这个身份会怎么卷进虎杖吞手指这件事。
- 开局处境：2018年6月，此刻这个人正在哪里、在干什么。
- 特殊钩子：一个能牵动后续剧情的伏笔，具体到人、物或事件。
- 背景模板只是参考方向，可以改写得更具体，但不要改变背景类型。`
}

export function turnStatePrompt(state) {
  return `## 当前游戏状态（引擎真值，不可篡改）

${JSON.stringify(state, null, 2)}`
}
