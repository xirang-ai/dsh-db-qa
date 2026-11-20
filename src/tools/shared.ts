/**
 * 分析 / 查询两个 preset 共用的工具：表结构、知识库读、知识库写。
 *
 * 所有工具都从当前会话的绑定解析数据源，不接受调用方传 `datasourceId`；
 * 每次调用打开一条只读短连接，读完即关。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Config as DbqaConfig } from '../config.ts'
import { callTimeoutText, raceAbort, startDeadline, statementTimeoutText, withDeadline } from '../db/deadline.ts'
import { openDbSession } from '../db/open.ts'
import {
  clampLimit,
  tableRefKey,
  type ColumnSummary,
  type DbSession,
  type QueryResult,
  type TableDdl,
  type TableRef,
  type TableSummary,
} from '../db/session.ts'
import { DbqaError, asDbqaError, describeError } from '../errors.ts'
import { translateBilingual } from '../i18n.ts'
import type { DbqaDatabase } from '../store/db.ts'

/** 宿主注入给 preset 的最小服务面。 */
export interface DbqaToolService {
  readonly database: DbqaDatabase
  readonly config: DbqaConfig
}

/** 单页默认表数；分页没有总量上限。 */
export const DEFAULT_TABLE_PAGE = 25
/** 单页最多表数；仍可继续翻页，不限制最终数量。 */
export const MAX_TABLE_PAGE = 200
/** 一次写入最多份数。 */
export const MAX_FILES = 20

/** 从插件上下文取 preset 注入的服务。 */
export function toolService(ctx: Context, key: 'dbqaAnalysis' | 'dbqaQuery'): DbqaToolService {
  const found = ctx.get(key) as DbqaToolService | undefined
  if (found === undefined) {
    throw new DbqaError('DBQA_INTERNAL', `dbqa: the ${key} service is not available`)
  }
  return found
}

/** 从工具执行上下文解析绑定。 */
export function bindingOf(
  serviceValue: DbqaToolService,
  exec: { readonly agent?: { readonly id: string } },
): string {
  const sessionId = exec.agent?.id
  if (sessionId === undefined) {
    throw new DbqaError('DBQA_NO_DATASOURCE', translateBilingual('dbqa.query.noSession'))
  }
  return serviceValue.database.conversations.requireBinding(sessionId).datasourceId
}

/**
 * 一次工具调用对用户数据库的访问面。
 *
 * 所有方法共用一个总预算（`toolTimeoutMs`）：连接、每条语句、关闭都算在里面。
 * 超时后自动强制断链——否则挂起的语句会让 `close()` 一直等下去，工具调用也就
 * 永远不会返回。工具必须在 `finally` 里调用 `close()`。
 */
export interface DbCall {
  readonly datasourceId: string
  listTables(): Promise<readonly TableSummary[]>
  describeTable(ref: TableRef): Promise<readonly ColumnSummary[]>
  tableDdl(ref: TableRef): Promise<TableDdl>
  sampleRows(ref: TableRef, limit: number): Promise<QueryResult>
  query(sql: string, limit: number): Promise<QueryResult>
  close(): Promise<void>
}

/**
 * 打开一条受截止时间约束的只读会话。
 * @param serviceValue - preset 注入的服务面（含配置）。
 * @param datasourceId - 已解析的数据源。
 * @param signal - 宿主工具的中止信号。
 */
export async function openDbCall(
  serviceValue: DbqaToolService,
  datasourceId: string,
  signal: AbortSignal,
): Promise<DbCall> {
  const datasource = serviceValue.database.store.get(datasourceId)
  const { config } = serviceValue
  const statementTimeoutMs = config.queryTimeoutMs
  // 总预算至少覆盖一条语句：配置把两者写反时不能比单条语句还短。
  const budgetMs = Math.max(config.toolTimeoutMs, config.queryTimeoutMs)
  const timeoutText = callTimeoutText(budgetMs)
  const deadline = startDeadline(signal, budgetMs, timeoutText)

  const opening = openDbSession(datasource.dbType, datasource.name, datasource.config, datasource.secrets, {
    dataDir: config.dataDir === '' ? serviceValue.database.dataDir : config.dataDir,
    signal: deadline.signal,
    env: process.env,
    defaultConnectTimeoutMs: config.connectTimeoutMs,
    statementTimeoutMs,
  })

  let session: DbSession
  try {
    session = await raceAbort(opening, deadline.signal)
  } catch (error) {
    // 放弃等待时连接可能还在建立：等它落地后立刻断掉，避免留下孤儿连接。
    void opening.then(
      (late) => late.close({ force: true }).catch(() => undefined),
      () => undefined,
    )
    deadline.dispose()
    throw deadline.timedOut() ? new DbqaError('DBQA_TIMEOUT', timeoutText) : error
  }

  const runStatement = <T>(task: (inner: AbortSignal) => Promise<T>): Promise<T> =>
    withDeadline(deadline.signal, statementTimeoutMs, statementTimeoutText(statementTimeoutMs), task)

  return {
    datasourceId,
    listTables: () => runStatement((inner) => session.listTables(inner)),
    describeTable: (ref) => runStatement((inner) => session.describeTable(ref, inner)),
    tableDdl: (ref) => runStatement((inner) => session.tableDdl(ref, inner)),
    sampleRows: (ref, limit) => runStatement((inner) => session.sampleRows(ref, limit, inner)),
    query: (sql, limit) => runStatement((inner) => session.query(sql, limit, inner)),
    async close() {
      // 超时/取消后不要再等驱动收尾：挂起的语句会把关闭一起拖住。
      const force = deadline.timedOut() || deadline.signal.aborted
      deadline.dispose()
      try {
        await session.close({ force })
      } catch (error) {
        serviceValue.database.log.warn(`dbqa: failed to close datasource session: ${describeError(error)}`)
      }
    },
  }
}

/** 把 `schema.table` / 表名统一成引用。 */
function refMatches(ref: TableRef, requested: readonly string[]): boolean {
  if (requested.length === 0) return true
  return requested.some((item) => item === tableRefKey(ref) || item === ref.table)
}

/** 记录一次工具调用的审计；审计写失败只告警，不影响主结果（R-7）。 */
export function recordToolAudit(
  value: DbqaToolService,
  exec: { readonly agent?: { readonly id: string } },
  input: {
    readonly datasourceId: string
    readonly toolName: string
    readonly startedAt: number
    readonly outcome: 'ok' | 'rejected' | 'failed'
    readonly errorCode?: string | null
    readonly rowCount?: number | null
    readonly truncated?: boolean
    readonly sqlText?: string | null
  },
): void {
  try {
    value.database.audit.record({
      datasourceId: input.datasourceId,
      sessionId: exec.agent?.id ?? null,
      toolName: input.toolName,
      sqlText: input.sqlText ?? null,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      rowCount: input.rowCount ?? null,
      truncated: input.truncated ?? false,
      durationMs: Date.now() - input.startedAt,
    })
  } catch (error) {
    value.database.log.warn(`dbqa: failed to write tool audit: ${describeError(error)}`)
  }
}

/** 注册 `dbqa_describe_schema`。 */
export function registerDescribeSchema(ctx: Context, value: DbqaToolService): void {
  ctx.tools.register(
    defineTool({
      name: 'dbqa_describe_schema',
      description:
        'List tables/views of the bound datasource with their full structure: columns, DDL, indexes and '
        + 'foreign keys. Results are paged: call again with `offset` set to `nextOffset` until it is null. '
        + 'There is no cap on the total number of tables. Returns JSON with table refs, kinds, columns '
        + '(name/type/nullable/default/comment/primaryKey), ddl, indexes and foreignKeys.',
      parameters: {
        tables: {
          type: 'array',
          description: 'Optional table refs (schema.table or bare table) to narrow the call.',
          items: { type: 'string' },
        },
        schema: {
          type: 'string',
          description: 'Optional schema/database name to narrow the call.',
        },
        offset: {
          type: 'integer',
          description: 'Zero-based table offset for paging; use the previous call\'s nextOffset.',
        },
        limit: {
          type: 'integer',
          description: 'Tables per page (1-200); defaults to 25. Does not limit the total.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
      },
      async execute(args, exec) {
        const datasourceId = bindingOf(value, exec)
        const startedAt = Date.now()
        let rowCount: number | null = null
        try {
          const call = await openDbCall(value, datasourceId, exec.signal)
          try {
            const all = await call.listTables()
            const filtered = all.filter(
              (table) =>
                refMatches(table.ref, args.tables ?? [])
                && (args.schema === undefined || args.schema === '' || table.ref.schema === args.schema),
            )
            const offset = Math.max(0, Math.trunc(args.offset ?? 0))
            const pageSize = clampLimit(args.limit, DEFAULT_TABLE_PAGE, MAX_TABLE_PAGE)
            const selected = filtered.slice(offset, offset + pageSize)
            const tables = []
            for (const table of selected) {
              const columns = await call.describeTable(table.ref)
              const detail = await call.tableDdl(table.ref).catch(() => ({
                ddl: '',
                indexes: [] as readonly string[],
                foreignKeys: [] as readonly string[],
              }))
              tables.push({
                table: tableRefKey(table.ref),
                kind: table.kind,
                comment: table.comment ?? '',
                ddl: detail.ddl,
                indexes: [...detail.indexes],
                foreignKeys: [...detail.foreignKeys],
                columns: columns.map((column) => ({
                  name: column.name,
                  type: column.type,
                  nullable: column.nullable,
                  default: column.defaultValue ?? '',
                  comment: column.comment ?? '',
                  primaryKey: column.primaryKey,
                })),
              })
            }
            rowCount = tables.length
            const nextOffset = offset + selected.length < filtered.length ? offset + selected.length : null
            recordToolAudit(value, exec, {
              datasourceId,
              toolName: 'dbqa_describe_schema',
              startedAt,
              outcome: 'ok',
              rowCount,
            })
            return {
              tables,
              totalTables: filtered.length,
              offset,
              nextOffset,
              hint:
                nextOffset === null
                  ? ''
                  : `More tables remain. Call dbqa_describe_schema again with offset=${nextOffset} until nextOffset is null.`,
            }
          } finally {
            await call.close()
          }
        } catch (error) {
          recordToolAudit(value, exec, {
            datasourceId,
            toolName: 'dbqa_describe_schema',
            startedAt,
            outcome: 'failed',
            errorCode: asDbqaError(error)?.code ?? 'DBQA_QUERY_FAILED',
            rowCount,
          })
          throw error
        }
      },
    }),
  )
}

/** 注册 `dbqa_read_knowledge`。 */
export function registerReadKnowledge(ctx: Context, value: DbqaToolService): void {
  ctx.tools.register(
    defineTool({
      name: 'dbqa_read_knowledge',
      description:
        'Read the knowledge base of the bound datasource. Without arguments returns index.md plus the table '
        + 'documents that exist on disk; with `table` returns that table\'s business/schema documents. Files are '
        + 'the source of truth, so this always reflects external edits.',
      parameters: {
        table: {
          type: 'string',
          description: 'Optional table ref `schema.table`; omit to read the index document.',
        },
        part: {
          type: 'string',
          enum: ['business', 'schema', 'both'],
          description: 'Which table document to read; defaults to both.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
      },
      async execute(args, exec) {
        const datasourceId = bindingOf(value, exec)
        const knowledge = value.database.knowledge
        if (args.table === undefined || args.table === '') {
          try {
            const index = await knowledge.read(datasourceId)
            return {
              table: '',
              documents: index.documents.map((document) => ({
                part: document.part,
                path: document.relPath,
                content: document.content,
              })),
              missing: [],
              hint: '',
            }
          } catch (error) {
            if (error instanceof DbqaError && error.code === 'DBQA_KNOWLEDGE_MISSING') {
              return { table: '', documents: [], missing: ['index'], hint: 'The knowledge base is empty.' }
            }
            throw error
          }
        }
        const part = args.part ?? 'both'
        try {
          const result = await knowledge.read(datasourceId, args.table, part)
          return {
            table: result.tableRef ?? args.table,
            documents: result.documents.map((document) => ({
              part: document.part,
              path: document.relPath,
              content: document.content,
            })),
            missing: [...result.missingParts],
            hint: '',
          }
        } catch (error) {
          if (error instanceof DbqaError && error.code === 'DBQA_KNOWLEDGE_MISSING') {
            return {
              table: args.table,
              documents: [],
              missing: part === 'both' ? ['business', 'schema'] : [part],
              hint: 'No document has been written for this table yet.',
            }
          }
          throw error
        }
      },
    }),
  )
}

/** 注册 `dbqa_write_knowledge`。 */
export function registerWriteKnowledge(ctx: Context, value: DbqaToolService): void {
  ctx.tools.register(
    defineTool({
      name: 'dbqa_write_knowledge',
      description:
        'Write knowledge documents for the bound datasource. Every file is replaced as a whole (temp file + '
        + 'rename); writes are independent and not rolled back across files. Send at most 20 files per call. '
        + 'Write table documents first, then index.md last. index.md must link to every other document you '
        + 'generate, and whenever a document describes a relationship to another table or document it must '
        + 'link to that document with a relative Markdown link. Table directories are named `<schema>.<table>`, '
        + 'so link with the full directory name (`tables/<schema>.<table>/business.md`), never a bare table '
        + 'name. Run dbqa_check_knowledge_links after writing and fix what it reports. Only include content the '
        + 'user has confirmed.',
      parameters: {
        files: {
          type: 'array',
          required: true,
          description: 'Documents to write, at most 20.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              table: {
                type: 'string',
                description: 'Table ref `schema.table`; omit only for the index document.',
              },
              part: {
                type: 'string',
                required: true,
                enum: ['index', 'business', 'schema'],
                description: 'index / business / schema.',
              },
              content: {
                type: 'string',
                required: true,
                description: 'Whole Markdown document, not a patch.',
              },
            },
          },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
      },
      async execute(args, exec) {
        const datasourceId = bindingOf(value, exec)
        if (args.files.length === 0) {
          throw new DbqaError('DBQA_KNOWLEDGE_WRITE', 'dbqa: no files to write')
        }
        if (args.files.length > MAX_FILES) {
          throw new DbqaError('DBQA_KNOWLEDGE_WRITE', `dbqa: at most ${MAX_FILES} files per call`)
        }
        for (const file of args.files) {
          if (file.part !== 'index' && (file.table === undefined || file.table === '')) {
            throw new DbqaError('DBQA_KNOWLEDGE_WRITE', 'dbqa: a table document needs a table reference')
          }
        }
        const results = await value.database.knowledge.write(
          datasourceId,
          args.files.map((file) => ({
            part: file.part,
            ...(file.table === undefined || file.table === '' ? {} : { tableRef: file.table }),
            content: file.content,
          })),
        )
        const wroteIndex = results.some((result) => result.kind === 'index')
        if (wroteIndex) value.database.store.markAnalyzed(datasourceId)
        return {
          files: results.map((result) => ({
            path: result.relPath,
            kind: result.kind,
            status: result.status,
          })),
          analyzedAt: wroteIndex ? Date.now() : null,
        }
      },
    }),
  )
}

/** 注册 `dbqa_check_knowledge_links`。 */
export function registerCheckKnowledgeLinks(ctx: Context, value: DbqaToolService): void {
  ctx.tools.register(
    defineTool({
      name: 'dbqa_check_knowledge_links',
      description:
        'Check every relative Markdown link in the knowledge base of the bound datasource. Table directories are '
        + 'named `<schema>.<table>`, so a link such as `../orders/business.md` resolves inside the panel but breaks '
        + 'in editors and static previews. With `fix` the tool rewrites each abbreviation that matches exactly one '
        + 'table directory and reports what is left; it never guesses when a directory is ambiguous or the target '
        + 'is missing. Run it after writing documents, and run it again after fixing.',
      parameters: {
        fix: {
          type: 'boolean',
          description: 'Rewrite fixable abbreviated links in place. Defaults to false (report only).',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
      },
      async execute(args, exec) {
        const datasourceId = bindingOf(value, exec)
        const startedAt = Date.now()
        try {
          const report = await value.database.knowledge.checkLinks(datasourceId, { fix: args.fix === true })
          const LIMIT = 100
          const problems = report.problems.slice(0, LIMIT).map((problem) => ({
            path: problem.path,
            line: problem.line,
            link: problem.href,
            kind: problem.kind,
            resolved: problem.resolved,
            suggestion: problem.suggestion,
          }))
          const truncated = problems.length < report.problems.length
          recordToolAudit(value, exec, {
            datasourceId,
            toolName: 'dbqa_check_knowledge_links',
            startedAt,
            outcome: 'ok',
            rowCount: report.problems.length,
            truncated,
          })
          const hint =
            report.problems.length === 0
              ? 'All relative links point at documents that exist.'
              : args.fix === true
                ? 'Remaining links could not be fixed automatically: write the missing target document or correct the link by hand.'
                : 'Call again with fix=true to rewrite abbreviated table links; dangling links need the missing document or a manual edit.'
          return {
            documents: report.documents,
            links: report.links,
            problems,
            fixed: report.fixed.map((item) => ({ path: item.path, links: item.links })),
            remaining: report.problems.length,
            truncated,
            hint,
          }
        } catch (error) {
          recordToolAudit(value, exec, {
            datasourceId,
            toolName: 'dbqa_check_knowledge_links',
            startedAt,
            outcome: 'failed',
            errorCode: asDbqaError(error)?.code ?? 'DBQA_INTERNAL',
          })
          throw error
        }
      },
    }),
  )
}

/** 注册分析 / 查询都要用的四件结构工具。 */
export function registerSharedTools(
  ctx: Context,
  value: DbqaToolService,
  which: readonly ('describe' | 'read' | 'write' | 'check')[],
): void {
  if (which.includes('describe')) registerDescribeSchema(ctx, value)
  if (which.includes('read')) registerReadKnowledge(ctx, value)
  if (which.includes('write')) registerWriteKnowledge(ctx, value)
  if (which.includes('check')) registerCheckKnowledgeLinks(ctx, value)
}
