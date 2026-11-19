/**
 * 知识库文件布局：一个数据源一个目录，表目录名由 `schema.table` 归一化。
 *
 * 归一化规则按《数据设计 · 知识库文件布局与索引》§5：禁止字符、空白与
 * 控制字符替换为 `_`，去首尾 `.` / `_`，超过 120 截断，保留大小写；与
 * 已有目录重名时追加 `-` 加 table_ref 的 sha256 前 6 位。
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 知识库索引文档的相对路径。 */
export const INDEX_REL_PATH = 'index.md'

/** 表文档的两种部分。 */
export type TablePart = 'business' | 'schema'

/** 归一化一段表引用为目录名。 */
export function normalizeTableDir(tableRef: string): string {
  let name = tableRef
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\s\p{Cc}]/gu, '_')
    .replace(/^[._]+|[._]+$/g, '')
  if (name === '') name = '_'
  return name.slice(0, 120)
}

/** 重名时追加的稳定后缀。 */
export function collisionSuffix(tableRef: string): string {
  return createHash('sha256').update(tableRef, 'utf8').digest('hex').slice(0, 6)
}

/** 表目录名：没有冲突时用归一化名，冲突时加后缀。 */
export function tableDirName(tableRef: string, taken: ReadonlySet<string>): string {
  const base = normalizeTableDir(tableRef)
  return taken.has(base) ? `${base}-${collisionSuffix(tableRef)}` : base
}

/** 表文档相对路径。 */
export function tableRelPath(dir: string, part: TablePart): string {
  return `tables/${dir}/${part}.md`
}

/** 知识库根目录。 */
export function knowledgeRoot(dataDir: string, datasourceId: string): string {
  return join(dataDir, 'knowledge', datasourceId)
}

/** 从表文档相对路径里取出目录名；不是表文档时返回 null。 */
export function dirOfRelPath(relPath: string): string | null {
  const match = /^tables\/([^/]+)\/(?:business|schema)\.md$/.exec(relPath)
  return match?.[1] ?? null
}
