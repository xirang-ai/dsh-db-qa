# dsh-db-qa

A DeepSeek Harness plugin that answers questions from your databases. It gives the agent a small set of tools (register a connection, read its schema, run read-only SQL, keep the answer) and the Web client a read-only workbench panel: connections on the left, and that connection's cached schema, recent queries, and saved answers on the right.

SQLite, PostgreSQL and MySQL are supported.

## Requirements

| Dependency | Version |
| --- | --- |
| Node.js | ≥ 24.9.0 (`node:sqlite` is built in; no native module to compile) |
| DeepSeek Harness | ≥ 0.2.2-rc.1, < 0.3.0 |
| Database drivers | `pg` and `mysql2` ship with the plugin and load only when that engine is used |

## Install

```bash
dsh plugin --profile web add @xirang-ai/dsh-db-qa
```

Restart the Host after installing, otherwise neither the tools nor the sidebar entry appear. The panel needs the Web client (`dsh web`); in a CLI-only profile the tools still work.

## Quick start

```text
Register /Users/me/app.db as a connection named app with dbqa_add_connection
dbqa_describe_schema connection=app
dbqa_run_query connection=app sql="select status, count(*) from orders group by status"
dbqa_save_answer question="orders per status" answer="..." connection=app
```

## Tools

| Tool | Purpose |
| --- | --- |
| `dbqa_list_connections` | Registered connections (redacted targets), table counts, last five queries |
| `dbqa_add_connection` | Register `name` / `kind` (`sqlite`, `postgres`, `mysql`) / `target` / `description` |
| `dbqa_remove_connection` | Delete a connection and its cached schema; query history survives with a null link |
| `dbqa_describe_schema` | Read every table and view, refresh the cache; optional `table` filter |
| `dbqa_run_query` | Run one read-only statement; rows default to `rowLimit`, capped at 1000 per call |
| `dbqa_save_answer` | Keep a question/answer pair, optionally with the `sql` that produced it |

## Read-only by construction

- Every statement passes a scanner that accepts only `select` / `with` / `explain` / `show` / `describe` / `desc` / `values` / `table`, rejects stacked statements, write keywords, `for update`, and `pg_sleep`-style calls. Keywords inside literals and comments do not trip it.
- The engine enforces it too: SQLite opens with `readOnly: true`, PostgreSQL pools carry `default_transaction_read_only=on`, MySQL runs `SET SESSION TRANSACTION READ ONLY`.
- Results are capped and report `truncated`, so a table never floods the context.
- Timeouts and hard disconnects: every statement has a server-side timeout (PostgreSQL `statement_timeout`, MySQL `max_execution_time` / MariaDB `max_statement_time`), and one whole tool call has a `toolTimeoutMs` budget. When either expires the plugin returns `DBQA_TIMEOUT` first and then drops the connection (destroying the PostgreSQL socket, `destroy()` on MySQL), so a hanging statement cannot pin the tool call or the close. Connection tests are bounded too. SQLite is synchronous and cannot be interrupted; there the read-only open plus `busy_timeout` is what protects you.
- The load discipline on the agent side lives in both preset prompts: cheap queries only (bounded time range plus a selective filter), no full scans or heavy statements, no retrying the same timed-out statement. A timeout is treated as "this query was too heavy", not as a hint to rewrite the same scan.
- Credentials are isolated: a password may be a plaintext value or `env:VARIABLE_NAME` (read at connect time). Either way it lives only in `secret_ref_json`, never in `config_json`; the edit form echoes stored passwords, while labels, results and errors still mask them.

## Data

```text
$DSH_HOME/xirang-ai/dsh-db-qa/db-qa.sqlite
```

Holds data sources, conversations, knowledge file indexes, and query audit. `dataDir` relocates the whole directory. The schema version lives in `PRAGMA user_version`; upgrades only append migrations.

## Configuration

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

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `''` | Metadata directory; empty means `$DSH_HOME/xirang-ai/dsh-db-qa` |
| `rowLimit` | `200` | Default maximum rows per query (1–2000) |
| `defaultLocale` | `''` | Panel language; empty follows the host |
| `queryTimeoutMs` | `30000` | Timeout for one statement (1000–120000 ms); also passed to PostgreSQL `statement_timeout` and MySQL `max_execution_time` |
| `toolTimeoutMs` | `120000` | Upper bound for one whole tool call (1000–600000 ms): connecting, every statement and reading rows; the connection is dropped on expiry |
| `connectTimeoutMs` | `10000` | Default connect/test timeout (1000–120000 ms) |
| `sampleRows` | `5` | Sample rows read per table during analysis (1–50) |
| `auditRetentionDays` | `90` | Days to keep query audit rows (1–3650) |

## Development

```bash
pnpm install
pnpm run verify      # typecheck → lint → build → test
```

Local loop:

```bash
dsh --profile dev --from-default-profile web --dump-config > /dev/null
dsh plugin --profile dev add .
dsh --profile dev --port 3091 --no-open
```

Rebuild and restart the test Host after each change so the browser picks up the new `lib/client.js`.

## License

MIT
