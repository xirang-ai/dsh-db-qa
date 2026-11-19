/**
 * 知识库文档链接解析：索引页到表文档、表文档之间的相对跳转与外部地址。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveKnowledgeLink, resolveTableRef } from '../src/client/link.ts'

test('resolves index links to table documents', () => {
  assert.deepEqual(resolveKnowledgeLink('index.md', 'tables/main.orders/business.md'), {
    kind: 'table',
    dir: 'main.orders',
    part: 'business',
  })
  assert.deepEqual(resolveKnowledgeLink('index.md', './tables/a/schema.md'), {
    kind: 'table',
    dir: 'a',
    part: 'schema',
  })
  assert.deepEqual(resolveKnowledgeLink('index.md', 'tables/a/business.md#fields'), {
    kind: 'table',
    dir: 'a',
    part: 'business',
  })
})

test('resolves links relative to the current table document', () => {
  assert.deepEqual(resolveKnowledgeLink('tables/a/business.md', 'schema.md'), {
    kind: 'table',
    dir: 'a',
    part: 'schema',
  })
  assert.deepEqual(resolveKnowledgeLink('tables/a/business.md', '../b/business.md'), {
    kind: 'table',
    dir: 'b',
    part: 'business',
  })
  assert.deepEqual(resolveKnowledgeLink('tables/a/business.md', '../../index.md'), { kind: 'index' })
})

test('decodes percent-encoded paths and query strings', () => {
  assert.deepEqual(resolveKnowledgeLink('index.md', 'tables/a%20b/business.md?plain=1'), {
    kind: 'table',
    dir: 'a b',
    part: 'business',
  })
})

test('leaves external links to the browser', () => {
  assert.deepEqual(resolveKnowledgeLink('index.md', 'https://example.com/doc.md'), { kind: 'external' })
  assert.deepEqual(resolveKnowledgeLink('index.md', 'mailto:ops@example.com'), { kind: 'external' })
  assert.deepEqual(resolveKnowledgeLink('index.md', '//example.com/doc.md'), { kind: 'external' })
})

test('matches table links by exact directory or by bare table name', () => {
  const tables = [
    { dir: 'lian_aibims_com.cloud_worker', tableRef: 'lian_aibims_com.cloud_worker' },
    { dir: 'lian_aibims_com.cloud_work_place', tableRef: 'lian_aibims_com.cloud_work_place' },
    { dir: 'main.t', tableRef: 'main.t' },
  ]
  assert.equal(resolveTableRef('lian_aibims_com.cloud_worker', tables), 'lian_aibims_com.cloud_worker')
  assert.equal(resolveTableRef('cloud_work_place', tables), 'lian_aibims_com.cloud_work_place')
  assert.equal(resolveTableRef('t', tables), 'main.t')
  assert.equal(resolveTableRef('missing', tables), undefined)
})

test('refuses to guess when a bare table name is ambiguous', () => {
  const tables = [
    { dir: 'a.orders', tableRef: 'a.orders' },
    { dir: 'b.orders', tableRef: 'b.orders' },
  ]
  assert.equal(resolveTableRef('orders', tables), undefined)
})

test('rejects anchors and paths outside the knowledge base', () => {
  assert.deepEqual(resolveKnowledgeLink('index.md', '#overview'), { kind: 'other', path: '#overview' })
  assert.deepEqual(resolveKnowledgeLink('index.md', '../../secret.md'), { kind: 'other', path: '../../secret.md' })
  assert.deepEqual(resolveKnowledgeLink('index.md', '/etc/passwd'), { kind: 'other', path: '/etc/passwd' })
  assert.deepEqual(resolveKnowledgeLink('index.md', 'assets/logo.png'), {
    kind: 'other',
    path: 'assets/logo.png',
  })
})
