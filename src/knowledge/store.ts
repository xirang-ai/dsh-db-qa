/**
 * 知识库索引：`dbqa_knowledge_file` 的读写。
 *
 * 索引只回答「文件变没变」：记录 content_hash / size_bytes / updated_at，
 * 不缓存正文，也不充当文件清单（清单来自扫盘）。
 *
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'

/** 索引文件类型。 */
export type KnowledgeKind = 'index' | 'table_business' | 'table_schema'

/** 一行索引。 */
export interface KnowledgeFileRow {
  readonly datasourceId: string
  readonly relPath: string
  readonly kind: KnowledgeKind
  readonly tableRef: string | null
  readonly contentHash: string
  readonly sizeBytes: number
  readonly updatedAt: number
}

interface RawRow {
  readonly datasource_id: string
  readonly rel_path: string
  readonly kind: string
  readonly table_ref: string | null
  readonly content_hash: string
  readonly size_bytes: number
  readonly updated_at: number
}

function toRow(row: RawRow): KnowledgeFileRow {
  return {
    datasourceId: row.datasource_id,
    relPath: row.rel_path,
    kind: row.kind as KnowledgeKind,
    tableRef: row.table_ref,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at,
  }
}

/** `dbqa_knowledge_file` 的数据访问层。 */
export class KnowledgeIndexStore {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** 一个数据源的全部索引行。 */
  list(datasourceId: string): readonly KnowledgeFileRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM dbqa_knowledge_file WHERE datasource_id = ? ORDER BY rel_path')
      .all(datasourceId) as unknown as RawRow[]
    return rows.map(toRow)
  }

  /** 按相对路径读一行。 */
  get(datasourceId: string, relPath: string): KnowledgeFileRow | null {
    const row = this.#db
      .prepare('SELECT * FROM dbqa_knowledge_file WHERE datasource_id = ? AND rel_path = ?')
      .get(datasourceId, relPath) as unknown as RawRow | undefined
    return row === undefined ? null : toRow(row)
  }

  /** 插入或覆盖一行。 */
  upsert(row: KnowledgeFileRow): void {
    this.#db
      .prepare(
        `INSERT INTO dbqa_knowledge_file
           (datasource_id, rel_path, kind, table_ref, content_hash, size_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (datasource_id, rel_path) DO UPDATE SET
           kind = excluded.kind,
           table_ref = excluded.table_ref,
           content_hash = excluded.content_hash,
           size_bytes = excluded.size_bytes,
           updated_at = excluded.updated_at`,
      )
      .run(row.datasourceId, row.relPath, row.kind, row.tableRef, row.contentHash, row.sizeBytes, row.updatedAt)
  }

  /** 删除一个数据源下某个相对路径的索引行。 */
  remove(datasourceId: string, relPath: string): void {
    this.#db
      .prepare('DELETE FROM dbqa_knowledge_file WHERE datasource_id = ? AND rel_path = ?')
      .run(datasourceId, relPath)
  }

  /** 删除一张表的全部索引行。 */
  removeTable(datasourceId: string, tableRef: string): void {
    this.#db
      .prepare('DELETE FROM dbqa_knowledge_file WHERE datasource_id = ? AND table_ref = ?')
      .run(datasourceId, tableRef)
  }
}
