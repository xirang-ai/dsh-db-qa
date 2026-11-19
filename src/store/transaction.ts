/**
 * 事务原语：启动路径与数据访问层共用。
 *
 * 单独成文件，避免「打开数据库」与「在已打开句柄上读写」互相 import 成环。
 *
 * @module
 */
import type { DatabaseSync } from 'node:sqlite'

import { describeError } from '../errors.ts'

/**
 * 在一个 IMMEDIATE 事务里执行 `body`，抛错即回滚。
 * @param db - 拥有该事务的已打开数据库。
 * @param body - 事务内要执行的同步逻辑。
 * @returns `body` 的返回值。
 */
export function withTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = body()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `dbqa: database transaction failed and its rollback failed: ${describeError(error)}`,
      )
    }
    throw error
  }
}
