/**
 * Remote 层：草稿「测试连接」的结论要跟着保存落库，避免列表刚建好就显示未测试。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import type { Config } from '../src/config.ts'
import { openDbqaDatabase } from '../src/store/db.ts'
import { DbqaWorkbenchService } from '../src/remote/service.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dbqa-remote-'))
}

/** 一个可测的 SQLite 文件。 */
function sqliteFile(dir: string): string {
  const file = join(dir, 'sample.db')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)')
  } finally {
    db.close()
  }
  return file
}

function setup(): { readonly service: DbqaWorkbenchService; readonly dir: string } {
  const dir = tempDir()
  const database = openDbqaDatabase({ dataDir: dir })
  const config: Config = {
    dataDir: dir,
    defaultLocale: '',
    rowLimit: 200,
    queryTimeoutMs: 30_000,
    toolTimeoutMs: 120_000,
    connectTimeoutMs: 10_000,
    sampleRows: 5,
    auditRetentionDays: 90,
  }
  return { service: new DbqaWorkbenchService(new Context(), database, config), dir }
}

test('saving the draft that just probed successfully keeps the test result', async () => {
  const { service, dir } = setup()
  const values = { name: 'demo', filePath: sqliteFile(dir) }

  const tested = await service.datasourceTest({ draft: { dbType: 'sqlite', values } })
  assert.equal(tested.result?.ok, true)
  assert.equal(tested.result?.readOnlyConfirmed, true)

  const saved = service.datasourceSave({ draft: { dbType: 'sqlite', values } })
  assert.equal(saved.issues.length, 0)
  assert.equal(saved.saved?.lastTestOk, true)
  assert.ok((saved.saved?.lastTestedAt ?? 0) > 0)
  assert.equal(saved.saved?.lastTestErrorCode, null)
  assert.ok((saved.saved?.serverVersion ?? '') !== '')
  // 列表里读到的也是带测试结论的那一行。
  assert.equal(service.datasourceList().datasources[0]?.lastTestOk, true)
})

test('saving the draft that just failed keeps the failure', async () => {
  const { service, dir } = setup()
  const values = { name: 'broken', filePath: join(dir, 'missing.db') }

  const tested = await service.datasourceTest({ draft: { dbType: 'sqlite', values } })
  assert.equal(tested.result?.ok, false)

  const saved = service.datasourceSave({ draft: { dbType: 'sqlite', values } })
  assert.equal(saved.saved?.lastTestOk, false)
  assert.ok((saved.saved?.lastTestErrorCode ?? '') !== '')
})

test('changing the draft after a test does not reuse the old result', async () => {
  const { service, dir } = setup()
  const file = sqliteFile(dir)

  const tested = await service.datasourceTest({ draft: { dbType: 'sqlite', values: { name: 'first', filePath: file } } })
  assert.equal(tested.result?.ok, true)

  const saved = service.datasourceSave({ draft: { dbType: 'sqlite', values: { name: 'second', filePath: file } } })
  assert.equal(saved.saved?.lastTestedAt, null)
  assert.equal(saved.saved?.lastTestOk, null)
})
