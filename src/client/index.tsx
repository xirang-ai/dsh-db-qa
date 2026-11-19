/**
 * 浏览器入口：注册文案、侧栏入口与主面板，并惰性挂载 Remote 通道。
 *
 * 侧栏入口与 `main` 面板必须成对注册（AGENTS.md R21）。组件是纯 props，
 * 拿到的 `data` 是「等待就绪」的 loader，不是半装好的 service（R24）。
 *
 * @module
 */
import type {
  ClientContext,
  Disposer,
  LayoutService,
  PanelSelectionSource,
  TranslateFn,
} from './context.ts'
import { DbqaIcon } from './icon.tsx'
import { DbqaPage } from './page.tsx'
import { DbqaSessionStrip } from './session.tsx'
import type { DbqaRemote } from './remote.ts'
import { unwrapRemote } from './remote.ts'
import { REMOTE_CONTRIBUTION } from '../remote/contract.ts'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }

/** 面板与侧栏入口共用的 id。 */
const PANEL_ID = 'dbqa.workbench'
/** 文案命名空间。 */
const NAMESPACE = 'dbqa'

/** 浏览器侧依赖的宿主服务。 */
export const inject = ['slots', 'locale', 'uiWorkspace', 'workspaces', 'layout'] as const

/**
 * 把「侧栏点击了任意主面板入口」变成可订阅信号。
 *
 * `LayoutController.selectPanel()` 每次都会先 abort 上一次
 * `beginNavigation()` 返回的信号，重复点击当前入口也一样；这里在每次
 * abort 后重新布防，面板收到信号就把视图重置到问答列表。
 */
function createPanelSelectionFeed(layout: LayoutService): PanelSelectionSource {
  const listeners = new Set<() => void>()
  let disposed = false
  let detach: (() => void) | null = null

  const arm = (): void => {
    if (disposed) return
    const signal = layout.beginNavigation()
    const onAbort = (): void => {
      detach = null
      if (disposed) return
      for (const listener of [...listeners]) listener()
      arm()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    detach = () => signal.removeEventListener('abort', onAbort)
  }
  arm()

  const feed: PanelSelectionSource = {
    subscribe(listener: () => void): Disposer {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: (): void => {
      disposed = true
      detach?.()
      detach = null
      listeners.clear()
    },
  }
  return feed
}

/** 惰性挂载 Remote 命名空间；失败会保留 rejection，由面板展示原因。 */
function createChannel(ctx: ClientContext): () => Promise<DbqaRemote> {
  let pending: Promise<DbqaRemote> | undefined
  return () => {
    pending ??= (async () => {
      const remote = ctx.get<{ $mount(contribution: unknown): Promise<Disposer> }>('remote')
      await remote.$mount(REMOTE_CONTRIBUTION)
      return ctx.get<DbqaRemote>(`remote.${NAMESPACE}`)
    })()
    return pending
  }
}

/** 注册侧栏入口与主面板。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { en, zh }), 'dbqa: locale dictionaries')
  const t: TranslateFn = ctx.locale.bind(NAMESPACE)
  const data = createChannel(ctx)
  const panelSelections = createPanelSelectionFeed(ctx.get<LayoutService>('layout'))
  ctx.effect(() => panelSelections.dispose, 'dbqa: panel selection feed')

  /** 默认工作区：宿主没给默认值时退回第一个。 */
  const defaultWorkspaceId = async (): Promise<string> => {
    const workspaces = ctx.get<{
      initializeDefault(): Promise<{ workspaceId: string } | undefined>
      list: { getSnapshot(): { items: readonly { workspaceId: string }[] } }
    }>('workspaces')
    const preferred = await workspaces.initializeDefault()
    const target = preferred ?? workspaces.list.getSnapshot().items[0]
    if (target === undefined) throw new Error('dbqa: no workspace available')
    return target.workspaceId
  }

  /** 打开一个带 `agentPreset` 标记的新会话；该标记就是会话页下拉的来源。 */
  const openPresetSession = async (
    agentPreset: string,
    beforeOpen?: (sessionId: string) => void,
  ): Promise<void> => {
    const workspace = ctx.get<{
      openWorkspace(
        workspaceId: string,
        beforeOpen?: (sessionId: string) => void,
        options?: { agentPreset?: string },
      ): Promise<void>
    }>('uiWorkspace')
    await workspace.openWorkspace(await defaultWorkspaceId(), beforeOpen, { agentPreset })
  }

  /** 手动触发分析：在默认工作区打开分析会话 → 写绑定。 */
  const startAnalysis = async (datasourceId: string): Promise<void> => {
    let sessionId: string | undefined
    let binding: Promise<void> | undefined
    await openPresetSession('dbqa-analysis', (opened) => {
      sessionId = opened
      binding = (async () => {
        const channel = await data()
        unwrapRemote(
          await channel['conversation.markActive']({
            sessionId: opened,
            datasourceId,
            agentKind: 'analysis',
          }),
        )
      })()
    })
    await binding
    if (sessionId === undefined) throw new Error('dbqa: analysis session was not opened')
  }

  /** 创建查询：新会话带查询标记，不预选数据源（由会话页下拉选择）。 */
  const startQuery = async (): Promise<void> => {
    await openPresetSession('dbqa-query')
  }

  /** 打开一条已有问答所在的会话。 */
  const openConversation = (sessionId: string): void => {
    ctx.get<{ openSession(target: string): void }>('uiWorkspace').openSession(sessionId)
  }

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NAMESPACE,
        inject: () => ({ t, data, startAnalysis, startQuery, openConversation, panelSelections }),
      },
      DbqaPage,
    ),
  )

  const sessionStrip = (slot: 'conversation.hero.options' | 'conversation.session.header.actions') => () =>
    ctx.slots.register(
      {
        name: slot,
        id: 'dbqa.datasource',
        order: 10,
        locale: NAMESPACE,
        inject: () => ({ t, data }),
      },
      DbqaSessionStrip,
    )

  // 空白会话把数据源放到 Agent 下拉后面；会话开始后 hero 行消失，改挂 header。
  ctx.slots.inject('conversation.hero.options', sessionStrip('conversation.hero.options'))
  ctx.slots.inject('conversation.session.header.actions', sessionStrip('conversation.session.header.actions'))

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 42,
        locale: NAMESPACE,
        label: () => t('dbqa.panel.title'),
      },
      DbqaIcon,
    ),
  )
}
