/**
 * 截止时间：超时先返回、外层取消原样传递、挂起语句不会把工具调用拖住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isTimeoutFailure, raceAbort, startDeadline, withDeadline } from '../src/db/deadline.ts'
import type { DbSession } from '../src/db/session.ts'
import { DbqaError } from '../src/errors.ts'
import { executeWithLimit } from '../src/query/execute.ts'

test('withDeadline passes a fast result through and disposes the timer', async () => {
  const value = await withDeadline(AbortSignal.timeout(5_000), 1_000, 'timeout', async () => 42)
  assert.equal(value, 42)
})

test('withDeadline reports an expired budget as DBQA_TIMEOUT with the given text', async () => {
  await assert.rejects(
    withDeadline(AbortSignal.timeout(5_000), 40, '超过 1 秒仍未返回', async (signal) => {
      assert.equal(signal.aborted, false)
      return new Promise<never>(() => undefined)
    }),
    (error: unknown) => error instanceof DbqaError && error.code === 'DBQA_TIMEOUT'
      && error.message.includes('超过 1 秒仍未返回'),
  )
})

test('startDeadline mirrors the parent signal and stops after dispose', () => {
  const parent = new AbortController()
  const deadline = startDeadline(parent.signal, 5_000, 'x')
  assert.equal(deadline.timedOut(), false)
  parent.abort(new DbqaError('DBQA_TIMEOUT', 'parent gone'))
  assert.equal(deadline.signal.aborted, true)
  assert.equal(deadline.timedOut(), false, 'a parent abort is not this deadline timing out')
  deadline.dispose()
})

test('an outer cancellation keeps its own error instead of becoming a timeout', async () => {
  const outer = new AbortController()
  const reason = new DbqaError('DBQA_NO_DATASOURCE', 'no datasource bound')
  const pending = withDeadline(outer.signal, 5_000, 'call timeout', async () => new Promise<never>(() => undefined))
  setTimeout(() => outer.abort(reason), 10)
  await assert.rejects(pending, (error: unknown) => error === reason)
})

test('raceAbort rejects immediately on an already aborted signal', async () => {
  const controller = new AbortController()
  const reason = new DbqaError('DBQA_TIMEOUT', 'already gone')
  controller.abort(reason)
  await assert.rejects(raceAbort(Promise.resolve(1), controller.signal), (error: unknown) => error === reason)
})

test('isTimeoutFailure only matches DBQA_TIMEOUT', () => {
  assert.equal(isTimeoutFailure(new DbqaError('DBQA_TIMEOUT', 'x')), true)
  assert.equal(isTimeoutFailure(new DbqaError('DBQA_QUERY_FAILED', 'x')), false)
  assert.equal(isTimeoutFailure(new Error('x')), false)
})

/** 所有方法都立刻返回、只有 query 会挂住的假会话。 */
function hangingSession(seen: AbortSignal[]): DbSession {
  const empty = { columns: [] as string[], rows: [] as never[][], rowCount: 0, truncated: false, durationMs: 0 }
  return {
    listTables: async () => [],
    describeTable: async () => [],
    tableDdl: async () => ({ ddl: '', indexes: [], foreignKeys: [] }),
    sampleRows: async () => empty,
    query: (_sql, _limit, signal) => {
      seen.push(signal)
      return new Promise(() => undefined)
    },
    close: async () => undefined,
  }
}

test('a hanging statement is abandoned when the statement deadline expires', async () => {
  const seen: AbortSignal[] = []
  const startedAt = Date.now()
  await assert.rejects(
    executeWithLimit(hangingSession(seen), 'SELECT 1', 10, 60, AbortSignal.timeout(5_000)),
    (error: unknown) => error instanceof DbqaError && error.code === 'DBQA_TIMEOUT',
  )
  // 工具必须自己先返回，而不是等驱动把那条语句跑完。
  assert.ok(Date.now() - startedAt < 2_000, 'the call must return without waiting for the statement')
  assert.equal(seen[0]?.aborted, true, 'the statement must see an aborted signal so the adapter can drop it')
})
