/**
 * 元数据库结构：DDL、数据字典与迁移表。
 *
 * 规则（AGENTS.md R6/R7）：
 * - 结构变更只追加迁移，已发布的迁移永不修改；
 * - 每张表、每一列都有中文 `--` 注释，并登记进 {@link SCHEMA_COMMENTS}；
 * - `test/store.test.ts` 会拿 `sqlite_master` 与 `PRAGMA table_info` 双向校验。
 *
 * 重建版从 `user_version = 1` 起算，与旧实现的版本号无关。
 *
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一条结构迁移。 */
export interface Migration {
  readonly version: number
  readonly description: string
  up(db: DatabaseSync): void
}

/** 数据字典条目；`column` 为空串表示表本身。 */
export interface SchemaComment {
  readonly table: string
  readonly column: string
  readonly description: string
}

/** 建表语句：顺序固定，迁移与测试都读它。 */
export const SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS dbqa_datasource ( -- 数据源：一条记录对应一个可查询的只读数据库
    id                 TEXT    PRIMARY KEY,                    -- 数据源主键：ds_ + ULID
    name               TEXT    NOT NULL UNIQUE,                -- 展示名，用户可改，全局唯一
    db_type            TEXT    NOT NULL CHECK (db_type IN ('mysql', 'postgresql', 'sqlite')), -- 数据库类型
    server_version     TEXT,                                   -- 最近一次测试连接探测到的原始版本串；未探测为 NULL
    server_version_num INTEGER,                                -- 归一化版本号（major*10000+minor*100+patch），供字段置灰
    config_json        TEXT    NOT NULL,                       -- 非敏感连接字段的 JSON，键名与字段定义一致
    secret_ref_json    TEXT    NOT NULL DEFAULT '{}',          -- 敏感字段的引用：env:VAR 或明文口令（明文为本插件已确认的取舍）
    knowledge_dir      TEXT    NOT NULL,                       -- 知识库子目录名（相对 dataDir），创建后不变
    last_tested_at     INTEGER,                                -- 最近一次测试连接时间（epoch ms）
    last_test_ok       INTEGER,                                -- 1 成功 / 0 失败 / NULL 从未测试
    last_test_error_code TEXT,                                 -- 最近一次失败的错误码，不含连接串
    analyzed_at        INTEGER,                                -- 最近一次数据结构分析落地的时间（epoch ms）
    created_at         INTEGER NOT NULL,                       -- 创建时间（epoch ms）
    updated_at         INTEGER NOT NULL                        -- 最后修改时间（epoch ms）
  )`,
  `CREATE TABLE IF NOT EXISTS dbqa_conversation ( -- 问题 / 会话索引：插件会话列表与数据源绑定的唯一来源
    id             TEXT    PRIMARY KEY,                        -- 会话索引主键：cv_ + ULID
    session_id     TEXT    NOT NULL UNIQUE,                    -- 宿主 DSH 会话 id，用于跳转
    title          TEXT    NOT NULL,                           -- 问题标题，取首条用户提问的前 60 字
    datasource_id  TEXT    REFERENCES dbqa_datasource(id) ON DELETE SET NULL, -- 用户在下拉里选定的数据源；未选为 NULL
    agent_kind     TEXT    NOT NULL CHECK (agent_kind IN ('query', 'analysis')), -- 会话类型：查询 / 分析
    is_favorite    INTEGER NOT NULL DEFAULT 0,                 -- 0 未收藏 / 1 已收藏
    favorited_at   INTEGER,                                    -- 收藏时间（epoch ms）；取消收藏置 NULL
    last_active_at INTEGER NOT NULL,                           -- 索引行建立时间（epoch ms）；列表排序以宿主会话时间为准，这里只保证分页稳定
    created_at     INTEGER NOT NULL                            -- 创建时间（epoch ms）
  )`,
  `CREATE TABLE IF NOT EXISTS dbqa_knowledge_file ( -- 知识库索引：只记录 hash / size，不存正文，也不充当文件清单
    datasource_id TEXT    NOT NULL REFERENCES dbqa_datasource(id) ON DELETE CASCADE, -- 所属数据源
    rel_path      TEXT    NOT NULL,                            -- 相对 dataDir 的文件路径
    kind          TEXT    NOT NULL CHECK (kind IN ('index', 'table_business', 'table_schema')), -- index / table_business / table_schema
    table_ref     TEXT,                                        -- 表引用 schema.table；index 文档为 NULL
    content_hash  TEXT    NOT NULL,                            -- 文件内容 sha256，仅用于判断是否被改过
    size_bytes    INTEGER NOT NULL,                            -- 文件字节数
    updated_at    INTEGER NOT NULL,                            -- 索引行更新时间（epoch ms，不是文件 mtime）
    PRIMARY KEY (datasource_id, rel_path)                      -- 一个数据源下一个文件一行
  )`,
  `CREATE TABLE IF NOT EXISTS dbqa_query_audit ( -- 查询审计：成功、拒绝、失败都写一行
    id            TEXT    PRIMARY KEY,                         -- 审计主键：au_ + ULID
    datasource_id TEXT,                                        -- 数据源；删除后保留原值，不级联
    session_id    TEXT,                                        -- 宿主会话 id
    tool_name     TEXT    NOT NULL,                            -- 工具名，如 dbqa_run_query
    sql_text      TEXT,                                        -- 实际执行的 SQL（已脱敏，不含凭据）
    outcome       TEXT    NOT NULL CHECK (outcome IN ('ok', 'rejected', 'failed')), -- 执行结果分类
    error_code    TEXT,                                        -- 失败或拒绝时的错误码
    row_count     INTEGER,                                     -- 返回行数
    truncated     INTEGER NOT NULL DEFAULT 0,                  -- 是否被限行截断
    duration_ms   INTEGER NOT NULL,                            -- 耗时（毫秒）
    created_at    INTEGER NOT NULL                             -- 写入时间（epoch ms）
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_last_active ON dbqa_conversation (last_active_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_favorite ON dbqa_conversation (is_favorite, favorited_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_file_ds_kind ON dbqa_knowledge_file (datasource_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_query_audit_created ON dbqa_query_audit (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_query_audit_ds ON dbqa_query_audit (datasource_id, created_at DESC)`,
])

/** 结构迁移：v1 是重建版的起点。 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    description: '重建版初始结构：数据源 / 会话 / 知识库索引 / 查询审计',
    up(db: DatabaseSync): void {
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
    },
  }),
  Object.freeze({
    version: 2,
    description: '会话行区分「选了数据源」与「用户已开始提问」：新增 started_at，旧行按创建时间回填',
    up(db: DatabaseSync): void {
      db.exec('ALTER TABLE dbqa_conversation ADD COLUMN started_at INTEGER')
      // 旧行都产生于「选数据源即入列表」的语义，回填后保持原来的可见性。
      db.exec('UPDATE dbqa_conversation SET started_at = created_at WHERE started_at IS NULL')
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_started ON dbqa_conversation (started_at DESC)')
    },
  }),
])

/** 当前构建期望的结构版本。 */
export const TARGET_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0

/** 数据字典：表与列的说明（测试会与 `sqlite_master` 双向校验）。 */
export const SCHEMA_COMMENTS: readonly SchemaComment[] = Object.freeze([
  { table: 'dbqa_datasource', column: '', description: '数据源：一条记录对应一个可查询的只读数据库' },
  { table: 'dbqa_datasource', column: 'id', description: '数据源主键：ds_ + ULID' },
  { table: 'dbqa_datasource', column: 'name', description: '展示名，用户可改，全局唯一' },
  { table: 'dbqa_datasource', column: 'db_type', description: '数据库类型：mysql / postgresql / sqlite' },
  { table: 'dbqa_datasource', column: 'server_version', description: '最近一次测试连接探测到的原始版本串；未探测为 NULL' },
  { table: 'dbqa_datasource', column: 'server_version_num', description: '归一化版本号（major*10000+minor*100+patch），供字段置灰' },
  { table: 'dbqa_datasource', column: 'config_json', description: '非敏感连接字段的 JSON，键名与字段定义一致' },
  { table: 'dbqa_datasource', column: 'secret_ref_json', description: '敏感字段的引用：env:VAR 或明文口令（明文为本插件已确认的取舍）' },
  { table: 'dbqa_datasource', column: 'knowledge_dir', description: '知识库子目录名（相对 dataDir），创建后不变' },
  { table: 'dbqa_datasource', column: 'last_tested_at', description: '最近一次测试连接时间（epoch ms）' },
  { table: 'dbqa_datasource', column: 'last_test_ok', description: '1 成功 / 0 失败 / NULL 从未测试' },
  { table: 'dbqa_datasource', column: 'last_test_error_code', description: '最近一次失败的错误码，不含连接串' },
  { table: 'dbqa_datasource', column: 'analyzed_at', description: '最近一次数据结构分析落地的时间（epoch ms）' },
  { table: 'dbqa_datasource', column: 'created_at', description: '创建时间（epoch ms）' },
  { table: 'dbqa_datasource', column: 'updated_at', description: '最后修改时间（epoch ms）' },

  { table: 'dbqa_conversation', column: '', description: '问题 / 会话索引：插件会话列表与数据源绑定的唯一来源' },
  { table: 'dbqa_conversation', column: 'id', description: '会话索引主键：cv_ + ULID' },
  { table: 'dbqa_conversation', column: 'session_id', description: '宿主 DSH 会话 id，用于跳转' },
  { table: 'dbqa_conversation', column: 'title', description: '问题标题，取首条用户提问的前 60 字' },
  { table: 'dbqa_conversation', column: 'datasource_id', description: '用户在下拉里选定的数据源；未选为 NULL' },
  { table: 'dbqa_conversation', column: 'agent_kind', description: '会话类型：query / analysis' },
  { table: 'dbqa_conversation', column: 'is_favorite', description: '0 未收藏 / 1 已收藏' },
  { table: 'dbqa_conversation', column: 'favorited_at', description: '收藏时间（epoch ms）；取消收藏置 NULL' },
  { table: 'dbqa_conversation', column: 'last_active_at', description: '索引行建立时间（epoch ms）；列表排序以宿主会话时间为准，这里只保证分页稳定' },
  { table: 'dbqa_conversation', column: 'created_at', description: '创建时间（epoch ms）' },
  { table: 'dbqa_conversation', column: 'started_at', description: '首条用户提问时间（epoch ms）；NULL 表示只选了数据源、还没开始对话，不进问题列表' },

  { table: 'dbqa_knowledge_file', column: '', description: '知识库索引：只记录 hash / size，不存正文，也不充当文件清单' },
  { table: 'dbqa_knowledge_file', column: 'datasource_id', description: '所属数据源' },
  { table: 'dbqa_knowledge_file', column: 'rel_path', description: '相对 dataDir 的文件路径' },
  { table: 'dbqa_knowledge_file', column: 'kind', description: 'index / table_business / table_schema' },
  { table: 'dbqa_knowledge_file', column: 'table_ref', description: '表引用 schema.table；index 文档为 NULL' },
  { table: 'dbqa_knowledge_file', column: 'content_hash', description: '文件内容 sha256，仅用于判断是否被改过' },
  { table: 'dbqa_knowledge_file', column: 'size_bytes', description: '文件字节数' },
  { table: 'dbqa_knowledge_file', column: 'updated_at', description: '索引行更新时间（epoch ms，不是文件 mtime）' },

  { table: 'dbqa_query_audit', column: '', description: '查询审计：成功、拒绝、失败都写一行' },
  { table: 'dbqa_query_audit', column: 'id', description: '审计主键：au_ + ULID' },
  { table: 'dbqa_query_audit', column: 'datasource_id', description: '数据源；删除后保留原值，不级联' },
  { table: 'dbqa_query_audit', column: 'session_id', description: '宿主会话 id' },
  { table: 'dbqa_query_audit', column: 'tool_name', description: '工具名，如 dbqa_run_query' },
  { table: 'dbqa_query_audit', column: 'sql_text', description: '实际执行的 SQL（已脱敏，不含凭据）' },
  { table: 'dbqa_query_audit', column: 'outcome', description: '执行结果分类：ok / rejected / failed' },
  { table: 'dbqa_query_audit', column: 'error_code', description: '失败或拒绝时的错误码' },
  { table: 'dbqa_query_audit', column: 'row_count', description: '返回行数' },
  { table: 'dbqa_query_audit', column: 'truncated', description: '是否被限行截断' },
  { table: 'dbqa_query_audit', column: 'duration_ms', description: '耗时（毫秒）' },
  { table: 'dbqa_query_audit', column: 'created_at', description: '写入时间（epoch ms）' },
])
