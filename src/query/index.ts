/**
 * 查询 Agent 的工具集（只挂在 `dbqa-query` preset 里）。
 *
 * 唯一的查数工具是 `dbqa_run_query`：先过只读闸门，再在短命只读连接上
 * 限行执行，结果与 `truncated` 一起返回。表结构与知识库读写复用分析
 * preset 的同一批实现；查询 preset 不注册 `dbqa_inspect_sql` 与
 * `dbqa_sample_rows`（《技术设计》§9）。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { translateBilingual } from '../i18n.ts'
import { runQuery } from './execute.ts'
import { registerSharedTools, toolService, type DbqaToolService } from '../tools/shared.ts'

export const name = 'dbqa-query-tools'
export const inject = ['tools', 'dbqaQuery'] as const

/** 注册查询工具。 */
export function apply(ctx: Context): void {
  const value: DbqaToolService = toolService(ctx, 'dbqaQuery')

  registerSharedTools(ctx, value, ['describe', 'read', 'write', 'check'])

  ctx.tools.register(
    defineTool({
      name: 'dbqa_run_query',
      description:
        'Run one read-only SQL statement against the datasource bound to this session and return the real rows. '
        + 'This is the only way to obtain data: never answer a data question from the knowledge base alone, and '
        + 'never invent numbers. Only SELECT / WITH / EXPLAIN / SHOW / DESCRIBE / PRAGMA / TABLE are accepted; '
        + 'INSERT / UPDATE / DELETE / DDL are rejected by the read-only gate. Results are capped (default 200 rows); '
        + 'when `truncated` is true, say so in the answer and refine the query instead of pretending the result is '
        + 'complete. On rejection, read the error, fix the SQL, and retry at most twice. The statement runs under a '
        + 'server-side timeout and the whole call under a hard budget: a query that is still running when the budget '
        + 'ends is cancelled and the connection dropped, and the tool returns an error instead of rows. Keep queries '
        + 'cheap (filters, few joins, SQL-side aggregation over small ranges) so they finish well inside that budget.',
      parameters: {
        sql: {
          type: 'string',
          required: true,
          description: 'One read-only SQL statement. No datasource id: the session binding decides the database.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum rows to return (1..plugin rowLimit); defaults to the plugin rowLimit.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
      },
      async execute(args, exec) {
        const result = await runQuery(value, exec, args.sql, args.limit)
        return {
          datasourceId: result.datasourceId,
          sql: result.sql,
          columns: [...result.columns],
          rows: result.rows.map((row) => [...row]),
          rowCount: result.rowCount,
          truncated: result.truncated,
          limit: result.limit,
          durationMs: result.durationMs,
          note: result.truncated
            ? translateBilingual('dbqa.query.truncatedNote', { limit: result.limit })
            : '',
        }
      },
    }),
  )
}
