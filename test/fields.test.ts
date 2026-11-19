/**
 * 字段定义：三种类型、无 DSN、就地校验、敏感值引用与明文的口径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  endpointHint,
  FIELD_DEFS,
  fieldsFor,
  formatSecretRef,
  initialValues,
  mergeSecrets,
  parseSecretRef,
  resolveConfig,
  splitDraft,
  validateDraft,
} from '../src/db/fields.ts'

test('every type has a field set and no field accepts a full DSN', () => {
  for (const type of ['mysql', 'postgresql', 'sqlite'] as const) {
    const keys = FIELD_DEFS[type].map((def) => def.key)
    assert.ok(keys.includes('name'))
    for (const key of keys) {
      assert.ok(!/dsn|connectionString|connection_string/i.test(key), `${type}.${key} looks like a DSN field`)
      assert.ok(!/dsn|connection string/i.test(key), `${type}.${key} looks like a DSN field`)
    }
  }
  assert.ok(FIELD_DEFS.mysql.some((def) => def.key === 'socketPath'))
  assert.ok(FIELD_DEFS.postgresql.some((def) => def.key === 'sslMode'))
  assert.ok(FIELD_DEFS.sqlite.some((def) => def.key === 'filePath'))
  assert.ok(FIELD_DEFS.mysql.some((def) => def.key === 'useSsh'))
  assert.ok(FIELD_DEFS.postgresql.some((def) => def.key === 'useSsh'))
  assert.ok(!FIELD_DEFS.sqlite.some((def) => def.key === 'useSsh'))
})

test('initial values never prefill secrets', () => {
  for (const type of ['mysql', 'postgresql', 'sqlite'] as const) {
    const values = initialValues(type)
    for (const def of FIELD_DEFS[type]) {
      if (def.secret) assert.equal(values[def.key], undefined)
    }
  }
})

test('mysql TLS defaults to DISABLED', () => {
  const def = FIELD_DEFS.mysql.find((entry) => entry.key === 'sslMode')
  assert.equal(def?.default, 'DISABLED')
  assert.equal(initialValues('mysql').sslMode, 'DISABLED')
  const resolved = resolveConfig(
    'mysql',
    'db',
    { host: '127.0.0.1', port: 3306, user: 'reader' },
    {},
    {},
  )
  assert.equal(resolved.type, 'mysql')
  if (resolved.type === 'mysql') assert.equal(resolved.ssl.mode, 'DISABLED')
})

test('required, numeric and dependent-switch validation report per field', () => {
  const missing = validateDraft('mysql', { name: '' })
  assert.ok(missing.some((issue) => issue.field === 'name' && issue.code === 'required'))

  const port = validateDraft('mysql', {
    name: 'db',
    transport: 'tcp',
    host: '127.0.0.1',
    port: 'abc',
    user: 'reader',
  })
  assert.ok(port.some((issue) => issue.field === 'port'))

  const socketAndSsh = validateDraft('mysql', {
    name: 'db',
    transport: 'socket',
    socketPath: '/tmp/mysql.sock',
    user: 'reader',
    useSsh: true,
    sshHost: 'jump',
    sshPort: '22',
    sshUser: 'ops',
    sshAuth: 'password',
  })
  assert.ok(socketAndSsh.some((issue) => issue.code === 'sshSocket'))

  const missingSshUser = validateDraft('postgresql', {
    name: 'db',
    host: '127.0.0.1',
    port: '5432',
    database: 'app',
    user: 'reader',
    useSsh: true,
    sshHost: 'jump',
    sshPort: '22',
  })
  assert.ok(missingSshUser.some((issue) => issue.field === 'sshUser' && issue.code === 'required'))
})

test('TLS dependencies are enforced', () => {
  const mysql = validateDraft('mysql', {
    name: 'db',
    transport: 'tcp',
    host: '127.0.0.1',
    port: '3306',
    user: 'reader',
    sslMode: 'VERIFY_CA',
  })
  assert.ok(mysql.some((issue) => issue.code === 'tlsCa'))

  const pg = validateDraft('postgresql', {
    name: 'db',
    host: '127.0.0.1',
    port: '5432',
    database: 'app',
    user: 'reader',
    sslMode: 'verify-full',
  })
  assert.ok(pg.some((issue) => issue.code === 'tlsRootCert'))
})

test('secrets accept env references or plaintext and are split out of config', () => {
  assert.equal(parseSecretRef('env:'), 'invalid')
  const ref = parseSecretRef('env:DBQA_PW')
  assert.equal(ref !== undefined && ref !== 'invalid' && ref.kind === 'env' ? ref.var : null, 'DBQA_PW')

  const plaintext = validateDraft('mysql', {
    name: 'db',
    transport: 'tcp',
    host: '127.0.0.1',
    port: '3306',
    user: 'reader',
    password: 'hunter2',
  })
  assert.deepEqual(plaintext, [])

  const plainSplit = splitDraft('mysql', {
    name: 'db',
    transport: 'tcp',
    host: '127.0.0.1',
    port: '3306',
    user: 'reader',
    password: 'hunter2',
  })
  assert.equal(plainSplit.ok, true)
  if (!plainSplit.ok) return
  assert.equal(plainSplit.value.config['password'], undefined)
  assert.deepEqual(plainSplit.value.secrets['password'], { kind: 'plain', value: 'hunter2' })

  const split = splitDraft('mysql', {
    name: 'db',
    transport: 'tcp',
    host: '127.0.0.1',
    port: '3306',
    user: 'reader',
    password: 'env:DBQA_PW',
  })
  assert.equal(split.ok, true)
  if (!split.ok) return
  assert.equal(split.value.config['password'], undefined)
  const savedRef = split.value.secrets['password']
  assert.equal(savedRef !== undefined && savedRef.kind === 'env' ? savedRef.var : null, 'DBQA_PW')
  assert.equal(split.value.config['port'], 3306)
})

test('resolveConfig fails loudly when the env var is missing and never embeds it', () => {
  assert.throws(
    () =>
      resolveConfig(
        'postgresql',
        'db',
        { host: '127.0.0.1', port: 5432, database: 'app', user: 'reader' },
        { password: { kind: 'env', var: 'DBQA_MISSING_PW' } },
        { env: {} },
      ),
    (error: unknown) => (error as { code?: string }).code === 'DBQA_ENV_MISSING',
  )

  const resolved = resolveConfig(
    'postgresql',
    'db',
    { host: '127.0.0.1', port: 5432, database: 'app', user: 'reader' },
    { password: { kind: 'env', var: 'DBQA_PW' } },
    { env: { DBQA_PW: 'secret-value' } },
  )
  assert.equal(resolved.type, 'postgresql')
  if (resolved.type === 'postgresql') assert.equal(resolved.password, 'secret-value')
})

test('version narrowing does not invalidate an already stored SSL mode', () => {
  const legacy = validateDraft('mysql', {
    name: 'db',
    transport: 'tcp',
    host: '127.0.0.1',
    port: '3306',
    user: 'reader',
    sslMode: 'PREFERRED',
  }, 50743)
  assert.equal(legacy.length, 0)
  const bogus = validateDraft('mysql', {
    name: 'db',
    transport: 'tcp',
    host: '127.0.0.1',
    port: '3306',
    user: 'reader',
    sslMode: 'SOMETHING_ELSE',
  }, 50743)
  assert.ok(bogus.some((issue) => issue.field === 'sslMode' && issue.code === 'enum'))
})

test('version gating disables new fields and narrows MySQL SSL modes', () => {
  const old = fieldsFor('mysql', 50700)
  const sslMode = old.find((def) => def.key === 'sslMode')
  assert.deepEqual([...(sslMode?.options ?? [])], ['DISABLED', 'REQUIRED', 'VERIFY_CA'])
  assert.equal(old.find((def) => def.key === 'authPlugin')?.disabledByVersion, true)

  const modern = fieldsFor('mysql', 80000)
  assert.equal(modern.find((def) => def.key === 'authPlugin')?.disabledByVersion, false)
  assert.deepEqual([...(modern.find((def) => def.key === 'sslMode')?.options ?? [])], [
    'DISABLED',
    'PREFERRED',
    'REQUIRED',
    'VERIFY_CA',
    'VERIFY_IDENTITY',
  ])
})

test('endpoint hints stay redacted', () => {
  assert.equal(endpointHint('mysql', { transport: 'tcp', host: 'db.internal', port: 3306 }), 'db.internal:3306')
  assert.equal(endpointHint('sqlite', { filePath: '/var/data/app.sqlite' }), 'app.sqlite')
  const mysql = endpointHint('mysql', { transport: 'tcp', host: 'db.internal', port: 3306, password: 'hunter2' })
  assert.ok(!mysql.includes('hunter2'))
})

test('mysql exposes the optional database field and carries it into the connection config', () => {
  const defs = FIELD_DEFS.mysql
  assert.ok(defs.some((def) => def.key === 'database' && def.required !== true))
  const config = resolveConfig(
    'mysql',
    'db',
    { transport: 'tcp', host: 'db.internal', port: 3306, user: 'reader', database: 'analytics' },
    {},
  )
  assert.equal(config.type === 'mysql' ? config.database : null, 'analytics')
})

test('stored secrets are echoed into the edit form', () => {
  assert.equal(formatSecretRef({ kind: 'plain', value: 'hunter2' }), 'hunter2')
  assert.equal(formatSecretRef({ kind: 'env', var: 'DBQA_PW' }), 'env:DBQA_PW')
  assert.equal(formatSecretRef(undefined), '')
})

test('editing keeps a stored secret when the field is left blank', () => {
  const merged = mergeSecrets(
    'mysql',
    {},
    { password: { kind: 'plain', value: 'hunter2' }, sslKeyPassphrase: { kind: 'env', var: 'KEY_PW' } },
  )
  assert.deepEqual(merged.password, { kind: 'plain', value: 'hunter2' })
  assert.deepEqual(merged.sslKeyPassphrase, { kind: 'env', var: 'KEY_PW' })
})
