/**
 * 只读闸门：在 SQL 交给适配器之前挡住写操作与 DDL。
 *
 * 判定顺序与《技术设计》§7.1 一致：先抹掉注释与字符串字面量，再依次检查
 * 空语句、多语句、首个关键字、写关键字、PRAGMA 白名单与 PostgreSQL 特例。
 * 被拒时抛 `DBQA_SQL_REJECTED`，消息同时给中英文（工具执行上下文没有
 * 界面语言，而拒绝原因必须双语可读）。
 *
 * 闸门是纵深防御的一层，不是唯一一层：适配器仍以只读身份连接（AGENTS.md
 * R10、R11），数据库账号权限才是最终边界。
 *
 * @module
 */
import type { DbType } from '../db/fields.ts'
import { DbqaError } from '../errors.ts'
import { translateBilingual } from '../i18n.ts'

/** 允许作为第一条语句的关键字。 */
const FIRST_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'describe', 'desc', 'pragma', 'table'])

/** 任何位置出现都视为写操作的词。 */
const WRITE_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'replace',
  'create',
  'alter',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'call',
  'exec',
  'execute',
  'load',
  'copy',
  'attach',
  'detach',
  'vacuum',
  'reindex',
  'analyze',
] as const

const WRITE_PATTERN = new RegExp(`\\b(${WRITE_KEYWORDS.join('|')})\\b`, 'i')

/** 只读 PRAGMA 白名单；写结构、改编译选项的一律不放行。 */
export const READ_ONLY_PRAGMAS: readonly string[] = Object.freeze([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'foreign_key_list',
  'database_list',
  'compile_options',
])

const PRAGMA_ALLOWED = new Set(READ_ONLY_PRAGMAS)

/** PostgreSQL 上只读语义下必须挡住的内置函数。 */
const POSTGRES_FUNCTIONS = ['set_config', 'pg_terminate_backend', 'pg_cancel_backend'] as const

/** 一次通过闸门的语句。 */
export interface GatedSql {
  /** 去掉尾部空白与结尾分号后的可执行 SQL。 */
  readonly sql: string
  /** 首关键字（小写）。 */
  readonly keyword: string
}

/** 拒绝原因；`params` 会写进错误对象方便审计与界面展示。 */
function reject(rule: string, key: string, params: Record<string, string | number> = {}): DbqaError {
  return new DbqaError('DBQA_SQL_REJECTED', translateBilingual(key, params), { rule, ...params })
}

/**
 * 抹掉注释与字符串字面量，保留结构与空白。
 *
 * 这样 `-- delete`、`/* drop *\/`、`WHERE note = 'delete'` 不会被误判，
 * 而 `DROP TABLE`、`SELECT 1; DROP TABLE t` 仍会被看到。
 * @param sql - 原始 SQL。
 * @param backslashEscapes - 单引号内是否用 `\` 转义；PostgreSQL 标准模式不用。
 */
export function maskSql(sql: string, backslashEscapes = true): string {
  const output: string[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index] ?? ''
    const next = sql[index + 1] ?? ''
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      output.push(' ')
      continue
    }
    if (char === '#') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      output.push(' ')
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index += 2
      output.push(' ')
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      index += 1
      while (index < sql.length) {
        if (backslashEscapes && sql[index] === '\\' && quote === "'") {
          index += 2
          continue
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      // 保留一个占位，避免前后词粘连。
      output.push(quote === "'" ? " '' " : ' "" ')
      continue
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0]
      if (tag !== undefined) {
        const end = sql.indexOf(tag, index + tag.length)
        index = end === -1 ? sql.length : end + tag.length
        output.push(" '' ")
        continue
      }
    }
    output.push(char)
    index += 1
  }
  return output.join('')
}

/**
 * 校验一条 SQL 是否可以交给只读适配器。
 * @param rawSql - 模型生成的 SQL。
 * @param dbType - 目标数据库类型，用于施加 PostgreSQL 特例。
 * @returns 去掉结尾分号后的 SQL 与首关键字。
 * @throws DbqaError `DBQA_SQL_REJECTED`，消息为中英双语。
 */
export function assertReadOnlySql(rawSql: string, dbType: DbType): GatedSql {
  const trimmed = rawSql.trim()
  if (trimmed === '') throw reject('empty', 'dbqa.query.rejected.empty')

  let masked = maskSql(trimmed, dbType !== 'postgresql')

  // 只允许一条语句：去掉一个结尾分号后不得再有分号。
  const withoutTrailing = masked.replace(/;\s*$/, '')
  if (withoutTrailing.trim() === '') throw reject('empty', 'dbqa.query.rejected.empty')
  if (withoutTrailing.includes(';')) throw reject('multi-statement', 'dbqa.query.rejected.multiStatement')

  const keyword = /^\s*([a-z]+)/i.exec(withoutTrailing)?.[1]?.toLowerCase()
  // 以写操作开头时按「写操作」报错，比「不认识的关键字」更直白。
  if (keyword !== undefined && (WRITE_KEYWORDS as readonly string[]).includes(keyword)) {
    throw reject('write-keyword', 'dbqa.query.rejected.writeKeyword', { keyword: keyword.toUpperCase() })
  }
  if (keyword === undefined || !FIRST_KEYWORDS.has(keyword)) {
    throw reject('first-keyword', 'dbqa.query.rejected.firstKeyword', {
      keyword: keyword ?? '',
    })
  }

  // `SHOW CREATE TABLE ...` 是只读语句，先把其中的 CREATE 抹掉再查写关键字。
  if (keyword === 'show' && /^\s*show\s+(full\s+)?create\s+/i.test(withoutTrailing)) {
    masked = withoutTrailing.replace(/\bcreate\b/i, '      ')
  }

  // `REPLACE(...)` / `REPLACE(col, ...)` 是标量函数，不是 REPLACE 语句。
  const scanned = masked.replace(/\breplace\s*\(/gi, '         (')

  const write = WRITE_PATTERN.exec(scanned)
  if (write !== null) {
    const found = (write[1] ?? '').toLowerCase()
    throw reject('write-keyword', 'dbqa.query.rejected.writeKeyword', { keyword: found.toUpperCase() })
  }

  if (/\bfor\s+update\b/i.test(scanned)) {
    throw reject('for-update', 'dbqa.query.rejected.writeKeyword', { keyword: 'FOR UPDATE' })
  }
  if (/\block\b/i.test(scanned)) {
    throw reject('lock', 'dbqa.query.rejected.writeKeyword', { keyword: 'LOCK' })
  }
  if (/\binto\s+(outfile|dumpfile)\b/i.test(scanned)) {
    throw reject('into-outfile', 'dbqa.query.rejected.writeKeyword', { keyword: 'INTO OUTFILE' })
  }
  if (dbType === 'postgresql') {
    if (/\binto\b/i.test(scanned)) {
      throw reject('select-into', 'dbqa.query.rejected.writeKeyword', { keyword: 'SELECT INTO' })
    }
    for (const fn of POSTGRES_FUNCTIONS) {
      if (new RegExp(`\\b${fn}\\b`, 'i').test(scanned)) {
        throw reject('postgres-function', 'dbqa.query.rejected.writeKeyword', { keyword: fn })
      }
    }
  }

  if (keyword === 'pragma') {
    const name =
      /^pragma\s+(?:""|[A-Za-z0-9_$]+)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)/i.exec(withoutTrailing)?.[1]
      ?? /^pragma\s+([A-Za-z_][A-Za-z0-9_$]*)/i.exec(withoutTrailing)?.[1]
      ?? ''
    if (!PRAGMA_ALLOWED.has(name.toLowerCase())) {
      throw reject('pragma', 'dbqa.query.rejected.pragma', {
        keyword: name === '' ? 'PRAGMA' : `PRAGMA ${name}`,
        allowed: READ_ONLY_PRAGMAS.join(', '),
      })
    }
  }

  const executable = trimmed.replace(/;+\s*$/, '')
  if (executable === '') throw reject('empty', 'dbqa.query.rejected.empty')
  return { sql: executable, keyword }
}
