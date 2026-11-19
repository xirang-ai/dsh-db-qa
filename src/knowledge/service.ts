/**
 * 知识库文件服务：整篇写入、每次读取重读文件、按 hash 自愈索引。
 *
 * 文件是唯一真源：读取不缓存，外部编辑器改完下一次读取就生效；写入一律
 * 先写 `<file>.tmp` 再 `rename`，避免读者看到半篇内容。
 *
 * @module
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { DbqaError } from '../errors.ts'
import {
  INDEX_REL_PATH,
  dirOfRelPath,
  knowledgeRoot,
  normalizeTableDir,
  tableRelPath,
  type TablePart,
} from './layout.ts'
import type { KnowledgeFileRow, KnowledgeIndexStore, KnowledgeKind } from './store.ts'

/** 单个文件的状态。 */
export interface FileState {
  readonly exists: boolean
  /** 文件最后修改时间（epoch ms）。 */
  readonly updatedAt: number | null
  readonly sizeBytes: number | null
  /** 磁盘内容与索引 hash 不一致，或尚未登记。 */
  readonly stale: boolean
}

/** 一张表在知识库里的状态。 */
export interface TableKnowledgeState {
  readonly tableRef: string
  /** 表目录名；重名时带 hash 后缀。 */
  readonly dir: string
  readonly business: FileState
  readonly schema: FileState
}

/** `knowledge.status` 的返回。 */
export interface KnowledgeStatus {
  readonly index: FileState
  readonly tables: readonly TableKnowledgeState[]
  /** 索引里有、磁盘上已经没有的相对路径。 */
  readonly indexedOnly: readonly string[]
}

/** 写入请求。 */
export interface KnowledgeWriteRequest {
  readonly tableRef?: string
  readonly part: 'index' | TablePart
  readonly content: string
}

/** 单份写入结果。 */
export interface KnowledgeWriteResult {
  readonly relPath: string
  readonly kind: KnowledgeKind
  readonly tableRef: string | null
  readonly status: 'created' | 'updated' | 'unchanged'
  readonly hash: string
  readonly sizeBytes: number
}

/** 读取到的一份文档。 */
export interface KnowledgeDocument {
  readonly part: 'index' | TablePart
  readonly relPath: string
  readonly content: string
  readonly updatedAt: number
}

/** 读取结果。 */
export interface KnowledgeReadResult {
  readonly tableRef: string | null
  readonly documents: readonly KnowledgeDocument[]
  /** 请求了但磁盘上不存在的部分。 */
  readonly missingParts: readonly string[]
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** 知识库文件服务。 */
export class KnowledgeService {
  readonly #dataDir: string
  readonly #index: KnowledgeIndexStore

  constructor(dataDir: string, index: KnowledgeIndexStore) {
    this.#dataDir = dataDir
    this.#index = index
  }

  /** 一个数据源的根目录。 */
  root(datasourceId: string): string {
    return knowledgeRoot(this.#dataDir, datasourceId)
  }

  /** 表目录映射：table_ref → 目录名（来自索引行）。 */
  #dirsByTable(datasourceId: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const row of this.#index.list(datasourceId)) {
      const dir = dirOfRelPath(row.relPath)
      if (dir !== null && row.tableRef !== null) map.set(row.tableRef, dir)
    }
    return map
  }

  /** 为新表选目录；与已有目录重名时加 hash 后缀。 */
  #resolveDir(datasourceId: string, tableRef: string, extraTaken?: ReadonlySet<string>): string {
    const known = this.#dirsByTable(datasourceId)
    const existing = known.get(tableRef)
    if (existing !== undefined) return existing
    const taken = new Set(known.values())
    for (const item of extraTaken ?? []) taken.add(item)
    const base = normalizeTableDir(tableRef)
    return taken.has(base) ? `${base}-${sha256(tableRef).slice(0, 6)}` : base
  }

  /** 读一个文件的 hash / 大小 / mtime；不存在返回 null。 */
  async #statFile(path: string): Promise<{ hash: string; sizeBytes: number; updatedAt: number } | null> {
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      const content = await readFile(path)
      return { hash: sha256(content), sizeBytes: info.size, updatedAt: Math.trunc(info.mtimeMs) }
    } catch (error) {
      if (isMissing(error)) return null
      throw new DbqaError('DBQA_KNOWLEDGE_MISSING', 'dbqa: cannot read a knowledge file', {
        cause: String(error),
      })
    }
  }

  /** 单个文件状态。 */
  async #fileState(datasourceId: string, relPath: string): Promise<FileState> {
    const file = await this.#statFile(join(this.root(datasourceId), relPath))
    if (file === null) return { exists: false, updatedAt: null, sizeBytes: null, stale: false }
    const row = this.#index.get(datasourceId, relPath)
    return {
      exists: true,
      updatedAt: file.updatedAt,
      sizeBytes: file.sizeBytes,
      stale: row === null || row.contentHash !== file.hash,
    }
  }

  /** 扫盘 + 索引，给面板用的状态。 */
  async status(datasourceId: string): Promise<KnowledgeStatus> {
    const root = this.root(datasourceId)
    const index = await this.#fileState(datasourceId, INDEX_REL_PATH)
    const dirsByTable = this.#dirsByTable(datasourceId)
    const dirToTable = new Map<string, string>()
    for (const [tableRef, dir] of dirsByTable) dirToTable.set(dir, tableRef)

    let entries: string[] = []
    try {
      const listed = await readdir(join(root, 'tables'), { withFileTypes: true })
      entries = listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    } catch (error) {
      if (!isMissing(error)) {
        throw new DbqaError('DBQA_KNOWLEDGE_MISSING', 'dbqa: cannot scan the knowledge directory', {
          cause: String(error),
        })
      }
    }

    const tables: TableKnowledgeState[] = []
    for (const dir of entries) {
      const tableRef = dirToTable.get(dir) ?? dir
      tables.push({
        tableRef,
        dir,
        business: await this.#fileState(datasourceId, tableRelPath(dir, 'business')),
        schema: await this.#fileState(datasourceId, tableRelPath(dir, 'schema')),
      })
    }

    const present = new Set<string>([
      ...(index.exists ? [INDEX_REL_PATH] : []),
      ...tables.flatMap((table) => [
        ...(table.business.exists ? [tableRelPath(table.dir, 'business')] : []),
        ...(table.schema.exists ? [tableRelPath(table.dir, 'schema')] : []),
      ]),
    ])
    const indexedOnly = this.#index
      .list(datasourceId)
      .map((row) => row.relPath)
      .filter((relPath) => !present.has(relPath))

    return { index, tables, indexedOnly }
  }

  /** 读取并顺带自愈索引：hash 不符只更新索引行，不影响返回内容。 */
  async #readDocument(datasourceId: string, relPath: string, part: 'index' | TablePart): Promise<KnowledgeDocument | null> {
    const full = join(this.root(datasourceId), relPath)
    try {
      const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
      const hash = sha256(content)
      const row = this.#index.get(datasourceId, relPath)
      if (row === null || row.contentHash !== hash) {
        this.#index.upsert({
          datasourceId,
          relPath,
          kind: part === 'index' ? 'index' : part === 'business' ? 'table_business' : 'table_schema',
          tableRef: part === 'index' ? null : this.#tableRefOf(datasourceId, relPath),
          contentHash: hash,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          updatedAt: Date.now(),
        })
      }
      return { part, relPath, content, updatedAt: Math.trunc(info.mtimeMs) }
    } catch (error) {
      if (isMissing(error)) return null
      throw new DbqaError('DBQA_KNOWLEDGE_MISSING', 'dbqa: cannot read a knowledge file', {
        cause: String(error),
      })
    }
  }

  #tableRefOf(datasourceId: string, relPath: string): string | null {
    const dir = dirOfRelPath(relPath)
    if (dir === null) return null
    for (const [tableRef, knownDir] of this.#dirsByTable(datasourceId)) {
      if (knownDir === dir) return tableRef
    }
    return dir
  }

  /** 读索引文档或表文档；都不存在时抛 `DBQA_KNOWLEDGE_MISSING`。 */
  async read(datasourceId: string, tableRef?: string, part?: 'business' | 'schema' | 'both'): Promise<KnowledgeReadResult> {
    if (tableRef === undefined) {
      const document = await this.#readDocument(datasourceId, INDEX_REL_PATH, 'index')
      if (document === null) {
        return { tableRef: null, documents: [], missingParts: ['index'] }
      }
      return { tableRef: null, documents: [document], missingParts: [] }
    }

    const dir = this.#resolveDir(datasourceId, tableRef)
    const wanted: TablePart[] = part === 'both' || part === undefined ? ['business', 'schema'] : [part]
    const documents: KnowledgeDocument[] = []
    const missingParts: string[] = []
    for (const wantedPart of wanted) {
      const document = await this.#readDocument(datasourceId, tableRelPath(dir, wantedPart), wantedPart)
      if (document === null) missingParts.push(wantedPart)
      else documents.push(document)
    }
    if (documents.length === 0) {
      throw new DbqaError('DBQA_KNOWLEDGE_MISSING', `dbqa: no knowledge documents for table "${tableRef}"`)
    }
    return { tableRef, documents, missingParts }
  }

  /**
   * 整篇写入一批文件；逐份独立生效，不跨文件回滚。
   *
   * 内容与磁盘一致时返回 `unchanged`，不重写文件。
   */
  async write(datasourceId: string, files: readonly KnowledgeWriteRequest[]): Promise<readonly KnowledgeWriteResult[]> {
    const root = this.root(datasourceId)
    const extraTaken = new Set<string>()
    const results: KnowledgeWriteResult[] = []
    for (const file of files) {
      let relPath: string
      let kind: KnowledgeKind
      let tableRef: string | null = null
      if (file.part === 'index') {
        relPath = INDEX_REL_PATH
        kind = 'index'
      } else {
        if (file.tableRef === undefined || file.tableRef === '') {
          throw new DbqaError('DBQA_KNOWLEDGE_WRITE', 'dbqa: a table document needs a table reference')
        }
        tableRef = file.tableRef
        const dir = this.#resolveDir(datasourceId, tableRef, extraTaken)
        extraTaken.add(dir)
        relPath = tableRelPath(dir, file.part)
        kind = file.part === 'business' ? 'table_business' : 'table_schema'
      }

      const full = join(root, relPath)
      const hash = sha256(file.content)
      const sizeBytes = Buffer.byteLength(file.content, 'utf8')
      const previous = await this.#statFile(full)
      let status: KnowledgeWriteResult['status'] = 'created'
      if (previous !== null) {
        if (previous.hash === hash) {
          status = 'unchanged'
        } else {
          status = 'updated'
        }
      }
      if (status !== 'unchanged') {
        await mkdir(dirname(full), { recursive: true })
        const tmp = `${full}.tmp-${randomBytes(4).toString('hex')}`
        try {
          await writeFile(tmp, file.content, 'utf8')
          await rename(tmp, full)
        } catch (error) {
          try {
            await unlink(tmp)
          } catch (cleanupError) {
            // 临时文件可能根本没写出来；清理失败不覆盖原始写入错误。
            void cleanupError
          }
          throw new DbqaError('DBQA_KNOWLEDGE_WRITE', `dbqa: cannot write "${relPath}"`, { cause: String(error) })
        }
      }
      this.#index.upsert({
        datasourceId,
        relPath,
        kind,
        tableRef,
        contentHash: hash,
        sizeBytes,
        updatedAt: Date.now(),
      })
      results.push({ relPath, kind, tableRef, status, hash, sizeBytes })
    }
    return results
  }

  /** 删除一张表的目录与索引行。 */
  async removeTable(datasourceId: string, tableRef: string): Promise<void> {
    const dir = this.#dirsByTable(datasourceId).get(tableRef)
    this.#index.removeTable(datasourceId, tableRef)
    if (dir === undefined) return
    try {
      await rm(join(this.root(datasourceId), 'tables', dir), { recursive: true, force: true })
    } catch (error) {
      throw new DbqaError('DBQA_KNOWLEDGE_WRITE', `dbqa: cannot remove the documents of "${tableRef}"`, {
        cause: String(error),
      })
    }
  }

  /** 删除整个数据源的知识库目录（数据源删除时调用）。 */
  async removeDatasource(datasourceId: string): Promise<void> {
    try {
      await rm(this.root(datasourceId), { recursive: true, force: true })
    } catch (error) {
      throw new DbqaError('DBQA_KNOWLEDGE_WRITE', 'dbqa: cannot remove the knowledge directory', {
        cause: String(error),
      })
    }
  }
}

/** 索引行到文件状态的转换；面板与其他调用方共用。 */
export function fileStateOf(row: KnowledgeFileRow | null, exists: boolean, updatedAt: number | null, sizeBytes: number | null): FileState {
  return {
    exists,
    updatedAt,
    sizeBytes,
    stale: exists && (row === null || sizeBytes !== row.sizeBytes),
  }
}
