# dsh-db-qa

基于数据库数据回答问题的 DeepSeek Harness 插件。它把「登记连接、读表结构、跑只读 SQL、沉淀问答」做成一小组模型工具，并在 Web 端提供一个只读的工作台面板：左边是已登记的连接，右边是该连接缓存的表结构、最近查询与已保存的回答。

支持 SQLite、PostgreSQL、MySQL 三种数据库。

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | ≥ 24.9.0（使用内置 `node:sqlite`，无需编译原生模块） |
| DeepSeek Harness | ≥ 0.2.2-rc.1，< 0.3.0 |
| 可选的数据库驱动 | `pg`、`mysql2` 已随插件安装；只有用到对应类型时才加载 |

## 安装

```bash
dsh plugin --profile web add @xirang-ai/dsh-db-qa
```

安装后必须重启 Host，模型工具与侧栏入口才会出现。本地面板需要 Web 前端（`dsh web`）；纯 CLI 场景下工具照常可用，只是没有面板。

## 快速开始

1. 让 Agent 登记一个数据库。SQLite 用文件路径，PostgreSQL/MySQL 用连接串（推荐 `env:变量名`）：

   ```text
   用 dbqa_add_connection 登记本地库 /Users/me/app.db，名字叫 app
   ```

   登记时会用一个只读账号真实连通、读取结构并执行只读探针；只有结论为 `pass` / `warn` 才会落库。可写账号会被拒绝，不产生连接，也不会出现在侧栏。

2. 读一次表结构，结果会缓存到插件的元数据库：

   ```text
   dbqa_describe_schema connection=app
   ```

3. 提问或直接跑只读 SQL：

   ```text
   dbqa_run_query connection=app sql="select status, count(*) from orders group by status"
   ```

4. 把结论存下来，下次同一连接可以直接看到：

   ```text
   dbqa_save_answer question="上周各状态订单数" answer="..." connection=app
   ```

## 工具

| 工具 | 作用 |
| --- | --- |
| `dbqa_list_connections` | 列出已登记连接（目标已脱敏）、只读校验结论、表数量、最近 5 条查询 |
| `dbqa_add_connection` | 只读接入：`name` / `kind`（`sqlite`、`postgres`、`mysql`）/ `target` / `description`；连通、读结构、跑探针后才落库 |
| `dbqa_revalidate_connection` | 重新校验既有连接的账号权限；可写时降级为 `reject` 并禁止后续查询/读结构 |
| `dbqa_remove_connection` | 按名称或 id 删除连接及其缓存结构（查询历史保留，连接置空） |
| `dbqa_describe_schema` | 读全库表/视图结构并刷新缓存；可用 `table` 过滤单表 |
| `dbqa_run_query` | 执行一条 SQL（能否写入由数据库账号权限决定）；默认行数取配置 `rowLimit`，单次最多 1000 行 |
| `dbqa_save_answer` | 保存一条问答（可带 `sql` 与 `connection`） |

工具前缀统一为 `dbqa_`，一次调用只做一件事。

## 只读与安全

- 接入与重新校验都先确认账号身份：探针只查权限、不试写。PostgreSQL 检查会话只读、数据库/schema 建表权限、业务表写权限与角色属性；MySQL 检查只读会话开关与 `information_schema` 里的全局/schema/表/列写权限；SQLite 确认以只读方式打开，并检查文件与 WAL 目录的可写性。
- 结论只有三种：`pass`（确认只读）、`warn`（无法完全确认，放行但展示告警原文）、`reject`（发现明确写权限）。SQLite 没有账号级只读，所以通常为 `warn`，写风险由数据库账号权限承担；旧版 MySQL 没有只读会话开关时同样只判 `warn`。
- 面板里的「创建只读账号指引」按 PostgreSQL / MySQL / SQLite 分别给出最小权限建号与授权语句、验证方式和常见坑；账号口令一律用占位符。
- 插件不检查 SQL 文本：能否执行由数据库账号权限决定。连接层仍以只读身份打开（见下条），作为第二道保险。
- 第二道保险在数据库侧：SQLite 以 `readOnly: true` 打开；PostgreSQL 连接池带 `default_transaction_read_only=on`；MySQL 连接后执行 `SET SESSION TRANSACTION READ ONLY`。
- 结果永远带行数上限并标记 `truncated`，避免把整库拉进上下文。
- 超时与断链：每条语句都有服务端超时（PostgreSQL `statement_timeout`，MySQL `max_execution_time` / MariaDB `max_statement_time`），整次工具调用再有 `toolTimeoutMs` 总预算。任一处到期，插件先返回 `DBQA_TIMEOUT`，再强制断链（PostgreSQL 销毁 socket、MySQL `destroy()`），不让挂起的语句把工具调用和连接关闭一起拖住；连接测试同样有上限。SQLite 是同步驱动、无法中断，靠只读打开与 `busy_timeout` 兜底。
- Agent 侧的负载纪律写在两个 preset 的提示词里：只发廉价查询（带时间范围与选择性条件）、不做全表扫描与重查询、不重试同一条超时语句；超时被当作「这条查询太重」的信号，而不是换个写法继续扫。
- 凭据隔离：口令可填 `env:变量名`（连接时读取环境变量），也可直接填明文；两者都只进 `secret_ref_json`、不进 `config_json`；编辑表单会回显已存口令，工具输出与错误信息里的连接串、账号与口令仍然脱敏。

## 数据与文件

元数据库位于：

```text
$DSH_HOME/xirang-ai/dsh-db-qa/db-qa.sqlite
```

其中保存数据源登记、会话、知识库文件索引与查询审计。`dataDir` 可以把整个目录搬到别处。结构版本记录在 `PRAGMA user_version`，升级只追加迁移。

## 配置

```yaml
- id: dbqa
  config:
    dataDir: ''
    defaultLocale: ''
    rowLimit: 200
    queryTimeoutMs: 30000
    toolTimeoutMs: 120000
    connectTimeoutMs: 10000
    sampleRows: 5
    auditRetentionDays: 90
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dataDir` | `''` | 元数据库目录；空串表示 `$DSH_HOME/xirang-ai/dsh-db-qa` |
| `rowLimit` | `200` | 单次查询默认返回的最大行数（1–2000） |
| `defaultLocale` | `''` | 面板默认语言；空串表示跟随宿主 |
| `queryTimeoutMs` | `30000` | 单条语句的超时，毫秒（1000–120000）；同时作为 PostgreSQL `statement_timeout` 与 MySQL `max_execution_time` |
| `toolTimeoutMs` | `120000` | 一次工具调用的整体上限，毫秒（1000–600000）；连接、所有语句与读行都算在里面，超时即断链 |
| `connectTimeoutMs` | `10000` | 建立连接与测试连接的默认超时，毫秒（1000–120000） |
| `sampleRows` | `5` | 结构分析时每张表读取的样例行数（1–50） |
| `auditRetentionDays` | `90` | 查询审计保留天数（1–3650） |

## 开发

```bash
pnpm install
pnpm run verify      # typecheck → lint → build → test
```

本机联调：

```bash
dsh --profile dev --from-default-profile web --dump-config > /dev/null
dsh plugin --profile dev add .
dsh --profile dev --port 3091 --no-open
```

每次改完代码都要重新 `pnpm run build` 并重启测试 Host，浏览器才会拿到新的 `lib/client.js`。

## 许可证

MIT
