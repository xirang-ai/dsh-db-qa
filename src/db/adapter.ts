/**
 * 用户数据库适配器契约。
 *
 * 每个适配器同时提供测试连接（{@link DbAdapter.probe}）与会话打开
 * （{@link DbAdapter.open}）。两者都是一次调用打开只读连接、用完关闭；
 * 会话不长期驻留。
 *
 * @module
 */
import type { DbType, ResolvedConfig } from './fields.ts'
import type { DbSession } from './session.ts'
import type { DbqaErrorCode } from '../errors.ts'
import { asDbqaError, describeError } from '../errors.ts'

/** 一次测试连接的结果；失败时也不抛错，让面板统一渲染。 */
export interface ProbeResult {
  readonly ok: boolean
  /** 服务端原始版本串，例如 `8.0.36`、`16.2`、`3.45.1`。 */
  readonly versionRaw: string | null
  /** 折成可比较的数字，供字段置灰判断。 */
  readonly versionNum: number | null
  readonly latencyMs: number
  /** 是否确认了连接级只读（第二道保险）。 */
  readonly readOnlyConfirmed: boolean
  /** 失败分类；成功时为 null。 */
  readonly errorCode: DbqaErrorCode | null
  /** 已脱敏的一行原因，可直接展示。 */
  readonly errorDetail: string | null
}

/** 打开会话时的连接级选项。 */
export interface OpenSessionOptions {
  /**
   * 服务端语句超时（毫秒）。
   *
   * 客户端 timer 只能让工具先返回，语句本身仍会在服务器上跑完；把这个值
   * 交给服务端（PostgreSQL `statement_timeout`、MySQL `max_execution_time`）
   * 才是真正掐断查询。
   */
  readonly statementTimeoutMs?: number
}

/** 适配器声明自己支持的类型、探测方式与会话打开方式。 */
export interface DbAdapter {
  readonly type: DbType
  probe(config: ResolvedConfig, signal: AbortSignal): Promise<ProbeResult>
  open(config: ResolvedConfig, signal: AbortSignal, options?: OpenSessionOptions): Promise<DbSession>
}

/** 失败结果。 */
export function failureResult(
  startedAt: number,
  errorCode: DbqaErrorCode,
  detail: string,
): ProbeResult {
  return {
    ok: false,
    versionRaw: null,
    versionNum: null,
    latencyMs: Date.now() - startedAt,
    readOnlyConfirmed: false,
    errorCode,
    errorDetail: detail,
  }
}

/** 成功结果。 */
export function successResult(
  startedAt: number,
  versionRaw: string | null,
  versionNum: number | null,
  readOnlyConfirmed: boolean,
): ProbeResult {
  return {
    ok: true,
    versionRaw,
    versionNum,
    latencyMs: Date.now() - startedAt,
    readOnlyConfirmed,
    errorCode: null,
    errorDetail: null,
  }
}

/** 把驱动抛出的错误归到稳定错误码；顺序从具体到宽泛。 */
export function classifyConnectionError(error: unknown, dbType: DbType): DbqaErrorCode {
  const tagged = asDbqaError(error)
  if (tagged !== undefined) return tagged.code

  const record = error as { code?: unknown; errno?: unknown; message?: unknown } | null
  const code = typeof record?.code === 'string' ? record.code.toUpperCase() : ''
  const message = describeError(error)
  const text = message.toLowerCase()

  if (
    code === 'ECONNREFUSED' ||
    text.includes('econnrefused') ||
    text.includes('connection refused') ||
    text.includes('can\'t connect to local mysql server')
  ) {
    return 'DBQA_CONN_REFUSED'
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    text.includes('getaddrinfo') ||
    text.includes('no such host')
  ) {
    return 'DBQA_HOST_UNREACHABLE'
  }
  if (
    code === 'ETIMEDOUT' ||
    text.includes('etimedout') ||
    text.includes('timed out') ||
    text.includes('timeout expired') ||
    text.includes('connect timeout')
  ) {
    return 'DBQA_TIMEOUT'
  }
  if (
    code === '28P01' ||
    code === '28000' ||
    code === 'ER_ACCESS_DENIED_ERROR' ||
    text.includes('password authentication failed') ||
    text.includes('access denied for user') ||
    text.includes('authentication failed') ||
    text.includes('invalid password')
  ) {
    return 'DBQA_AUTH_FAILED'
  }
  if (
    code === '3D000' ||
    code === 'ER_BAD_DB_ERROR' ||
    text.includes('database does not exist') ||
    text.includes('unknown database')
  ) {
    return 'DBQA_DB_NOT_FOUND'
  }
  if (
    text.includes('self-signed certificate') ||
    text.includes('self signed certificate') ||
    text.includes('unable to verify the first certificate') ||
    text.includes('unable to verify leaf signature') ||
    text.includes('certificate has expired') ||
    text.includes('hostname/ip does not match certificate') ||
    text.includes('altnames') ||
    text.includes('certificate verify failed') ||
    text.includes('sslcert')
  ) {
    return 'DBQA_TLS_VERIFY'
  }
  if (
    code === 'HANDSHAKE_SSL_ERROR' ||
    text.includes('ssl is required') ||
    text.includes('secure connection') ||
    text.includes('requires ssl') ||
    text.includes('server does not support ssl')
  ) {
    return 'DBQA_TLS_REQUIRED'
  }
  if (dbType === 'sqlite' && (code.includes('SQLITE_CANTOPEN') || text.includes('unable to open database'))) {
    return 'DBQA_FILE_MISSING'
  }
  return 'DBQA_QUERY_FAILED'
}
