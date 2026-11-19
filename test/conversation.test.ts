/**
 * 会话绑定：分析 / 查询会话都可改选、未绑定报 DBQA_NO_DATASOURCE。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DbqaError } from '../src/errors.ts'
import { openDbqaDatabase } from '../src/store/db.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dbqa-conversation-'))
}

function datasource(database: ReturnType<typeof openDbqaDatabase>, name: string): string {
  return database.store.create({
    name,
    dbType: 'sqlite',
    config: { filePath: ':memory:' },
    secrets: {},
  }).id
}

test('an analysis binding can be changed mid-conversation', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const a = datasource(database, 'a')
    const b = datasource(database, 'b')

    const first = database.conversations.markActive({
      sessionId: 's1',
      datasourceId: a,
      agentKind: 'analysis',
    })
    assert.equal(first?.datasourceId, a)
    assert.equal(first?.agentKind, 'analysis')

    const second = database.conversations.markActive({
      sessionId: 's1',
      datasourceId: b,
      agentKind: 'analysis',
    })
    assert.equal(second?.datasourceId, b)
    assert.equal(second?.agentKind, 'analysis')
    assert.equal(database.conversations.requireBinding('s1').datasourceId, b)
  } finally {
    database.close()
  }
})

test('query binding can be changed', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const a = datasource(database, 'a')
    const b = datasource(database, 'b')
    database.conversations.markActive({ sessionId: 'q1', datasourceId: a, agentKind: 'query' })
    const rebound = database.conversations.markActive({
      sessionId: 'q1',
      datasourceId: b,
      agentKind: 'query',
    })
    assert.equal(rebound?.datasourceId, b)
    assert.equal(rebound?.agentKind, 'query')
  } finally {
    database.close()
  }
})

test('a title-only update keeps the binding and records the conversation title', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const a = datasource(database, 'a')
    database.conversations.markActive({
      sessionId: 'q2',
      datasourceId: a,
      agentKind: 'query',
      title: '上月华东退货率为什么涨',
    })
    const before = database.conversations.getBySession('q2')
    assert.equal(before?.title, '上月华东退货率为什么涨')
    assert.equal(before?.datasourceId, a)

    // 会话标题由宿主在首条提问后确定，客户端只补标题，不动已选数据源。
    const after = database.conversations.markActive({ sessionId: 'q2', title: '退货率排查' })
    assert.equal(after?.datasourceId, a)
    assert.equal(after?.agentKind, 'query')
    const row = database.conversations.getBySession('q2')
    assert.equal(row?.title, '退货率排查')
    assert.equal(row?.datasourceId, a)
    // 列表时间取宿主会话的最后一条用户消息时间，写回标题不能把它刷成「现在」。
    assert.equal(row?.createdAt, before?.createdAt)
    assert.equal(row?.lastActiveAt, before?.lastActiveAt)
  } finally {
    database.close()
  }
})

test('unbound sessions fail with DBQA_NO_DATASOURCE', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    assert.throws(
      () => database.conversations.requireBinding('missing'),
      (error: unknown) => error instanceof DbqaError && error.code === 'DBQA_NO_DATASOURCE',
    )
  } finally {
    database.close()
  }
})

/** 把某行的两个时间字段改成确定值，避免测试依赖真实时钟。 */
function stamp(
  database: ReturnType<typeof openDbqaDatabase>,
  sessionId: string,
  fields: { readonly lastActiveAt?: number; readonly favoritedAt?: number | null },
): void {
  const row = database.conversations.getBySession(sessionId)
  assert.ok(row !== null)
  if (fields.lastActiveAt !== undefined) {
    database.db.prepare('UPDATE dbqa_conversation SET last_active_at = ? WHERE id = ?').run(fields.lastActiveAt, row.id)
  }
  if (fields.favoritedAt !== undefined) {
    database.db
      .prepare('UPDATE dbqa_conversation SET favorited_at = ? WHERE id = ?')
      .run(fields.favoritedAt, row.id)
  }
}

test('the all tab lists only query conversations by last activity, newest first', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const a = datasource(database, 'a')
    for (const sessionId of ['q1', 'q2', 'q3']) {
      database.conversations.markActive({ sessionId, datasourceId: a, agentKind: 'query', title: sessionId })
    }
    database.conversations.markActive({ sessionId: 'an1', datasourceId: a, agentKind: 'analysis', title: 'an1' })
    stamp(database, 'q1', { lastActiveAt: 1000 })
    stamp(database, 'q2', { lastActiveAt: 3000 })
    stamp(database, 'q3', { lastActiveAt: 2000 })

    const first = database.conversations.listPage({ tab: 'all', page: 1, pageSize: 2 })
    assert.equal(first.total, 3)
    assert.equal(first.page, 1)
    assert.deepEqual(first.items.map((row) => row.sessionId), ['q2', 'q3'])

    const second = database.conversations.listPage({ tab: 'all', page: 2, pageSize: 2 })
    assert.deepEqual(second.items.map((row) => row.sessionId), ['q1'])

    const beyond = database.conversations.listPage({ tab: 'all', page: 9, pageSize: 2 })
    assert.deepEqual(beyond.items, [])
    assert.equal(beyond.total, 3)
  } finally {
    database.close()
  }
})

test('the favorite tab lists favorited conversations by favorite time', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const a = datasource(database, 'a')
    for (const sessionId of ['q1', 'q2', 'q3']) {
      database.conversations.markActive({ sessionId, datasourceId: a, agentKind: 'query', title: sessionId })
    }
    const q1 = database.conversations.getBySession('q1')
    const q2 = database.conversations.getBySession('q2')
    assert.ok(q1 !== null && q2 !== null)
    database.conversations.setFavorite(q1.id, true)
    database.conversations.setFavorite(q2.id, true)
    // 收藏时间与最后交互时间的顺序相反，确认排序字段是收藏时间。
    stamp(database, 'q1', { favoritedAt: 5000, lastActiveAt: 1000 })
    stamp(database, 'q2', { favoritedAt: 7000, lastActiveAt: 9000 })

    const page = database.conversations.listPage({ tab: 'favorite', page: 1, pageSize: 20 })
    assert.equal(page.total, 2)
    assert.deepEqual(page.items.map((row) => row.sessionId), ['q2', 'q1'])
    assert.deepEqual(page.items.map((row) => row.favoritedAt), [7000, 5000])
  } finally {
    database.close()
  }
})

test('setFavorite is keyed by row id, idempotent and clears the favorite time', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  try {
    const a = datasource(database, 'a')
    database.conversations.markActive({ sessionId: 'q1', datasourceId: a, agentKind: 'query' })
    const row = database.conversations.getBySession('q1')
    assert.ok(row !== null)

    const first = database.conversations.setFavorite(row.id, true)
    assert.equal(first?.isFavorite, true)
    const firstAt = first?.favoritedAt ?? 0
    assert.ok(firstAt > 0)

    database.db.prepare('UPDATE dbqa_conversation SET favorited_at = ? WHERE id = ?').run(1234, row.id)
    const again = database.conversations.setFavorite(row.id, true)
    assert.equal(again?.isFavorite, true)
    assert.ok((again?.favoritedAt ?? 0) > 1234)

    const off = database.conversations.setFavorite(row.id, false)
    assert.equal(off?.isFavorite, false)
    assert.equal(off?.favoritedAt, null)

    assert.equal(database.conversations.setFavorite('cv_missing', true), null)
  } finally {
    database.close()
  }
})
