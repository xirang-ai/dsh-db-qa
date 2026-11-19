/**
 * 首次提问对账：查询会话在用户真正发出消息时才进入问题列表。
 *
 * 问题列表的唯一来源是 `dbqa_conversation`，而「选了 Agent 和数据源」并不等于
 * 「开始了一次对话」。宿主在这里监听 `session/event`，只认首条真人
 * `user/message`（`source.kind === 'user'`，排除 skill、cron、agent.inject 等
 * 合成消息），把行标成已开始；分析会话不落列表行。
 *
 * 预设取当前投影（`agentPreset`，能覆盖空白期的切换），投影不可用时退回
 * 会话创建时的 `header.agentPreset`。首轮之后宿主会锁死预设，因此这里决定的
 * 类型不会再漂移。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'

import type { DbqaDatabase } from './store/db.ts'
import type { FlowLogger } from './store/db.ts'

/** 只有查询预设的会话进问题列表。 */
const QUERY_PRESET = 'dbqa-query'

/** 标题取首条提问的前 60 字（与 `dbqa_conversation.title` 的注释一致）。 */
const TITLE_LIMIT = 60

/** 宿主会话的最小结构；插件不直接依赖 `@deepseek-ai/dsh-session`。 */
interface SessionLike {
  readonly id: string
  readonly header: { readonly agentPreset?: string | null }
}

interface ContentBlockLike {
  readonly type: string
  readonly text?: string
}

interface UserMessageLike {
  readonly source?: { readonly kind?: string }
  readonly content?: readonly ContentBlockLike[]
}

interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

/** `ctx.sessionProjections` 的最小读面。 */
interface ProjectionReader {
  snapshot(
    session: unknown,
    keys?: readonly string[],
  ): { readonly values: Readonly<Record<string, unknown>> }
}

interface SessionEventHost {
  on(
    name: string,
    listener: (session: SessionLike, event: SessionEventLike) => void,
  ): () => void
}

interface ProjectionHost {
  get(name: string): unknown
}

/** 终端转义、零宽与方向控制字符：写进问题列表前先清掉。 */
// eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符本身，标题来自用户输入
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/**
 * 取首条真人消息的可读文本：拼接文本块、压成一行、截到 60 字。
 * @param content - 消息的内容块；非文本块（图片、文件等）跳过。
 * @returns 标题摘要；没有可用文本时为空串。
 */
export function titleFromContent(content: readonly ContentBlockLike[] | undefined): string {
  if (content === undefined) return ''
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join(' ')
    .replace(UNSAFE_TEXT, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return [...text].slice(0, TITLE_LIMIT).join('').trimEnd()
}

/** 当前会话的预设：优先读投影，失败时退回创建时的 header。 */
function presetOf(ctx: Context, session: SessionLike, log: FlowLogger): string | null {
  const projections = (ctx as unknown as ProjectionHost).get('sessionProjections') as
    | ProjectionReader
    | undefined
  if (projections !== undefined) {
    try {
      const value = projections.snapshot(session, ['agentPreset']).values['agentPreset']
      if (typeof value === 'string') return value
    } catch (error) {
      // 投影读取失败不该影响消息本身，退回 header 上的创建时预设。
      log.warn(`dbqa: failed to read the agentPreset projection: ${String(error)}`)
    }
  }
  return typeof session.header.agentPreset === 'string' ? session.header.agentPreset : null
}

/**
 * 监听宿主会话事件，把「用户开始提问」的查询会话补进问题列表。
 *
 * 监听器挂在插件自己的 ctx 上，随插件卸载；写入失败只记日志，不让插件的
 * 索引问题影响用户消息。
 * @param ctx - 插件的宿主上下文。
 * @param database - 元数据库。
 * @param log - 插件日志。
 * @returns 取消监听的 disposer。
 */
export function watchFirstQuestions(
  ctx: Context,
  database: DbqaDatabase,
  log: FlowLogger,
): () => void {
  const host = ctx as unknown as SessionEventHost
  return host.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const message = event.data as UserMessageLike | undefined
    // 只认真人提问：skill、cron、agent.inject 等合成消息都不算「开始对话」。
    if (message?.source?.kind !== 'user') return
    if (presetOf(ctx, session, log) !== QUERY_PRESET) return
    try {
      database.conversations.start({ sessionId: session.id, title: titleFromContent(message.content) })
    } catch (error) {
      // 插件的索引失败不能影响消息处理本身。
      log.warn(`dbqa: failed to index the first question of session ${session.id}: ${String(error)}`)
    }
  })
}
