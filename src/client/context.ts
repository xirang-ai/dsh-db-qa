/**
 * 面板依赖的最小客户端上下文契约。
 *
 * 类型包 `dsh-client-ui-slots` 不随插件安装；这里只声明本插件用到的
 * 方法，组件保持纯 props（AGENTS.md R20）。
 *
 * @module
 */
import type { RemoteContributionLike } from './remote.ts'

/** 释放函数。 */
export type Disposer = () => void

/** 文案函数；`{name}` 占位符由 locale 服务替换。 */
export type TranslateFn = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * 宿主会话列表快照里本插件用到的字段。
 *
 * 列表时间取 `updatedAt`：宿主算的是「创建时间与最后一条用户消息时间里的较大值」，
 * 也就是会话最后一次真正被提问的时间——打开会话、执行工具都不会改它。
 */
export interface SessionListSnapshot {
  readonly byId: Readonly<Record<string, {
    readonly title?: string
    readonly updatedAt?: number
    readonly projectionValues?: Readonly<Record<string, unknown>>
  } | undefined>>
}

/** 宿主注入的 `useSessions` 选择器 hook（标准 props，任何作用域都有）。 */
export type UseSessions = <Selected>(selector: (state: SessionListSnapshot) => Selected) => Selected

/** locale 服务。 */
export interface LocaleService {
  register(
    namespace: string,
    dictionaries: { readonly en: Readonly<Record<string, string>>; readonly zh: Readonly<Record<string, string>> },
  ): Disposer
  bind(namespace: string): TranslateFn
  getLocale(): { readonly active: string; readonly locales: readonly { readonly id: string; readonly label: string }[] }
}

/** 槽位注册参数（只列本插件用到的字段）。 */
export interface SlotOptions<Props> {
  readonly name: string
  readonly id?: string
  readonly key?: string
  readonly order?: number
  readonly locale?: string
  readonly label?: () => string
  readonly inject?: () => Props
}

/**
 * 槽位服务。
 *
 * 组件拿到的 props 分两半：`inject` 返回的业务 props，加上宿主按作用域补的
 * 标准 props（会话作用域的 `sessionId` / `useSessions` 等）。所以 `inject`
 * 只提供一部分，`Props` 由组件自己声明。
 */
export interface SlotService {
  register<Props extends object>(
    options: SlotOptions<Partial<Props>>,
    component: (props: Props) => unknown,
  ): Disposer
  inject(slot: string, declare: () => Disposer): Disposer
}

/** Remote 挂载入口。 */
export interface RemoteService {
  $mount(contribution: RemoteContributionLike): Promise<Disposer>
}

/** 布局服务里本插件用到的部分：只借导航信号判断「侧栏入口被点击」。 */
export interface LayoutService {
  /** 开始一次导航；下一次 `selectPanel` 会 abort 上一次返回的信号。 */
  beginNavigation(): AbortSignal
}

/**
 * 主面板选择信号。
 *
 * 侧栏每次点击主面板入口都会 `selectPanel`，即使点的是当前入口；面板据此
 * 把自己重置到问答列表（需求 2）。组件只拿到订阅函数，不接触布局服务。
 */
export interface PanelSelectionFeed {
  subscribe(listener: () => void): Disposer
}

/** 插件自己持有的信号源：比面板拿到的多一个 dispose。 */
export interface PanelSelectionSource extends PanelSelectionFeed {
  dispose(): void
}

/** 插件拿到的客户端上下文。 */
export interface ClientContext {
  effect(setup: () => Disposer, label?: string): Disposer
  readonly locale: LocaleService
  readonly slots: SlotService
  get<T>(name: string): T
}
