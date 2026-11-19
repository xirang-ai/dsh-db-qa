/** 适配器探测：只读、短命、失败可读且不含口令。 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { classifyConnectionError } from '../src/db/adapter.ts'
import { testConnection } from '../src/db/probe.ts'

function scratch(): { dir: string; sqliteFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dbqa-probe-'))
  const sqliteFile = join(dir, 'sample.db')
  const db = new DatabaseSync(sqliteFile)
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
  db.close()
  return { dir, sqliteFile }
}

test('sqlite probe opens read-only and reports version', async () => {
  const { dir, sqliteFile } = scratch()
  const result = await testConnection('sqlite', 'local', { filePath: sqliteFile }, {}, {
    dataDir: dir,
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(result.ok, true)
  assert.equal(result.readOnlyConfirmed, true)
  assert.match(result.versionRaw ?? '', /^3\.\d+/)
  assert.equal(result.errorCode, null)
})

test('sqlite probe reports a missing file without the full path', async () => {
  const { dir } = scratch()
  const result = await testConnection('sqlite', 'local', { filePath: join(dir, 'absent.db') }, {}, {
    dataDir: dir,
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'DBQA_FILE_MISSING')
  assert.match(result.errorDetail ?? '', /absent\.db/)
  assert.equal((result.errorDetail ?? '').includes(dir), false)
})

test('a missing env reference fails before dialing out', async () => {
  const { dir } = scratch()
  const result = await testConnection(
    'mysql',
    'prod',
    { host: '127.0.0.1', port: 1, user: 'qa' },
    { password: { kind: 'env', var: 'DBQA_TEST_ABSENT' } },
    { dataDir: dir, signal: AbortSignal.timeout(5_000), env: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'DBQA_ENV_MISSING')
  assert.match(result.errorDetail ?? '', /DBQA_TEST_ABSENT/)
})

test('mysql refusal keeps the password out of the message', async () => {
  const { dir } = scratch()
  const secret = 'Sup3rSecretPassw0rd'
  const result = await testConnection(
    'mysql',
    'prod',
    { host: '127.0.0.1', port: 1, user: 'qa', connectTimeoutMs: 1_000 },
    { password: { kind: 'env', var: 'DBQA_TEST_PW' } },
    { dataDir: dir, signal: AbortSignal.timeout(5_000), env: { DBQA_TEST_PW: secret } },
  )
  assert.equal(result.ok, false)
  assert.equal(result.errorDetail?.includes(secret), false)
  assert.match(result.errorDetail ?? '', /127\.0\.0\.1:1/)
  assert.ok(['DBQA_CONN_REFUSED', 'DBQA_HOST_UNREACHABLE', 'DBQA_TIMEOUT', 'DBQA_QUERY_FAILED'].includes(String(result.errorCode)))
})

test('postgres refusal is classified and redacted', async () => {
  const { dir } = scratch()
  const secret = 'pg-Sup3rSecret'
  const result = await testConnection(
    'postgresql',
    'prod',
    { host: '127.0.0.1', port: 1, database: 'app', user: 'qa', connectTimeoutMs: 1_000 },
    { password: { kind: 'env', var: 'DBQA_TEST_PG_PW' } },
    { dataDir: dir, signal: AbortSignal.timeout(5_000), env: { DBQA_TEST_PG_PW: secret } },
  )
  assert.equal(result.ok, false)
  assert.equal(result.errorDetail?.includes(secret), false)
})

test('driver errors map to the documented codes', () => {
  assert.equal(classifyConnectionError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'mysql'), 'DBQA_CONN_REFUSED')
  assert.equal(classifyConnectionError(Object.assign(new Error('getaddrinfo ENOTFOUND db'), { code: 'ENOTFOUND' }), 'mysql'), 'DBQA_HOST_UNREACHABLE')
  assert.equal(classifyConnectionError(Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' }), 'mysql'), 'DBQA_AUTH_FAILED')
  assert.equal(classifyConnectionError(Object.assign(new Error('certificate verify failed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }), 'postgresql'), 'DBQA_TLS_VERIFY')
  assert.equal(classifyConnectionError(new Error('SQLITE_CANTOPEN: unable to open database file'), 'sqlite'), 'DBQA_FILE_MISSING')
  assert.equal(classifyConnectionError(new Error('boom'), 'postgresql'), 'DBQA_QUERY_FAILED')
})
