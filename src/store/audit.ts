/**
 * 查询审计：`dbqa_query_audit` 的写入。
 *
 * 成功、被只读闸门拒绝、执行失败都要落一行（AGENTS.md R18）。审计是旁路：
 * 写失败只记日志，不能盖住查询本身的结果或错误（《逻辑说明》R-7）。
 *
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'

import { auditId } from './ids.ts'

/** 一次执行的结果分类。 */
export type AuditOutcome = 'ok' | 'rejected' | 'failed'

/** 写入一行审计所需的最小字段。 */
export interface AuditInput {
  readonly datasourceId: string | null
  readonly sessionId: string | null
  readonly toolName: string
  readonly sqlText: string | null
  readonly outcome: AuditOutcome
  readonly errorCode?: string | null
  readonly rowCount?: number | null
  readonly truncated?: boolean
  readonly durationMs: number
}

/** 一行审计记录。 */
export interface AuditRecord extends AuditInput {
  readonly id: string
  readonly createdAt: number
}

interface RawRow {
  readonly id: string
  readonly datasource_id: string | null
  readonly session_id: string | null
  readonly tool_name: string
  readonly sql_text: string | null
  readonly outcome: string
  readonly error_code: string | null
  readonly row_count: number | null
  readonly truncated: number
  readonly duration_ms: number
  readonly created_at: number
}

function toRecord(row: RawRow): AuditRecord {
  return {
    id: row.id,
    datasourceId: row.datasource_id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    sqlText: row.sql_text,
    outcome: row.outcome === 'ok' || row.outcome === 'rejected' ? row.outcome : 'failed',
    errorCode: row.error_code,
    rowCount: row.row_count,
    truncated: row.truncated === 1,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

/** `dbqa_query_audit` 的数据访问层。 */
export class AuditStore {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** 追加一行审计。 */
  record(input: AuditInput): void {
    this.#db
      .prepare(
        `INSERT INTO dbqa_query_audit
           (id, datasource_id, session_id, tool_name, sql_text, outcome, error_code,
            row_count, truncated, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId(),
        input.datasourceId,
        input.sessionId,
        input.toolName,
        input.sqlText,
        input.outcome,
        input.errorCode ?? null,
        input.rowCount ?? null,
        input.truncated === true ? 1 : 0,
        Math.max(0, Math.trunc(input.durationMs)),
        Date.now(),
      )
  }

  /** 按数据源读最近的审计行；供测试和后续问题列表使用。 */
  recent(datasourceId: string, limit = 20): readonly AuditRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM dbqa_query_audit
          WHERE datasource_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(datasourceId, Math.max(1, Math.trunc(limit))) as unknown as RawRow[]
    return rows.map(toRecord)
  }
}
