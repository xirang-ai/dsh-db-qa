/**
 * 数据结构分析 Agent 的工具集（只挂在 `dbqa-analysis` preset 里）。
 *
 * 表结构、知识库读写与链接检查四件工具与查询 preset 共用；分析额外拥有
 * `dbqa_inspect_sql` 与 `dbqa_sample_rows`，查询 preset 不注册它们。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { clampLimit, parseTableRef, tableRefKey } from '../db/session.ts'
import { asDbqaError } from '../errors.ts'
import {
  bindingOf,
  openDbCall,
  recordToolAudit,
  registerSharedTools,
  toolService,
  type DbqaToolService,
} from '../tools/shared.ts'

export const name = 'dbqa-analysis-tools'
export const inject = ['tools', 'dbqaAnalysis'] as const

/** 注册分析工具。 */
export function apply(ctx: Context): void {
  const value: DbqaToolService = toolService(ctx, 'dbqaAnalysis')

  registerSharedTools(ctx, value, ['describe', 'read', 'write', 'check'])

  ctx.tools.register(
    defineTool({
      name: 'dbqa_inspect_sql',
      description:
        'Run one SQL statement against the bound datasource when the schema tools are not enough. The account '
        + 'and connection decide what is allowed; the plugin does not filter SQL text. Typical use: '
        + '`SHOW CREATE TABLE schema.table` on MySQL, `PRAGMA table_info(...)` on SQLite, or a pg_catalog query on '
        + 'PostgreSQL. Results are capped, and the call is bounded: a statement that outlives the timeout is '
        + 'cancelled and the connection dropped, so keep statements small. '
        + 'Prefer dbqa_describe_schema for bulk structure.',
      parameters: {
        sql: {
          type: 'string',
          required: true,
          description: 'One SQL statement to execute.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum rows to return (1-200); defaults to 50.',
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
            const limit = clampLimit(args.limit, 50, 200)
            const result = await call.query(args.sql, limit)
            rowCount = result.rowCount
            recordToolAudit(value, exec, {
              datasourceId,
              toolName: 'dbqa_inspect_sql',
              startedAt,
              outcome: 'ok',
              rowCount,
              truncated: result.truncated,
              sqlText: args.sql,
            })
            return {
              columns: [...result.columns],
              rows: result.rows.map((row) => [...row]),
              rowCount: result.rowCount,
              truncated: result.truncated,
              durationMs: result.durationMs,
            }
          } finally {
            await call.close()
          }
        } catch (error) {
          recordToolAudit(value, exec, {
            datasourceId,
            toolName: 'dbqa_inspect_sql',
            startedAt,
            outcome: 'failed',
            errorCode: asDbqaError(error)?.code ?? 'DBQA_QUERY_FAILED',
            rowCount,
            sqlText: args.sql,
          })
          throw error
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dbqa_sample_rows',
      description:
        'Read a few sample rows from one table of the bound datasource. Use it to understand value formats and '
        + 'business meaning; never copy whole rows into the knowledge documents. Read-only, hard-capped at 10 rows.',
      parameters: {
        table: {
          type: 'string',
          required: true,
          description: 'Table ref `schema.table` (or a bare table name when the schema is unambiguous).',
        },
        limit: {
          type: 'integer',
          description: 'Rows to read (1-10); defaults to the plugin sampleRows setting.',
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
          const call = await openDbCall(value, datasourceId, exec.signal)
          try {
            const tables = await call.listTables()
            const requested = args.table
            const found = tables.find(
              (table) => tableRefKey(table.ref) === requested || table.ref.table === requested,
            )
            const ref = found?.ref ?? parseTableRef(requested, tables[0]?.ref.schema ?? 'main')
            const limit = clampLimit(args.limit, value.config.sampleRows, 10)
            const result = await call.sampleRows(ref, limit)
            recordToolAudit(value, exec, {
              datasourceId,
              toolName: 'dbqa_sample_rows',
              startedAt,
              outcome: 'ok',
              rowCount: result.rowCount,
              truncated: result.truncated,
            })
            return {
              table: tableRefKey(ref),
              columns: [...result.columns],
              rows: result.rows.map((row) => [...row]),
              rowCount: result.rowCount,
              truncated: result.truncated,
              durationMs: result.durationMs,
            }
          } finally {
            await call.close()
          }
        } catch (error) {
          recordToolAudit(value, exec, {
            datasourceId,
            toolName: 'dbqa_sample_rows',
            startedAt,
            outcome: 'failed',
            errorCode: asDbqaError(error)?.code ?? 'DBQA_QUERY_FAILED',
          })
          throw error
        }
      },
    }),
  )
}
