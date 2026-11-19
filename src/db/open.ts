/**
 * 打开用户数据库会话的编排：装配配置 →（可选）SSH 隧道 → 适配器只读打开。
 *
 * 会话短命：调用方负责 `close()`，隧道与会话一起关闭（R14）。
 *
 * @module
 */
import type { DbType, FieldValue, ResolvedConfig, SecretRef } from './fields.ts'
import { resolveConfig } from './fields.ts'
import { ADAPTERS } from './probe.ts'
import type { CloseOptions, DbSession } from './session.ts'
import { DbqaError } from '../errors.ts'
import { openSshTunnel } from '../ssh/tunnel.ts'

/** 打开会话需要的上下文。 */
export interface OpenContext {
  /** 插件数据目录，SSH known_hosts 放在这里。 */
  readonly dataDir: string
  readonly signal: AbortSignal
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly defaultConnectTimeoutMs?: number
  /** 服务端语句超时（毫秒）；交给适配器去设置连接级上限。 */
  readonly statementTimeoutMs?: number
}

/** 用本地转发端口替换真实目标，其余字段保持不变。 */
function throughTunnel(config: ResolvedConfig, host: string, port: number): ResolvedConfig {
  if (config.type === 'mysql') return { ...config, transport: 'tcp', host, port, socketPath: undefined }
  if (config.type === 'postgresql') return { ...config, host, port }
  return config
}

/** 关闭会话之后再拆隧道；关闭顺序固定，且隧道失败不覆盖会话错误。 */
class TunneledSession implements DbSession {
  readonly #session: DbSession
  readonly #closeTunnel: (() => Promise<void>) | undefined

  constructor(session: DbSession, closeTunnel: (() => Promise<void>) | undefined) {
    this.#session = session
    this.#closeTunnel = closeTunnel
  }

  listTables(signal: AbortSignal) {
    return this.#session.listTables(signal)
  }

  describeTable(ref: Parameters<DbSession['describeTable']>[0], signal: AbortSignal) {
    return this.#session.describeTable(ref, signal)
  }

  tableDdl(ref: Parameters<DbSession['tableDdl']>[0], signal: AbortSignal) {
    return this.#session.tableDdl(ref, signal)
  }

  query(sql: string, limit: number, signal: AbortSignal) {
    return this.#session.query(sql, limit, signal)
  }

  sampleRows(ref: Parameters<DbSession['sampleRows']>[0], limit: number, signal: AbortSignal) {
    return this.#session.sampleRows(ref, limit, signal)
  }

  async close(options?: CloseOptions): Promise<void> {
    try {
      await this.#session.close(options)
    } finally {
      await this.#closeTunnel?.()
    }
  }
}

/**
 * 打开一个只读会话。
 * @param type - 数据库类型。
 * @param name - 数据源名称（只用于错误上下文）。
 * @param config - 非敏感字段。
 * @param secrets - 敏感字段的 `env:VAR` 引用。
 * @param context - 数据目录、取消信号与环境。
 */
export async function openDbSession(
  type: DbType,
  name: string,
  config: Readonly<Record<string, FieldValue>>,
  secrets: Readonly<Record<string, SecretRef>>,
  context: OpenContext,
): Promise<DbSession> {
  const resolved = resolveConfig(type, name, config, secrets, {
    ...(context.env === undefined ? {} : { env: context.env }),
    ...(context.defaultConnectTimeoutMs === undefined
      ? {}
      : { defaultConnectTimeoutMs: context.defaultConnectTimeoutMs }),
  })
  const adapter = ADAPTERS[type]
  let target = resolved
  let closeTunnel: (() => Promise<void>) | undefined
  try {
    if ((resolved.type === 'mysql' || resolved.type === 'postgresql') && resolved.ssh.useSsh) {
      const host = resolved.host
      const port = resolved.port
      if (host === undefined || port === undefined) {
        throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: SSH tunnel needs a TCP host and port')
      }
      const tunnel = await openSshTunnel({
        ssh: resolved.ssh,
        targetHost: host,
        targetPort: port,
        dataDir: context.dataDir,
        signal: context.signal,
      })
      closeTunnel = tunnel.close
      target = throughTunnel(resolved, tunnel.localHost, tunnel.localPort)
    }
    const session = await adapter.open(target, context.signal, {
      ...(context.statementTimeoutMs === undefined ? {} : { statementTimeoutMs: context.statementTimeoutMs }),
    })
    return closeTunnel === undefined ? session : new TunneledSession(session, closeTunnel)
  } catch (error) {
    await closeTunnel?.()
    throw error
  }
}
