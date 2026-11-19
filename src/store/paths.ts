/**
 * 插件自有目录与数据库文件的位置。
 *
 * 数据只写进 `$DSH_HOME/xirang-ai/dsh-db-qa`（或用 `dataDir` 覆盖），
 * 不碰用户数据库文件本身，也不写工作区。展示路径统一用
 * {@link toDisplayPath} 做家目录脱敏。
 *
 * 元数据库文件命名为 `db-qa.sqlite`（《技术设计》§3）。
 *
 * @module
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { homedir } from 'node:os'
import { mkdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 插件在 DSH home 下的固定目录段。 */
export const PLUGIN_HOME_SEGMENTS = ['xirang-ai', 'dsh-db-qa'] as const

/** 重建版元数据库文件名。 */
export const DATABASE_FILENAME = 'db-qa.sqlite'

/** 默认数据目录：`$DSH_HOME/xirang-ai/dsh-db-qa`。 */
export function defaultDataDir(): string {
  return dshHomePath(...PLUGIN_HOME_SEGMENTS)
}

/**
 * 解析 `dataDir` 配置：空值走默认目录，`~` 展开，其余按当前目录绝对化。
 * @param configured - 配置原文；`''`/空白表示使用默认目录。
 */
export function resolveDataDir(configured?: string): string {
  const value = configured?.trim() ?? ''
  if (value === '') return defaultDataDir()
  if (value === '~') return homedir()
  if (value.startsWith(`~${sep}`) || value.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolve(value)
}

/**
 * 创建数据目录（仅本用户可读写）。
 * @param dataDir - {@link resolveDataDir} 的结果。
 * @throws 路径已被普通文件占用时抛错——配置错误必须在加载期就可见。
 */
export function ensureDataDir(dataDir: string): void {
  if (dataDir.includes('\0')) {
    throw new Error('dbqa: config "dataDir" must not contain a NUL byte')
  }
  let stat
  try {
    stat = statSync(dataDir)
  } catch {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    return
  }
  if (!stat.isDirectory()) {
    throw new Error(`dbqa: config "dataDir" points at a file, not a directory: ${dataDir}`)
  }
}

/** 元数据库文件路径。 */
export function databaseFile(dataDir: string): string {
  return join(dataDir, DATABASE_FILENAME)
}

/** 某个数据源的知识库目录（相对 dataDir 的 `knowledge/<datasource-id>`）。 */
export function knowledgeDir(dataDir: string, datasourceId: string): string {
  return join(dataDir, 'knowledge', datasourceId)
}

/** SSH 辅助文件目录（known_hosts、临时 askpass 脚本）。 */
export function sshDir(dataDir: string): string {
  return join(dataDir, 'ssh')
}
