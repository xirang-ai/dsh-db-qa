/**
 * 宿主入口：打开插件自己的元数据库，把它发布成 `dbqa` 服务，并在宿主带
 * Typert 网关时挂上面板数据通道。
 *
 * 打开数据库是副作用，全部放进 `ctx.effect`；返回的 disposer 是唯一允许
 * 关闭它的入口（AGENTS.md R2）。`typert` 是可选能力，用 `ctx.inject` 探测，
 * 不写进静态 `inject`。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.ts'
import type { Config as DbqaConfig } from './config.ts'
import { openDbqaDatabase } from './store/db.ts'
import { DbqaWorkbenchService } from './remote/service.ts'
import { TYPERT_MANIFEST } from './remote/contract.ts'

/** 注册表对外暴露的最小接口：`typert` 服务实际提供了 `register`。 */
interface TypertRegistrar {
  register(contribution: unknown): () => void
}

/** 插件 id，同时是 `dbqa` 服务键与 patch 行 id。 */
export const name = 'dbqa'

/** 没有必需的宿主服务；`typert` 在 apply 里按需探测。 */
export const inject = [] as const

export { Config }
export type { DbqaConfig }

/**
 * 把插件接到宿主上下文。
 * @param ctx - 本插件的宿主上下文。
 * @param config - 已校验的配置。
 */
export function apply(ctx: Context, config: DbqaConfig): void {
  const logger = ctx.logger('dbqa')

  ctx.effect(() => {
    const database = openDbqaDatabase({
      ...(config.dataDir === '' ? {} : { dataDir: config.dataDir }),
      log: logger,
    })

    // 服务必须挂在插件自己的上下文上：Gateway 从描述表所属的上下文解析实现。
    ctx.provide('dbqa', database)
    // 预设里的工具只拿到这个窄面：元数据库 + 已校验配置。
    ctx.provide('dbqaAnalysis', { database, config })
    ctx.provide('dbqaQuery', { database, config })

    ctx.inject(['typert'], (registryCtx) => {
      const typert = registryCtx.get('typert') as unknown as TypertRegistrar | undefined
      if (typert === undefined) return
      void new DbqaWorkbenchService(ctx, database, config)
      return typert.register(TYPERT_MANIFEST)
    })

    return () => {
      database.close()
    }
  }, 'dbqa: metadata database')
}

export { openDbqaDatabase } from './store/db.ts'
export type { DbqaDatabase, OpenDatabaseOptions, StartupReport, StartupOutcome } from './store/db.ts'
export { DbqaError, describeError } from './errors.ts'
