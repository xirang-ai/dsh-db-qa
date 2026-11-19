/**
 * 查询编排：限行、截断标注、只读闸门、审计与问题索引回写。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { Config as DbqaConfig } from '../src/config.ts'
import { DbqaError } from '../src/errors.ts'
import { runQuery, wrapForLimit } from '../src/query/execute.ts'
import { openDbqaDatabase } from '../src/store/db.ts'

const CONFIG: DbqaConfig = {
  dataDir: '',
  defaultLocale: '',
  rowLimit: 3,
  queryTimeoutMs: 10_000,
  toolTimeoutMs: 30_000,
  connectTimeoutMs: 5_000,
  sampleRows: 5,
  auditRetentionDays: 90,
}

function fixture(): { file: string; database: ReturnType<typeof openDbqaDatabase>; datasourceId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dbqa-query-'))
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
  database.conversations.markActive({
    sessionId: 's1',
    datasourceId,
    agentKind: 'query',
    title: '上月华东退货率为什么涨',
  })
  return { file, database, datasourceId }
}

const exec = { agent: { id: 's1' }, signal: AbortSignal.timeout(10_000) }

test('wraps the query, caps rows and marks truncation with a bilingual note', async () => {
  const { database, datasourceId } = fixture()
  try {
    const result = await runQuery(
      { database, config: CONFIG },
      exec,
      'SELECT id, region FROM orders ORDER BY id',
      undefined,
    )
    assert.equal(result.datasourceId, datasourceId)
    assert.equal(result.limit, 3)
    assert.equal(result.rowCount, 3)
    assert.equal(result.truncated, true)
    assert.equal(result.sql, 'SELECT id, region FROM orders ORDER BY id')
    assert.match(wrapForLimit(result.sql, 3).sql, /dbqa_sub/)
    assert.deepEqual(result.columns, ['id', 'region'])

    const audited = database.audit.recent(datasourceId, 5)
    assert.equal(audited.length, 1)
    assert.equal(audited[0]?.outcome, 'ok')
    assert.equal(audited[0]?.truncated, true)
    assert.equal(audited[0]?.rowCount, 3)
    assert.equal(audited[0]?.toolName, 'dbqa_run_query')
  } finally {
    database.close()
  }
})

test('a smaller requested limit is honoured and a full result is not truncated', async () => {
  const { database } = fixture()
  try {
    const result = await runQuery({ database, config: CONFIG }, exec, 'SELECT count(*) AS n FROM orders', 1)
    assert.equal(result.limit, 1)
    assert.equal(result.rowCount, 1)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.rows, [[5]])
  } finally {
    database.close()
  }
})

test('rejects writes through the gate and still audits the rejection', async () => {
  const { database, datasourceId } = fixture()
  try {
    await assert.rejects(
      runQuery({ database, config: CONFIG }, exec, 'DELETE FROM orders', undefined),
      (error: unknown) => error instanceof DbqaError && error.code === 'DBQA_SQL_REJECTED',
    )
    const audited = database.audit.recent(datasourceId, 5)
    assert.equal(audited.length, 1)
    assert.equal(audited[0]?.outcome, 'rejected')
    assert.equal(audited[0]?.errorCode, 'DBQA_SQL_REJECTED')
    assert.match(audited[0]?.sqlText ?? '', /DELETE FROM orders/)
  } finally {
    database.close()
  }
})

test('an answer keeps the conversation title and leaves the index time alone', async () => {
  const { database } = fixture()
  try {
    const before = database.conversations.getBySession('s1')
    await runQuery({ database, config: CONFIG }, exec, 'SELECT count(*) AS n FROM orders', undefined)
    const after = database.conversations.getBySession('s1')
    assert.equal(after?.title, '上月华东退货率为什么涨')
    // 跑查询不再刷新索引时间：列表用的是宿主会话的最后一条用户消息时间。
    assert.equal(after?.lastActiveAt, before?.lastActiveAt)
  } finally {
    database.close()
  }
})

test('unbound sessions fail with DBQA_NO_DATASOURCE', async () => {
  const { database } = fixture()
  try {
    await assert.rejects(
      runQuery({ database, config: CONFIG }, { agent: { id: 'other' }, signal: AbortSignal.timeout(5_000) }, 'SELECT 1', undefined),
      (error: unknown) => error instanceof DbqaError && error.code === 'DBQA_NO_DATASOURCE',
    )
  } finally {
    database.close()
  }
})
