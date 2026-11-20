# AGENTS.md — dsh-db-qa

面向在本仓库里继续开发的 Agent。它只记录本项目特有的约束；DSH 插件的通用规则以官方文档为准（见 §5）。

## 1. 这个插件做什么

`@xirang-ai/dsh-db-qa` 把用户数据库变成模型可问的数据源：

- 宿主侧：登记连接 → 读表结构 → 执行 SQL（权限由数据库账号决定） → 保存问答；元数据落在插件自己的 SQLite 里。
- 客户端侧：一个只读工作台面板（侧栏入口 + `main` 面板），展示连接、缓存结构、查询历史与问答。
- 数据库支持：SQLite、PostgreSQL、MySQL。三者只在适配器层不同，上层共用 `DbAdapter`。

硬边界：只用 DSH 公开扩展点；不修改宿主；产物必须是可以 `dsh plugin --profile <p> add` 的 bundle。

## 2. 版本基线

- dsh `0.2.2-rc.5`，Node `>= 24.9.0`，Cordis 4.1.x，Schemastery 3.19.x。
- `engines.dsh` 决定兼容范围；改它之前先确认目标版本真的存在。
- 版本号只由发版指令变更（见 RELEASE.md）。

## 3. 目录

```text
src/
  index.ts            宿主入口：name / inject / apply
  config.ts           Schemastery 配置
  errors.ts           DbqaError + 上下文错误 + 路径脱敏
  version.ts          从 package.json 读版本
  i18n.ts             宿主侧文案（与 locale/*.json 共用）
  store/              元数据库：schema、迁移、版本对账、事务、CRUD
  db/                 用户数据库：只读连接、三个适配器、执行编排
  tools/              七个模型工具
  remote/             Typert 描述表与面板读模型
  client/             Web 面板（纯 props）
cordis.patch.yml      bundle 层：插件行 + 默认 config
scripts/build.mjs     双构建链：tsc 编宿主，esbuild 打包浏览器
locale/{en,zh}.json   两份字典，键必须对齐
test/                 node:test，直接跑 TypeScript
```

## 4. 硬性规则

### 入口与生命周期

- R1 `src/index.ts` 只导出 `name`、`inject`、`apply`（以及 `Config` 与少量公开类型），不得有顶层副作用。
- R2 打开数据库是副作用，必须放在 `ctx.effect` 里，返回的 disposer 是唯一允许关闭它的入口。
- R3 service 注册在插件自己的 `ctx` 上；`ctx.inject(['typert'], ...)` 用于可选能力，不要让可选依赖进静态 `inject`。
- R4 `inject` 与实现一致：用到什么就声明什么；`typert` 是例外（可选，用 `ctx.get` 探测）。

### 数据层

- R5 元数据库只放在 `$DSH_HOME/xirang-ai/dsh-db-qa`（或 `dataDir`），每个连接 PRAGMA 固定为 WAL / `synchronous=NORMAL` / `foreign_keys=ON` / `busy_timeout`。
- R6 结构变更只能新增迁移：`MIGRATIONS` 追加、`TARGET_SCHEMA_VERSION` 随之增长；已发布的迁移永不修改。
- R7 每个表、每一列都要有中文 `--` 注释，并登记进 `SCHEMA_COMMENTS`；`test/store.test.ts` 会双向校验 `sqlite_master` / `PRAGMA table_info`。
- R8 一次写入要么全成要么全败：多语句写入包 `withTransaction`。
- R9 启动必须做版本对账：新库 `initialized`、同版本 `unchanged`、更高插件版本 `upgraded`、更低版本只告警不降级。

### 用户数据库与安全

- R10 不检查 SQL 文本；能否执行由数据库账号权限决定，适配器只保持只读连接。
- R11 适配器一律以只读身份打开，并保留第二道保险（SQLite `readOnly`、PG `default_transaction_read_only`、MySQL `SET SESSION TRANSACTION READ ONLY`）。
- R12 结果集必须限行并返回 `truncated`；不要把整表结果塞进工具输出。
- R13 凭据落盘口径（已确认的产品取舍）：口令允许以明文存进插件元数据库的 `secret_ref_json`，也支持 `env:VAR`；`config_json` 不含敏感字段；展示一律走 `redactTarget`，日志、工具输出与错误信息里不得出现原始连接串、账号或口令；编辑表单按设计回显已存口令。
- R14 适配器短命：一次调用打开、`finally` 关闭；不要让用户数据库连接长期留在插件里。
- R15 禁止空 `catch`；可以静默降级的点（如旧版 MySQL 没有只读开关）要写清原因。

### 工具

- R16 用 `defineTool`，参数与输出都要有 schema；`execute` 返回一个 JSON 值并尊重 `exec.signal`。
- R17 工具前缀统一 `dbqa_`，一次调用只做一件事；名称/描述要写「什么时候用」。
- R18 失败要么抛带 `code` 的 `DbqaError`，要么让宿主记录；成功与失败都要写查询审计。
- R19 单个工具输出超过几百行时截断并说明原因。

### 客户端

- R20 客户端只在 `dsh.client.inject` 声明的服务上工作；组件是纯 props，不 import `ctx`，不直接开数据库。
- R21 侧栏入口与 `main` 面板必须成对注册：只注册侧栏会在点击时抛 `layout.selectPanel: main panel "<id>" is not registered`。
- R22 所有 UI 文案来自 `locale/*.json`；`en` 与 `zh` 键集合必须一致。
- R23 颜色只用宿主 token（`var(--dsw-alias-*)`），类名前缀 `dbqa-`。
- R24 数据通道走本插件自己的 Remote 命名空间（`dbqa`）；挂载是异步的，面板拿到的是「等待就绪」的 loader，不是半装好的 service。

### 构建与测试

- R25 双构建链产物只进 `lib/`：`tsc` 出宿主 JS + `.d.ts`，esbuild 出 `lib/client.js`（`window.__ModuleLoader__.load`，`id` 等于包名，React 等 external）。
- R26 不要在 `lib/` 里手改代码，也不要提交 `lib/`。
- R27 测试分三层：纯逻辑（目标解析、行数截断）、装配（临时目录打开元数据库、CRUD、版本对账）、真实 profile 冒烟。
- R28 改完代码必须 `pnpm run verify`，然后重建并重启测试 Host 验证。

### 知识库文档

- R29 知识库里的相对链接必须写完整表目录名 `tables/<schema>.<table>/{business,schema}.md`。表目录带库/schema 前缀，裸表名（`tables/<table>/…`）在面板里有后缀兜底、在编辑器里 404，`dbqa_check_knowledge_links` 会判成 `abbreviated`。
- R30 链接的解析、校验与修复只在 `src/knowledge/links.ts` 实现一次：写侧工具与 `src/client/link.ts` 都从这里取，不要在服务层或客户端另写一套。
- R31 写完知识库文档必须跑 `dbqa_check_knowledge_links`；有 `abbreviated` 就带 `fix: true` 再查，直到 `problems` 为空。`dangling`（目标不存在）、`missing-index`、`outside` 不自动改，要报告给人或补文档后再查。

## 5. 官方文档入口

- 工具：`tool.md`
- 配置：`config.md`
- 打包与发布：`publish.md`
- 事件：`events.md`
- 服务：`service.md`
- 客户端槽位：`slots.md`、`packages/client/AGENTS.md`
- CLI：`cli-help`

开发前先读对应章节，不要凭记忆猜 API。

## 6. 开发闭环

```bash
pnpm install
pnpm run verify

dsh --profile dev --from-default-profile web --dump-config > /dev/null
dsh plugin --profile dev add .
dsh --profile dev --port 3091 --no-open
```

注意：

- `dsh --profile <p>` 后面不要再写 app 名，否则报 `too many arguments`。
- 每次启动 profile 会重写 `cordis.yml`；`link:` 安装时 peer 未解析属预期。
- 往 `~/.dsh` 写入需要 `danger-full-access`，或把 `DSH_HOME` 指到工作区内。

## 7. 交付前检查

- [ ] `pnpm run verify` 全绿（typecheck / lint / build / test）
- [ ] `lib/index.js`、`lib/index.d.ts`、`lib/client.js` 都在，且 `lib/client.js` 以 `window.__ModuleLoader__.load` 开头
- [ ] 新表/新列有注释，测试通过
- [ ] 新增配置项进了 `Config` 与 `cordis.patch.yml` 默认值，README 配置表同步
- [ ] 中英文案键对齐
- [ ] 真实 profile 里：工具可见、侧栏入口可点、面板能加载数据
- [ ] 连接串/口令不出现在日志、工具输出或错误信息里（编辑表单按设计回显已存口令）
