/**
 * 首次提问对账：只认真人 user/message，只给查询预设建列表行。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { titleFromContent, watchFirstQuestions } from '../src/session-recorder.ts'
import { openDbqaDatabase, SILENT_LOGGER } from '../src/store/db.ts'

interface SessionLike {
  readonly id: string
  readonly header: { readonly agentPreset?: string | null }
}

interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

type Listener = (session: SessionLike, event: SessionEventLike) => void

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dbqa-recorder-'))
}

/** 最小 ctx：`on` 返回 disposer，`get` 给出可选的投影读面。 */
function fakeContext(preset: string | null): { ctx: Context; emit: Listener; disposed: () => boolean } {
  const listeners: Listener[] = []
  let disposed = false
  const ctx = {
    on: (_name: string, listener: Listener) => {
      listeners.push(listener)
      return () => {
        disposed = true
        listeners.length = 0
      }
    },
    get: (name: string) =>
      name === 'sessionProjections'
        ? { snapshot: () => ({ values: { agentPreset: preset } }) }
        : undefined,
  }
  return {
    ctx: ctx as unknown as Context,
    emit: (session, event) => {
      for (const listener of listeners) listener(session, event)
    },
    disposed: () => disposed,
  }
}

function message(text: string, kind = 'user'): SessionEventLike {
  return { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } }
}

test('the first human question starts the conversation with a normalized title', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  const { ctx, emit } = fakeContext('dbqa-query')
  try {
    const stop = watchFirstQuestions(ctx, database, SILENT_LOGGER)
    emit({ id: 's1', header: {} }, message('  上月\n华东   退货率为什么涨  '))
    const row = database.conversations.getBySession('s1')
    assert.equal(row?.title, '上月 华东 退货率为什么涨')
    assert.equal(row?.agentKind, 'query')
    assert.ok((row?.startedAt ?? 0) > 0)
    stop()
  } finally {
    database.close()
  }
})

test('synthetic messages and analysis sessions are ignored', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  const { ctx, emit } = fakeContext('dbqa-query')
  try {
    watchFirstQuestions(ctx, database, SILENT_LOGGER)
    // skill / cron / agent.inject 的 source 不是 user，不算开始对话。
    emit({ id: 's1', header: {} }, message('skill payload', 'skill'))
    assert.equal(database.conversations.getBySession('s1'), null)

    const analysis = fakeContext('dbqa-analysis')
    watchFirstQuestions(analysis.ctx, database, SILENT_LOGGER)
    analysis.emit({ id: 's2', header: {} }, message('表结构怎么样'))
    assert.equal(database.conversations.getBySession('s2'), null)
  } finally {
    database.close()
  }
})

test('the projection wins over the creation-time preset', () => {
  const database = openDbqaDatabase({ dataDir: tempDir() })
  // 会话创建时是分析预设，空白期切到查询；投影才是当前值。
  const { ctx, emit } = fakeContext('dbqa-query')
  try {
    watchFirstQuestions(ctx, database, SILENT_LOGGER)
    emit({ id: 's1', header: { agentPreset: 'dbqa-analysis' } }, message('订单量'))
    assert.equal(database.conversations.getBySession('s1')?.agentKind, 'query')
  } finally {
    database.close()
  }
})

test('the title keeps the first 60 characters and skips control characters', () => {
  const long = 'a'.repeat(80)
  assert.equal(titleFromContent([{ type: 'text', text: long }]).length, 60)
  assert.equal(titleFromContent([{ type: 'text', text: 'a\u0000b\u202Ec' }]), 'a b c')
  assert.equal(titleFromContent([{ type: 'image' }]), '')
  assert.equal(titleFromContent(undefined), '')
})
