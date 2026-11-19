/**
 * 查询编排：闸门 → 短命只读连接 → 限行包装 → 超时保护 → 执行 → 关闭 → 审计。
 *
 * 连接一次调用打开、`finally` 关闭（AGENTS.md R14）。结果集一律限行并
 * 返回 `truncated`（R12）；超时或用户中止时先中止等待再关闭连接（《逻辑
 * 说明》R-3）。审计写失败只记日志，不影响查询结果（R-7）。
 *
 * @module
 */
import type { Config as DbqaConfig } from '../config.ts'
import { callTimeoutText, isTimeoutFailure, statementTimeoutText, withDeadline } from '../db/deadline.ts'
import { openDbSession } from '../db/open.ts'
import { clampLimit, type DbSession, type JsonValue, type QueryResult } from '../db/session.ts'
import type { DbqaErrorCode } from '../errors.ts'
import { asDbqaError, describeError, DbqaError } from '../errors.ts'
import { translateBilingual } from '../i18n.ts'
import type { DbqaDatabase } from '../store/db.ts'
import type { AuditOutcome } from '../store/audit.ts'
import { assertReadOnlySql } from './gate.ts'

/** 工具执行上下文里本模块用到的字段。 */
export interface QueryExecutionScope {
  readonly agent?: { readonly id: string }
  readonly signal: AbortSignal
}

/** 查询链路需要的最小服务面。 */
export interface QueryToolService {
  readonly database: DbqaDatabase
  readonly config: DbqaConfig
}

/** 一次成功查询的可展示结果。 */
export interface QueryRunResult {
  readonly datasourceId: string
  readonly sql: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly JsonValue[])[]
  readonly rowCount: number
  readonly truncated: boolean
  readonly limit: number
  readonly durationMs: number
}

/**
 * 判断能否把整条语句包成子查询来限行。
 *
 * `SELECT` / `WITH` / `TABLE` 可以；`SHOW`、`PRAGMA`、`EXPLAIN` 等不能
 * （包起来会变语义），这些语句由适配器读完后截断，同样返回 `truncated`。
 * @param sql - 已过闸门的 SQL。
 * @param limit - 用户可见行数上限。
 */
export function wrapForLimit(sql: string, limit: number): { sql: string; wrapped: boolean } {
  const keyword = /^\s*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase() ?? ''
  if (keyword !== 'select' && keyword !== 'with' && keyword !== 'table') {
    return { sql, wrapped: false }
  }
  const fetch = Math.max(1, Math.trunc(limit)) + 1
  return { sql: `SELECT * FROM (\n${sql}\n) AS dbqa_sub LIMIT ${fetch}`, wrapped: true }
}

/**
 * 在一条已打开的只读会话上执行限行查询，并施加超时。
 *
 * 超时只负责「工具先返回」；语句本身是否还在服务器上跑，取决于适配器有没有
 * 把 `statementTimeoutMs` 交给服务端（见 `db/adapters`）。调用方在超时后必须
 * 强制断链，否则挂起的语句会把连接的关闭一起拖住。
 * @param session - 只读会话，由调用方负责关闭。
 * @param sql - 已过闸门、不含结尾分号的 SQL。
 * @param limit - 用户可见行数上限。
 * @param timeoutMs - 查询超时。
 * @param signal - 本次调用的中止信号（可能是调用级预算的子信号）。
 */
export async function executeWithLimit(
  session: DbSession,
  sql: string,
  limit: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<QueryResult> {
  const wrapped = wrapForLimit(sql, limit)
  return withDeadline(signal, timeoutMs, statementTimeoutText(timeoutMs), (inner) =>
    session.query(wrapped.sql, limit, inner),
  )
}

/** 关闭会话；放弃等待时强制断链，关闭失败只告警，不覆盖原始错误。 */
async function closeSession(
  service: QueryToolService,
  session: DbSession,
  force: boolean,
): Promise<void> {
  try {
    await session.close({ force })
  } catch (error) {
    service.database.log.warn(`dbqa: failed to close datasource session: ${describeError(error)}`)
  }
}

interface AuditInput {
  readonly datasourceId: string | null
  readonly sessionId: string | null
  readonly sql: string | null
  readonly outcome: AuditOutcome
  readonly errorCode?: DbqaErrorCode | null
  readonly rowCount?: number | null
  readonly truncated?: boolean
  readonly durationMs: number
}

/** 审计是旁路：失败只告警，不改变本次查询的结果或错误。 */
function audit(service: QueryToolService, input: AuditInput): void {
  try {
    service.database.audit.record({
      datasourceId: input.datasourceId,
      sessionId: input.sessionId,
      toolName: 'dbqa_run_query',
      sqlText: input.sql,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      rowCount: input.rowCount ?? null,
      truncated: input.truncated === true,
      durationMs: input.durationMs,
    })
  } catch (error) {
    service.database.log.warn(`dbqa: failed to write query audit: ${describeError(error)}`)
  }
}

/**
 * 执行一次只读问答查询。
 *
 * 失败（含被闸门拒绝）时同样写审计，然后把原始错误抛给宿主；模型据此
 * 决定是否改写 SQL（最多重试 2 次，见《逻辑说明》S7）。
 * @param service - 元数据库与配置。
 * @param exec - 工具执行上下文（会话 id + 中止信号）。
 * @param rawSql - 模型给出的 SQL。
 * @param requestedLimit - 模型请求的行数上限；最终不超过 `config.rowLimit`。
 */
export async function runQuery(
  service: QueryToolService,
  exec: QueryExecutionScope,
  rawSql: string,
  requestedLimit: number | undefined,
): Promise<QueryRunResult> {
  const startedAt = Date.now()
  const sessionId = exec.agent?.id ?? null
  let datasourceId: string | null = null
  let auditedSql: string | null = rawSql.trim() === '' ? null : rawSql
  try {
    if (sessionId === null) {
      throw new DbqaError('DBQA_NO_DATASOURCE', translateBilingual('dbqa.query.noSession'))
    }
    const binding = service.database.conversations.requireBinding(sessionId)
    datasourceId = binding.datasourceId
    const datasource = service.database.store.get(datasourceId)
    const gated = assertReadOnlySql(rawSql, datasource.dbType)
    auditedSql = gated.sql
    const limit = clampLimit(requestedLimit, service.config.rowLimit, service.config.rowLimit)
    // 整体预算至少覆盖一条语句：配置里把两者配反时以语句超时为准。
    const budgetMs = Math.max(service.config.toolTimeoutMs, service.config.queryTimeoutMs)

    const result = await withDeadline(
      exec.signal,
      budgetMs,
      callTimeoutText(budgetMs),
      async (signal) => {
        const session = await openDbSession(
          datasource.dbType,
          datasource.name,
          datasource.config,
          datasource.secrets,
          {
            dataDir: service.config.dataDir === '' ? service.database.dataDir : service.config.dataDir,
            signal,
            env: process.env,
            defaultConnectTimeoutMs: service.config.connectTimeoutMs,
            statementTimeoutMs: service.config.queryTimeoutMs,
          },
        )
        let force = false
        try {
          return await executeWithLimit(session, gated.sql, limit, service.config.queryTimeoutMs, signal)
        } catch (error) {
          // 超时/取消后不要再等驱动收尾：挂起的语句会把关闭一起拖住。
          force = isTimeoutFailure(error) || signal.aborted
          throw error
        } finally {
          await closeSession(service, session, force)
        }
      },
    )

    audit(service, {
      datasourceId,
      sessionId,
      sql: gated.sql,
      outcome: 'ok',
      rowCount: result.rowCount,
      truncated: result.truncated,
      durationMs: Date.now() - startedAt,
    })
    return {
      datasourceId,
      sql: gated.sql,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      limit,
      durationMs: result.durationMs,
    }
  } catch (error) {
    const dbqa = asDbqaError(error)
    audit(service, {
      datasourceId,
      sessionId,
      sql: auditedSql,
      outcome: dbqa?.code === 'DBQA_SQL_REJECTED' ? 'rejected' : 'failed',
      errorCode: dbqa?.code ?? 'DBQA_INTERNAL',
      durationMs: Date.now() - startedAt,
    })
    throw error
  }
}
