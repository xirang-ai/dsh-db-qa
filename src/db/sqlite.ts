/**
 * SQLite 适配器：`node:sqlite`，文件以 `readOnly: true` 打开。
 *
 * 只读打开本身是第二道保险：即使上层漏判，任何写入都会在 SQLite 层失败，
 * 也不会在用户库旁边留下 `-wal` / `-shm`。
 *
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import type { ResolvedSqlite } from './fields.ts'
import {
  classifyConnectionError,
  failureResult,
  successResult,
  type DbAdapter,
  type ProbeResult,
} from './adapter.ts'
import type {
  CloseOptions,
  ColumnSummary,
  DbSession,
  QueryResult,
  TableDdl,
  TableRef,
  TableSummary,
} from './session.ts'
import { toJsonValue } from './session.ts'
import { DbqaError, describeError } from '../errors.ts'

/**
 * 探测 SQLite 文件：存在性 → 只读打开 → 版本 → 关闭。
 * @param config - 已装配的 SQLite 配置。
 * @param signal - 调用方取消信号。
 */
export async function probeSqlite(config: ResolvedSqlite, signal: AbortSignal): Promise<ProbeResult> {
  const startedAt = Date.now()
  const file = config.filePath
  const display = basename(file)

  if (signal.aborted) {
    return failureResult(startedAt, 'DBQA_TIMEOUT', 'dbqa: the call was cancelled before connecting')
  }
  if (!existsSync(file)) {
    return failureResult(startedAt, 'DBQA_FILE_MISSING', `dbqa: SQLite file "${display}" does not exist`)
  }
  for (const attachment of config.attachments) {
    if (!existsSync(attachment.filePath)) {
      return failureResult(
        startedAt,
        'DBQA_FILE_MISSING',
        `dbqa: SQLite attachment "${attachment.alias}" points to a missing file`,
      )
    }
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(config.busyTimeoutMs)}`)
    // `readOnly: true` 已由驱动兜底；再开 query_only 并把结果读回来，作为可观测的第二道保险。
    db.exec('PRAGMA query_only = ON')
    const queryOnly = db.prepare('PRAGMA query_only').get() as { query_only?: unknown } | undefined
    const readOnlyConfirmed = Number(queryOnly?.query_only ?? 0) === 1
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown } | undefined
    const versionRaw = typeof row?.version === 'string' ? row.version : null
    return successResult(startedAt, versionRaw, null, readOnlyConfirmed)
  } catch (error) {
    const code = classifyConnectionError(error, 'sqlite')
    const detail =
      code === 'DBQA_FILE_MISSING'
        ? `dbqa: cannot open SQLite file "${display}" read-only`
        : `dbqa: SQLite probe failed for "${display}" (${code})`
    return failureResult(startedAt, code, detail)
  } finally {
    db?.close()
  }
}

/** SQLite 适配器。 */
export const sqliteAdapter: DbAdapter = {
  type: 'sqlite',
  async probe(config, signal): Promise<ProbeResult> {
    if (config.type !== 'sqlite') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: sqlite adapter received a non-sqlite config')
    }
    return probeSqlite(config, signal)
  },
  async open(config, signal): Promise<DbSession> {
    if (config.type !== 'sqlite') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: sqlite adapter received a non-sqlite config')
    }
    return openSqlite(config, signal)
  },
}

/** 标识符引用。 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** SQLite 只读会话；关闭后再次调用会报错。 */
class SqliteSession implements DbSession {
  readonly #db: DatabaseSync
  #closed = false

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  async listTables(signal: AbortSignal): Promise<readonly TableSummary[]> {
    signal.throwIfAborted()
    const rows = this.#db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name?: unknown; type?: unknown }[]
    return rows.flatMap((row) => {
      if (typeof row.name !== 'string') return []
      return [{
        ref: { schema: 'main', table: row.name },
        kind: row.type === 'view' ? 'view' as const : 'table' as const,
        comment: null,
      }]
    })
  }

  async describeTable(ref: TableRef, signal: AbortSignal): Promise<readonly ColumnSummary[]> {
    signal.throwIfAborted()
    const rows = this.#db
      .prepare(`PRAGMA table_info(${quoteIdent(ref.table)})`)
      .all() as {
        name?: unknown
        type?: unknown
        notnull?: unknown
        dflt_value?: unknown
        pk?: unknown
      }[]
    return rows.flatMap((row) => {
      if (typeof row.name !== 'string') return []
      return [{
        name: row.name,
        type: typeof row.type === 'string' && row.type !== '' ? row.type : 'any',
        nullable: Number(row.notnull ?? 0) === 0,
        defaultValue: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
        comment: null,
        primaryKey: Number(row.pk ?? 0) > 0,
      }]
    })
  }

  async tableDdl(ref: TableRef, signal: AbortSignal): Promise<TableDdl> {
    signal.throwIfAborted()
    const row = this.#db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`)
      .get(ref.table) as { sql?: unknown } | undefined
    const ddl = typeof row?.sql === 'string' ? row.sql : ''
    const indexes: string[] = []
    const indexRows = this.#db
      .prepare(`PRAGMA index_list(${quoteIdent(ref.table)})`)
      .all() as { name?: unknown; unique?: unknown }[]
    for (const index of indexRows) {
      if (typeof index.name !== 'string') continue
      const columns = this.#db
        .prepare(`PRAGMA index_info(${quoteIdent(index.name)})`)
        .all() as { name?: unknown }[]
      const list = columns.map((column) => String(column.name)).join(', ')
      indexes.push(`${index.name}(${list})${Number(index.unique ?? 0) === 1 ? ' unique' : ''}`)
    }
    const foreignRows = this.#db
      .prepare(`PRAGMA foreign_key_list(${quoteIdent(ref.table)})`)
      .all() as { from?: unknown; table?: unknown; to?: unknown }[]
    const foreignKeys = foreignRows.map(
      (foreign) => `${String(foreign.from)} -> ${String(foreign.table)}.${String(foreign.to)}`,
    )
    return { ddl, indexes, foreignKeys }
  }

  async query(sql: string, limit: number, signal: AbortSignal): Promise<QueryResult> {
    signal.throwIfAborted()
    const startedAt = Date.now()
    const statement = this.#db.prepare(sql)
    let columns: string[] = []
    try {
      columns = (statement.columns() as { name?: unknown }[]).flatMap((column) =>
        typeof column.name === 'string' ? [column.name] : [],
      )
    } catch {
      // PRAGMA 等语句没有声明列；从首行键名推断。
    }
    const raw = statement.all() as Record<string, unknown>[]
    if (columns.length === 0 && raw.length > 0) columns = Object.keys(raw[0] ?? {})
    const truncated = raw.length > limit
    const visible = truncated ? raw.slice(0, limit) : raw
    return {
      columns,
      rows: visible.map((row) => columns.map((column) => toJsonValue(row[column]))),
      rowCount: visible.length,
      truncated,
      durationMs: Date.now() - startedAt,
    }
  }

  async sampleRows(ref: TableRef, limit: number, signal: AbortSignal): Promise<QueryResult> {
    signal.throwIfAborted()
    const startedAt = Date.now()
    const statement = this.#db.prepare(
      `SELECT * FROM ${quoteIdent(ref.schema)}.${quoteIdent(ref.table)} LIMIT ${Math.trunc(limit) + 1}`,
    )
    const columns = (statement.columns() as { name?: unknown }[]).flatMap((column) =>
      typeof column.name === 'string' ? [column.name] : [],
    )
    const raw = statement.all() as Record<string, unknown>[]
    const truncated = raw.length > limit
    const rows = (truncated ? raw.slice(0, limit) : raw).map((row) =>
      columns.map((column) => toJsonValue(row[column])),
    )
    return { columns, rows, rowCount: rows.length, truncated, durationMs: Date.now() - startedAt }
  }

  /**
   * 关闭连接。
   *
   * `node:sqlite` 是同步 API，语句执行期间不会让出事件循环，也没有
   * `sqlite3_interrupt` 的等价物：超时计时器在语句跑完之前根本没机会触发，
   * 所以 `force` 在这里没有额外动作。真实保护来自 `busy_timeout`（等锁上限）
   * 与只读打开——读锁冲突最多等 `busyTimeoutMs` 就报错。
   */
  async close(_options?: CloseOptions): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

/** 打开 SQLite 只读会话。 */
export async function openSqlite(config: ResolvedSqlite, signal: AbortSignal): Promise<DbSession> {
  if (signal.aborted) throw new DbqaError('DBQA_TIMEOUT', 'dbqa: the call was cancelled before connecting')
  if (!existsSync(config.filePath)) {
    throw new DbqaError('DBQA_FILE_MISSING', 'dbqa: the SQLite file does not exist')
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(config.filePath, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(config.busyTimeoutMs)}`)
    db.exec('PRAGMA query_only = ON')
  } catch (error) {
    throw new DbqaError('DBQA_FILE_MISSING', 'dbqa: cannot open the SQLite file read-only', {
      cause: describeError(error),
    })
  }
  return new SqliteSession(db)
}
