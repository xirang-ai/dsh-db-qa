/**
 * 只读会话：表结构、DDL、索引、外键与只读 SQL 闸门。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { openDbSession } from '../src/db/open.ts'

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbqa-session-'))
  const file = join(dir, 'demo.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount NUMERIC
    );
    CREATE INDEX idx_orders_user ON orders(user_id);
  `)
  db.close()
  return file
}

test('sqlite session exposes ddl, indexes, foreign keys and rows', async () => {
  const file = fixture()
  const session = await openDbSession(
    'sqlite',
    'demo',
    { filePath: file },
    {},
    { dataDir: '/tmp', signal: AbortSignal.timeout(5000) },
  )
  try {
    const tables = await session.listTables(AbortSignal.timeout(5000))
    assert.deepEqual(tables.map((table) => table.ref.table).sort(), ['orders', 'users'])

    const orders = tables.find((table) => table.ref.table === 'orders')
    assert.ok(orders)
    const detail = await session.tableDdl(orders.ref, AbortSignal.timeout(5000))
    assert.match(detail.ddl, /CREATE TABLE orders/)
    assert.ok(detail.indexes.some((index) => index.startsWith('idx_orders_user')))
    assert.ok(detail.foreignKeys.some((foreign) => foreign.includes('users')))

    const columns = await session.describeTable(orders.ref, AbortSignal.timeout(5000))
    assert.deepEqual(columns.map((column) => column.name), ['id', 'user_id', 'amount'])

    const result = await session.query('SELECT name FROM users ORDER BY id', 10, AbortSignal.timeout(5000))
    assert.deepEqual(result.columns, ['name'])
    assert.equal(result.rowCount, 0)
  } finally {
    await session.close()
  }
})

test('sqlite session rejects writing SQL', async () => {
  const file = fixture()
  const session = await openDbSession(
    'sqlite',
    'demo',
    { filePath: file },
    {},
    { dataDir: '/tmp', signal: AbortSignal.timeout(5000) },
  )
  try {
    // 插件不再检查 SQL 文本；写入尝试由只读连接本身拒绝。
    await assert.rejects(() => session.query('DELETE FROM users', 10, AbortSignal.timeout(5000)))
  } finally {
    await session.close()
  }
})
