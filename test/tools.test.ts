/**
 * preset 工具的装配：注册了哪些工具、只读闸门与限行在工具层是否生效、
 * 成功与失败是否都写查询审计。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { apply as applyAnalysis } from '../src/analysis/index.ts'
import type { Config as DbqaConfig } from '../src/config.ts'
import { DbqaError } from '../src/errors.ts'
import { apply as applyQuery } from '../src/query/index.ts'
import { openDbqaDatabase } from '../src/store/db.ts'

const SESSION = 'session-tools'
const CONFIG: DbqaConfig = {
  dataDir: '',
  defaultLocale: '',
  rowLimit: 2,
  queryTimeoutMs: 10_000,
  toolTimeoutMs: 30_000,
  connectTimeoutMs: 5_000,
  sampleRows: 3,
  auditRetentionDays: 90,
}

interface ToolLike {
  readonly name: string
  readonly execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface Harness {
  readonly database: ReturnType<typeof openDbqaDatabase>
  readonly tools: ReadonlyMap<string, ToolLike>
  readonly exec: unknown
  readonly datasourceId: string
}

/** 一套最小装配：假 ctx 收集注册的工具，会话已绑定一个 SQLite 数据源。 */
function harness(key: 'dbqaQuery' | 'dbqaAnalysis'): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dbqa-tools-'))
  const file = join(dir, 'shop.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT NOT NULL, amount NUMERIC);
    INSERT INTO orders (region, amount) VALUES
      ('east', 10), ('east', 20), ('west', 30), ('east', 40), ('west', 50);
  `)
  db.close()

  const database = openDbqaDatabase({ dataDir: join(dir, 'meta') })
  const datasourceId = database.store.create({
    name: 'shop',
    dbType: 'sqlite',
    config: { filePath: file },
    secrets: {},
  }).id
  database.conversations.markActive({ sessionId: SESSION, datasourceId, agentKind: 'query' })

  const tools = new Map<string, ToolLike>()
  const ctx = {
    get: (name: string) => (name === key ? { database, config: CONFIG } : undefined),
    tools: { register: (tool: ToolLike) => { tools.set(tool.name, tool) } },
  }
  if (key === 'dbqaQuery') applyQuery(ctx as unknown as Context)
  else applyAnalysis(ctx as unknown as Context)

  const exec = { agent: { id: SESSION }, signal: AbortSignal.timeout(10_000) }
  return { database, tools, exec, datasourceId }
}

async function run(harnessValue: Harness, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = harnessValue.tools.get(name)
  assert.ok(tool !== undefined, `tool ${name} should be registered`)
  return tool.execute(args, harnessValue.exec)
}

test('the query preset exposes only the read-only answer tools', () => {
  const h = harness('dbqaQuery')
  try {
    assert.deepEqual([...h.tools.keys()].sort(), [
      'dbqa_describe_schema',
      'dbqa_read_knowledge',
      'dbqa_run_query',
      'dbqa_write_knowledge',
    ])
    assert.equal(h.tools.has('dbqa_inspect_sql'), false)
    assert.equal(h.tools.has('dbqa_sample_rows'), false)
  } finally {
    h.database.close()
  }
})

test('the analysis preset keeps the two structure tools', () => {
  const h = harness('dbqaAnalysis')
  try {
    assert.deepEqual([...h.tools.keys()].sort(), [
      'dbqa_describe_schema',
      'dbqa_inspect_sql',
      'dbqa_read_knowledge',
      'dbqa_sample_rows',
      'dbqa_write_knowledge',
    ])
  } finally {
    h.database.close()
  }
})

test('dbqa_run_query executes real rows, caps them and audits every call', async () => {
  const h = harness('dbqaQuery')
  try {
    const result = await run(h, 'dbqa_run_query', {
      sql: 'select region, sum(amount) as total from orders group by region order by region',
    }) as { rows: unknown[][]; rowCount: number; truncated: boolean }

    assert.deepEqual(result.rows, [['east', 70], ['west', 80]])
    assert.equal(result.truncated, false)

    const capped = await run(h, 'dbqa_run_query', { sql: 'select * from orders' }) as {
      rowCount: number
      truncated: boolean
      note: string
    }
    assert.equal(capped.rowCount, 2)
    assert.equal(capped.truncated, true)
    assert.match(capped.note, /已截断到 2 行/)

    const audits = h.database.audit.recent(h.datasourceId)
    assert.equal(audits.filter((item) => item.toolName === 'dbqa_run_query' && item.outcome === 'ok').length, 2)
    assert.ok(audits.some((item) => item.truncated === true))
  } finally {
    h.database.close()
  }
})

test('a write is rejected with a bilingual error and audited', async () => {
  const h = harness('dbqaQuery')
  try {
    const rejection = await run(h, 'dbqa_run_query', {
      sql: 'delete from orders where region = \'west\'',
    }).then(
      () => null,
      (error: unknown) => error as DbqaError,
    )
    assert.ok(rejection instanceof DbqaError)
    assert.equal(rejection.code, 'DBQA_SQL_REJECTED')
    assert.match(rejection.message, /拒绝写操作关键字/)
    assert.match(rejection.message, /rejected the write keyword/)

    const audits = h.database.audit.recent(h.datasourceId)
    const rejected = audits.find((item) => item.outcome === 'rejected')
    assert.ok(rejected !== undefined)
    assert.equal(rejected.errorCode, 'DBQA_SQL_REJECTED')
  } finally {
    h.database.close()
  }
})

test('describe_schema and sample_rows are audited on success', async () => {
  const h = harness('dbqaAnalysis')
  try {
    await run(h, 'dbqa_describe_schema', { limit: 5 })
    await run(h, 'dbqa_sample_rows', { table: 'orders', limit: 2 })
    const audits = h.database.audit.recent(h.datasourceId)
    const describe = audits.find((item) => item.toolName === 'dbqa_describe_schema')
    const sample = audits.find((item) => item.toolName === 'dbqa_sample_rows')
    assert.equal(describe?.outcome, 'ok')
    assert.equal(describe?.rowCount, 1)
    assert.equal(sample?.outcome, 'ok')
    assert.equal(sample?.rowCount, 2)
  } finally {
    h.database.close()
  }
})
