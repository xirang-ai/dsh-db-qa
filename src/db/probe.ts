/**
 * 测试连接的编排：装配配置 →（可选）建 SSH 隧道 → 适配器只读探测 → 拆隧道。
 *
 * 这里不缓存任何连接：一次调用一条短命连接，`finally` 关闭（R14）。失败也
 * 不抛错，统一折成 {@link ProbeResult}，让面板与 Remote 用同一套文案渲染。
 *
 * @module
 */
import type { DbType, FieldValue, ResolvedConfig, SecretRef } from './fields.ts'
import { parseVersionNumber, resolveConfig } from './fields.ts'
import { asDbqaError, DbqaError, describeError } from '../errors.ts'
import { withDeadline } from './deadline.ts'
import { translateBilingual } from '../i18n.ts'
import { failureResult, type DbAdapter, type ProbeResult } from './adapter.ts'
import { mysqlAdapter } from './mysql.ts'
import { postgresAdapter } from './postgres.ts'
import { sqliteAdapter } from './sqlite.ts'
import { openSshTunnel } from '../ssh/tunnel.ts'

const ADAPTERS: Readonly<Record<DbType, DbAdapter>> = {
  mysql: mysqlAdapter,
  postgresql: postgresAdapter,
  sqlite: sqliteAdapter,
}

/** 测试连接需要的上下文。 */
export interface ProbeContext {
  /** 插件数据目录，SSH known_hosts 与临时文件放在这里。 */
  readonly dataDir: string
  readonly signal: AbortSignal
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly defaultConnectTimeoutMs?: number
}

/** 装配失败时也给出可展示的错误码与原因。 */
function failedFrom(error: unknown, startedAt: number): ProbeResult {
  const tagged = asDbqaError(error)
  if (tagged !== undefined) return failureResult(startedAt, tagged.code, tagged.message)
  return failureResult(startedAt, 'DBQA_INTERNAL', `dbqa: ${describeError(error)}`)
}

/** 用本地转发端口替换真实目标，其余字段保持不变。 */
function throughTunnel(config: ResolvedConfig, host: string, port: number): ResolvedConfig {
  if (config.type === 'mysql') return { ...config, transport: 'tcp', host, port, socketPath: undefined }
  if (config.type === 'postgresql') return { ...config, host, port }
  return config
}

/**
 * 测试一个数据源配置。
 * @param type - 数据库类型。
 * @param name - 数据源名称（只用于错误上下文）。
 * @param config - 非敏感字段。
 * @param secrets - 敏感字段的 `env:VAR` 引用。
 * @param context - 数据目录与取消信号。
 */
export async function testConnection(
  type: DbType,
  name: string,
  config: Readonly<Record<string, FieldValue>>,
  secrets: Readonly<Record<string, SecretRef>>,
  context: ProbeContext,
): Promise<ProbeResult> {
  const startedAt = Date.now()
  let resolved: ResolvedConfig
  try {
    resolved = resolveConfig(type, name, config, secrets, {
      ...(context.env === undefined ? {} : { env: context.env }),
      ...(context.defaultConnectTimeoutMs === undefined
        ? {}
        : { defaultConnectTimeoutMs: context.defaultConnectTimeoutMs }),
    })
  } catch (error) {
    return failedFrom(error, startedAt)
  }

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

    // 探测同样要有上限：驱动自带的 connectTimeout 只覆盖 TCP 建连，DNS、TLS 握手
    // 或握手后拿不到版本时面板会一直转圈，所以再加一层整体截止时间。
    const budgetMs = (context.defaultConnectTimeoutMs ?? 10_000) + 10_000
    const result = await withDeadline(
      context.signal,
      budgetMs,
      translateBilingual('dbqa.probe.timeout', { seconds: Math.max(1, Math.round(budgetMs / 1000)) }),
      (signal) => adapter.probe(target, signal),
    )
    return { ...result, latencyMs: Date.now() - startedAt, versionNum: result.versionNum ?? versionOf(result.versionRaw) }
  } catch (error) {
    return failedFrom(error, startedAt)
  } finally {
    await closeTunnel?.()
  }
}

/** 适配器只给原始版本串时在这里补可比较数字。 */
function versionOf(raw: string | null): number | null {
  return raw === null ? null : parseVersionNumber(raw)
}

export { ADAPTERS }
export type { DbAdapter, ProbeResult }
