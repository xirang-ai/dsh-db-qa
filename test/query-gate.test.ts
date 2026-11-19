/**
 * 只读闸门：放行查询、拒绝写操作与多语句，并给出中英双语错误。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DbqaError } from '../src/errors.ts'
import { assertReadOnlySql, READ_ONLY_PRAGMAS } from '../src/query/gate.ts'

function rejection(sql: string, dbType: 'sqlite' | 'postgresql' | 'mysql' = 'sqlite'): DbqaError {
  try {
    assertReadOnlySql(sql, dbType)
  } catch (error) {
    assert.ok(error instanceof DbqaError)
    return error
  }
  assert.fail(`expected rejection for ${sql}`)
}

test('accepts read-only queries and keeps comments out of the decision', () => {
  for (const sql of [
    'SELECT 1',
    'select id, name from users where id = 1',
    'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
    'EXPLAIN SELECT * FROM users',
    'SHOW CREATE TABLE users',
    'DESCRIBE users',
    'TABLE users',
    'PRAGMA table_info(users)',
    '-- delete is mentioned in a comment\nSELECT 1',
    "SELECT 'update users set x = 1' AS text",
    "SELECT replace(name, 'a', 'b') FROM users",
  ]) {
    const gated = assertReadOnlySql(sql, 'mysql')
    assert.equal(typeof gated.keyword, 'string')
    assert.ok(gated.sql.length > 0)
  }
  assert.ok(READ_ONLY_PRAGMAS.includes('table_info'))
})

test('rejects writes, DDL and multiple statements with bilingual errors', () => {
  for (const sql of [
    'INSERT INTO users (id) VALUES (1)',
    'UPDATE users SET name = \'x\'',
    'DELETE FROM users',
    'CREATE TABLE t (id int)',
    'DROP TABLE users',
    'TRUNCATE TABLE users',
    'ALTER TABLE users ADD COLUMN x int',
    'GRANT ALL ON users TO someone',
    'VACUUM',
    'SELECT 1; DELETE FROM users',
    'PRAGMA writable_schema = ON',
    'PRAGMA foreign_keys = OFF',
  ]) {
    const error = rejection(sql)
    assert.equal(error.code, 'DBQA_SQL_REJECTED')
    assert.match(error.message, /只读闸门|查询语句|不允许执行|一次只允许一条语句/)
    assert.match(error.message, /read-only gate|Only one statement|is not allowed/)
  }
})

test('rejects PostgreSQL SELECT INTO and session-killing functions', () => {
  for (const sql of [
    'SELECT * INTO backup FROM users',
    'SELECT set_config(\'x\', \'y\', false)',
    'SELECT pg_terminate_backend(123)',
  ]) {
    const error = rejection(sql, 'postgresql')
    assert.equal(error.code, 'DBQA_SQL_REJECTED')
  }
})

test('rejects empty SQL', () => {
  const error = rejection('   -- nothing here\n')
  assert.equal(error.code, 'DBQA_SQL_REJECTED')
  assert.match(error.message, /没有任何 SQL|no SQL/i)
})
