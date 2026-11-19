/** 两份字典键集合必须一致，且字段定义的文案键都要有译文。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { FIELD_DEFS } from '../src/db/fields.ts'

const root = new URL('..', import.meta.url).pathname
const en = JSON.parse(readFileSync(`${root}locale/en.json`, 'utf8')) as Record<string, string>
const zh = JSON.parse(readFileSync(`${root}locale/zh.json`, 'utf8')) as Record<string, string>

test('en and zh expose the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('every field label, hint and validation key is translated', () => {
  const required = new Set<string>()
  for (const defs of Object.values(FIELD_DEFS)) {
    for (const def of defs) {
      required.add(def.labelKey)
      if (def.hintKey !== undefined) required.add(def.hintKey)
    }
  }
  const source = readFileSync(`${root}src/db/fields.ts`, 'utf8')
  for (const match of source.matchAll(/'dbqa\.(?:validation|field|group)\.[a-zA-Z0-9.]+'/g)) {
    required.add(match[0].slice(1, -1))
  }
  const missing = [...required].filter((key) => en[key] === undefined || zh[key] === undefined)
  assert.deepEqual(missing, [])
})

test('every error code has both messages', () => {
  const source = readFileSync(`${root}src/errors.ts`, 'utf8')
  const codes = [...source.matchAll(/'(DBQA_[A-Z_]+)'/g)].map((match) => match[1])
  const missing = [...new Set(codes)].filter(
    (code) => en[`dbqa.error.${code}`] === undefined || zh[`dbqa.error.${code}`] === undefined,
  )
  assert.deepEqual(missing, [])
})
