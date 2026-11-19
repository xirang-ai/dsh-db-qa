# RELEASE.md — 发版检查清单

版本号只在收到发版指令时变更；日常开发不动 `version`。

## 1. 准备

- [ ] 工作区干净：`git status --short` 无非预期改动
- [ ] `pnpm install` 后 `pnpm run verify` 全绿
- [ ] 确认 `engines.dsh` 与 `peerDependencies` 仍然匹配目标 dsh 版本
- [ ] 新增/变更的配置项已同步：`src/config.ts`、`cordis.patch.yml`、`README.md`、`README.en.md`
- [ ] 新增 UI 文案在 `locale/en.json` 与 `locale/zh.json` 都存在
- [ ] 结构有变更时：迁移是追加的、`TARGET_SCHEMA_VERSION` 已增长、README 的「数据与文件」仍准确

## 2. 升版本

- [ ] 修改 `package.json` 的 `version`（遵循 semver：新工具/新 UI 记 minor，修 bug 记 patch，破坏 bundle 契约记 major）
- [ ] `pnpm run build`，确认 `lib/` 是最新产物
- [ ] 本地真实 Host 冒烟：安装 → 重启 → 工具可见 → 侧栏面板可打开 → 能登记一个 SQLite 库并跑通查询

## 3. 打包检查

```bash
npm pack --dry-run
```

- [ ] 包含 `lib/`、`locale/`、`cordis.patch.yml`、`presets/`、`README.md`、`README.en.md`、`RELEASE.md`、`LICENSE`
- [ ] 不包含 `src/`、`test/`、`node_modules/`、本地 `.sqlite` 文件、`*.tgz`
- [ ] `lib/client.js` 首行是 `window.__ModuleLoader__.load` 包装，且 `id` 等于包名

## 4. 发布

```bash
pnpm publish --access public
```

- [ ] registry 上的 `version` 与 `package.json` 一致
- [ ] 在干净 profile 里安装发布产物并重启：

  ```bash
  dsh plugin --profile verify --from-default-profile web add @xirang-ai/dsh-db-qa@<version>
  dsh --profile verify --port 3092 --no-open
  ```

- [ ] 打 tag 并推送：`git tag v<version> && git push --tags`

## 5. 发布后

- [ ] 在仓库 Releases 里写变更摘要（新增工具、行为变化、配置变化、迁移说明）
- [ ] 若升级涉及元数据库结构：提醒用户先备份 `db-qa.sqlite`
