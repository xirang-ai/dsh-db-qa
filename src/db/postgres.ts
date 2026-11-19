/**
 * PostgreSQL 适配器（本故事只实现探测）。
 *
 * 连接参数里带 `-c default_transaction_read_only=on`，连接后再确认一次
 * `SHOW default_transaction_read_only`；探测只读 `server_version`，随后
 * `finally` 关闭。
 *
 * @module
 */
import type * as Pg from 'pg'
import type { SecureVersion } from 'node:tls'

import type { ResolvedPostgres } from './fields.ts'
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

type PgModule = typeof Pg

let pgModule: PgModule | undefined

/** 按需加载驱动。 */
async function loadPg(): Promise<PgModule> {
  if (pgModule !== undefined) return pgModule
  try {
    pgModule = await import('pg')
    return pgModule
  } catch {
    throw new DbqaError('DBQA_INTERNAL', 'dbqa: the pg driver is not available; reinstall the plugin to restore it')
  }
}

/** 把 SSL 档位翻成 node-postgres 的 `ssl` 参数。 */
function sslOptions(config: ResolvedPostgres): Pg.ClientConfig['ssl'] {
  const mode = config.ssl.mode.toLowerCase()
  if (mode === 'disable') return false
  const ca = config.ssl.rootCert ?? undefined
  const cert = config.ssl.cert ?? undefined
  const key = config.ssl.key ?? undefined
  const base = {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(config.ssl.keyPassphrase === undefined ? {} : { passphrase: config.ssl.keyPassphrase }),
    ...(config.ssl.minProtocolVersion === undefined ? {} : { minVersion: config.ssl.minProtocolVersion as SecureVersion }),
    ...(config.ssl.maxProtocolVersion === undefined ? {} : { maxVersion: config.ssl.maxProtocolVersion as SecureVersion }),
    ...(config.ssl.crl === undefined ? {} : { crl: config.ssl.crl }),
  }
  if (mode === 'verify-ca' || mode === 'verify-full') {
    return { ...base, rejectUnauthorized: true }
  }
  return { ...base, rejectUnauthorized: false }
}

/** 组装一次连接。 */
function clientConfig(config: ResolvedPostgres, withTls: boolean, statementTimeoutMs?: number): Pg.ClientConfig {
  return {
    host: config.host ?? '127.0.0.1',
    port: config.port,
    database: config.database,
    user: config.user,
    ...(config.password === undefined ? {} : { password: config.password }),
    connectionTimeoutMillis: config.connectTimeoutMs,
    // 服务端掐断：超时后由 PostgreSQL 自己取消语句，连接不会带着慢查询继续留着。
    ...(statementTimeoutMs === undefined ? {} : { statement_timeout: Math.trunc(statementTimeoutMs) }),
    // 客户端兜底：服务端没回包（网络半死）时让 node-postgres 先报错。
    ...(statementTimeoutMs === undefined ? {} : { query_timeout: Math.trunc(statementTimeoutMs) + 1_000 }),
    options: '-c default_transaction_read_only=on',
    ...(config.applicationName === undefined ? {} : { application_name: config.applicationName }),
    ...(config.targetSessionAttrs === undefined ? {} : { target_session_attrs: config.targetSessionAttrs }),
    ...(withTls ? { ssl: sslOptions(config) } : { ssl: false }),
  }
}

/** 打开一条短连接；allow / prefer 先试 TLS，失败再退回明文。 */
async function connect(
  pg: PgModule,
  config: ResolvedPostgres,
  statementTimeoutMs?: number,
): Promise<Pg.Client> {
  const mode = config.ssl.mode.toLowerCase()
  const tryTlsFirst = mode === 'allow' || mode === 'prefer'
  const client = new pg.Client(clientConfig(config, mode !== 'disable', statementTimeoutMs))
  try {
    await client.connect()
    return client
  } catch (error) {
    if (!tryTlsFirst) throw error
    const text = String((error as Error).message ?? '').toLowerCase()
    if (!text.includes('ssl') && !text.includes('tls')) throw error
    await client.end().catch(() => undefined)
    const fallback = new pg.Client(clientConfig(config, false, statementTimeoutMs))
    await fallback.connect()
    return fallback
  }
}

/**
 * 探测 PostgreSQL：只读会话 → 版本 → 关闭。
 * @param config - 已装配的配置。
 * @param signal - 取消信号。
 */
export async function probePostgres(config: ResolvedPostgres, signal: AbortSignal): Promise<ProbeResult> {
  const startedAt = Date.now()
  if (signal.aborted) return failureResult(startedAt, 'DBQA_TIMEOUT', 'dbqa: the call was cancelled before connecting')

  let client: Pg.Client | undefined
  try {
    const pg = await loadPg()
    client = await connect(pg, config)
    if (config.searchPath !== undefined && config.searchPath !== '') {
      await client.query('SELECT set_config($1, $2, false)', ['search_path', config.searchPath])
    }
    // node-postgres 用列名作为结果键，这里兼容 `default_transaction_read_only` 与 `setting` 两种形态。
    const readOnly = await client.query<{ default_transaction_read_only?: string; setting?: string }>(
      'SHOW default_transaction_read_only',
    )
    const readOnlyValue = readOnly.rows[0]?.default_transaction_read_only ?? readOnly.rows[0]?.setting ?? ''
    const readOnlyConfirmed = readOnlyValue.toLowerCase() === 'on'
    const version = await client.query<{ version?: string }>("SELECT current_setting('server_version') AS version")
    const raw = version.rows[0]?.version ?? null
    return successResult(startedAt, raw, null, readOnlyConfirmed)
  } catch (error) {
    return failureResult(startedAt, classifyConnectionError(error, 'postgresql'), safeDetail(config, error))
  } finally {
    if (client !== undefined) {
      try {
        await client.end()
      } catch {
        // 已断开的连接无需再报错。
      }
    }
  }
}

/** 失败详情只带主机/端口/库名。 */
function safeDetail(config: ResolvedPostgres, error: unknown): string {
  const password = config.password
  let reason = error instanceof Error ? error.message : String(error)
  if (password !== undefined && password !== '') reason = reason.split(password).join('***')
  return `dbqa: PostgreSQL at ${config.host ?? ''}:${config.port}/${config.database} failed: ${reason}`
}

/** PostgreSQL 适配器。 */
export const postgresAdapter: DbAdapter = {
  type: 'postgresql',
  async probe(config, signal): Promise<ProbeResult> {
    if (config.type !== 'postgresql') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: postgresql adapter received a non-postgresql config')
    }
    return probePostgres(config, signal)
  },
  async open(config, signal, options): Promise<DbSession> {
    if (config.type !== 'postgresql') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: postgres adapter received a non-postgres config')
    }
    return openPostgres(config, signal, options?.statementTimeoutMs)
  },
}

/** 标识符引用。 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** PostgreSQL 只读会话。 */
class PostgresSession implements DbSession {
  readonly #client: Pg.Client
  #closed = false

  constructor(client: Pg.Client) {
    this.#client = client
  }

  async listTables(signal: AbortSignal): Promise<readonly TableSummary[]> {
    signal.throwIfAborted()
    const result = await this.#client.query<{
      table_schema: string
      table_name: string
      table_type: string
    }>(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`,
    )
    return result.rows.map((row) => ({
      ref: { schema: row.table_schema, table: row.table_name },
      kind: row.table_type === 'VIEW' ? 'view' as const : 'table' as const,
      comment: null,
    }))
  }

  async describeTable(ref: TableRef, signal: AbortSignal): Promise<readonly ColumnSummary[]> {
    signal.throwIfAborted()
    const result = await this.#client.query<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
      comment: string | null
      primary_key: boolean
    }>(
      `SELECT c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              (SELECT d.description
                 FROM pg_catalog.pg_description d
                 JOIN pg_catalog.pg_class cl ON cl.oid = d.objoid
                 JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
                WHERE n.nspname = c.table_schema
                  AND cl.relname = c.table_name
                  AND d.objsubid = c.ordinal_position) AS comment,
              EXISTS (SELECT 1
                        FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu
                          ON kcu.constraint_name = tc.constraint_name
                         AND kcu.table_schema = tc.table_schema
                         AND kcu.table_name = tc.table_name
                       WHERE tc.constraint_type = 'PRIMARY KEY'
                         AND tc.table_schema = c.table_schema
                         AND tc.table_name = c.table_name
                         AND kcu.column_name = c.column_name) AS primary_key
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [ref.schema, ref.table],
    )
    return result.rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      comment: row.comment,
      primaryKey: row.primary_key,
    }))
  }

  async tableDdl(ref: TableRef, signal: AbortSignal): Promise<TableDdl> {
    signal.throwIfAborted()
    const indexes = await this.#client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [ref.schema, ref.table],
    )
    const foreign = await this.#client.query<{
      column_name: string
      foreign_schema: string
      foreign_table: string
      foreign_column: string
    }>(
      `SELECT kcu.column_name,
              ccu.table_schema AS foreign_schema,
              ccu.table_name AS foreign_table,
              ccu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
          AND kcu.table_name = tc.table_name
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1
          AND tc.table_name = $2
        ORDER BY kcu.column_name`,
      [ref.schema, ref.table],
    )
    return {
      // PostgreSQL 没有 SHOW CREATE TABLE；Agent 可再用只读 SQL 查 pg_catalog 细节。
      ddl: '',
      indexes: indexes.rows.map((row) => row.indexdef),
      foreignKeys: foreign.rows.map(
        (row) => `${row.column_name} -> ${row.foreign_schema}.${row.foreign_table}.${row.foreign_column}`,
      ),
    }
  }

  async query(sql: string, limit: number, signal: AbortSignal): Promise<QueryResult> {
    signal.throwIfAborted()
    const startedAt = Date.now()
    const result = await this.#client.query({ text: sql, rowMode: 'array' })
    const rows = result.rows as unknown[][]
    const truncated = rows.length > limit
    const visible = truncated ? rows.slice(0, limit) : rows
    return {
      columns: result.fields.map((field) => field.name),
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
    const result = await this.#client.query({ text: sql, rowMode: 'array' })
    const rows = result.rows as unknown[][]
    const truncated = rows.length > limit
    const visible = truncated ? rows.slice(0, limit) : rows
    return {
      columns: result.fields.map((field) => field.name),
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
      // 放弃等待时直接销毁 socket：end() 虽然也会强断挂起的语句，但这里不必再走一遍收尾。
      this.#client.connection.stream.destroy()
      return
    }
    await this.#client.end()
  }
}

/** 打开 PostgreSQL 只读会话。 */
export async function openPostgres(
  config: ResolvedPostgres,
  signal: AbortSignal,
  statementTimeoutMs?: number,
): Promise<DbSession> {
  if (signal.aborted) throw new DbqaError('DBQA_TIMEOUT', 'dbqa: the call was cancelled before connecting')
  let client: Pg.Client | undefined
  try {
    const pg = await loadPg()
    client = await connect(pg, config, statementTimeoutMs)
    if (config.searchPath !== undefined && config.searchPath !== '') {
      await client.query('SELECT set_config($1, $2, false)', ['search_path', config.searchPath])
    }
    return new PostgresSession(client)
  } catch (error) {
    // 连接建到一半失败时也要断开，避免留下半开连接。
    await client?.end().catch(() => undefined)
    if (error instanceof DbqaError) throw error
    throw new DbqaError(classifyConnectionError(error, 'postgresql'), 'dbqa: cannot open the PostgreSQL connection')
  }
}
