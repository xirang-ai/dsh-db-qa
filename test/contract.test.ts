/** Remote 描述表与构建产物必须符合宿主与 Web 加载器的约定。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { DESCRIPTORS, PACKAGE_NAME, REMOTE_CONTRIBUTION, TYPERT_MANIFEST } from '../src/remote/contract.ts'

const root = new URL('..', import.meta.url).pathname

test('remote descriptors are unique and unary', () => {
  const names = DESCRIPTORS.map((entry) => entry.method)
  assert.deepEqual(names, [
    'datasource.list',
    'datasource.get',
    'datasource.save',
    'datasource.remove',
    'datasource.test',
    'datasource.fieldDefs',
    'conversation.markActive',
    'conversation.get',
    'conversation.list',
    'conversation.setFavorite',
    'knowledge.status',
    'knowledge.read',
  ])
  assert.equal(new Set(DESCRIPTORS.map((entry) => entry.id)).size, DESCRIPTORS.length)
  for (const entry of DESCRIPTORS) {
    assert.equal(entry.parameters.length, entry.method === 'datasource.list' ? 0 : 1)
    assert.equal(entry.result.mode, 'strict')
    assert.equal(entry.namespace, 'dbqa')
  }
  assert.equal(REMOTE_CONTRIBUTION.package, PACKAGE_NAME)
  assert.equal(TYPERT_MANIFEST.face, 'host')
})

test('built artifacts follow the loader contract', () => {
  for (const file of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js']) {
    assert.equal(existsSync(join(root, file)), true, `${file} should exist after pnpm run build`)
  }
  const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.equal(client.startsWith('window.__ModuleLoader__.load'), true)
  assert.match(client, /id: "@xirang-ai\/dsh-db-qa"/)
  assert.equal(client.includes('node:sqlite'), false)
  assert.equal(client.includes('dbqa.workbench'), true)
})
