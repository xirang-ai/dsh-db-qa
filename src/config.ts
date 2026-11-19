/**
 * 插件配置（Schemastery）。
 *
 * 可调项与《技术设计》§12 对齐；新增项必须同时照顾 `cordis.patch.yml`
 * 默认值与 README 配置表（AGENTS.md R6）。
 *
 * @module
 */
import Schema from '@deepseek-ai/schemastery'

/** 插件配置。 */
export interface Config {
  /** 元数据库与知识库的根目录；空串表示 `$DSH_HOME/xirang-ai/dsh-db-qa`。 */
  dataDir: string
  /** 显式语言；空串表示跟随宿主。 */
  defaultLocale: string
  /** 单次查询默认返回的最大行数。 */
  rowLimit: number
  /** 单条查询的服务端超时（毫秒）。 */
  queryTimeoutMs: number
  /** 一次工具调用的整体上限（毫秒）；连接 + 所有语句都算在里面。 */
  toolTimeoutMs: number
  /** 连接超时（毫秒）；字段未填时使用。 */
  connectTimeoutMs: number
  /** 数据结构分析时每表取样行数上限。 */
  sampleRows: number
  /** 查询审计保留天数。 */
  auditRetentionDays: number
}

/** 配置 schema；宿主用它校验并生成文档。 */
export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string()
    .default('')
    .description('Directory for the db-qa metadata database and knowledge bases. Empty uses $DSH_HOME/xirang-ai/dsh-db-qa.'),
  defaultLocale: Schema.string()
    .default('')
    .description('Explicit UI locale for plugin-owned messages (zh or en); empty follows the Host.'),
  rowLimit: Schema.number()
    .min(1)
    .max(2_000)
    .default(200)
    .description('Maximum rows returned by dbqa_run_query unless the call asks for fewer.'),
  queryTimeoutMs: Schema.number()
    .min(1_000)
    .max(120_000)
    .default(30_000)
    .description('Timeout for one query against a user database, in milliseconds.'),
  toolTimeoutMs: Schema.number()
    .min(1_000)
    .max(600_000)
    .default(120_000)
    .description(
      'Upper bound for one whole tool call against a user database, in milliseconds: connecting, every '
      + 'statement and reading the rows. A call that exceeds it is aborted and the connection is dropped.',
    ),
  connectTimeoutMs: Schema.number()
    .min(1_000)
    .max(120_000)
    .default(10_000)
    .description('Connection timeout used when a datasource does not set its own, in milliseconds.'),
  sampleRows: Schema.number()
    .min(1)
    .max(50)
    .default(5)
    .description('Rows sampled per table by the schema-analysis Agent.'),
  auditRetentionDays: Schema.number()
    .min(1)
    .max(3_650)
    .default(90)
    .description('How many days of query audit rows are kept.'),
})
