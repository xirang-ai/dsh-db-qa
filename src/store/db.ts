/**
 * 元数据库的打开、PRAGMA 与结构对账。
 *
 * 启动顺序固定：解析目录 → 打开文件 → 连接级 PRAGMA → 结构迁移 → 版本对账。
 *
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, renameSync } from 'node:fs'

import { contextualError, describeError, toDisplayPath } from '../errors.ts'
import { AuditStore } from './audit.ts'
import { ConversationStore } from './conversation.ts'
import { DatasourceStore } from './datasource.ts'
import { databaseFile, ensureDataDir, resolveDataDir } from './paths.ts'
import {
  MIGRATIONS,
  SCHEMA_COMMENTS,
  TARGET_SCHEMA_VERSION,
  type SchemaComment,
} from './schema.ts'
import { withTransaction } from './transaction.ts'
import { KnowledgeIndexStore } from '../knowledge/store.ts'
import { KnowledgeService } from '../knowledge/service.ts'

/** 启动日志接口；`SILENT_LOGGER` 供测试与 headless 场景使用。 */
export interface FlowLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 不输出任何内容的日志。 */
export const SILENT_LOGGER: FlowLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** 一次启动的结构对账结果。 */
export type StartupOutcome = 'initialized' | 'unchanged' | 'upgraded' | 'rebuilt' | 'ahead'

/** 启动报告：日志、面板与测试都读它。 */
export interface StartupReport {
  /** 元数据库绝对路径。 */
  readonly file: string
  /** 脱敏后的路径，可直接写日志。 */
  readonly displayFile: string
  readonly outcome: StartupOutcome
  /** 本次启动前的结构版本。 */
  readonly fromSchemaVersion: number
  /** 本次启动后的结构版本。 */
  readonly schemaVersion: number
  /** 库版本高于插件时为 false：读取仍可用，写入被拒绝。 */
  readonly writable: boolean
}

/** 打开选项。 */
export interface OpenDatabaseOptions {
  /** 覆盖 `$DSH_HOME/xirang-ai/dsh-db-qa`。 */
  readonly dataDir?: string
  readonly log?: FlowLogger
}

/** 打开后的元数据库及其数据访问层。 */
export interface DbqaDatabase {
  /** 插件数据目录；知识库与 SSH 临时文件都在它下面。 */
  readonly dataDir: string
  readonly file: string
  readonly displayFile: string
  readonly db: DatabaseSync
  readonly report: StartupReport
  readonly store: DatasourceStore
  readonly conversations: ConversationStore
  readonly audit: AuditStore
  readonly knowledge: KnowledgeService
  /** 启动日志；查询链路用它记录审计写入失败等旁路问题。 */
  readonly log: FlowLogger
  listSchemaComments(): readonly SchemaComment[]
  close(): void
}

/** 连接级 PRAGMA：每个连接固定这一组（AGENTS.md R5）。 */
function configure(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
}

/** 读取 `PRAGMA user_version`。 */
function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  const value = row?.['user_version']
  return typeof value === 'number' ? value : 0
}

/** 库里现有的用户表名。 */
function userTables(db: DatabaseSync): readonly string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name?: unknown }[]
  return rows.map((row) => String(row.name ?? '')).filter((name) => name !== '')
}

/** 外键问题必须让启动失败，而不是带病运行。 */
function assertForeignKeys(db: DatabaseSync, version: number): void {
  const rows = db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[]
  if (rows.length === 0) return
  const first = rows[0] ?? {}
  throw new Error(
    `dbqa: schema migration ${version} left ${rows.length} foreign-key violation(s) ` +
      `(table ${String(first['table'] ?? '?')})`,
  )
}

/** 依次执行待办迁移。 */
function migrate(db: DatabaseSync, current: number, log: FlowLogger): readonly number[] {
  const pending = MIGRATIONS.filter((migration) => migration.version > current).sort(
    (left, right) => left.version - right.version,
  )
  const applied: number[] = []
  for (const migration of pending) {
    log.info(`migrating metadata schema to v${migration.version}: ${migration.description}`)
    withTransaction(db, () => {
      migration.up(db)
      assertForeignKeys(db, migration.version)
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`)
    })
    applied.push(migration.version)
  }
  return applied
}

/** 把一个不是本插件结构的库文件挪到旁边，保留数据而不是删除。 */
function quarantine(file: string, log: FlowLogger): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  renameSync(file, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${target}${suffix}`)
  }
  log.warn(`metadata file ${toDisplayPath(file)} has a foreign schema; moved it to ${toDisplayPath(target)}`)
}

/**
 * 打开（必要时创建）元数据库。
 * @param options - 目录与日志。
 * @returns 数据库句柄、启动报告与数据访问层。
 */
export function openDbqaDatabase(options: OpenDatabaseOptions = {}): DbqaDatabase {
  const log = options.log ?? SILENT_LOGGER
  const dataDir = resolveDataDir(options.dataDir)
  ensureDataDir(dataDir)
  const file = databaseFile(dataDir)
  const displayFile = toDisplayPath(file)
  const existed = existsSync(file)

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file)
    configure(db)

    let fromSchemaVersion = readUserVersion(db)
    let outcome: StartupOutcome = existed ? 'unchanged' : 'initialized'
    let rebuilt = false

    const tables = userTables(db)
    if (tables.length > 0 && !tables.includes('dbqa_datasource')) {
      // 同名的旧结构或别的插件的库：不解读、不迁移，挪到旁边后重建。
      db.close()
      db = undefined
      quarantine(file, log)
      db = new DatabaseSync(file)
      configure(db)
      fromSchemaVersion = 0
      rebuilt = true
    }

    let writable = true
    if (fromSchemaVersion > TARGET_SCHEMA_VERSION) {
      writable = false
      outcome = 'ahead'
      log.warn(
        `metadata schema v${fromSchemaVersion} is newer than this build supports ` +
          `(v${TARGET_SCHEMA_VERSION}); writes are disabled until the plugin is upgraded`,
      )
    } else {
      const applied = migrate(db, fromSchemaVersion, log)
      if (rebuilt) outcome = 'rebuilt'
      else if (applied.length > 0 && existed) outcome = 'upgraded'
      else if (!existed) outcome = 'initialized'
      else outcome = 'unchanged'
      fromSchemaVersion = readUserVersion(db)
    }

    const report: StartupReport = {
      file,
      displayFile,
      outcome,
      fromSchemaVersion,
      schemaVersion: TARGET_SCHEMA_VERSION,
      writable,
    }

    if (outcome === 'initialized') log.info(`created metadata database ${displayFile} (schema v${TARGET_SCHEMA_VERSION})`)
    if (outcome === 'rebuilt') log.warn(`metadata database ${displayFile}: old schema was reset`)
    if (outcome === 'upgraded') log.info(`metadata database ${displayFile}: schema upgraded to v${TARGET_SCHEMA_VERSION}`)

    return {
      dataDir,
      file,
      displayFile,
      db,
      report,
      store: new DatasourceStore(db),
      conversations: new ConversationStore(db),
      audit: new AuditStore(db),
      knowledge: new KnowledgeService(dataDir, new KnowledgeIndexStore(db)),
      log,
      listSchemaComments: () => SCHEMA_COMMENTS,
      close: () => db?.close(),
    }
  } catch (error) {
    try {
      db?.close()
    } catch {
      // 关闭失败不能盖住原始错误。
    }
    throw contextualError(`startup failed for ${displayFile}: ${describeError(error)}`, error)
  }
}

export { TARGET_SCHEMA_VERSION, SCHEMA_COMMENTS, MIGRATIONS }
export type { SchemaComment, Migration } from './schema.ts'
