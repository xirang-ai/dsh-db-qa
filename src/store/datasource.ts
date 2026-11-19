/**
 * 数据源的持久化：`dbqa_datasource` 的读写。
 *
 * 口令以 `env:VAR` 或明文的形式进入 `secret_ref_json`；`config_json` 永远
 * 不含敏感字段。类型在创建后不可改（界面同样不允许切换）。
 *
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'

import type { DbType, FieldValue, SecretRef } from '../db/fields.ts'
import { endpointHint } from '../db/fields.ts'
import { DbqaError, describeError } from '../errors.ts'
import { datasourceId } from './ids.ts'
import { withTransaction } from './transaction.ts'

/** 列表行需要的摘要。 */
export interface DatasourceSummary {
  readonly id: string
  readonly name: string
  readonly dbType: DbType
  /** 脱敏后的端点：`host:port`、socket 文件名或 SQLite 文件名。 */
  readonly endpoint: string
  readonly serverVersion: string | null
  readonly serverVersionNum: number | null
  readonly lastTestedAt: number | null
  readonly lastTestOk: boolean | null
  readonly lastTestErrorCode: string | null
  readonly analyzedAt: number | null
  readonly updatedAt: number
}

/** 详情：摘要 + 配置 + 敏感字段引用。 */
export interface DatasourceRecord extends DatasourceSummary {
  readonly config: Readonly<Record<string, FieldValue>>
  readonly secrets: Readonly<Record<string, SecretRef>>
  readonly knowledgeDir: string
  readonly createdAt: number
}

/** 新建 / 更新时写入的字段。 */
export interface DatasourceInput {
  readonly name: string
  readonly dbType: DbType
  readonly config: Readonly<Record<string, FieldValue>>
  readonly secrets: Readonly<Record<string, SecretRef>>
}

/** 测试连接结果里需要落库的部分。 */
export interface TestRecord {
  readonly ok: boolean
  readonly versionRaw?: string
  readonly versionNum?: number
  readonly errorCode?: string
  readonly testedAt?: number
}

interface RawRow {
  readonly id: string
  readonly name: string
  readonly db_type: string
  readonly server_version: string | null
  readonly server_version_num: number | null
  readonly config_json: string
  readonly secret_ref_json: string
  readonly knowledge_dir: string
  readonly last_tested_at: number | null
  readonly last_test_ok: number | null
  readonly last_test_error_code: string | null
  readonly analyzed_at: number | null
  readonly created_at: number
  readonly updated_at: number
}

const SELECT_COLUMNS = `
  id, name, db_type, server_version, server_version_num, config_json, secret_ref_json,
  knowledge_dir, last_tested_at, last_test_ok, last_test_error_code, analyzed_at,
  created_at, updated_at`

/** 数据库里存的 JSON 必须回读成对象；损坏时给空对象而不是崩溃。 */
function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // 落到下面的空对象：一条坏行不该让整个面板打不开。
  }
  return {}
}

function toSummary(row: RawRow): DatasourceSummary {
  const config = parseJsonObject(row.config_json) as Record<string, FieldValue>
  const dbType = row.db_type as DbType
  return {
    id: row.id,
    name: row.name,
    dbType,
    endpoint: endpointHint(dbType, config),
    serverVersion: row.server_version,
    serverVersionNum: row.server_version_num,
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestErrorCode: row.last_test_error_code,
    analyzedAt: row.analyzed_at,
    updatedAt: row.updated_at,
  }
}

function toRecord(row: RawRow): DatasourceRecord {
  const config = parseJsonObject(row.config_json) as Record<string, FieldValue>
  const secrets = parseJsonObject(row.secret_ref_json) as Record<string, SecretRef>
  return {
    ...toSummary(row),
    config,
    secrets,
    knowledgeDir: row.knowledge_dir,
    createdAt: row.created_at,
  }
}

/** 名称冲突统一映射成 `DBQA_CONFLICT`，让界面把它显示在名称字段下。 */
function asNameConflict(error: unknown): never {
  if (describeError(error).includes('UNIQUE constraint failed: dbqa_datasource.name')) {
    throw new DbqaError('DBQA_CONFLICT', 'dbqa: another datasource already uses this name')
  }
  throw error
}

/** `dbqa_datasource` 的数据访问层。 */
export class DatasourceStore {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** 按创建顺序列出全部数据源；测试/编辑只更新记录，不改变顺序。 */
  list(): readonly DatasourceSummary[] {
    const rows = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM dbqa_datasource ORDER BY created_at ASC, rowid ASC`)
      .all() as unknown as RawRow[]
    return rows.map(toSummary)
  }

  /**
   * 读一个数据源。
   * @throws `DBQA_NOT_FOUND`：id 不存在。
   */
  get(id: string): DatasourceRecord {
    const row = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM dbqa_datasource WHERE id = ?`)
      .get(id) as unknown as RawRow | undefined
    if (row === undefined) {
      throw new DbqaError('DBQA_NOT_FOUND', `dbqa: no datasource with id "${id}"`)
    }
    return toRecord(row)
  }

  /** 名称是否已被别的数据源占用。 */
  nameTaken(name: string, exceptId?: string): boolean {
    const row = this.#db
      .prepare('SELECT id FROM dbqa_datasource WHERE name = ? AND id <> ?')
      .get(name, exceptId ?? '') as { id?: string } | undefined
    return row !== undefined
  }

  /**
   * 新建数据源。
   * @throws `DBQA_CONFLICT`：名称重复。
   */
  create(input: DatasourceInput): DatasourceRecord {
    const id = datasourceId()
    const now = Date.now()
    try {
      withTransaction(this.#db, () => {
        this.#db
          .prepare(
            `INSERT INTO dbqa_datasource
               (id, name, db_type, config_json, secret_ref_json, knowledge_dir, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.name,
            input.dbType,
            JSON.stringify(input.config),
            JSON.stringify(input.secrets),
            id,
            now,
            now,
          )
      })
    } catch (error) {
      asNameConflict(error)
    }
    return this.get(id)
  }

  /**
   * 更新数据源；类型不可改，`knowledge_dir` 与创建时间保持不变。
   * @throws `DBQA_CONFLICT`：名称重复。
   * @throws `DBQA_INVALID_CONFIG`：试图改变类型。
   */
  update(id: string, input: DatasourceInput): DatasourceRecord {
    const current = this.get(id)
    if (current.dbType !== input.dbType) {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: a datasource type cannot be changed after creation')
    }
    const now = Date.now()
    try {
      withTransaction(this.#db, () => {
        this.#db
          .prepare(
            `UPDATE dbqa_datasource
                SET name = ?, config_json = ?, secret_ref_json = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(input.name, JSON.stringify(input.config), JSON.stringify(input.secrets), now, id)
      })
    } catch (error) {
      asNameConflict(error)
    }
    return this.get(id)
  }

  /**
   * 删除数据源；知识库索引行由外键级联删除，会话绑定置 NULL。
   * @returns 是否真的删掉了一行。
   */
  remove(id: string): boolean {
    return withTransaction(this.#db, () => {
      const result = this.#db.prepare('DELETE FROM dbqa_datasource WHERE id = ?').run(id)
      return result.changes > 0
    })
  }

  /** 写入一次测试连接的结果。 */
  recordTest(id: string, result: TestRecord): void {
    const testedAt = result.testedAt ?? Date.now()
    this.#db
      .prepare(
        `UPDATE dbqa_datasource
            SET last_tested_at = ?, last_test_ok = ?, last_test_error_code = ?,
                server_version = ?, server_version_num = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        testedAt,
        result.ok ? 1 : 0,
        result.errorCode ?? null,
        result.versionRaw ?? null,
        result.versionNum ?? null,
        testedAt,
        id,
      )
  }

  /** 数据结构分析落地后刷新时间戳（后续故事使用）。 */
  markAnalyzed(id: string, at: number = Date.now()): void {
    this.#db.prepare('UPDATE dbqa_datasource SET analyzed_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
  }
}
