/**
 * 工具 schema。用 tool calling 而不是 JSON mode，
 * 因为这个端点关掉 thinking 后支持强制 tool_choice，结构最稳。
 *
 * 注意：narration 必须放在 properties 第一位 —— 流式解析靠它做打字机，
 * 放后面就得等整个 JSON 生成完才能出字。
 */

import { playModeOf } from './playmodes.js'
import { DOMAIN_TYPES } from './domains.js'

export const submitAttributeFlavor = {
  name: 'submit_attribute_flavor',
  description: '提交三份属性档案的创意字段（数值由引擎给定，不可修改）',
  input_schema: {
    type: 'object',
    properties: {
      profiles: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            slot: { type: 'string', enum: ['A', 'B', 'C', '自定义'] },
            techniqueName: { type: 'string', description: '生得术式名称' },
            techniqueEffect: { type: 'string', description: '术式效果，一句话说清机制' },
            techniqueCooldown: { type: 'integer', description: '冷却回合数，1~5' },
            domain: {
              type: ['object', 'null'],
              properties: {
                name: { type: 'string' },
                sureHit: { type: 'string', description: '必中效果' },
                cost: { type: 'string', description: '代价' },
                type: {
                  type: 'string',
                  enum: [...DOMAIN_TYPES],
                  description: '领域类型。伤害型＝必中重击并持续追斩；规则型＝封锁对方的术式、反转术式与领域；增益型＝当场回血回咒力并提高暴击。名字与效果要和这一型对得上。',
                },
              },
              required: ['name', 'sureHit', 'cost', 'type'],
              description: 'domainUnlocked 为 false 时填 null',
            },
            talents: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
            playstyle: { type: 'string', description: '给玩家看的一句话玩法风格提示' },
            tool: { type: ['string', 'null'], description: '咒具名称，toolCount 为 0 时填 null' },
          },
          required: ['slot', 'techniqueName', 'techniqueEffect', 'techniqueCooldown', 'domain', 'talents', 'playstyle', 'tool'],
        },
      },
    },
    required: ['profiles'],
  },
}

export const submitIdentityFlavor = {
  name: 'submit_identity_flavor',
  description: '提交三份身份档案的创意字段',
  input_schema: {
    type: 'object',
    properties: {
      identities: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            slot: { type: 'string', enum: ['甲', '乙', '丙', '自定义'] },
            name: { type: 'string' },
            // 只在"自主定义"时使用：由模型按玩家描述判定身份类型，引擎据此重掷关系值
            kind: {
              type: 'string',
              enum: ['原作关联', '反派向', '自由派'],
              description: '仅自主定义时填写；预设三选一时可省略',
            },
            background: { type: 'string', description: '具体背景与来历' },
            mainlineRelation: { type: 'string', description: '与主线的关系' },
            openingSituation: { type: 'string', description: '开局处境' },
            hook: { type: 'string', description: '特殊钩子' },
          },
          required: ['slot', 'name', 'background', 'mainlineRelation', 'openingSituation', 'hook'],
        },
      },
    },
    required: ['identities'],
  },
}

export const submitTurn = {
  name: 'submit_turn',
  description: '提交本回合的剧情推进结果',
  input_schema: {
    type: 'object',
    properties: {
      narration: {
        type: 'string',
        description: '本回合正文。分镜级叙事，战斗/冲突占 70% 以上，日常一句带过。不要写数值变化。',
      },
      // 下面这份 submitTurnFor() 会按游玩模式改写 narration 的描述 ——
      // 见文件末尾
      recap: {
        type: 'string',
        description: '本回合的一句话概括（20~60 字），显示在选项上方。只讲当前状态：谁在哪、发生了什么、手上有什么、接下来要面对什么。不写描写、不复述对话。',
      },
      dialogue: {
        type: 'array',
        description: 'NPC 台词。极简，每句不超过两行。禁止出现弱特级/标特级/超特级/龙级。',
        items: {
          type: 'object',
          properties: {
            speaker: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['speaker', 'text'],
        },
      },
      choices: {
        type: 'array',
        description: '3~4 个行动选项，要有实质分歧。不要写"跳过当天修炼"，引擎会自动追加。',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 4,
      },
      proposal: {
        type: 'object',
        description: '对引擎的数值变更提议，引擎会校验并夹紧。拿不准就填 0。',
        properties: {
          hpDelta: { type: 'integer', description: '玩家血量变化，负数为受伤' },
          ceDelta: { type: 'integer', description: '玩家咒力变化，负数为消耗' },
          relationDelta: {
            type: 'object',
            description: '角色好感度变化，key 用角色全名',
            additionalProperties: { type: 'integer' },
          },
          sukunaAwakeningDelta: { type: 'integer', description: '宿傩觉醒度变化，0~100 的绝对值增量' },
          deaths: { type: 'array', items: { type: 'string' }, description: '本回合确认死亡的角色全名。引擎会永久记下，后续不会再让这个人出现。' },
          flags: { type: 'array', items: { type: 'string' }, description: '剧情标记，如"少年院任务_开始"' },
          timeAdvance: { type: 'string', enum: ['0', '1d', '3d', '1w'], description: '时间推进量' },
        },
        required: ['hpDelta', 'ceDelta', 'relationDelta', 'sukunaAwakeningDelta', 'deaths', 'flags', 'timeAdvance'],
      },
      combatRequest: {
        type: ['object', 'null'],
        description: '若本回合触发战斗，填敌方信息；引擎会按等级表生成实际数值。',
        properties: {
          enemyName: { type: 'string' },
          enemyGrade: {
            type: 'string',
            enum: ['四级', '三级', '二级', '准一级', '一级', '弱特级', '标特级', '超特级', '龙级'],
            description: '应与玩家当前等级相称，差距不超过 2 级；剧情明确要写碾压时才可拉开，且需给出理由。',
          },
          enemyTechniqueName: { type: 'string', description: '敌方的术式名，会出现在战斗面板里' },
          enemyTechniqueEffect: { type: 'string', description: '敌方术式效果，一句话' },
          enemyDomainName: { type: ['string', 'null'], description: '敌方领域名，非特级填 null' },
          enemyDomainType: {
            type: ['string', 'null'],
            enum: [...DOMAIN_TYPES, null],
            description: '敌方领域类型，只在 enemyDomainName 不为 null 时填；否则填 null',
          },
          reason: { type: 'string' },
        },
        required: ['enemyName', 'enemyGrade', 'enemyTechniqueName', 'enemyTechniqueEffect', 'enemyDomainName', 'enemyDomainType', 'reason'],
      },
    },
    required: ['narration', 'recap', 'dialogue', 'choices', 'proposal', 'combatRequest'],
  },
}

export const submitCustomTime = {
  name: 'submit_custom_time',
  description: '把玩家想要的穿越时机解析成一个合法时间点',
  input_schema: {
    type: 'object',
    properties: {
      anchorId: {
        type: 'string',
        enum: ['start', 'juvenile', 'sisters', 'shibuya-eve', 'shibuya', 'culling', 'final'],
        description: '最接近的既有时间点。原作进度与危险度都继承自它，所以必须选最贴近玩家描述的那个。',
      },
      // 说明：submitCustomTime 不需要 recap；下面是 submitOpeningScene 的字段
      date: {
        type: 'string',
        description: '玩家实际落地日期，YYYY-MM-DD，必须落在 2018-06-05 ~ 2019-12-31 之间',
      },
      label: { type: 'string', description: '一行标题，如「2018年9月 · 涩谷前夜」' },
      situation: { type: 'string', description: '那一刻正在发生什么（两三句）' },
      hook: { type: 'string', description: '一句局势提示' },
      note: { type: 'string', description: '一句话说明为什么落在这个时机' },
    },
    required: ['anchorId', 'date', 'label', 'situation', 'hook', 'note'],
  },
}

export const submitOpeningScene = {
  name: 'submit_opening_scene',
  description: '提交开局情境',
  input_schema: {
    type: 'object',
    properties: {
      narration: {
        type: 'string',
        description: '开局情境。直接切入战斗或高张力冲突，不要铺垫。',
      },
      recap: {
        type: 'string',
        description: '开局局面的一句话概括（20~60 字），显示在选项上方。只讲当前状态：你在哪、正在发生什么、手上有什么。',
      },
      dialogue: {
        type: 'array',
        items: {
          type: 'object',
          properties: { speaker: { type: 'string' }, text: { type: 'string' } },
          required: ['speaker', 'text'],
        },
      },
      choices: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 4 },
      proposal: {
        type: 'object',
        properties: {
          hpDelta: { type: 'integer' },
          ceDelta: { type: 'integer' },
          relationDelta: { type: 'object', additionalProperties: { type: 'integer' } },
          sukunaAwakeningDelta: { type: 'integer' },
          deaths: { type: 'array', items: { type: 'string' }, description: '本回合确认死亡的角色全名。引擎会永久记下。' },
          flags: { type: 'array', items: { type: 'string' } },
          timeAdvance: { type: 'string', enum: ['0', '1d', '3d', '1w'] },
        },
        required: ['hpDelta', 'ceDelta', 'relationDelta', 'sukunaAwakeningDelta', 'deaths', 'flags', 'timeAdvance'],
      },
      combatRequest: {
        type: ['object', 'null'],
        properties: {
          enemyName: { type: 'string' },
          enemyGrade: { type: 'string', enum: ['四级', '三级', '二级', '准一级', '一级', '弱特级', '标特级', '超特级', '龙级'] },
          enemyTechniqueName: { type: 'string' },
          enemyTechniqueEffect: { type: 'string' },
          enemyDomainName: { type: ['string', 'null'] },
          enemyDomainType: { type: ['string', 'null'], enum: [...DOMAIN_TYPES, null] },
          reason: { type: 'string' },
        },
        required: ['enemyName', 'enemyGrade', 'enemyTechniqueName', 'enemyTechniqueEffect', 'enemyDomainName', 'enemyDomainType', 'reason'],
      },
    },
    required: ['narration', 'recap', 'dialogue', 'choices', 'proposal', 'combatRequest'],
  },
}

/**
 * 按游玩模式改写过的提交工具。
 *
 * narration 的字数预算是**模式属性**，所以描述也得跟着模式走 ——
 * 战斗向要把"正文 + 台词合计不超过 400 字"写进字段说明里。
 * 这个位置比系统提示更靠近生成点，模型写这个字段时正看着它，比在几千字
 * 之外的规则里说一遍管用得多。
 *
 * 返回的是深拷贝，不动 submitTurn 本身（契约测试直接断言那个常量）。
 */
export function submitTurnFor(playMode) {
  const cap = playModeOf(playMode).narrationCap
  if (!cap) return submitTurn

  const tool = structuredClone(submitTurn)
  tool.input_schema.properties.narration.description =
    `本回合正文。**战斗向：正文与台词合计不超过 ${cap} 字，超出会被引擎退回重写。**`
    + '只写与战斗有关的部分：谁出了什么招、打中了哪里、伤成什么样、局势因此怎么变。'
    + '天气、街景、回忆、内心独白、气氛铺垫一律不写；不要铺垫，开门就是第一招。'
    + '不要写数值变化。'
  tool.input_schema.properties.dialogue.description =
    `NPC 台词。只留战斗中的喊话与短促交流，**算进那 ${cap} 字预算里**。`
    + '禁止出现弱特级/标特级/超特级/龙级。'
  return tool
}
