# dsh-db-qa

把用户自己的数据库变成 DSH 里可以提问的数据源：在侧栏「数据问答」登记连接，在会话里用自然语言提问，模型通过 `dbqa_` 工具读表结构、知识库与真实数据后作答。

- 数据库：SQLite、PostgreSQL、MySQL，一律只读接入。
- 两个 Agent preset：**查询回答**（`dbqa-query`，查数作答）与**数据结构分析**（`dbqa-analysis`，生成/维护知识库）。
- 元数据、问答索引与知识库都放在插件自己的目录，不改用户的库。

## 环境要求

- dsh `>=0.2.2-rc.5 <0.3.0`；bundle 带宿主 patch，安装后重启生效。
- Node.js `>=24.9.0`（依赖内置 `node:sqlite`）。

## 安装

```bash
dsh plugin add @xirang-ai/dsh-db-qa
dsh web
```

重启后侧栏出现「数据问答」，面板标题右侧显示当前插件版本。

## 快速开始

1. 「数据问答」→「数据源」→「新增数据源」，选类型并填连接信息。
2. 点「测试连接」：成功时显示数据库版本、耗时与「只读已确认」。测试不是保存的前置条件，但建议先测；保存的若是刚测过的同一份配置，结果会一起落库。
3. 回「问答列表」，点「创建查询」；在会话顶部选 **查询回答** 与数据源。
4. 直接提问，例如「上个月各状态的订单数」。模型会先用 `dbqa_describe_schema` / `dbqa_read_knowledge` 了解库，再用 `dbqa_run_query` 取真实数据。
5. 第一条真人提问才会把会话写进问答列表；之后可以收藏、再次打开。

要生成知识库：在数据源行点「重构数据结构分析」，确认后起一个 **数据结构分析** 会话。模型读取表结构、DDL 与少量样本，写入 `index.md` 与每张表的文档；之后的查询会话会先读知识库。

## 面板

**数据源**：列表、统计（数据源 / 连接正常 / 需要处理），每行有「测试连接」「重构数据结构分析」「知识库」「编辑」「删除」。类型创建后不可改。

**问答列表**：只列真正提过问的查询会话，按宿主会话的最后更新时间排序；「收藏」页签只看收藏。没有数据源时不引导创建查询，先添加数据源。

**会话**：顶部条带选 Agent 与数据源；工具按当前绑定解析数据源，每轮都生效。

**知识库**：按数据源展示 `index.md` 与表文档，可切「渲染 / 代码」两种视图。

## 模型工具

工具都从**当前会话绑定**解析数据源，不接受 `datasourceId` 参数；每次调用开一条短命只读连接，结束后关闭。

| 工具 | 可用 preset | 作用与参数 |
| --- | --- | --- |
| `dbqa_describe_schema` | 两者 | 表结构分页：`tables?`、`schema?`、`offset?`、`limit?`（1–200，默认 25）。返回 DDL、列、索引、外键与注释；`nextOffset` 为 `null` 表示读完。 |
| `dbqa_sample_rows` | 仅分析 | 取样：`table`、`limit?`（1–10，默认 `sampleRows`）。 |
| `dbqa_inspect_sql` | 仅分析 | 结构查询：`sql`、`limit?`（1–200，默认 50）。用于 `SHOW CREATE TABLE`、`PRAGMA`、`pg_catalog`；不过只读闸门，能否执行由账号权限决定。 |
| `dbqa_read_knowledge` | 两者 | 读知识库：`table?`、`part?`（`business` / `schema` / `both`）。 |
| `dbqa_write_knowledge` | 两者 | 写知识库：`files[]`，每份 `{ table?, part, content }`，最多 20 份；整篇替换、不回滚。先写表文档，最后写 `index.md`，索引必须链到每份文档。 |
| `dbqa_run_query` | 仅查询 | 查数：`sql`、`limit?`（1..`rowLimit`）。先过只读闸门再限行执行，返回 `columns` / `rows` / `rowCount` / `truncated` / `durationMs`。 |

## 只读与安全

**查询回答**的 SQL 先过只读闸门，再交给数据库：

- 只允许单条语句；首关键字必须是 `SELECT`、`WITH`、`EXPLAIN`、`SHOW`、`DESCRIBE`、`DESC`、`PRAGMA` 或 `TABLE`。
- 出现写关键字（`INSERT`、`UPDATE`、`DELETE`、`MERGE`、`CREATE`、`ALTER`、`DROP`、`TRUNCATE`、`GRANT`、`VACUUM` 等）就拒绝；注释与字符串字面量里的同名词会先被忽略。
- `PRAGMA` 只放行只读白名单：`table_info`、`table_xinfo`、`index_list`、`index_info`、`foreign_key_list`、`database_list`、`compile_options`。
- 拒绝 `FOR UPDATE`、`LOCK IN SHARE MODE`、`INTO OUTFILE`、`SELECT … INTO`，以及 PostgreSQL 的 `set_config` / `pg_terminate_backend` / `pg_cancel_backend`。

**结构分析**用的 `dbqa_inspect_sql` 不过闸门——它要跑 `PRAGMA`、`SHOW CREATE TABLE` 这类语句。这个工具的边界是账号权限与只读连接，不要在分析会话里让模型写数据。

连接一律以只读身份打开，并留第二道保险：SQLite `readOnly` + `query_only`、PostgreSQL `default_transaction_read_only=on`、MySQL `SET SESSION TRANSACTION READ ONLY`。

结果集限行并返回 `truncated`；`dbqa_run_query` 默认最多 `rowLimit`（200）行。语句受 `queryTimeoutMs` 超时、整次调用受 `toolTimeoutMs` 硬预算约束，超时会取消并断开连接。SQLite 是同步 API，没有可中断的语句句柄，长查询只能等它结束；`busy_timeout` 只限制等锁。

凭据策略（产品取舍）：口令可以明文存进插件元数据库的 `secret_ref_json`，也可以写 `env:VAR` 从进程环境读取；`config_json` 不含敏感字段。连接串、账号与口令在日志、工具输出和错误里都会脱敏；编辑表单按设计回显已存口令。

每次工具调用（成功与失败）都写查询审计，保留 `auditRetentionDays` 天。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `''` | 元数据库与知识库根目录；空串用 `$DSH_HOME/xirang-ai/dsh-db-qa`。 |
| `defaultLocale` | `''` | 显式 UI 语言（`zh` / `en`）；空串跟随宿主。 |
| `rowLimit` | `200` | `dbqa_run_query` 默认返回行数上限（1–2000）。 |
| `queryTimeoutMs` | `30000` | 单条查询的服务端超时（1000–120000）。 |
| `toolTimeoutMs` | `120000` | 一次工具调用的整体上限，含连接与读行（1000–600000）。 |
| `connectTimeoutMs` | `10000` | 数据源未单独设置时的连接超时（1000–120000）。 |
| `sampleRows` | `5` | 结构分析每表取样行数（1–50）。 |
| `auditRetentionDays` | `90` | 查询审计保留天数（1–3650）。 |

配置写在 profile 的 `cordis.yml` 里 `- id: dbqa` 那一行的 `config` 下；bundle 的默认值见 `cordis.patch.yml`。

## 数据与文件

默认都在 `$DSH_HOME/xirang-ai/dsh-db-qa/`：

```text
db-qa.sqlite                         元数据库（WAL）
knowledge/<datasource-id>/index.md
knowledge/<datasource-id>/tables/<schema.table>/business.md
knowledge/<datasource-id>/tables/<schema.table>/schema.md
```

元数据库用 `PRAGMA user_version` 记结构版本；插件升级时自动执行新增迁移，不回退。升级前建议备份 `db-qa.sqlite`。库里的结构版本高于插件时，会以只读方式打开并告警。

## 开发

```bash
pnpm install
pnpm run verify          # typecheck + lint + build + test

DSH_HOME=$PWD/.devhome dsh --profile dev --from-default-profile web --dump-config > /dev/null
DSH_HOME=$PWD/.devhome dsh plugin --profile dev add .
DSH_HOME=$PWD/.devhome dsh --profile dev --port 3091 --no-open
```

测试分三层：纯逻辑（闸门、字段解析、行数截断）、装配（临时目录里的元数据库、迁移、CRUD、Remote 服务）、真实 profile 冒烟。发版流程见 [RELEASE.md](RELEASE.md)。

## 已知边界

- 只支持 SQLite / PostgreSQL / MySQL；没有写操作工具，也不打算提供。
- 只读闸门是词法级防护，最终权限仍由数据库账号决定；生产库建议用只读账号接入。
- 一个数据源一份知识库；表文档整篇替换，没有版本历史与回滚。
- 面板是单用户工作台，不含权限模型；元数据库里的明文口令请按本机机密对待。

## License

MIT
