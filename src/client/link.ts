/**
 * 知识库文档内的相对链接解析（客户端入口）。
 *
 * 面板只认识两种文档：根目录的 `index.md` 与 `tables/<dir>/{business,schema}.md`。
 * 这里把 Markdown 里的 href 按当前文档路径解析成其中一种；外部地址与
 * 知识库之外的路径都返回 `other`，由调用方决定怎么提示。
 *
 * 解析与「短名对全名」的规则统一放在 `knowledge/links.ts`，写侧校验工具与
 * 面板渲染共用同一份实现，避免两边对链接是否有效的判断走样。
 *
 * @module
 */
import { matchTableDir, resolveRelative, type TableDirEntry } from '../knowledge/links.ts'

/** 表文档的两种部分。 */
export type KnowledgeLinkPart = 'business' | 'schema'

/** 一条链接的去向。 */
export type KnowledgeLinkTarget =
  | { readonly kind: 'external' }
  | { readonly kind: 'index' }
  | { readonly kind: 'table'; readonly dir: string; readonly part: KnowledgeLinkPart }
  | { readonly kind: 'other'; readonly path: string }

/** 一张表在知识库里的目录名与表引用。 */
export type TableLinkCandidate = TableDirEntry

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const TABLE_DOC = /^tables\/([^/]+)\/(business|schema)\.md$/

/**
 * 把链接里的目录名对到真实表引用。
 *
 * 表目录名是归一化后的 `schema.table`，但知识库文档由模型生成，表间链接常写成
 * `../<table>/business.md`（省略库/schema 前缀）。先按目录名精确匹配，再按
 * `dir` / `tableRef` 的后缀匹配；多个候选时视为有歧义，返回 undefined。
 */
export function resolveTableRef(
  dir: string,
  tables: readonly TableLinkCandidate[],
): string | undefined {
  return matchTableDir(dir, tables)?.tableRef
}

/** 解析一条 Markdown 链接；`fromRelPath` 是链接所在文档的相对路径。 */
export function resolveKnowledgeLink(fromRelPath: string, href: string): KnowledgeLinkTarget {
  const raw = href.trim()
  if (raw === '') return { kind: 'other', path: '' }
  if (raw.startsWith('//') || SCHEME.test(raw)) return { kind: 'external' }

  const cut = raw.search(/[?#]/)
  const pathPart = cut === -1 ? raw : raw.slice(0, cut)
  if (pathPart === '') return { kind: 'other', path: raw }

  const path = resolveRelative(fromRelPath, raw)
  if (path === null) return { kind: 'other', path: pathPart }
  if (path === 'index.md') return { kind: 'index' }

  const table = TABLE_DOC.exec(path)
  if (table !== null) {
    return { kind: 'table', dir: table[1] ?? '', part: table[2] as KnowledgeLinkPart }
  }
  return { kind: 'other', path }
}
