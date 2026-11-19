/**
 * 元数据库：新文件名、PRAGMA、结构对账、注释双向校验。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { openDbqaDatabase } from '../src/store/db.ts'
import { SCHEMA_COMMENTS } from '../src/store/schema.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dbqa-store-'))
}

test('fresh database: new filename, fixed PRAGMAs, every table and column commented', () => {
  const dir = tempDir()
  const database = openDbqaDatabase({ dataDir: dir })
  try {
    assert.equal(database.report.outcome, 'initialized')
    assert.equal(database.report.file, join(dir, 'db-qa.sqlite'))
    assert.equal(database.report.writable, true)

    const journal = database.db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
    assert.equal(String(journal['journal_mode']).toLowerCase(), 'wal')
    const sync = database.db.prepare('PRAGMA synchronous').get() as Record<string, unknown>
    assert.equal(Number(sync['synchronous']), 1)
    const fk = database.db.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>
    assert.equal(Number(fk['foreign_keys']), 1)
    const busy = database.db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>
    assert.equal(Number(busy['timeout']), 5000)

    const tables = (
      database.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name)
    assert.deepEqual(tables.sort(), ['dbqa_conversation', 'dbqa_datasource', 'dbqa_knowledge_file', 'dbqa_query_audit'])

    const expected = new Set<string>()
    for (const table of tables) {
      expected.add(`${table}:`)
      const columns = database.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      for (const column of columns) expected.add(`${table}:${column.name}`)
    }
    const actual = new Set<string>()
    for (const comment of SCHEMA_COMMENTS) {
      assert.ok(comment.description.trim() !== '', `${comment.table}.${comment.column} needs a Chinese comment`)
      actual.add(`${comment.table}:${comment.column}`)
    }
    assert.deepEqual([...actual].sort(), [...expected].sort())
  } finally {
    database.close()
  }
})

test('reopening the same file is unchanged', () => {
  const dir = tempDir()
  const first = openDbqaDatabase({ dataDir: dir })
  first.close()
  const second = openDbqaDatabase({ dataDir: dir })
  try {
    assert.equal(second.report.outcome, 'unchanged')
    assert.equal(second.report.schemaVersion, 1)
  } finally {
    second.close()
  }
})

test('a database with a foreign schema is moved aside and rebuilt', () => {
  const dir = tempDir()
  const file = join(dir, 'db-qa.sqlite')
  const foreign = new DatabaseSync(file)
  foreign.exec('CREATE TABLE old_connection (id INTEGER PRIMARY KEY, dsn TEXT)')
  foreign.close()
  const database = openDbqaDatabase({ dataDir: dir })
  try {
    assert.equal(database.report.outcome, 'rebuilt')
    const backups = readdirSync(dir).filter((name) => name.startsWith('db-qa.sqlite.bak-'))
    assert.equal(backups.length, 1)
    assert.equal(readdirSync(dir).includes('db-qa.sqlite'), true)
  } finally {
    database.close()
  }
})

test('a newer metadata schema is opened read-only', () => {
  const dir = tempDir()
  const file = join(dir, 'db-qa.sqlite')
  const newer = new DatabaseSync(file)
  newer.exec('PRAGMA user_version = 99')
  newer.close()
  const database = openDbqaDatabase({ dataDir: dir })
  try {
    assert.equal(database.report.outcome, 'ahead')
    assert.equal(database.report.writable, false)
    assert.equal(database.report.schemaVersion, 1)
  } finally {
    database.close()
  }
})

test('datasource CRUD keeps secrets as references and rejects type changes', () => {
  const dir = tempDir()
  const database = openDbqaDatabase({ dataDir: dir })
  try {
    const created = database.store.create({
      name: 'local',
      dbType: 'mysql',
      config: { host: '127.0.0.1', port: 3306, user: 'reader' },
      secrets: { password: { kind: 'env', var: 'MYSQL_PASSWORD' } },
    })
    assert.match(created.id, /^ds_/)
    assert.equal(database.store.list().length, 1)
    const passwordRef = database.store.get(created.id).secrets.password
    assert.equal(passwordRef !== undefined && passwordRef.kind === 'env' ? passwordRef.var : null, 'MYSQL_PASSWORD')

    const raw = database.db.prepare('SELECT config_json, secret_ref_json FROM dbqa_datasource WHERE id = ?').get(created.id) as Record<string, string>
    assert.ok(!raw['config_json']?.includes('MYSQL_PASSWORD'))
    assert.ok(!raw['config_json']?.includes('password'))
    assert.match(String(raw['secret_ref_json']), /MYSQL_PASSWORD/)

    assert.throws(
      () => database.store.create({ name: 'local', dbType: 'postgresql', config: {}, secrets: {} }),
      (error: unknown) => (error as { code?: string }).code === 'DBQA_CONFLICT',
    )

    assert.throws(
      () =>
        database.store.update(created.id, {
          name: 'local',
          dbType: 'postgresql',
          config: {},
          secrets: {},
        }),
      (error: unknown) => (error as { code?: string }).code === 'DBQA_INVALID_CONFIG',
    )

    database.store.recordTest(created.id, { ok: false, errorCode: 'DBQA_AUTH_FAILED' })
    const tested = database.store.get(created.id)
    assert.equal(tested.lastTestOk, false)
    assert.equal(tested.lastTestErrorCode, 'DBQA_AUTH_FAILED')

    assert.equal(database.store.remove(created.id), true)
    assert.equal(database.store.list().length, 0)
  } finally {
    database.close()
  }
})

test('list order is creation order and survives test-result updates', () => {
  const dir = tempDir()
  const database = openDbqaDatabase({ dataDir: dir })
  try {
    const first = database.store.create({ name: 'first', dbType: 'sqlite', config: { filePath: '/tmp/a.db' }, secrets: {} })
    database.store.create({ name: 'second', dbType: 'sqlite', config: { filePath: '/tmp/b.db' }, secrets: {} })
    const before = database.store.list().map((row) => row.name)
    database.store.recordTest(first.id, { ok: false, errorCode: 'DBQA_HOST_UNREACHABLE' })
    const after = database.store.list().map((row) => row.name)
    assert.deepEqual(before, ['first', 'second'])
    assert.deepEqual(after, before)
  } finally {
    database.close()
  }
})
