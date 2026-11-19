/**
 * 插件错误类型、错误码与脱敏工具。
 *
 * 所有对外文本（Remote 失败、测试连接结果、日志）都从错误码出发选文案：
 * 文案里只允许出现主机、端口、账号首字母和文件名，**不得出现口令、私钥口令
 * 或完整连接串**（AGENTS.md R13）。
 *
 * @module
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { basename } from 'node:path'
import { homedir } from 'node:os'

/**
 * 稳定的失败分类。取值与《技术设计》§8 错误码表一致；后三个是本实现
 * 在面板保存链路上需要的补充码（配置校验、对象不存在、名称冲突）。
 */
export type DbqaErrorCode =
  | 'DBQA_NO_DATASOURCE'
  | 'DBQA_ENV_MISSING'
  | 'DBQA_HOST_UNREACHABLE'
  | 'DBQA_CONN_REFUSED'
  | 'DBQA_TIMEOUT'
  | 'DBQA_AUTH_FAILED'
  | 'DBQA_DB_NOT_FOUND'
  | 'DBQA_TLS_VERIFY'
  | 'DBQA_TLS_REQUIRED'
  | 'DBQA_SSH_AUTH'
  | 'DBQA_SSH_HOSTKEY'
  | 'DBQA_FILE_MISSING'
  | 'DBQA_NOT_READONLY'
  | 'DBQA_SQL_REJECTED'
  | 'DBQA_QUERY_FAILED'
  | 'DBQA_KNOWLEDGE_MISSING'
  | 'DBQA_KNOWLEDGE_WRITE'
  | 'DBQA_ANALYSIS_RUNNING'
  | 'DBQA_VERSION_UNSUPPORTED'
  | 'DBQA_INVALID_CONFIG'
  | 'DBQA_NOT_FOUND'
  | 'DBQA_CONFLICT'
  | 'DBQA_INTERNAL'

/** 渲染任意抛出值的一行文本，安全用于日志与错误消息。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 给失败补上「当时在做什么」。 */
export function contextualError(operation: string, cause: unknown): Error {
  return new Error(`dbqa: ${operation}: ${describeError(cause)}`, { cause })
}

/** 可带稳定错误码的插件错误。 */
export class DbqaError extends Error {
  /** 稳定的失败分类，例如 `DBQA_AUTH_FAILED`。 */
  readonly code: DbqaErrorCode
  /** 可选的、已脱敏的附加信息（主机、端口、变量名等）。 */
  readonly params: Readonly<Record<string, string | number>>

  constructor(
    code: DbqaErrorCode,
    message: string,
    params: Readonly<Record<string, string | number>> = {},
  ) {
    super(message)
    this.name = 'DbqaError'
    this.code = code
    this.params = params
  }
}

/** 判断任意抛出值是否带插件错误码。 */
export function asDbqaError(error: unknown): DbqaError | undefined {
  return error instanceof DbqaError ? error : undefined
}

/** 错误码对应的文案键；`locale/*.json` 必须有同名条目。 */
export function errorMessageKey(code: DbqaErrorCode): string {
  return `dbqa.error.${code}`
}

/** 路径展示脱敏：家目录显示为 `~`，DSH home 显示为 `$DSH_HOME`。 */
export function toDisplayPath(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  const dshHome = dshHomePath()
  if (dshHome !== '' && path.startsWith(`${dshHome}/`)) return `$DSH_HOME${path.slice(dshHome.length)}`
  return path
}

/** 展示连接目标所需的脱敏元素。 */
export interface TargetHint {
  readonly host?: string
  readonly port?: string | number
  readonly user?: string
  readonly socketPath?: string
  readonly filePath?: string
}

/** 账号只保留首字符。 */
export function redactUser(user: string | undefined): string {
  const value = user?.trim() ?? ''
  if (value === '') return ''
  return `${value.slice(0, 1)}***`
}

/**
 * 生成可放进提示的脱敏目标描述。
 *
 * - TCP：`host:port`，账号只留首字符；
 * - Socket：只给 socket 文件名；
 * - SQLite：只给文件名，不给完整路径。
 */
export function redactTarget(hint: TargetHint): string {
  if (hint.filePath !== undefined && hint.filePath !== '') return basename(hint.filePath)
  if (hint.socketPath !== undefined && hint.socketPath !== '') return basename(hint.socketPath)
  const host = hint.host?.trim() ?? ''
  const port = hint.port === undefined ? '' : String(hint.port)
  const address = host === '' ? '' : port === '' ? host : `${host}:${port}`
  const user = redactUser(hint.user)
  if (address === '') return user
  return user === '' ? address : `${address} (${user})`
}

/**
 * 从任意文本里抹掉已知敏感值，作为错误信息的最后一道保险。
 * @param text - 驱动返回的原始消息。
 * @param secrets - 本次连接使用的口令 / 私钥口令。
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret.length >= 3) result = result.split(secret).join('***')
  }
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
}
