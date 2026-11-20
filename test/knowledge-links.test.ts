import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyFixes,
  checkLinks,
  fixesOf,
  matchTableDir,
  parseMarkdownLinks,
  resolveRelative,
} from '../src/knowledge/links.ts'

const TABLES = [
  { dir: 'baimiao_aibims_com.cloud_users', tableRef: 'baimiao_aibims_com.cloud_users' },
  { dir: 'baimiao_aibims_com.cloud_orders', tableRef: 'baimiao_aibims_com.cloud_orders' },
]

test('parses inline links while skipping images and fenced code', () => {
  const markdown = [
    '# index',
    '',
    'See [users](tables/baimiao_aibims_com.cloud_users/business.md) and ![logo](assets/logo.png).',
    '',
    '```md',
    '[fenced](tables/nope/business.md)',
    '```',
    '',
    '[orders](../baimiao_aibims_com.cloud_orders/schema.md "title")',
  ].join('\n')
  const links = parseMarkdownLinks(markdown)
  assert.deepEqual(
    links.map((link) => [link.href, link.line]),
    [
      ['tables/baimiao_aibims_com.cloud_users/business.md', 3],
      ['../baimiao_aibims_com.cloud_orders/schema.md', 9],
    ],
  )
  for (const link of links) assert.equal(markdown.slice(link.start, link.end), link.href)
})

test('resolves relative hrefs and refuses to leave the knowledge base', () => {
  assert.equal(resolveRelative('tables/a/business.md', '../b/business.md'), 'tables/b/business.md')
  assert.equal(resolveRelative('index.md', './tables/a/schema.md?plain=1'), 'tables/a/schema.md')
  assert.equal(resolveRelative('index.md', '#overview'), null)
  assert.equal(resolveRelative('index.md', '../../secret.md'), null)
  assert.equal(resolveRelative('index.md', '/etc/passwd'), null)
  assert.equal(resolveRelative('index.md', 'https://example.com'), null)
})

test('matches table directories exactly, by bare suffix, or not at all when ambiguous', () => {
  assert.equal(
    matchTableDir('baimiao_aibims_com.cloud_users', TABLES)?.tableRef,
    'baimiao_aibims_com.cloud_users',
  )
  assert.equal(matchTableDir('cloud_users', TABLES)?.tableRef, 'baimiao_aibims_com.cloud_users')
  assert.equal(matchTableDir('cloud_missing', TABLES), undefined)

  const ambiguous = [
    { dir: 'a.orders', tableRef: 'a.orders' },
    { dir: 'b.orders', tableRef: 'b.orders' },
  ]
  assert.equal(matchTableDir('orders', ambiguous), undefined)
})

test('flags abbreviated table links and suggests the full directory name', () => {
  const documents = [
    { path: 'index.md', content: '[users](tables/cloud_users/business.md)' },
    {
      path: 'tables/baimiao_aibims_com.cloud_users/business.md',
      content: '[orders](../cloud_orders/business.md)',
    },
  ]
  const report = checkLinks(documents, TABLES, true)
  assert.equal(report.links, 2)
  assert.deepEqual(
    report.problems.map((problem) => [problem.path, problem.kind, problem.suggestion]),
    [
      ['index.md', 'abbreviated', 'tables/baimiao_aibims_com.cloud_users/business.md'],
      [
        'tables/baimiao_aibims_com.cloud_users/business.md',
        'abbreviated',
        '../baimiao_aibims_com.cloud_orders/business.md',
      ],
    ],
  )
})

test('reports dangling targets, a missing index and links above the root', () => {
  const tableDocument = {
    path: 'tables/baimiao_aibims_com.cloud_users/business.md',
    content: [
      '[home](../../index.md)',
      '[gone](../cloud_gone/business.md)',
      '[same](../baimiao_aibims_com.cloud_users/business.md)',
    ].join('\n'),
  }
  const report = checkLinks([tableDocument], TABLES, false)
  assert.equal(report.links, 3)
  assert.deepEqual(
    report.problems.map((problem) => [problem.path, problem.line, problem.kind]),
    [
      [tableDocument.path, 1, 'missing-index'],
      [tableDocument.path, 2, 'dangling'],
    ],
  )
  assert.ok(report.problems.every((problem) => problem.suggestion === null))

  const outside = checkLinks([{ path: 'index.md', content: '[secret](../../secret.md)' }], TABLES, true)
  assert.deepEqual(
    outside.problems.map((problem) => [problem.path, problem.kind]),
    [['index.md', 'outside']],
  )
})

test('rewrites only the links that have a suggestion', () => {
  const document = {
    path: 'tables/baimiao_aibims_com.cloud_users/business.md',
    content: 'A [orders](../cloud_orders/business.md) and [gone](../cloud_gone/business.md).\n',
  }
  const report = checkLinks([document], TABLES, true)
  const fixes = fixesOf(document, report.problems)
  assert.equal(fixes.length, 1)
  assert.equal(document.content.slice(fixes[0]?.start, fixes[0]?.end), '../cloud_orders/business.md')
  assert.equal(
    applyFixes(document.content, fixes),
    'A [orders](../baimiao_aibims_com.cloud_orders/business.md) and [gone](../cloud_gone/business.md).\n',
  )
})
