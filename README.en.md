# dsh-db-qa

Turn your own databases into data sources you can question inside DSH: register a connection in the **Data Q&A** sidebar panel, then ask in natural language while the model reads schema, the knowledge base and real rows through `dbqa_` tools.

- Databases: SQLite, PostgreSQL and MySQL, always opened read-only.
- Two agent presets: **Data Query** (`dbqa-query`, answers questions) and **Data Analysis** (`dbqa-analysis`, builds and maintains the knowledge base).
- Metadata, question index and knowledge bases live in the plugin's own directory; your databases are never modified.

## Requirements

- dsh `>=0.2.2-rc.5 <0.3.0`; the bundle ships a host patch, so restart after installing.
- Node.js `>=24.9.0` (uses the built-in `node:sqlite`).

## Install

```bash
dsh plugin add @xirang-ai/dsh-db-qa
dsh web
```

After a restart **Data Q&A** appears in the sidebar, and the panel title shows the installed plugin version.

## Quick start

1. **Data Q&A** → **Datasources** → **Add datasource**, pick a type and fill in the connection details.
2. Click **Test connection**: on success it shows the server version, latency and "read-only confirmed". A test is not required to save, but it is recommended; if you save the same configuration you just tested, the result is stored with it.
3. Back in **Questions**, click **Create query**, then pick **Data Query** and a data source in the session header.
4. Just ask, for example "how many orders per status last month". The model first reads schema and knowledge with `dbqa_describe_schema` / `dbqa_read_knowledge`, then fetches real rows with `dbqa_run_query`.
5. A session appears in the question list only after your first real question; you can then favorite it or open it again.

To build a knowledge base, click **Rebuild structure analysis** on a data source row and confirm. A **Data Analysis** session starts, the model reads schema, DDL and a few sample rows, and writes `index.md` plus one document set per table. Query sessions read the knowledge base first.

## The panel

**Datasources**: list and counters (data sources / healthy / need attention). Each row offers **Test connection**, **Rebuild structure analysis**, **Knowledge**, **Edit** and **Delete**. The database type cannot be changed after creation.

**Questions**: only query sessions that actually asked something, ordered by the host session's last update; the **Favorites** tab shows favorites only. Without any data source the panel asks you to add one instead of starting a query.

**Session**: the header band picks the agent and the data source; tools resolve the data source from the current binding on every turn.

**Knowledge base**: `index.md` and table documents per data source, switchable between **Rendered** and **Code**.

## Model tools

Every tool resolves the data source from the **current session binding** and takes no `datasourceId`; each call opens a short-lived read-only connection and closes it afterwards.

| Tool | Preset | What it does and its parameters |
| --- | --- | --- |
| `dbqa_describe_schema` | both | Paged table structure: `tables?`, `schema?`, `offset?`, `limit?` (1–200, default 25). Returns DDL, columns, indexes, foreign keys and comments; `nextOffset` is `null` when done. |
| `dbqa_sample_rows` | analysis only | Sampling: `table`, `limit?` (1–10, default `sampleRows`). |
| `dbqa_inspect_sql` | analysis only | Structure queries: `sql`, `limit?` (1–200, default 50). Meant for `SHOW CREATE TABLE`, `PRAGMA`, `pg_catalog`; it does **not** go through the read-only gate, so the account decides what runs. |
| `dbqa_read_knowledge` | both | Read the knowledge base: `table?`, `part?` (`business` / `schema` / `both`). |
| `dbqa_write_knowledge` | both | Write the knowledge base: `files[]` of `{ table?, part, content }`, at most 20 files; each file is replaced whole and there is no rollback. Write table documents first and `index.md` last; the index must link to every document. |
| `dbqa_check_knowledge_links` | both | Check links: `fix?` (default `false`). Validates every relative link against the real directories on disk; with `fix: true` it rewrites table links that omit the database/schema prefix to the full `tables/<schema>.<table>/…` name, then reports which documents changed and what remains. Missing or ambiguous targets are reported, never guessed. |
| `dbqa_run_query` | query only | Fetch data: `sql`, `limit?` (1..`rowLimit`). Runs through the read-only gate, then returns `columns` / `rows` / `rowCount` / `truncated` / `durationMs`. |

## Read-only and safety

SQL from **Data Query** goes through the read-only gate before it reaches the database:

- Exactly one statement; the first keyword must be `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `DESCRIBE`, `DESC`, `PRAGMA` or `TABLE`.
- Any write keyword (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `VACUUM`, and friends) is rejected; the same words inside comments or string literals are ignored first.
- `PRAGMA` is limited to a read-only whitelist: `table_info`, `table_xinfo`, `index_list`, `index_info`, `foreign_key_list`, `database_list`, `compile_options`.
- `FOR UPDATE`, `LOCK IN SHARE MODE`, `INTO OUTFILE`, `SELECT … INTO`, and PostgreSQL's `set_config` / `pg_terminate_backend` / `pg_cancel_backend` are rejected.

`dbqa_inspect_sql`, used by **Data Analysis**, deliberately skips the gate because it must run `PRAGMA` and `SHOW CREATE TABLE`. Its boundary is the account's permissions and the read-only connection, so do not let the model write data in analysis sessions.

Connections are opened read-only with a second line of defence: SQLite `readOnly` + `query_only`, PostgreSQL `default_transaction_read_only=on`, MySQL `SET SESSION TRANSACTION READ ONLY`.

Result sets are capped and report `truncated`; `dbqa_run_query` returns at most `rowLimit` (200) rows by default. A statement is bounded by `queryTimeoutMs` and the whole call by the `toolTimeoutMs` hard budget; on timeout the call is cancelled and the connection dropped. SQLite's API is synchronous and has no interruptible statement handle, so a long query can only finish on its own; `busy_timeout` only bounds lock waits.

Credential policy (a deliberate trade-off): a password may be stored in plaintext in the plugin's `secret_ref_json`, or as `env:VAR` read from the process environment; `config_json` never contains sensitive fields. Connection strings, accounts and passwords are redacted from logs, tool output and errors; the edit form echoes stored passwords by design.

Every tool call, successful or not, writes a query-audit row, kept for `auditRetentionDays` days.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `''` | Root for the metadata database and knowledge bases; empty means `$DSH_HOME/xirang-ai/dsh-db-qa`. |
| `defaultLocale` | `''` | Explicit UI locale (`zh` / `en`); empty follows the host. |
| `rowLimit` | `200` | Default row cap for `dbqa_run_query` (1–2000). |
| `queryTimeoutMs` | `30000` | Server-side timeout for one query (1000–120000). |
| `toolTimeoutMs` | `120000` | Upper bound for a whole tool call, connecting and reading rows included (1000–600000). |
| `connectTimeoutMs` | `10000` | Connection timeout used when a data source does not set its own (1000–120000). |
| `sampleRows` | `5` | Rows sampled per table by the analysis agent (1–50). |
| `auditRetentionDays` | `90` | Days of query-audit rows to keep (1–3650). |

Set these under `config` on the `- id: dbqa` row in the profile's `cordis.yml`; the bundle defaults live in `cordis.patch.yml`.

## Data and files

By default everything lives under `$DSH_HOME/xirang-ai/dsh-db-qa/`:

```text
db-qa.sqlite                         metadata database (WAL)
knowledge/<datasource-id>/index.md
knowledge/<datasource-id>/tables/<schema.table>/business.md
knowledge/<datasource-id>/tables/<schema.table>/schema.md
```

The metadata database records its schema version in `PRAGMA user_version`; upgrades run the new migrations and never downgrade. Back up `db-qa.sqlite` before upgrading. If the stored schema is newer than the plugin, it is opened read-only with a warning.

## Development

```bash
pnpm install
pnpm run verify          # typecheck + lint + build + test

DSH_HOME=$PWD/.devhome dsh --profile dev --from-default-profile web --dump-config > /dev/null
DSH_HOME=$PWD/.devhome dsh plugin --profile dev add .
DSH_HOME=$PWD/.devhome dsh --profile dev --port 3091 --no-open
```

Tests come in three layers: pure logic (the gate, field parsing, row capping), assembly (a metadata database in a temp directory, migrations, CRUD, the remote service), and a real-profile smoke test. See [RELEASE.md](RELEASE.md) for the release checklist.

## Known limits

- SQLite, PostgreSQL and MySQL only; there are no write tools and none are planned.
- The read-only gate is lexical protection; the database account still has the final say. Use a read-only account for production.
- One knowledge base per data source; table documents are replaced whole, with no history or rollback.
- The panel is a single-user workbench with no permission model; treat plaintext passwords in the metadata database as local secrets.

## License

MIT
