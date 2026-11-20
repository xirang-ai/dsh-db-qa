/**
 * 知识库文档里的相对链接：解析、校验与修复。
 *
 * 表目录名是归一化后的 `schema.table`，带库/schema 前缀（例如
 * `baimiao_aibims_com.cloud_org_nodes`）。写文档的模型习惯省掉前缀，写成
 * `../cloud_org_nodes/business.md`：面板渲染器有后缀兜底，能跳转；但普通
 * Markdown 阅读器按字面解析会 404。这里把「判对错」和「改成全名」放在同一处，
 * 供工具与渲染器共用，避免两边规则走样。
 *
 * 纯函数，不碰文件系统，客户端 bundle 也可以复用。
 *
 * @module
 */

/** 表目录名与表引用的对应关系。 */
export interface TableDirEntry {
  readonly dir: string
  readonly tableRef: string
}

/** 一条解析出来的 Markdown 链接。 */
export interface ParsedLink {
  readonly href: string
  /** href 在源文本中的起始偏移。 */
  readonly start: number
  /** href 在源文本中的结束偏移（半开区间）。 */
  readonly end: number
  /** 1 起算的行号。 */
  readonly line: number
}

/** 链接的问题类型。 */
export type LinkProblemKind = 'abbreviated' | 'dangling' | 'missing-index' | 'outside'

/** 一条需要处理的链接。 */
export interface LinkProblem {
  /** 链接所在文档的相对路径。 */
  readonly path: string
  readonly line: number
  readonly href: string
  /** 按字面解析出的相对路径；越出知识库根目录时为原 href。 */
  readonly resolved: string
  readonly kind: LinkProblemKind
  /** 规范化后的 href；无法自动修复时为 null。 */
  readonly suggestion: string | null
}

/** 一份文档的检查输入。 */
export interface LinkCheckDocument {
  readonly path: string
  readonly content: string
}

/** 文档里需要修复的一处链接。 */
export interface LinkFix {
  readonly start: number
  readonly end: number
  readonly href: string
}

const FENCE = /^\s*(```|~~~)/
const LINK = /(!?)\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const TABLE_DOC = /^tables\/([^/]+)\/(business|schema)\.md$/

/** 把围栏代码块替换成等长空白，偏移与行号保持不变。 */
function maskFencedCode(markdown: string): string {
  const lines = markdown.split('\n')
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = FENCE.exec(line)
    if (fence === null) {
      if (match !== null) {
        fence = match[1] ?? '```'
        lines[index] = ' '.repeat(line.length)
      }
      continue
    }
    if (match !== null && (match[1] ?? '') === fence) fence = null
    lines[index] = ' '.repeat(line.length)
  }
  return lines.join('\n')
}

/** 解析文档里的行内链接，跳过图片与围栏代码块。 */
export function parseMarkdownLinks(markdown: string): readonly ParsedLink[] {
  const masked = maskFencedCode(markdown)
  const links: ParsedLink[] = []
  let cursor = 0
  let line = 1
  for (const match of masked.matchAll(LINK)) {
    const text = match[0]
    const start = match.index
    if (start === undefined) continue
    // 图片不是文档链接，不参与跳转约定。
    if ((match[1] ?? '') === '!') continue
    const href = match[2] ?? ''
    if (href === '') continue
    const hrefOffset = start + text.indexOf(href, 2)
    line += countNewlines(masked, cursor, hrefOffset)
    cursor = hrefOffset
    links.push({ href, start: hrefOffset, end: hrefOffset + href.length, line })
  }
  return links
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  for (let index = from; index < to; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

/**
 * 把相对 href 按所在文档解析成知识库内的相对路径。
 *
 * @param fromRelPath - 链接所在文档的相对路径。
 * @param href - Markdown 里的原始目标。
 * @returns 知识库内的相对路径；外部地址、绝对路径或越出根目录时返回 null。
 */
export function resolveRelative(fromRelPath: string, href: string): string | null {
  const raw = href.trim()
  if (raw === '' || raw.startsWith('//') || SCHEME.test(raw)) return null
  const cut = raw.search(/[?#]/)
  const pathPart = cut === -1 ? raw : raw.slice(0, cut)
  if (pathPart === '') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return null
  }
  if (decoded.startsWith('/')) return null

  const parts = fromRelPath.split('/')
  parts.pop()
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.length === 0 ? null : parts.join('/')
}

/**
 * 把链接里的目录名对到真实表目录。
 *
 * 先按目录名精确匹配，再按 `dir` / `tableRef` 的后缀匹配；多个候选时视为
 * 有歧义，返回 undefined。
 */
export function matchTableDir(
  dir: string,
  tables: readonly TableDirEntry[],
): TableDirEntry | undefined {
  const exact = tables.find((table) => table.dir === dir)
  if (exact !== undefined) return exact
  const matches = tables.filter(
    (table) =>
      table.tableRef === dir
      || table.tableRef.endsWith(`.${dir}`)
      || table.dir.endsWith(`.${dir}`),
  )
  return matches.length === 1 ? matches[0] : undefined
}

/** 从 `fromPath` 所在目录指向 `targetPath` 的相对 href。 */
export function relativeHref(fromPath: string, targetPath: string): string {
  const from = fromPath.split('/')
  from.pop()
  const to = targetPath.split('/')
  let shared = 0
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1
  const up = from.length - shared
  const rest = to.slice(shared)
  return [...Array<string>(up).fill('..'), ...rest].join('/')
}

function isDocumentLike(resolved: string): boolean {
  return resolved.endsWith('.md')
}

/**
 * 检查一批文档里的相对链接。
 *
 * @param documents - 需要检查的文档（路径 + 全文）。
 * @param tables - 磁盘上真实存在的表目录。
 * @param indexExists - `index.md` 是否存在。
 */
export function checkLinks(
  documents: readonly LinkCheckDocument[],
  tables: readonly TableDirEntry[],
  indexExists: boolean,
): { readonly links: number; readonly problems: readonly LinkProblem[] } {
  const exists = new Set<string>()
  if (indexExists) exists.add('index.md')
  for (const document of documents) exists.add(document.path)

  const problems: LinkProblem[] = []
  let links = 0
  for (const document of documents) {
    for (const link of parseMarkdownLinks(document.content)) {
      const resolved = resolveRelative(document.path, link.href)
      if (resolved === null) {
        if (isDocumentLike(link.href)) {
          problems.push({
            path: document.path,
            line: link.line,
            href: link.href,
            resolved: link.href,
            kind: 'outside',
            suggestion: null,
          })
        }
        continue
      }
      // 图片与附件不参与文档链接约定。
      if (!isDocumentLike(resolved)) continue
      links += 1
      if (exists.has(resolved)) continue

      if (resolved === 'index.md') {
        problems.push({
          path: document.path,
          line: link.line,
          href: link.href,
          resolved,
          kind: 'missing-index',
          suggestion: null,
        })
        continue
      }

      const tableDoc = TABLE_DOC.exec(resolved)
      const segment = tableDoc?.[1]
      const part = tableDoc?.[2]
      const hit = segment === undefined ? undefined : matchTableDir(segment, tables)
      if (hit === undefined || part === undefined) {
        problems.push({
          path: document.path,
          line: link.line,
          href: link.href,
          resolved,
          kind: 'dangling',
          suggestion: null,
        })
        continue
      }
      if (hit.dir === segment) {
        // 目录对得上、文件没写：不是链接写法问题，不能自动修。
        problems.push({
          path: document.path,
          line: link.line,
          href: link.href,
          resolved,
          kind: 'dangling',
          suggestion: null,
        })
        continue
      }
      problems.push({
        path: document.path,
        line: link.line,
        href: link.href,
        resolved,
        kind: 'abbreviated',
        suggestion: relativeHref(document.path, `tables/${hit.dir}/${part}.md`),
      })
    }
  }
  return { links, problems }
}

/** 把一条链接的问题折叠成可执行的替换。 */
export function fixesOf(
  document: LinkCheckDocument,
  problems: readonly LinkProblem[],
): readonly LinkFix[] {
  const fixes: LinkFix[] = []
  for (const link of parseMarkdownLinks(document.content)) {
    const problem = problems.find(
      (item) => item.path === document.path && item.line === link.line && item.href === link.href,
    )
    if (problem === undefined || problem.suggestion === null) continue
    fixes.push({ start: link.start, end: link.end, href: problem.suggestion })
  }
  return fixes
}

/** 按偏移从后往前替换，避免前面的替换移动后面的位置。 */
export function applyFixes(content: string, fixes: readonly LinkFix[]): string {
  const ordered = [...fixes].sort((left, right) => right.start - left.start)
  let result = content
  for (const fix of ordered) {
    result = result.slice(0, fix.start) + fix.href + result.slice(fix.end)
  }
  return result
}
