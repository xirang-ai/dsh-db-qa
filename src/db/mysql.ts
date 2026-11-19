/**
 * MySQL / MariaDB 适配器（本故事只实现探测）。
 *
 * 连接建立后立刻 `SET SESSION TRANSACTION READ ONLY`，这是只读闸门之外的
 * 第二道保险；随后只读一次 `VERSION()`，`finally` 关闭连接。
 *
 * @module
 */
import type * as Mysql from 'mysql2/promise'

import type { ResolvedMysql } from './fields.ts'
import type { ColumnSummary, CloseOptions, DbSession, QueryResult, TableDdl, TableRef, TableSummary } from './session.ts'
import { toJsonValue } from './session.ts'
import {
  classifyConnectionError,
  failureResult,
  successResult,
  type DbAdapter,
  type ProbeResult,
} from './adapter.ts'
import { DbqaError } from '../errors.ts'

type MysqlModule = typeof Mysql

let mysqlModule: MysqlModule | undefined

/** 按需加载驱动：SQLite 用户不需要安装 MySQL 客户端。 */
async function loadMysql(): Promise<MysqlModule> {
  if (mysqlModule !== undefined) return mysqlModule
  try {
    mysqlModule = await import('mysql2/promise')
    return mysqlModule
  } catch (error) {
    throw new DbqaError(
      'DBQA_INTERNAL',
      'dbqa: the mysql2 driver is not available; reinstall the plugin to restore it',
      { cause: String(error) },
    )
  }
}

/** 把表单的 SSL 档位翻成 mysql2 的连接参数。 */
function sslOptions(config: ResolvedMysql): Mysql.ConnectionOptions['ssl'] {
  const mode = config.ssl.mode.toUpperCase()
  if (mode === 'DISABLED') return undefined
  const ca = config.ssl.ca ?? undefined
  const cert = config.ssl.cert ?? undefined
  const key = config.ssl.key ?? undefined
  if (mode === 'VERIFY_CA' || mode === 'VERIFY_IDENTITY') {
    return {
      ...(ca === undefined ? {} : { ca }),
      ...(cert === undefined ? {} : { cert }),
      ...(key === undefined ? {} : { key }),
      ...(config.ssl.keyPassphrase === undefined ? {} : { passphrase: config.ssl.keyPassphrase }),
      rejectUnauthorized: true,
    }
  }
  return {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(config.ssl.keyPassphrase === undefined ? {} : { passphrase: config.ssl.keyPassphrase }),
    rejectUnauthorized: false,
  }
}

/** 组装一次连接。 */
function connectionOptions(config: ResolvedMysql, withTls: boolean): Mysql.ConnectionOptions {
  return {
    ...(config.transport === 'socket'
      ? { socketPath: config.socketPath ?? '' }
      : { host: config.host ?? '127.0.0.1', port: config.port ?? 3306 }),
    user: config.user,
    ...(config.database === undefined ? {} : { database: config.database }),
    ...(config.password === undefined ? {} : { password: config.password }),
    connectTimeout: config.connectTimeoutMs,
    ...(config.charset === undefined ? {} : { charset: config.charset }),
    compress: config.compress !== undefined && config.compress !== 'uncompressed',
    ...(withTls ? { ssl: sslOptions(config) } : {}),
    ...(config.authPlugin === 'mysql_clear_password'
      ? {
          authPlugins: {
            mysql_clear_password: () => () => Buffer.from(`${config.password ?? ''}\0`, 'utf8'),
          },
        }
      : {}),
  }
}

/** 打开一条短连接；PREFERRED 先试 TLS，握手失败再退回明文。 */
async function connect(mysql: MysqlModule, config: ResolvedMysql): Promise<Mysql.Connection> {
  const mode = config.ssl.mode.toUpperCase()
  if (mode === 'PREFERRED' && config.transport === 'tcp') {
    try {
      return await mysql.createConnection(connectionOptions(config, true))
    } catch (error) {
      const text = String((error as Error).message ?? '').toLowerCase()
      if (!text.includes('ssl') && !text.includes('tls') && !text.includes('handshake')) throw error
      return mysql.createConnection(connectionOptions(config, false))
    }
  }
  return mysql.createConnection(connectionOptions(config, mode !== 'DISABLED'))
}

/**
 * 探测 MySQL：只读会话 → 版本 → 关闭。
 * @param config - 已装配的配置。
 * @param signal - 取消信号。
 */
export async function probeMysql(config: ResolvedMysql, signal: AbortSignal): Promise<ProbeResult> {
  const startedAt = Date.now()
  if (signal.aborted) return failureResult(startedAt, 'DBQA_TIMEOUT', 'dbqa: the call was cancelled before connecting')

  let connection: Mysql.Connection | undefined
  try {
    const mysql = await loadMysql()
    connection = await connect(mysql, config)
    await connection.query('SET SESSION TRANSACTION READ ONLY')
    const [rows] = await connection.query('SELECT VERSION() AS version')
    const first = Array.isArray(rows) ? (rows[0] as { version?: unknown } | undefined) : undefined
    const raw = typeof first?.version === 'string' ? first.version : null
    return successResult(startedAt, raw, null, true)
  } catch (error) {
    return failureResult(startedAt, classifyConnectionError(error, 'mysql'), safeDetail(config, error))
  } finally {
    if (connection !== undefined) {
      try {
        await connection.end()
      } catch {
        // 连接可能已经断开；关闭失败不覆盖原始结果。
      }
    }
  }
}

/** 失败详情只带主机/端口/套接字文件名，不带账号口令与连接串。 */
function safeDetail(config: ResolvedMysql, error: unknown): string {
  const where =
    config.transport === 'socket'
      ? `socket ${(config.socketPath ?? '').split('/').at(-1) ?? ''}`
      : `${config.host ?? ''}:${config.port ?? 3306}`
  const reason = error instanceof Error ? error.message : String(error)
  return `dbqa: MySQL at ${where} failed: ${reason}`
}

/** MySQL 适配器。 */
export const mysqlAdapter: DbAdapter = {
  type: 'mysql',
  async probe(config, signal): Promise<ProbeResult> {
    if (config.type !== 'mysql') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: mysql adapter received a non-mysql config')
    }
    return probeMysql(config, signal)
  },
  async open(config, signal, options): Promise<DbSession> {
    if (config.type !== 'mysql') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: mysql adapter received a non-mysql config')
    }
    return openMysql(config, signal, options?.statementTimeoutMs)
  },
}

/** 标识符引用。 */
function quoteIdent(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

/**
 * 把语句超时交给服务端：MySQL 用 `max_execution_time`（毫秒），MariaDB 用
 * `max_statement_time`（秒）。
 *
 * 两个变量都不存在时（MySQL < 5.7.8 / MariaDB < 10.1）只剩客户端超时与强制
 * 断链：工具会按时返回，但服务端语句仍可能自己跑完——这是可接受的能力降级，
 * 所以这里静默跳过（R15）。
 */
async function applyStatementTimeout(connection: Mysql.Connection, timeoutMs: number): Promise<void> {
  const ms = Math.max(1, Math.trunc(timeoutMs))
  try {
    await connection.query('SET SESSION max_execution_time = ?', [ms])
    return
  } catch {
    // 变量不存在：换 MariaDB 的名字再试一次。
  }
  try {
    await connection.query('SET SESSION max_statement_time = ?', [ms / 1000])
  } catch {
    // 老版本两个变量都没有，见上方注释。
  }
}

/** MySQL 只读会话；连接建立时已设置会话级只读。 */
class MysqlSession implements DbSession {
  readonly #connection: Mysql.Connection
  readonly #queryTimeoutMs: number | undefined
  #closed = false

  constructor(connection: Mysql.Connection, statementTimeoutMs?: number) {
    this.#connection = connection
    this.#queryTimeoutMs =
      statementTimeoutMs === undefined ? undefined : Math.max(1, Math.trunc(statementTimeoutMs)) + 1_000
  }

  /** 每条语句都带客户端超时：服务端没回包时 mysql2 主动断开而不是一直等。 */
  #options(sql: string): Mysql.QueryOptions {
    return {
      sql,
      rowsAsArray: true,
      ...(this.#queryTimeoutMs === undefined ? {} : { timeout: this.#queryTimeoutMs }),
    }
  }

  async listTables(signal: AbortSignal): Promise<readonly TableSummary[]> {
    signal.throwIfAborted()
    const [rows] = await this.#connection.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    )
    const list = rows as { TABLE_SCHEMA?: unknown; TABLE_NAME?: unknown; TABLE_TYPE?: unknown }[]
    return list.flatMap((row) => {
      if (typeof row.TABLE_SCHEMA !== 'string' || typeof row.TABLE_NAME !== 'string') return []
      return [{
        ref: { schema: row.TABLE_SCHEMA, table: row.TABLE_NAME },
        kind: row.TABLE_TYPE === 'VIEW' ? 'view' as const : 'table' as const,
        comment: null,
      }]
    })
  }

  async describeTable(ref: TableRef, signal: AbortSignal): Promise<readonly ColumnSummary[]> {
    signal.throwIfAborted()
    const [rows] = await this.#connection.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [ref.schema, ref.table],
    )
    const list = rows as {
      COLUMN_NAME?: unknown
      COLUMN_TYPE?: unknown
      IS_NULLABLE?: unknown
      COLUMN_DEFAULT?: unknown
      COLUMN_COMMENT?: unknown
      COLUMN_KEY?: unknown
    }[]
    return list.flatMap((row) => {
      if (typeof row.COLUMN_NAME !== 'string') return []
      return [{
        name: row.COLUMN_NAME,
        type: typeof row.COLUMN_TYPE === 'string' ? row.COLUMN_TYPE : 'unknown',
        nullable: row.IS_NULLABLE === 'YES',
        defaultValue: row.COLUMN_DEFAULT === null || row.COLUMN_DEFAULT === undefined ? null : String(row.COLUMN_DEFAULT),
        comment: typeof row.COLUMN_COMMENT === 'string' && row.COLUMN_COMMENT !== '' ? row.COLUMN_COMMENT : null,
        primaryKey: row.COLUMN_KEY === 'PRI',
      }]
    })
  }

  async tableDdl(ref: TableRef, signal: AbortSignal): Promise<TableDdl> {
    signal.throwIfAborted()
    const [createRows] = await this.#connection.query(
      `SHOW CREATE TABLE ${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}`,
    )
    const first = (createRows as Record<string, unknown>[])[0] ?? {}
    const ddl = Object.values(first)
      .filter((value): value is string => typeof value === 'string' && value.startsWith('CREATE '))
      .sort((left, right) => right.length - left.length)[0] ?? ''
    const [indexRows] = await this.#connection.query(
      `SHOW INDEX FROM ${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}`,
    )
    const indexes = (indexRows as { Key_name?: unknown; Column_name?: unknown; Non_unique?: unknown }[]).map(
      (row) => `${String(row.Key_name)}(${String(row.Column_name)})${Number(row.Non_unique ?? 1) === 0 ? ' unique' : ''}`,
    )
    const [foreignRows] = await this.#connection.query(
      `SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [ref.schema, ref.table],
    )
    const foreignKeys = (foreignRows as {
      COLUMN_NAME?: unknown
      REFERENCED_TABLE_SCHEMA?: unknown
      REFERENCED_TABLE_NAME?: unknown
      REFERENCED_COLUMN_NAME?: unknown
    }[]).map(
      (row) =>
        `${String(row.COLUMN_NAME)} -> ${String(row.REFERENCED_TABLE_SCHEMA)}.${String(row.REFERENCED_TABLE_NAME)}.${String(row.REFERENCED_COLUMN_NAME)}`,
    )
    return { ddl, indexes, foreignKeys }
  }

  async query(sql: string, limit: number, signal: AbortSignal): Promise<QueryResult> {
    signal.throwIfAborted()
    const startedAt = Date.now()
    const [rawRows, fields] = await this.#connection.query(this.#options(sql))
    const rows = rawRows as unknown[][]
    const truncated = rows.length > limit
    const visible = truncated ? rows.slice(0, limit) : rows
    const columns = (fields as { name?: unknown }[]).flatMap((field) =>
      typeof field.name === 'string' ? [field.name] : [],
    )
    return {
      columns,
      rows: visible.map((row) => row.map(toJsonValue)),
      rowCount: visible.length,
      truncated,
      durationMs: Date.now() - startedAt,
    }
  }

  async sampleRows(ref: TableRef, limit: number, signal: AbortSignal): Promise<QueryResult> {
    signal.throwIfAborted()
    const startedAt = Date.now()
    const sql = `SELECT * FROM ${quoteIdent(ref.schema)}.${quoteIdent(ref.table)} LIMIT ${Math.trunc(limit) + 1}`
    const [rawRows, fields] = await this.#connection.query(this.#options(sql))
    const rows = rawRows as unknown[][]
    const truncated = rows.length > limit
    const visible = truncated ? rows.slice(0, limit) : rows
    const columns = (fields as { name?: unknown }[]).flatMap((field) =>
      typeof field.name === 'string' ? [field.name] : [],
    )
    return {
      columns,
      rows: visible.map((row) => row.map(toJsonValue)),
      rowCount: visible.length,
      truncated,
      durationMs: Date.now() - startedAt,
    }
  }

  async close(options?: CloseOptions): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (options?.force === true) {
      // 挂起的语句之后才轮到 QUIT：断链而不是排队，否则关闭会一直等下去。
      this.#connection.destroy()
      return
    }
    await this.#connection.end()
  }
}

/** 打开 MySQL 只读会话。 */
export async function openMysql(
  config: ResolvedMysql,
  signal: AbortSignal,
  statementTimeoutMs?: number,
): Promise<DbSession> {
  if (signal.aborted) throw new DbqaError('DBQA_TIMEOUT', 'dbqa: the call was cancelled before connecting')
  let connection: Mysql.Connection | undefined
  try {
    const mysql = await loadMysql()
    connection = await connect(mysql, config)
    await connection.query('SET SESSION TRANSACTION READ ONLY')
    if (statementTimeoutMs !== undefined) await applyStatementTimeout(connection, statementTimeoutMs)
    return new MysqlSession(connection, statementTimeoutMs)
  } catch (error) {
    if (connection !== undefined) {
      try {
        await connection.end()
      } catch {
        // 打开失败时连接可能已经断开；关闭失败不覆盖原始错误。
      }
    }
    if (error instanceof DbqaError) throw error
    throw new DbqaError(classifyConnectionError(error, 'mysql'), 'dbqa: cannot open the MySQL connection')
  }
}
