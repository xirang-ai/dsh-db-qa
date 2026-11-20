/**
 * 知识库文件层：整篇写入、读取重读、外部编辑自愈、按数据源隔离。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDbqaDatabase } from '../src/store/db.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dbqa-knowledge-'))
}

function makeDatasource(database: ReturnType<typeof openDbqaDatabase>, name: string): string {
  return database.store.create({
    name,
    dbType: 'sqlite',
    config: { filePath: ':memory:' },
    secrets: {},
  }).id
}

test('writes table documents and index.md, then reads them back', async () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const id = makeDatasource(database, 'orders')
    const results = await database.knowledge.write(id, [
      { tableRef: 'main.orders', part: 'schema', content: '# orders schema\n' },
      { tableRef: 'main.orders', part: 'business', content: '# orders business\n' },
      { part: 'index', content: '# index\n' },
    ])
    assert.deepEqual(results.map((item) => item.status), ['created', 'created', 'created'])
    assert.equal(results[0]?.relPath, 'tables/main.orders/schema.md')

    const root = join(database.dataDir, 'knowledge', id)
    assert.equal(readFileSync(join(root, 'index.md'), 'utf8'), '# index\n')
    assert.equal(
      readFileSync(join(root, 'tables/main.orders/business.md'), 'utf8'),
      '# orders business\n',
    )

    const read = await database.knowledge.read(id, 'main.orders', 'both')
    assert.deepEqual(read.documents.map((item) => item.part), ['business', 'schema'])

    const status = await database.knowledge.status(id)
    assert.equal(status.index.exists, true)
    assert.equal(status.index.stale, false)
    assert.equal(status.tables.length, 1)
    assert.equal(status.tables[0]?.business.exists, true)
    assert.equal(status.tables[0]?.schema.exists, true)
    assert.deepEqual(status.indexedOnly, [])
  } finally {
    database.close()
  }
})

test('external edits win: read returns the file and refreshes the index hash', async () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const id = makeDatasource(database, 'external')
    await database.knowledge.write(id, [{ part: 'index', content: 'old\n' }])
    const file = join(database.dataDir, 'knowledge', id, 'index.md')

    writeFileSync(file, 'new from editor\n')
    const before = await database.knowledge.status(id)
    assert.equal(before.index.stale, true)

    const read = await database.knowledge.read(id)
    assert.equal(read.documents[0]?.content, 'new from editor\n')

    const after = await database.knowledge.status(id)
    assert.equal(after.index.stale, false)
  } finally {
    database.close()
  }
})

test('datasources are isolated and a missing index reads as empty', async () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const a = makeDatasource(database, 'a')
    const b = makeDatasource(database, 'b')
    await database.knowledge.write(a, [{ part: 'index', content: 'A only\n' }])

    const readA = await database.knowledge.read(a)
    assert.equal(readA.documents[0]?.content, 'A only\n')

    const readB = await database.knowledge.read(b)
    assert.deepEqual(readB.documents, [])
    assert.deepEqual(readB.missingParts, ['index'])

    const statusB = await database.knowledge.status(b)
    assert.equal(statusB.index.exists, false)
    assert.deepEqual(statusB.tables, [])
  } finally {
    database.close()
  }
})

test('normalized table names keep colliding tables apart', async () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const id = makeDatasource(database, 'collide')
    const first = await database.knowledge.write(id, [
      { tableRef: 'main.a/b', part: 'business', content: 'slash\n' },
    ])
    const second = await database.knowledge.write(id, [
      { tableRef: 'main.a_b', part: 'business', content: 'underscore\n' },
    ])
    assert.notEqual(first[0]?.relPath, second[0]?.relPath)
    assert.match(second[0]?.relPath ?? '', /^tables\/main\.a_b-[0-9a-f]{6}\/business\.md$/)
  } finally {
    database.close()
  }
})

test('checkLinks rewrites abbreviated table links and leaves dangling ones alone', async () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const id = makeDatasource(database, 'links')
    await database.knowledge.write(id, [
      {
        tableRef: 'main.users',
        part: 'business',
        content: '# users\n\n[orders](../orders/business.md)\n[mystery](../missing/business.md)\n',
      },
      { tableRef: 'main.orders', part: 'business', content: '# orders\n\n[users](../main.users/business.md)\n' },
      { part: 'index', content: '# index\n\n[users](tables/users/business.md)\n' },
    ])

    const report = await database.knowledge.checkLinks(id)
    assert.equal(report.documents, 3)
    assert.equal(report.links, 4)
    assert.deepEqual(
      report.problems.map((problem) => `${problem.path}:${problem.kind}`).sort(),
      [
        'index.md:abbreviated',
        'tables/main.users/business.md:abbreviated',
        'tables/main.users/business.md:dangling',
      ].sort(),
    )

    const fixed = await database.knowledge.checkLinks(id, { fix: true })
    assert.deepEqual(fixed.fixed.map((item) => item.path).sort(), ['index.md', 'tables/main.users/business.md'])
    assert.deepEqual(fixed.problems.map((problem) => problem.kind), ['dangling'])

    const root = join(database.dataDir, 'knowledge', id)
    assert.equal(
      readFileSync(join(root, 'tables/main.users/business.md'), 'utf8'),
      '# users\n\n[orders](../main.orders/business.md)\n[mystery](../missing/business.md)\n',
    )
    assert.equal(readFileSync(join(root, 'index.md'), 'utf8'), '# index\n\n[users](tables/main.users/business.md)\n')
  } finally {
    database.close()
  }
})
