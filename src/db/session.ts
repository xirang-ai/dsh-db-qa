/**
 * 用户数据库会话契约：一次工具调用打开、读完即关。
 *
 * 所有实现都以只读身份连接；`sampleRows` 与 `listTables` 都必须限行，
 * 结果经过 {@link toJsonValue} 转成可直接进入工具输出的 JSON 值。
 *
 * @module
 */
import { DbqaError } from '../errors.ts'

/** 一张表的引用。 */
export interface TableRef {
  /** 所属 schema；SQLite 主库固定为 `main`。 */
  readonly schema: string
  /** 表名或视图名。 */
  readonly table: string
}

/** 表级元数据。 */
export interface TableSummary {
  readonly ref: TableRef
  readonly kind: 'table' | 'view'
  /** 表注释；没有时为 null。 */
  readonly comment: string | null
}

/** 列级元数据。 */
export interface ColumnSummary {
  readonly name: string
  /** 驱动返回的原始类型串，例如 `varchar(64)`、`integer`。 */
  readonly type: string
  readonly nullable: boolean
  readonly defaultValue: string | null
  readonly comment: string | null
  readonly primaryKey: boolean
}

/** JSON 安全值。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 一次查询结果；`rows` 已限行并转成 JSON 值。 */
export interface QueryResult {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly JsonValue[])[]
  readonly rowCount: number
  readonly truncated: boolean
  readonly durationMs: number
}

/** 表级 DDL 与索引 / 外键：让 Agent 看到的不只是列。 */
export interface TableDdl {
  /** 建表语句；无法直接取得时为空串（例如 PostgreSQL）。 */
  readonly ddl: string
  /** 索引的文字描述。 */
  readonly indexes: readonly string[]
  /** 外键的文字描述。 */
  readonly foreignKeys: readonly string[]
}

/** 关闭会话时的选项。 */
export interface CloseOptions {
  /**
   * 强制断链：超时或取消后不再等驱动收尾。
   *
   * 挂起的语句之后才轮到 `QUIT`（MySQL）会让关闭永不返回，所以放弃等待时
   * 直接断开 socket，而不是再排一次队。
   */
  readonly force?: boolean
}

/** 只读数据库会话。 */
export interface DbSession {
  /** 列出所有用户可见的表与视图。 */
  listTables(signal: AbortSignal): Promise<readonly TableSummary[]>
  /** 读取一张表的字段结构。 */
  describeTable(ref: TableRef, signal: AbortSignal): Promise<readonly ColumnSummary[]>
  /** 读取一张表的 DDL、索引与外键。 */
  tableDdl(ref: TableRef, signal: AbortSignal): Promise<TableDdl>
  /** 读取少量样本行。 */
  sampleRows(ref: TableRef, limit: number, signal: AbortSignal): Promise<QueryResult>
  /** 执行一条只读 SQL（已过只读闸门），结果限行。 */
  query(sql: string, limit: number, signal: AbortSignal): Promise<QueryResult>
  /** 关闭连接；重复调用无副作用。 */
  close(options?: CloseOptions): Promise<void>
}

/** 表引用的展示形式 `schema.table`。 */
export function tableRefKey(ref: TableRef): string {
  return `${ref.schema}.${ref.table}`
}

/** 解析 `schema.table`；没有点时按默认 schema 处理。 */
export function parseTableRef(value: string, defaultSchema: string): TableRef {
  const index = value.indexOf('.')
  if (index <= 0) return { schema: defaultSchema, table: value }
  return { schema: value.slice(0, index), table: value.slice(index + 1) }
}

/** 把驱动返回值转成 JSON 安全值；BigInt 优先转 number，超范围转字符串。 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item))
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(record)) out[key] = toJsonValue(item)
    return out
  }
  return String(value)
}

/** 结果集限行：多取一行判断是否被截断。 */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const value = limit === undefined || !Number.isFinite(limit) ? fallback : Math.trunc(limit)
  return Math.max(1, Math.min(max, value))
}

/** 统一的「无法列出表」错误。 */
export function sessionError(message: string, cause?: unknown): DbqaError {
  return new DbqaError('DBQA_QUERY_FAILED', message, cause === undefined ? undefined : { cause: String(cause) })
}
