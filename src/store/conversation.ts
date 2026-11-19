/**
 * 会话索引与数据源绑定：`dbqa_conversation` 的读写。
 *
 * 绑定可在会话存续期间改选：`markActive` 带上新的 datasourceId 即更新，
 * 省略时保留原绑定。工具侧只按宿主会话 id 查这一行，不接受调用方传
 * datasourceId（最小暴露）。
 *
 * 一行分两个阶段：选数据源时 `markActive` 先建行（`started_at` 为 NULL，
 * 只作绑定与草稿），用户发出首条提问时宿主 `start` 才置 `started_at`。
 * 问题列表只列 `started_at` 非空的行——选了 Agent 和数据源却没开始对话
 * 不会留下垃圾条目。
 *
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'

import { conversationId } from './ids.ts'
import { DbqaError } from '../errors.ts'

/** 会话类型。 */
export type AgentKind = 'query' | 'analysis'

/** 一行会话索引。 */
export interface ConversationRecord {
  readonly id: string
  readonly sessionId: string
  readonly title: string
  readonly datasourceId: string | null
  readonly agentKind: AgentKind
  readonly isFavorite: boolean
  readonly favoritedAt: number | null
  readonly lastActiveAt: number
  readonly createdAt: number
  /** 首条用户提问时间；NULL 表示还没开始对话（不算一条问题）。 */
  readonly startedAt: number | null
}

/** 绑定后的最小可展示信息。 */
export interface ConversationBinding {
  readonly sessionId: string
  readonly datasourceId: string
  readonly agentKind: AgentKind
}

/** 问题列表的 Tab：全部 / 收藏。 */
export type ConversationTab = 'all' | 'favorite'

/** 一页问题列表。 */
export interface ConversationPage {
  readonly items: readonly ConversationRecord[]
  readonly total: number
  readonly page: number
}

/** 写入 / 刷新会话时需要的字段。 */
export interface MarkActiveInput {
  readonly sessionId: string
  readonly datasourceId?: string
  readonly title?: string
  readonly agentKind?: AgentKind
}

interface RawRow {
  readonly id: string
  readonly session_id: string
  readonly title: string
  readonly datasource_id: string | null
  readonly agent_kind: string
  readonly is_favorite: number
  readonly favorited_at: number | null
  readonly last_active_at: number
  readonly created_at: number
  readonly started_at: number | null
}

function toRecord(row: RawRow): ConversationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    datasourceId: row.datasource_id,
    agentKind: row.agent_kind === 'analysis' ? 'analysis' : 'query',
    isFavorite: row.is_favorite === 1,
    favoritedAt: row.favorited_at,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
  }
}

/** `dbqa_conversation` 的数据访问层。 */
export class ConversationStore {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** 按宿主会话 id 读；不存在返回 null。 */
  getBySession(sessionId: string): ConversationRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM dbqa_conversation WHERE session_id = ?')
      .get(sessionId) as unknown as RawRow | undefined
    return row === undefined ? null : toRecord(row)
  }

  /** 按行 id 读；不存在返回 null。 */
  getById(id: string): ConversationRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM dbqa_conversation WHERE id = ?')
      .get(id) as unknown as RawRow | undefined
    return row === undefined ? null : toRecord(row)
  }

  /** 供工具解析绑定；未绑定抛 `DBQA_NO_DATASOURCE`。 */
  requireBinding(sessionId: string): ConversationBinding {
    const row = this.getBySession(sessionId)
    if (row === null || row.datasourceId === null) {
      throw new DbqaError('DBQA_NO_DATASOURCE', 'dbqa: this session is not bound to a datasource')
    }
    return { sessionId, datasourceId: row.datasourceId, agentKind: row.agentKind }
  }

  /**
   * 建立或刷新会话索引。
   *
   * - 不存在：插入一行。
   * - 已存在：带 datasourceId 时改选，省略时保留原绑定；标题同规则。
   * - 未绑定：写入本次选择的数据源。
   *
   * 不刷新 `last_active_at`：列表时间取宿主会话的最后一条用户消息时间，
   * 打开会话、切数据源、跑工具都不应该改动它（否则列表会跳到「刚刚」）。
   * @returns 绑定结果（数据源为空时返回 null）。
   */
  markActive(input: MarkActiveInput): ConversationBinding | null {
    const existing = this.getBySession(input.sessionId)
    const now = Date.now()
    if (existing === null) {
      this.#db
        .prepare(
          `INSERT INTO dbqa_conversation
             (id, session_id, title, datasource_id, agent_kind, is_favorite, favorited_at, last_active_at, created_at)
           VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        )
        .run(
          conversationId(),
          input.sessionId,
          input.title ?? '',
          input.datasourceId ?? null,
          input.agentKind ?? 'query',
          now,
          now,
        )
    } else {
      const datasourceId = input.datasourceId ?? existing.datasourceId
      this.#db
        .prepare(
          `UPDATE dbqa_conversation
              SET title = ?, datasource_id = ?
            WHERE session_id = ?`,
        )
        .run(input.title ?? existing.title, datasourceId, input.sessionId)
    }
    const result = this.getBySession(input.sessionId)
    if (result === null || result.datasourceId === null) return null
    return {
      sessionId: result.sessionId,
      datasourceId: result.datasourceId,
      agentKind: result.agentKind,
    }
  }

  /** 按数据源列出分析会话；用于判断是否已有分析在跑。 */
  listAnalysis(datasourceId: string): readonly ConversationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM dbqa_conversation
          WHERE datasource_id = ? AND agent_kind = 'analysis'
          ORDER BY last_active_at DESC`,
      )
      .all(datasourceId) as unknown as RawRow[]
    return rows.map(toRecord)
  }

  /**
   * 标记「用户已经开始这次对话」，让查询会话进入问题列表。
   *
   * 由宿主在首条真人提问时调用，因此列表里不会出现「只选了 Agent 和数据源」
   * 的空会话。行不存在时补一行（未绑定数据源也算一次真实提问）；已存在时
   * 只补 `started_at`、把类型改成查询，并在标题为空时写入首条提问摘要。
   * 幂等：重复调用不会改写首次开始时间。
   * @param input - 宿主会话 id 与首条提问的标题摘要。
   * @returns 更新后的行。底层写库失败时抛出，调用方负责兜底——宿主正在处理
   * 消息，索引失败不应改变消息的结果（见 `src/session-recorder.ts`）。
   */
  start(input: { readonly sessionId: string; readonly title: string }): ConversationRecord {
    const now = Date.now()
    const existing = this.getBySession(input.sessionId)
    if (existing === null) {
      this.#db
        .prepare(
          `INSERT INTO dbqa_conversation
             (id, session_id, title, datasource_id, agent_kind, is_favorite, favorited_at,
              last_active_at, created_at, started_at)
           VALUES (?, ?, ?, NULL, 'query', 0, NULL, ?, ?, ?)`,
        )
        .run(conversationId(), input.sessionId, input.title, now, now, now)
    } else {
      this.#db
        .prepare(
          `UPDATE dbqa_conversation
              SET started_at = COALESCE(started_at, ?),
                  agent_kind = 'query',
                  title = CASE WHEN title = '' THEN ? ELSE title END
            WHERE session_id = ?`,
        )
        .run(now, input.title, input.sessionId)
    }
    const row = this.getBySession(input.sessionId)
    if (row === null) {
      throw new DbqaError('DBQA_INTERNAL', 'dbqa: the conversation row disappeared right after it was written')
    }
    return row
  }

  /**
   * 问题列表分页：只列已开始提问的查询会话，按索引行建立时间（全部）或
   * 收藏时间（收藏）倒序。
   *
   * 真正的展示顺序由面板按宿主会话的最后更新时间重排；这里的顺序只用来稳定分页。
   * 页码超界返回空数组与总数，由界面据此判断是否取完。
   */
  listPage(input: {
    readonly tab: ConversationTab
    readonly page: number
    readonly pageSize: number
  }): ConversationPage {
    const favorite = input.tab === 'favorite'
    const where = favorite
      ? "agent_kind = 'query' AND started_at IS NOT NULL AND is_favorite = 1 AND favorited_at IS NOT NULL"
      : "agent_kind = 'query' AND started_at IS NOT NULL"
    const order = favorite ? 'favorited_at DESC, last_active_at DESC' : 'last_active_at DESC, id ASC'
    const page = Number.isFinite(input.page) && input.page >= 1 ? Math.trunc(input.page) : 1
    const pageSize = Number.isFinite(input.pageSize) && input.pageSize >= 1 ? Math.trunc(input.pageSize) : 20

    const counted = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM dbqa_conversation WHERE ${where}`)
      .get() as unknown as { total: number }
    const total = Number(counted.total)
    const rows = this.#db
      .prepare(
        `SELECT * FROM dbqa_conversation
          WHERE ${where}
          ORDER BY ${order}
          LIMIT ? OFFSET ?`,
      )
      .all(pageSize, (page - 1) * pageSize) as unknown as RawRow[]
    return { items: rows.map(toRecord), total, page }
  }

  /**
   * 收藏 / 取消收藏（按行 id，幂等）。
   *
   * 重复收藏只刷新收藏时间；取消后收藏时间置 NULL。
   * @returns 更新后的行；id 不存在时返回 null。
   */
  setFavorite(id: string, favorite: boolean): ConversationRecord | null {
    const now = Date.now()
    this.#db
      .prepare(
        `UPDATE dbqa_conversation
            SET is_favorite = ?, favorited_at = ?
          WHERE id = ?`,
      )
      .run(favorite ? 1 : 0, favorite ? now : null, id)
    return this.getById(id)
  }
}
