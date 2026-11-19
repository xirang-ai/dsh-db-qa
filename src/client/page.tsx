/**
 * 数据源配置面板。
 *
 * 三个视图：主页（问题列表）、数据源列表、新增/编辑表单。表单字段全部由
 * 宿主下发的 `FieldDefView` 渲染——与连接装配共用同一份定义（AGENTS.md R22）。
 *
 * @module
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, MouseEvent } from 'react'

import type { DbType, FieldDefView, FieldValue, ValidationIssue } from '../db/fields.ts'
import type { DatasourceSummary } from '../store/datasource.ts'
import type {
  ConversationItemView,
  DatasourceDetail,
  KnowledgeReadResult,
  KnowledgeStatusResult,
} from '../remote/contract.ts'
import type { PanelSelectionFeed, SessionListSnapshot, TranslateFn, UseSessions } from './context.ts'
import { unwrapRemote, type DbqaRemote } from './remote.ts'
import { STYLES } from './styles.ts'
import { resolveKnowledgeLink, resolveTableRef } from './link.ts'
import { Markdown } from './markdown.tsx'

/** 面板属性：文案函数 + 惰性挂载的数据通道。 */
export interface DbqaPageProps {
  readonly t: TranslateFn
  readonly data: () => Promise<DbqaRemote>
  /** 宿主会话列表（标准 props）：问题列表的时间与排序都取会话的最后更新时间。 */
  readonly useSessions: UseSessions
  /** 手动触发一次分析：建会话、写绑定、打开会话。 */
  readonly startAnalysis?: (datasourceId: string) => Promise<void>
  /** 创建查询：打开一个带查询来源标记的新会话。 */
  readonly startQuery?: () => Promise<void>
  /** 打开某条问答所在的会话。 */
  readonly openConversation?: (sessionId: string) => void
  /** 侧栏主面板入口每次被点击都会触发；面板据此回到问答列表。 */
  readonly panelSelections?: PanelSelectionFeed
}

type View =
  | { readonly kind: 'home' }
  | { readonly kind: 'list' }
  | { readonly kind: 'form'; readonly id?: string }
  | { readonly kind: 'knowledge'; readonly datasourceId: string }

type DialogState =
  | { readonly kind: 'analyze'; readonly datasource: DatasourceSummary }
  | { readonly kind: 'delete'; readonly datasource: DatasourceSummary }

const EMPTY_VALUES: Record<string, FieldValue> = {}

/** 读取条件对应的字符串值。 */
function conditionText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 字段是否渲染。 */
function visible(def: FieldDefView, values: Readonly<Record<string, FieldValue>>): boolean {
  return (
    def.visibleWhen === undefined ||
    def.visibleWhen.every((condition) => {
      const expected = typeof condition.equals === 'string' ? [condition.equals] : condition.equals
      return expected.includes(conditionText(values[condition.field]))
    })
  )
}

/** 字段是否必填。 */
function required(def: FieldDefView, values: Readonly<Record<string, FieldValue>>): boolean {
  if (def.required === true) return true
  return (
    def.requiredWhen !== undefined &&
    def.requiredWhen.every((condition) => {
      const expected = typeof condition.equals === 'string' ? [condition.equals] : condition.equals
      return expected.includes(conditionText(values[condition.field]))
    })
  )
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** 下拉选项：保留当前值，避免版本收窄后已存值显示为空。 */
function enumOptions(options: readonly string[], value: FieldValue | undefined): readonly string[] {
  const current = typeof value === 'string' ? value : ''
  if (current === '' || options.includes(current)) return options
  return [...options, current]
}

/** 表单默认值：与服务端 `initialValues` 同规则，但只依赖下发的定义。 */
function seedValues(defs: readonly FieldDefView[], record?: DatasourceDetail): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const def of defs) {
    if (def.secret) {
      const ref = record?.secrets[def.key]
      if (ref !== undefined) values[def.key] = ref.kind === 'env' ? `env:${ref.var}` : ref.value
      continue
    }
    if (record?.config[def.key] !== undefined) {
      const stored = record.config[def.key]
      if (stored !== undefined) values[def.key] = stored
      continue
    }
    if (def.default !== undefined) values[def.key] = def.default
    else if (def.type === 'switch') values[def.key] = false
    else if (def.type === 'list') values[def.key] = []
  }
  if (record !== undefined) values.name = record.name
  return values
}

/** 只做「必填 / 数字 / 端口」这一层就地校验；依赖规则由宿主统一裁决。 */
function localIssues(defs: readonly FieldDefView[], values: Readonly<Record<string, FieldValue>>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const def of defs) {
    if (!visible(def, values) || def.disabledByVersion) continue
    const value = values[def.key]
    if (required(def, values) && isBlank(value)) {
      issues.push({ field: def.key, code: 'required', messageKey: 'dbqa.validation.required' })
      continue
    }
    if (isBlank(value) || def.type !== 'number') continue
    const text = String(value).trim()
    if (!/^\d+$/.test(text)) {
      issues.push({ field: def.key, code: 'number', messageKey: 'dbqa.validation.number' })
      continue
    }
    if (def.key === 'port' || def.key === 'sshPort') {
      const port = Number(text)
      if (port < 1 || port > 65535) issues.push({ field: def.key, code: 'port', messageKey: 'dbqa.validation.port' })
    }
  }
  return issues
}

/** 把问题里的 labelKey 参数翻成当前语言。 */
function issueText(t: TranslateFn, issue: ValidationIssue): string {
  const params: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(issue.params ?? {})) {
    params[key] = typeof value === 'string' && value.startsWith('dbqa.') ? t(value) : value
  }
  return t(issue.messageKey, params)
}

/** 从抛出的错误里取一条可读原因。 */
function describeFailure(t: TranslateFn, error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('DBQA_')) {
      const detail = (error as { message?: unknown }).message
      return t(`dbqa.error.${code}`, { detail: typeof detail === 'string' ? detail : '' })
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** 测试失败的可读原因：优先用错误码的本地化文案，找不到再退回宿主给的细节。 */
function failureReason(
  t: TranslateFn,
  result: { readonly errorCode?: string | null; readonly errorDetail?: string | null },
): string {
  const code = result.errorCode ?? 'DBQA_QUERY_FAILED'
  const key = `dbqa.error.${code}`
  const localized = t(key)
  // 需要参数的文案（如 `主机 {host}`）在只有错误码时无法填参，退回宿主已脱敏的细节。
  if (localized !== key) {
    if (!/\{[a-zA-Z]+\}/.test(localized)) return localized
    // 持久化的只有错误码，没有参数；把占位符收敛成省略号，避免把 {host} 直接展示给用户。
    return localized.replace(/\{[a-zA-Z]+\}/g, '…')
  }
  return result.errorDetail ?? localized
}

/** 右上角齿轮。 */
function GearIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
    </svg>
  )
}

/** 数据库图标：面板标题与数据源入口。 */
function DatabaseIcon(props: { readonly size?: number }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7" ry="3" />
      <path d="M5 5.5v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
      <path d="M5 11.5v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
    </svg>
  )
}

/** 问答气泡：空态与列表行首。 */
function ChatIcon(props: { readonly size?: number }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5z" />
      <path d="M8.5 9.5h7M8.5 12.5h4.5" strokeLinecap="round" />
    </svg>
  )
}

/** 加号。 */
function PlusIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** 返回箭头。 */
function ArrowLeftIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  )
}

/** 刷新：测试连接。 */
function RefreshIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-.7 4.2" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

/** 星芒：重构结构分析。 */
function SparkIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2z" />
      <path d="M19 3v3M17.5 4.5h3" strokeLinecap="round" />
    </svg>
  )
}

/** 警告三角。 */
function WarningIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4.5" strokeLinecap="round" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 垃圾桶。 */
function TrashIcon(props: { readonly size?: number }): JSX.Element {
  const size = props.size ?? 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface DialogItem {
  readonly text: string
  /** 需要额外强调的条目：warn 用琥珀色，danger 用红色。 */
  readonly tone?: 'warn' | 'danger'
}

/** 说明型确认框：标题、影响清单、风险注记，底部是取消与确认。 */
function ConfirmDialog(props: {
  readonly title: string
  readonly lead: string
  readonly items: readonly DialogItem[]
  readonly note?: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly tone: 'default' | 'danger'
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): JSX.Element {
  const { title, lead, items, note, confirmLabel, cancelLabel, tone, onConfirm, onCancel } = props
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useRef(`dbqa-dialog-${Math.random().toString(36).slice(2)}`).current

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="dbqa-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="dbqa-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dbqa-modal-head">
          <span className={`dbqa-modal-icon${tone === 'danger' ? ' dbqa-modal-icon--danger' : ''}`}>
            {tone === 'danger' ? <TrashIcon /> : <WarningIcon />}
          </span>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p className="dbqa-modal-lead">{lead}</p>
          </div>
        </div>
        <div className="dbqa-modal-body">
          <ul className="dbqa-modal-list">
            {items.map((item) => (
              <li key={item.text} className={`dbqa-modal-item${item.tone === undefined ? '' : ` dbqa-modal-item--${item.tone}`}`}>
                <span className="dbqa-modal-bullet" aria-hidden="true" />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          {note === undefined ? null : <p className="dbqa-modal-note">{note}</p>}
        </div>
        <div className="dbqa-modal-foot">
          <button ref={cancelRef} type="button" className="dbqa-button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`dbqa-button ${tone === 'danger' ? 'dbqa-button--danger' : 'dbqa-button--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}


/** 主页问题列表的 Tab。 */
type HomeTab = 'all' | 'favorite'

/** 每页条数；与设计文档一致。 */
const HOME_PAGE_SIZE = 20

/** 取全量时每次请求的行数（服务端上限 100）。 */
const LIST_FETCH_SIZE = 100

/** 取全量的页数上限：异常大的库不至于把面板卡住，正常规模一次就够。 */
const LIST_FETCH_PAGES = 50

/** 取消收藏的淡出时长（毫秒）。 */
const FAVORITE_FADE_MS = 160

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 列表里的相对时间：当天 HH:mm，当年 MM-DD HH:mm，跨年 YYYY-MM-DD。 */
function formatStamp(timestamp: number, now: Date): string {
  const date = new Date(timestamp)
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (date.getFullYear() !== now.getFullYear()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }
  if (date.getMonth() !== now.getMonth() || date.getDate() !== now.getDate()) {
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`
  }
  return clock
}

/** 悬停时展示的绝对时间。 */
function absoluteStamp(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 星标图标：实心表示已收藏。 */
function StarIcon(props: { readonly filled: boolean }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={props.filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.8 1-5.8L3.5 9.8l5.9-.9z" />
    </svg>
  )
}

/**
 * 一行的时间：宿主会话的最后更新时间。
 *
 * 宿主在会话被删掉后就不再报告它，这时退回索引行的建立时间，避免列表出现空白。
 */
function conversationStamp(
  row: ConversationItemView,
  sessionTimes: SessionListSnapshot['byId'],
): number {
  return sessionTimes[row.sessionId]?.updatedAt ?? row.createdAt
}

/** 主页问题列表：全部 / 收藏双 Tab、星标与分页。 */
function HomeView(props: {
  readonly t: TranslateFn
  readonly remote: DbqaRemote
  readonly hasDatasource: boolean
  /** 宿主会话列表：列表时间取会话的最后更新时间，排序也用它。 */
  readonly useSessions: UseSessions
  readonly startQuery?: () => Promise<void>
  readonly openConversation?: (sessionId: string) => void
  readonly onAddDatasource: () => void
}): JSX.Element {
  const { t, remote, hasDatasource, useSessions, startQuery, openConversation, onAddDatasource } = props
  const [tab, setTab] = useState<HomeTab>('all')
  const [items, setItems] = useState<readonly ConversationItemView[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<readonly string[]>([])
  const [pending, setPending] = useState<readonly string[]>([])
  const requestRef = useRef(0)

  /**
   * 取回整个 Tab 的问题（分页循环）。
   *
   * 时间来自宿主的会话列表，只有面板能拿到，所以排序与分页都放在这里做：
   * 服务端按库里那行的时间取数，顺序在面板侧重新排。
   */
  const load = useCallback(
    async (targetTab: HomeTab): Promise<void> => {
      const seq = ++requestRef.current
      setLoading(true)
      setError(null)
      try {
        const rows: ConversationItemView[] = []
        for (let nextPage = 1; nextPage <= LIST_FETCH_PAGES; nextPage += 1) {
          const result = unwrapRemote(
            await remote['conversation.list']({ tab: targetTab, page: nextPage, pageSize: LIST_FETCH_SIZE }),
          )
          rows.push(...result.items)
          if (rows.length >= result.total || result.items.length === 0) break
        }
        if (seq !== requestRef.current) return
        setItems(rows)
        setPage(1)
      } catch (failure) {
        if (seq !== requestRef.current) return
        setError(describeFailure(t, failure))
      } finally {
        if (seq === requestRef.current) setLoading(false)
      }
    },
    [remote, t],
  )

  useEffect(() => {
    setItems([])
    setPage(1)
    void load(tab)
  }, [load, tab])

  // 宿主时间变了（有人在别处提问、会话被删）就重排；订阅整张表，保证排序与显示同源。
  const sessionTimes = useSessions((state) => state.byId)
  const ordered = useMemo(() => {
    const rows = [...items]
    rows.sort((left, right) => {
      if (tab === 'favorite') {
        const byFavorite = (right.favoritedAt ?? 0) - (left.favoritedAt ?? 0)
        if (byFavorite !== 0) return byFavorite
      }
      const byTime = conversationStamp(right, sessionTimes) - conversationStamp(left, sessionTimes)
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id)
    })
    return rows
  }, [items, sessionTimes, tab])
  const visible = ordered.slice(0, page * HOME_PAGE_SIZE)

  const toggleFavorite = async (item: ConversationItemView): Promise<void> => {
    if (pending.includes(item.id)) return
    const next = !item.isFavorite
    setPending((previous) => [...previous, item.id])
    setError(null)
    setItems((previous) =>
      previous.map((row) =>
        row.id === item.id ? { ...row, isFavorite: next, favoritedAt: next ? Date.now() : null } : row,
      ),
    )
    try {
      const saved = unwrapRemote(await remote['conversation.setFavorite']({ id: item.id, favorite: next }))
      setItems((previous) =>
        previous.map((row) =>
          row.id === item.id ? { ...row, isFavorite: saved.isFavorite, favoritedAt: saved.favoritedAt } : row,
        ),
      )
      if (!next && tab === 'favorite') {
        setLeaving((previous) => [...previous, item.id])
        window.setTimeout(() => {
          setLeaving((previous) => previous.filter((id) => id !== item.id))
          setItems((previous) => previous.filter((row) => row.id !== item.id))
        }, FAVORITE_FADE_MS)
      }
    } catch (failure) {
      setItems((previous) =>
        previous.map((row) =>
          row.id === item.id
            ? { ...row, isFavorite: item.isFavorite, favoritedAt: item.favoritedAt }
            : row,
        ),
      )
      setError(describeFailure(t, failure))
    } finally {
      setPending((previous) => previous.filter((id) => id !== item.id))
    }
  }

  const createQuery = async (): Promise<void> => {
    if (startQuery === undefined) return
    setError(null)
    try {
      await startQuery()
    } catch (failure) {
      setError(describeFailure(t, failure))
    }
  }

  const now = new Date()
  const emptyAll = tab === 'all'

  return (
    <div className="dbqa-home">
      <div className="dbqa-page-head">
        <div className="dbqa-page-head-text">
          <h2 className="dbqa-section-title">{t('dbqa.home.listTitle')}</h2>
          <p className="dbqa-subtitle">{t('dbqa.home.listHint')}</p>
        </div>
        {startQuery === undefined || !hasDatasource ? null : (
          <button type="button" className="dbqa-button dbqa-button--primary" onClick={() => void createQuery()}>
            <PlusIcon />
            {t('dbqa.home.createQuery')}
          </button>
        )}
      </div>

      <div className="dbqa-home-toolbar">
        <div
          className="dbqa-tabs"
          role="tablist"
          aria-label={t('dbqa.home.tabs')}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const next = tab === 'all' ? 'favorite' : 'all'
            setTab(next)
            document.getElementById(`dbqa-home-tab-${next}`)?.focus()
          }}
        >
          <button
            type="button"
            role="tab"
            id="dbqa-home-tab-all"
            aria-controls="dbqa-home-panel"
            aria-selected={tab === 'all'}
            tabIndex={tab === 'all' ? 0 : -1}
            className={`dbqa-tab${tab === 'all' ? ' dbqa-tab--active' : ''}`}
            onClick={() => setTab('all')}
          >
            {t('dbqa.home.tabAll')}
          </button>
          <button
            type="button"
            role="tab"
            id="dbqa-home-tab-favorite"
            aria-controls="dbqa-home-panel"
            aria-selected={tab === 'favorite'}
            tabIndex={tab === 'favorite' ? 0 : -1}
            className={`dbqa-tab${tab === 'favorite' ? ' dbqa-tab--active' : ''}`}
            onClick={() => setTab('favorite')}
          >
            {t('dbqa.home.tabFavorite')}
          </button>
        </div>
        <span className="dbqa-count">
          {loading ? t('dbqa.home.loading') : t('dbqa.home.total', { count: ordered.length })}
        </span>
      </div>

      {error === null ? null : (
        <div className="dbqa-error-bar" role="alert">
          <span>{error}</span>
          <button type="button" className="dbqa-button dbqa-button--link" onClick={() => void load(tab)}>
            {t('dbqa.home.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <>
          <div className="dbqa-skeleton-list" aria-hidden="true">
            {[0, 1, 2, 3].map((key) => (
              <div className="dbqa-skeleton-row" key={key}>
                <span className="dbqa-skeleton dbqa-skeleton--icon" />
                <span className="dbqa-skeleton-lines">
                  <span className="dbqa-skeleton dbqa-skeleton--title" />
                  <span className="dbqa-skeleton dbqa-skeleton--meta" />
                </span>
              </div>
            ))}
          </div>
          <p className="dbqa-sr-only" role="status">
            {t('dbqa.home.skeleton')}
          </p>
        </>
      ) : null}

      {!loading && ordered.length === 0 ? (
        <div className="dbqa-empty">
          <span className="dbqa-empty-icon" aria-hidden="true">
            <ChatIcon size={22} />
          </span>
          <h3>{t(emptyAll ? 'dbqa.home.emptyAllTitle' : 'dbqa.home.emptyFavoriteTitle')}</h3>
          <p>
            {t(
              emptyAll
                ? hasDatasource
                  ? 'dbqa.home.emptyAllBody'
                  : 'dbqa.home.emptyAllBodyNoDataSource'
                : 'dbqa.home.emptyFavoriteBody',
            )}
          </p>
          {emptyAll ? (
            <div className="dbqa-actions dbqa-home-empty-actions">
              {hasDatasource ? (
                startQuery === undefined ? null : (
                  <button type="button" className="dbqa-button dbqa-button--primary" onClick={() => void createQuery()}>
                    <PlusIcon />
                    {t('dbqa.home.createQuery')}
                  </button>
                )
              ) : (
                <button type="button" className="dbqa-button dbqa-button--primary" onClick={onAddDatasource}>
                  {t('dbqa.datasource.add')}
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        id="dbqa-home-panel"
        role="tabpanel"
        aria-labelledby={tab === 'all' ? 'dbqa-home-tab-all' : 'dbqa-home-tab-favorite'}
        aria-busy={loading}
      >
        {visible.length === 0 ? null : (
          <ul className="dbqa-home-list">
            {visible.map((item) => {
              const title = item.title === '' ? t('dbqa.home.untitled') : item.title
              const source =
                item.datasourceId === null
                  ? t('dbqa.home.noDatasourceBound')
                  : (item.datasourceName ?? t('dbqa.session.datasourceDeleted'))
              const stamp = conversationStamp(item, sessionTimes)
              const busy = pending.includes(item.id)
              return (
                <li
                  key={item.id}
                  className={`dbqa-home-item${leaving.includes(item.id) ? ' dbqa-home-item--leaving' : ''}`}
                  onClick={() => openConversation?.(item.sessionId)}
                >
                  <span className="dbqa-home-icon" aria-hidden="true">
                    <ChatIcon size={15} />
                  </span>
                  <div
                    className="dbqa-home-open"
                    role="button"
                    tabIndex={0}
                    aria-label={t('dbqa.home.openItem', { title })}
                    title={absoluteStamp(stamp)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openConversation?.(item.sessionId)
                      }
                    }}
                  >
                    <span className="dbqa-home-item-title">{title}</span>
                    <span className="dbqa-home-item-meta">
                      <span className="dbqa-home-item-source" title={source}>
                        {source}
                      </span>
                      <span className="dbqa-meta-dot" aria-hidden="true" />
                      <span>{formatStamp(stamp, now)}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`dbqa-star${item.isFavorite ? ' dbqa-star--on' : ''}`}
                    aria-pressed={item.isFavorite}
                    aria-label={t(item.isFavorite ? 'dbqa.home.favoriteRemove' : 'dbqa.home.favoriteAdd')}
                    title={t(item.isFavorite ? 'dbqa.home.favoriteRemove' : 'dbqa.home.favoriteAdd')}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      void toggleFavorite(item)
                    }}
                  >
                    <StarIcon filled={item.isFavorite} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {ordered.length <= visible.length ? null : (
        <div className="dbqa-home-more">
          <span className="dbqa-muted">
            {t('dbqa.home.shown', { shown: visible.length, total: ordered.length })}
          </span>
          <button type="button" className="dbqa-button" onClick={() => setPage((previous) => previous + 1)}>
            {t('dbqa.home.loadMore')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 数据库类型标签。 */
function typeLabel(t: TranslateFn, type: DbType): string {
  return t(`dbqa.type.${type}`)
}

/** 面板根组件。 */
export function DbqaPage(props: DbqaPageProps): JSX.Element {
  const { t, data, useSessions, startAnalysis, startQuery, openConversation, panelSelections } = props
  const [remote, setRemote] = useState<DbqaRemote | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [datasources, setDatasources] = useState<readonly DatasourceSummary[]>([])
  const [startupNotices, setStartupNotices] = useState<readonly string[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [rowState, setRowState] = useState<
    Record<string, { readonly state: 'testing' | 'ok' | 'fail' | 'analyzing'; readonly text?: string }>
  >({})
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // 侧栏点击「数据问答」——包括已经停在本面板时再点一次——都回到问答列表顶部。
  useEffect(() => {
    if (panelSelections === undefined) return
    return panelSelections.subscribe(() => {
      setView({ kind: 'home' })
      setDialog(null)
      setToast(null)
      bodyRef.current?.scrollTo({ top: 0 })
    })
  }, [panelSelections])

  useEffect(() => {
    let cancelled = false
    data().then(
      (service) => {
        if (!cancelled) setRemote(service)
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(describeFailure(t, error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [data, t])

  const refresh = useCallback(
    async (service: DbqaRemote): Promise<void> => {
      setListLoading(true)
      try {
        const payload = unwrapRemote(await service['datasource.list']())
        setDatasources(payload.datasources)
        const notices: string[] = []
        if (payload.startup.outcome === 'rebuilt') notices.push('dbqa.notice.rebuilt')
        if (payload.startup.outcome === 'ahead') notices.push('dbqa.notice.ahead')
        setStartupNotices(notices)
        setLoadError(null)
      } catch (error) {
        setLoadError(describeFailure(t, error))
      } finally {
        setListLoading(false)
      }
    },
    [t],
  )

  useEffect(() => {
    if (remote !== null) void refresh(remote)
  }, [remote, refresh])

  const openList = (): void => {
    setToast(null)
    setView({ kind: 'list' })
  }

  const openForm = (id?: string): void => {
    setToast(null)
    setView({ kind: 'form', ...(id === undefined ? {} : { id }) })
  }

  const removeDatasource = async (summary: DatasourceSummary): Promise<void> => {
    if (remote === null) return
    setDialog(null)
    try {
      unwrapRemote(await remote['datasource.remove']({ id: summary.id }))
      setToast(t('dbqa.datasource.deleted'))
      await refresh(remote)
    } catch (error) {
      setLoadError(describeFailure(t, error))
    }
  }

  const askRemove = (summary: DatasourceSummary): void => {
    setToast(null)
    setDialog({ kind: 'delete', datasource: summary })
  }

  const openKnowledge = (summary: DatasourceSummary): void => {
    setToast(null)
    setView({ kind: 'knowledge', datasourceId: summary.id })
  }

  const analyze = async (summary: DatasourceSummary): Promise<void> => {
    if (startAnalysis === undefined) return
    setDialog(null)
    setRowState((previous) => ({ ...previous, [summary.id]: { state: 'analyzing' } }))
    try {
      await startAnalysis(summary.id)
      setToast(t('dbqa.datasource.analyzeStarted'))
      await refresh(remote as DbqaRemote)
    } catch (error) {
      setLoadError(describeFailure(t, error))
    } finally {
      setRowState((previous) => {
        const next = { ...previous }
        delete next[summary.id]
        return next
      })
    }
  }

  const askAnalyze = (summary: DatasourceSummary): void => {
    setToast(null)
    setDialog({ kind: 'analyze', datasource: summary })
  }

  const testSaved = async (summary: DatasourceSummary): Promise<void> => {
    if (remote === null) return
    setRowState((previous) => ({ ...previous, [summary.id]: { state: 'testing' } }))
    try {
      const result = unwrapRemote(await remote['datasource.test']({ id: summary.id }))
      if (result.result === null) {
        setRowState((previous) => ({
          ...previous,
          [summary.id]: { state: 'fail', text: result.issues[0] === undefined ? '' : issueText(t, result.issues[0]) },
        }))
        return
      }
      const tested = result.result
      const text = tested.ok
        ? t('dbqa.datasource.testOk', {
            version: tested.versionRaw ?? t('dbqa.datasource.unknownVersion'),
            ms: tested.latencyMs,
          })
        : t('dbqa.datasource.testFailed', { reason: failureReason(t, tested) })
      setRowState((previous) => ({ ...previous, [summary.id]: { state: tested.ok ? 'ok' : 'fail', text } }))
      await refresh(remote)
    } catch (error) {
      setRowState((previous) => ({ ...previous, [summary.id]: { state: 'fail', text: describeFailure(t, error) } }))
    }
  }

  const listHint = datasources.length === 0 && !listLoading
  const viewKey = view.kind === 'form' ? `form:${view.id ?? 'new'}` : view.kind

  return (
    <div className="dbqa-root">
      <style>{STYLES}</style>
      <header className="dbqa-header">
        <div className="dbqa-heading">
          <span className="dbqa-brand-mark" aria-hidden="true">
            <DatabaseIcon size={18} />
          </span>
          <div className="dbqa-heading-text">
            <div className="dbqa-title-line">
              <h1 className="dbqa-title">{t('dbqa.panel.title')}</h1>
              <span className="dbqa-version">{`v${__DBQA_VERSION__}`}</span>
            </div>
            <p className="dbqa-subtitle">{t('dbqa.panel.subtitle')}</p>
          </div>
        </div>
        <button
          type="button"
          className={`dbqa-button dbqa-button--ghost dbqa-header-action${view.kind === 'list' ? ' dbqa-button--selected' : ''}`}
          aria-label={t('dbqa.panel.settings')}
          title={t('dbqa.panel.settings')}
          onClick={openList}
        >
          <GearIcon />
          <span>{t('dbqa.datasource.title')}</span>
        </button>
      </header>
      <div className="dbqa-body" ref={bodyRef}>
        {loadError !== null ? <div className="dbqa-error-bar">{loadError}</div> : null}
        {remote === null && loadError === null ? <div className="dbqa-loading">{t('dbqa.datasource.testing')}</div> : null}

        {remote !== null && view.kind === 'home' ? (
          <HomeView
            t={t}
            remote={remote}
            hasDatasource={datasources.length > 0}
            useSessions={useSessions}
            {...(startQuery === undefined ? {} : { startQuery })}
            {...(openConversation === undefined ? {} : { openConversation })}
            onAddDatasource={() => openForm()}
          />
        ) : null}

        {remote !== null && view.kind === 'list' ? (
          <div className="dbqa-datasources">
            <div className="dbqa-page-head">
              <div className="dbqa-page-head-text">
                <h2 className="dbqa-section-title">{t('dbqa.datasource.title')}</h2>
                <p className="dbqa-subtitle">{t('dbqa.datasource.subtitle')}</p>
              </div>
              <div className="dbqa-actions">
                <button
                  type="button"
                  className="dbqa-button dbqa-button--ghost"
                  onClick={() => setView({ kind: 'home' })}
                >
                  <ArrowLeftIcon />
                  {t('dbqa.datasource.back')}
                </button>
                <button type="button" className="dbqa-button dbqa-button--primary" onClick={() => openForm()}>
                  <PlusIcon />
                  {t('dbqa.datasource.add')}
                </button>
              </div>
            </div>

            {startupNotices.map((key) => (
              <div key={key} className="dbqa-notice" role="status">
                {t(key)}
              </div>
            ))}

            {datasources.length === 0 ? null : (
              <div className="dbqa-stats">
                <div className="dbqa-stat">
                  <span className="dbqa-stat-value">{datasources.length}</span>
                  <span className="dbqa-stat-label">{t('dbqa.datasource.statTotal')}</span>
                </div>
                <div className="dbqa-stat dbqa-stat--ok">
                  <span className="dbqa-stat-value">
                    {datasources.filter((summary) => summary.lastTestOk === true).length}
                  </span>
                  <span className="dbqa-stat-label">{t('dbqa.datasource.statOk')}</span>
                </div>
                <div
                  className={`dbqa-stat${datasources.some((summary) => summary.lastTestOk === false) ? ' dbqa-stat--warn' : ''}`}
                >
                  <span className="dbqa-stat-value">
                    {datasources.filter((summary) => summary.lastTestOk === false).length}
                  </span>
                  <span className="dbqa-stat-label">{t('dbqa.datasource.statAttention')}</span>
                </div>
              </div>
            )}

            {listHint ? (
              <div className="dbqa-empty">
                <span className="dbqa-empty-icon" aria-hidden="true">
                  <DatabaseIcon size={22} />
                </span>
                <h3>{t('dbqa.datasource.emptyTitle')}</h3>
                <p>{t('dbqa.datasource.emptyBody')}</p>
                <button type="button" className="dbqa-button dbqa-button--primary" onClick={() => openForm()}>
                  <PlusIcon />
                  {t('dbqa.datasource.add')}
                </button>
              </div>
            ) : (
              <div className="dbqa-table-wrap">
                <table className="dbqa-table">
                  <caption className="dbqa-sr-only">{t('dbqa.datasource.title')}</caption>
                  <thead>
                    <tr>
                      <th>{t('dbqa.field.name')}</th>
                      <th>{t('dbqa.datasource.type')}</th>
                      <th>{t('dbqa.datasource.endpoint')}</th>
                      <th>{t('dbqa.datasource.status')}</th>
                      <th className="dbqa-ds-actions-head">{t('dbqa.datasource.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datasources.map((summary) => {
                      const state = rowState[summary.id]
                      const statusKey =
                        summary.lastTestOk === null
                          ? 'dbqa.datasource.untested'
                          : summary.lastTestOk
                            ? 'dbqa.datasource.ok'
                            : 'dbqa.datasource.failed'
                      const tone =
                        state?.state === 'testing' || state?.state === 'analyzing'
                          ? 'busy'
                          : state?.state === 'ok'
                            ? 'ok'
                            : state?.state === 'fail'
                              ? 'fail'
                              : summary.lastTestOk === null
                                ? 'idle'
                                : summary.lastTestOk
                                  ? 'ok'
                                  : 'fail'
                      const statusLabel =
                        state?.state === 'testing'
                          ? t('dbqa.datasource.testing')
                          : state?.state === 'analyzing'
                            ? t('dbqa.datasource.analyzing')
                            : t(statusKey)
                      return (
                        <tr key={summary.id}>
                          <td>
                            <div className="dbqa-ds-name">{summary.name}</div>
                            <div className="dbqa-ds-sub">
                              {summary.analyzedAt === null
                                ? t('dbqa.datasource.notAnalyzed')
                                : t('dbqa.datasource.analyzed')}
                            </div>
                          </td>
                          <td>
                            <span className={`dbqa-type dbqa-type--${summary.dbType}`}>{typeLabel(t, summary.dbType)}</span>
                          </td>
                          <td>
                            <span className="dbqa-endpoint dbqa-mono" title={summary.endpoint}>
                              {summary.endpoint}
                            </span>
                          </td>
                          <td>
                            <span className={`dbqa-pill dbqa-pill--${tone}`}>
                              <span className="dbqa-dot" aria-hidden="true" />
                              {statusLabel}
                            </span>
                            {state?.text !== undefined ? (
                              <div className="dbqa-ds-sub">{state.text}</div>
                            ) : summary.lastTestOk === false && summary.lastTestErrorCode !== null ? (
                              <div className="dbqa-ds-sub">
                                {failureReason(t, { errorCode: summary.lastTestErrorCode })}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <div className="dbqa-row-actions dbqa-ds-actions">
                              <button
                                type="button"
                                className="dbqa-icon-button"
                                aria-label={t('dbqa.datasource.test')}
                                title={t('dbqa.datasource.test')}
                                disabled={state?.state === 'testing'}
                                onClick={() => void testSaved(summary)}
                              >
                                {state?.state === 'testing' ? <span className="dbqa-spinner" /> : <RefreshIcon />}
                              </button>
                              <button
                                type="button"
                                className="dbqa-icon-button"
                                aria-label={t('dbqa.datasource.analyze')}
                                title={t('dbqa.datasource.analyze')}
                                disabled={state?.state === 'analyzing'}
                                onClick={() => askAnalyze(summary)}
                              >
                                <SparkIcon />
                              </button>
                              <button
                                type="button"
                                className="dbqa-button dbqa-button--sm"
                                onClick={() => openKnowledge(summary)}
                              >
                                {t('dbqa.datasource.knowledge')}
                              </button>
                              <button
                                type="button"
                                className="dbqa-button dbqa-button--sm"
                                onClick={() => openForm(summary.id)}
                              >
                                {t('dbqa.datasource.edit')}
                              </button>
                              <button
                                type="button"
                                className="dbqa-icon-button dbqa-icon-button--danger"
                                aria-label={t('dbqa.datasource.delete')}
                                title={t('dbqa.datasource.delete')}
                                onClick={() => askRemove(summary)}
                              >
                                <TrashIcon size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}

        {remote !== null && view.kind === 'form' ? (
          <DatasourceForm
            key={viewKey}
            remote={remote}
            t={t}
            {...(view.id === undefined ? {} : { id: view.id })}
            onCancel={() => setView({ kind: 'list' })}
            onSaved={async (summary) => {
              setToast(t('dbqa.datasource.saved'))
              setView({ kind: 'list' })
              if (remote !== null) await refresh(remote)
              void summary
            }}
          />
        ) : null}
        {remote !== null && view.kind === 'knowledge' ? (
          <KnowledgeView
            remote={remote}
            t={t}
            datasourceId={view.datasourceId}
            onBack={() => setView({ kind: 'list' })}
          />
        ) : null}
        {toast !== null ? <span className="dbqa-toast">{toast}</span> : null}
      </div>
      {dialog === null ? null : dialog.kind === 'analyze' ? (
        <ConfirmDialog
          title={t('dbqa.analyzeDialog.title', { name: dialog.datasource.name })}
          lead={t('dbqa.analyzeDialog.lead')}
          items={[
            { text: t('dbqa.analyzeDialog.itemScan') },
            { text: t('dbqa.analyzeDialog.itemFiles') },
            { text: t('dbqa.analyzeDialog.itemConflict'), tone: 'warn' },
            { text: t('dbqa.analyzeDialog.itemOverwrite'), tone: 'warn' },
            { text: t('dbqa.analyzeDialog.itemSwitch') },
          ]}
          note={t('dbqa.analyzeDialog.note')}
          confirmLabel={t('dbqa.dialog.confirmAnalyze')}
          cancelLabel={t('dbqa.dialog.cancel')}
          tone="default"
          onCancel={() => setDialog(null)}
          onConfirm={() => void analyze(dialog.datasource)}
        />
      ) : (
        <ConfirmDialog
          title={t('dbqa.deleteDialog.title', { name: dialog.datasource.name })}
          lead={t('dbqa.deleteDialog.lead')}
          items={[
            { text: t('dbqa.deleteDialog.itemConfig') },
            { text: t('dbqa.deleteDialog.itemFiles'), tone: 'danger' },
            { text: t('dbqa.deleteDialog.itemConversations') },
          ]}
          note={t('dbqa.deleteDialog.note')}
          confirmLabel={t('dbqa.dialog.confirmDelete')}
          cancelLabel={t('dbqa.dialog.cancel')}
          tone="danger"
          onCancel={() => setDialog(null)}
          onConfirm={() => void removeDatasource(dialog.datasource)}
        />
      )}
    </div>
  )
}

/** 新增 / 编辑表单。 */
function DatasourceForm(props: {
  readonly remote: DbqaRemote
  readonly t: TranslateFn
  readonly id?: string
  readonly onCancel: () => void
  readonly onSaved: (summary: DatasourceSummary) => void | Promise<void>
}): JSX.Element {
  const { remote, t, id, onCancel, onSaved } = props
  const [record, setRecord] = useState<DatasourceDetail | null>(null)
  const [dbType, setDbType] = useState<DbType>('mysql')
  const [defs, setDefs] = useState<readonly FieldDefView[] | null>(null)
  const [values, setValues] = useState<Record<string, FieldValue>>(EMPTY_VALUES)
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testView, setTestView] = useState<{ readonly ok: boolean; readonly text: string } | null>(null)
  /** TLS 高级选项是否展开；未点过时按“已有值”自动展开。 */
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({})
  /** 已铺过默认值的「类型 + 记录」组合；切类型或记录到达时重铺，其余情况保留用户输入。 */
  const seededKey = useRef<string | null>(null)

  useEffect(() => {
    if (id === undefined) return
    let cancelled = false
    remote['datasource.get']({ id }).then(unwrapRemote).then(
      (result) => {
        if (cancelled) return
        setRecord(result.datasource)
        setDbType(result.datasource.dbType)
      },
      (error: unknown) => {
        if (!cancelled) setFormError(describeFailure(t, error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [id, remote, t])

  const versionNum = record?.serverVersionNum ?? null

  useEffect(() => {
    let cancelled = false
    setDefs(null)
    remote['datasource.fieldDefs']({ dbType, versionNum }).then(unwrapRemote).then(
      (result) => {
        if (cancelled) return
        const fields = result.fields as readonly FieldDefView[]
        setDefs(fields)
        const key = `${dbType}:${record?.id ?? 'new'}`
        setValues((previous) => {
          if (seededKey.current === key) return previous
          seededKey.current = key
          const seeded = seedValues(fields, record ?? undefined)
          if (record !== undefined) return seeded
          return { ...seeded, name: previous.name ?? seeded.name ?? '' }
        })
      },
      (error: unknown) => {
        if (!cancelled) setFormError(describeFailure(t, error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [dbType, versionNum, remote, record, t])

  const grouped = useMemo(() => {
    const groups: { readonly key: string; readonly fields: FieldDefView[] }[] = []
    for (const def of defs ?? []) {
      if (!visible(def, values)) continue
      let group = groups.find((entry) => entry.key === def.group)
      if (group === undefined) {
        group = { key: def.group, fields: [] }
        groups.push(group)
      }
      group.fields.push(def)
    }
    return groups
  }, [defs, values])

  const setValue = (key: string, value: FieldValue): void => {
    setValues((previous) => ({ ...previous, [key]: value }))
    setIssues((previous) => previous.filter((issue) => issue.field !== key))
    setTestView(null)
  }

  const issueFor = (key: string): ValidationIssue | undefined => issues.find((issue) => issue.field === key)

  const validate = (): ValidationIssue[] => {
    const found = localIssues(defs ?? [], values)
    setIssues(found)
    return found
  }

  const runTest = async (): Promise<void> => {
    if (defs === null) return
    const found = localIssues(defs, values)
    if (found.length > 0) {
      setIssues(found)
      return
    }
    setTesting(true)
    setFormError(null)
    try {
      const result = unwrapRemote(await remote['datasource.test']({ draft: { dbType, values } }))
      if (result.issues.length > 0) {
        setIssues(result.issues)
        setTestView(null)
        return
      }
      const tested = result.result
      if (tested === null) return
      setTestView({
        ok: tested.ok,
        text: tested.ok
          ? t(tested.readOnlyConfirmed ? 'dbqa.datasource.testOkReadonly' : 'dbqa.datasource.testOk', {
              version: tested.versionRaw ?? t('dbqa.datasource.unknownVersion'),
              ms: tested.latencyMs,
            })
          : t('dbqa.datasource.testFailed', {
              reason: failureReason(t, tested),
            }),
      })
    } catch (error) {
      setTestView({ ok: false, text: describeFailure(t, error) })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (defs === null) return
    if (validate().length > 0) return
    setSaving(true)
    setFormError(null)
    try {
      const result = unwrapRemote(
        await remote['datasource.save']({
          ...(id === undefined ? {} : { id }),
          draft: { dbType, values },
        }),
      )
      if (result.issues.length > 0) {
        setIssues(result.issues)
        return
      }
      if (result.saved !== null) await onSaved(result.saved)
    } catch (error) {
      setFormError(describeFailure(t, error))
    } finally {
      setSaving(false)
    }
  }

  const editing = id !== undefined || record !== null

  return (
    <div className="dbqa-form">
      <div className="dbqa-page-head">
        <div className="dbqa-page-head-text">
          <div className="dbqa-title-row">
            <button
              type="button"
              className="dbqa-icon-button dbqa-back"
              onClick={onCancel}
              aria-label={t('dbqa.datasource.back')}
              title={t('dbqa.datasource.back')}
            >
              <ArrowLeftIcon />
            </button>
            <h2 className="dbqa-section-title">{t(editing ? 'dbqa.datasource.editTitle' : 'dbqa.datasource.newTitle')}</h2>
          </div>
          <p className="dbqa-subtitle">{t('dbqa.form.subtitle')}</p>
        </div>
      </div>
      {formError !== null ? <div className="dbqa-error-bar" role="alert">{formError}</div> : null}
      {issues.some((issue) => issue.field === '') ? <div className="dbqa-error-bar" role="alert">{t(issues[0]?.messageKey ?? '')}</div> : null}

      <div className="dbqa-form-identity">
        <div className="dbqa-form-identity-label">
          <span className="dbqa-form-label">{t('dbqa.form.typeLabel')}</span>
          <span className="dbqa-field-hint">{t('dbqa.datasource.noDsn')}</span>
        </div>
        <div className="dbqa-form-identity-control">
          <div className="dbqa-segmented" role="group" aria-label={t('dbqa.form.typeLabel')}>
            {(['mysql', 'postgresql', 'sqlite'] as const).map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={dbType === type}
                disabled={editing}
                onClick={() => {
                  if (editing) return
                  setDbType(type)
                  setValues((previous) => ({ ...previous, name: previous.name ?? '' }))
                  setIssues([])
                  setTestView(null)
                  setAdvancedOpen({})
                }}
              >
                {typeLabel(t, type)}
              </button>
            ))}
          </div>
          {editing ? <span className="dbqa-field-hint">{t('dbqa.form.typeLocked')}</span> : null}
        </div>
      </div>

      {defs === null ? <div className="dbqa-loading">{t('dbqa.datasource.testing')}</div> : null}

      <div className="dbqa-form-sheet">
        {grouped.map((group) => {
          const advanced = group.key === 'tls'
            ? group.fields.filter((def) => def.key !== 'sslMode')
            : []
          const primary = group.key === 'tls'
            ? group.fields.filter((def) => def.key === 'sslMode')
            : group.fields
          const advancedHasValue = advanced.some((def) => !isBlank(values[def.key]))
          const expanded = advancedOpen[group.key] ?? advancedHasValue
          return (
            <section key={group.key} className="dbqa-section" aria-labelledby={`dbqa-group-${group.key}`}>
              <div className="dbqa-section-intro">
                <h3 id={`dbqa-group-${group.key}`}>{t(`dbqa.group.${group.key}`)}</h3>
                <p>{t(`dbqa.group.${group.key}.hint`)}</p>
              </div>
              <div className="dbqa-section-fields">
                <div className="dbqa-grid">
                  {primary.map((def) => (
                    <Field
                      key={def.key}
                      def={def}
                      t={t}
                      values={values}
                      value={values[def.key]}
                      issue={issueFor(def.key)}
                      onChange={setValue}
                    />
                  ))}
                </div>
                {advanced.length === 0 ? null : (
                  <details
                    className="dbqa-disclosure"
                    open={expanded}
                    onToggle={(event) => {
                      const next = event.currentTarget.open
                      setAdvancedOpen((previous) => ({ ...previous, [group.key]: next }))
                    }}
                  >
                    <summary>{t('dbqa.form.tlsAdvanced')}</summary>
                    <div className="dbqa-grid">
                      {advanced.map((def) => (
                        <Field
                          key={def.key}
                          def={def}
                          t={t}
                          values={values}
                          value={values[def.key]}
                          issue={issueFor(def.key)}
                          onChange={setValue}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </section>
          )
        })}
      </div>

      {testView !== null ? (
        <div className={`dbqa-test-result ${testView.ok ? 'dbqa-test-result--ok' : 'dbqa-test-result--fail'}`}>{testView.text}</div>
      ) : null}

      <div className="dbqa-footer dbqa-form-footer">
        <button type="button" className="dbqa-button dbqa-button--primary" disabled={saving || defs === null} onClick={() => void save()}>
          {saving ? t('dbqa.datasource.saving') : t('dbqa.datasource.save')}
        </button>
        <button type="button" className="dbqa-button" disabled={testing || defs === null} onClick={() => void runTest()}>
          {testing ? t('dbqa.datasource.testing') : t('dbqa.datasource.test')}
        </button>
        <button type="button" className="dbqa-button" onClick={onCancel}>
          {t('dbqa.datasource.cancel')}
        </button>
        <span className="dbqa-form-footer-hint">{t('dbqa.form.testHint')}</span>
      </div>
    </div>
  )
}

/** 单个字段控件。 */
function Field(props: {
  readonly def: FieldDefView
  readonly t: TranslateFn
  readonly values: Readonly<Record<string, FieldValue>>
  readonly value: FieldValue | undefined
  readonly issue: ValidationIssue | undefined
  readonly onChange: (key: string, value: FieldValue) => void
}): JSX.Element {
  const { def, t, values, value, issue, onChange } = props
  const id = `dbqa-field-${def.key}`
  const disabled = def.disabledByVersion
  const options = def.options ?? []
  const hasOptions = options.length > 0
  const wide = def.type === 'list' || def.multiline === true

  const label = (
    <label htmlFor={id}>
      {t(def.labelKey)}
      {required(def, values) ? <span className="dbqa-muted"> *</span> : null}
    </label>
  )

  const hint =
    def.hintKey !== undefined ? <span className="dbqa-field-hint">{t(def.hintKey)}</span> : null
  const error = issue !== undefined ? <span className="dbqa-field-error">{issueText(t, issue)}</span> : null

  if (def.type === 'switch') {
    return (
      <div className={`dbqa-field${wide ? ' dbqa-field--wide' : ''}`}>
        <span className="dbqa-switch">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(def.key, event.currentTarget.checked)}
          />
          <label htmlFor={id}>{t(def.labelKey)}</label>
        </span>
        {hint}
        {error}
      </div>
    )
  }

  if (def.type === 'list' && def.listItemFields !== undefined) {
    const items = Array.isArray(value) ? (value as readonly { readonly alias: string; readonly filePath: string }[]) : []
    return (
      <div className="dbqa-field dbqa-field--wide">
        <label>{t(def.labelKey)}</label>
        <div className="dbqa-list-editor">
          {items.map((item, index) => (
            <div className="dbqa-list-row" key={index}>
              <input
                type="text"
                aria-label={t(def.listItemFields?.[0]?.labelKey ?? '')}
                placeholder={t('dbqa.datasource.attachmentAlias')}
                value={item.alias}
                disabled={disabled}
                onChange={(event) => {
                  const next = items.map((entry, at) => (at === index ? { ...entry, alias: event.currentTarget.value } : entry))
                  onChange(def.key, next)
                }}
              />
              <input
                type="text"
                aria-label={t(def.listItemFields?.[1]?.labelKey ?? '')}
                placeholder={t('dbqa.datasource.attachmentPath')}
                value={item.filePath}
                disabled={disabled}
                onChange={(event) => {
                  const next = items.map((entry, at) => (at === index ? { ...entry, filePath: event.currentTarget.value } : entry))
                  onChange(def.key, next)
                }}
              />
              <button
                type="button"
                className="dbqa-button dbqa-button--link"
                onClick={() => onChange(def.key, items.filter((_, at) => at !== index))}
              >
                {t('dbqa.datasource.removeAttachment')}
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="dbqa-button"
              disabled={disabled}
              onClick={() => onChange(def.key, [...items, { alias: '', filePath: '' }])}
            >
              {t('dbqa.datasource.addAttachment')}
            </button>
          </div>
        </div>
        {hint}
        {error}
      </div>
    )
  }

  if (def.type === 'list' && hasOptions) {
    const selected = Array.isArray(value) ? (value as readonly string[]) : []
    return (
      <div className={`dbqa-field${wide ? ' dbqa-field--wide' : ''}`}>
        <label>{t(def.labelKey)}</label>
        <div className="dbqa-actions">
          {options.map((option) => {
            const checked = selected.includes(option)
            return (
              <label key={option} className="dbqa-switch">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    onChange(def.key, checked ? selected.filter((entry) => entry !== option) : [...selected, option])
                  }
                />
                {option}
              </label>
            )
          })}
        </div>
        {hint}
        {error}
      </div>
    )
  }

  if (def.type === 'enum' || hasOptions) {
    return (
      <div className={`dbqa-field${wide ? ' dbqa-field--wide' : ''}${issue !== undefined ? ' dbqa-field--invalid' : ''}`}>
        {label}
        <select
          id={id}
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          onChange={(event) => onChange(def.key, event.currentTarget.value)}
        >
          <option value="">—</option>
          {enumOptions(options, value).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {hint}
        {error}
      </div>
    )
  }

  const inputType = def.type === 'number' ? 'number' : 'text'
  return (
    <div className={`dbqa-field${wide ? ' dbqa-field--wide' : ''}${issue !== undefined ? ' dbqa-field--invalid' : ''}`}>
      {label}
      <input
        id={id}
        type={inputType}
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        placeholder={def.secret === true ? '•••••• or env:VAR' : def.type === 'path' ? '/path/to/file' : undefined}
        onChange={(event) => {
          const text = event.currentTarget.value
          if (def.type === 'number') onChange(def.key, text === '' ? '' : Number(text))
          else onChange(def.key, text)
        }}
      />
      {def.secret === true ? <span className="dbqa-field-hint">{t('dbqa.form.secretHint')}</span> : null}
      {hint}
      {error}
    </div>
  )
}

type KnowledgeSelection =
  | { readonly part: 'index' }
  | { readonly part: 'table'; readonly tableRef: string }

/** 只读知识库视图：左栏索引 + 表清单，右栏 Markdown。 */
function KnowledgeView(props: {
  readonly remote: DbqaRemote
  readonly t: TranslateFn
  readonly datasourceId: string
  readonly onBack: () => void
}): JSX.Element {
  const { remote, t, datasourceId, onBack } = props
  const [status, setStatus] = useState<KnowledgeStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<KnowledgeSelection>({ part: 'index' })
  const [document, setDocument] = useState<KnowledgeReadResult | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'render' | 'source'>('render')
  const initialized = useRef(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = unwrapRemote(await remote['knowledge.status']({ datasourceId }))
      setStatus(next)
      setError(null)
    } catch (failure) {
      setError(describeFailure(t, failure))
    }
  }, [datasourceId, remote, t])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const open = useCallback(
    async (next: KnowledgeSelection): Promise<void> => {
      setSelection(next)
      setLinkError(null)
      setLoading(true)
      try {
        const result = unwrapRemote(
          await remote['knowledge.read']({
            datasourceId,
            ...(next.part === 'index' ? {} : { tableRef: next.tableRef, part: 'both' as const }),
          }),
        )
        setDocument(result)
        setError(null)
      } catch (failure) {
        setDocument(null)
        setError(describeFailure(t, failure))
      } finally {
        setLoading(false)
      }
    },
    [datasourceId, remote, t],
  )

  useEffect(() => {
    if (status !== null && !initialized.current) {
      initialized.current = true
      void open({ part: 'index' })
    }
  }, [status, open])

  /** 链接里的目录名 → 表引用：Remote 只认表引用。 */
  const linkTables = useMemo(() => status?.status.tables ?? [], [status])

  /**
   * 正文链接：和点击左栏一样打开目标文档，左侧选中随之移动。
   *
   * 链接只指向某张表的 business.md / schema.md，但表文档始终成对展示，
   * 因此这里按表引用重新走 `open`，不单独渲染被链接的那一份。
   */
  const followLink = useCallback(
    async (fromRelPath: string, href: string, event: MouseEvent<HTMLAnchorElement>): Promise<void> => {
      const target = resolveKnowledgeLink(fromRelPath, href)
      if (target.kind === 'external') return
      event.preventDefault()
      setLinkError(null)
      if (target.kind === 'other') {
        setLinkError(t('dbqa.kb.linkUnavailable', { path: target.path }))
        return
      }
      if (target.kind === 'index') {
        await open({ part: 'index' })
        return
      }

      const tableRef = resolveTableRef(target.dir, linkTables)
      if (tableRef === undefined) {
        setLinkError(t('dbqa.kb.linkUnavailable', { path: `tables/${target.dir}/${target.part}.md` }))
        return
      }
      await open({ part: 'table', tableRef })
    },
    [linkTables, open, t],
  )

  const groups = useMemo(() => {
    const map = new Map<string, KnowledgeStatusResult['status']['tables'][number][]>()
    for (const table of status?.status.tables ?? []) {
      const index = table.tableRef.indexOf('.')
      const schema = index > 0 ? table.tableRef.slice(0, index) : ''
      const list = map.get(schema) ?? []
      list.push(table)
      map.set(schema, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [status])

  const selectedTable =
    selection.part === 'index'
      ? null
      : (status?.status.tables.find((table) => table.tableRef === selection.tableRef) ?? null)
  const stale =
    selection.part === 'index'
      ? (status?.status.index.stale ?? false)
      : (selectedTable?.business.stale ?? false) || (selectedTable?.schema.stale ?? false)

  const stateMark = (business: boolean, schema: boolean): { className: string; label: string } => {
    if (business && schema) return { className: 'dbqa-kb-mark dbqa-kb-mark--full', label: t('dbqa.kb.stateComplete') }
    if (business || schema) return { className: 'dbqa-kb-mark dbqa-kb-mark--half', label: t('dbqa.kb.statePartial') }
    return { className: 'dbqa-kb-mark dbqa-kb-mark--empty', label: t('dbqa.kb.stateMissing') }
  }

  const currentDocs =
    selection.part === 'index'
      ? (document?.documents.filter((item) => item.part === 'index') ?? [])
      : (['schema', 'business'] as const).flatMap((part) => {
          const doc = document?.documents.find((item) => item.part === part)
          return doc === undefined ? [] : [doc]
        })
  const updatedAt =
    currentDocs.length === 0 ? null : new Date(Math.max(...currentDocs.map((doc) => doc.updatedAt))).toLocaleString()

  return (
    <div>
      <div className="dbqa-toolbar">
        <div>
          <h2>{t('dbqa.kb.title')}</h2>
          <p className="dbqa-subtitle">{status?.datasourceName ?? ''}</p>
        </div>
        <button type="button" className="dbqa-button" onClick={onBack}>
          {t('dbqa.kb.back')}
        </button>
      </div>
      {error !== null ? <div className="dbqa-error-bar">{error}</div> : null}
      {status === null && error === null ? <div className="dbqa-loading">{t('dbqa.kb.loading')}</div> : null}
      {status !== null ? (
        <div className="dbqa-kb">
          <aside className="dbqa-kb-nav">
            <button
              type="button"
              className={`dbqa-kb-item${selection.part === 'index' ? ' dbqa-kb-item--active' : ''}`}
              onClick={() => void open({ part: 'index' })}
            >
              <span className={status.status.index.exists ? 'dbqa-kb-mark dbqa-kb-mark--full' : 'dbqa-kb-mark dbqa-kb-mark--empty'} />
              {t('dbqa.kb.index')}
            </button>
            {status.status.tables.length === 0 ? (
              <p className="dbqa-muted">{t('dbqa.kb.empty')}</p>
            ) : (
              <p className="dbqa-kb-legend">
                <span className="dbqa-kb-legend-item"><span className="dbqa-kb-mark dbqa-kb-mark--full" />{t('dbqa.kb.stateComplete')}</span>
                <span className="dbqa-kb-legend-item"><span className="dbqa-kb-mark dbqa-kb-mark--half" />{t('dbqa.kb.statePartial')}</span>
                <span className="dbqa-kb-legend-item"><span className="dbqa-kb-mark dbqa-kb-mark--empty" />{t('dbqa.kb.stateMissing')}</span>
              </p>
            )}
            {groups.map(([schema, tables]) => (
              <div key={schema} className="dbqa-kb-group">
                <div className="dbqa-kb-group-title">
                  {schema === '' ? t('dbqa.kb.groupSchema') : t('dbqa.kb.groupSchemaNamed', { schema })}
                </div>
                {tables.map((table) => {
                  const dot = stateMark(table.business.exists, table.schema.exists)
                  const active = selection.part !== 'index' && selection.tableRef === table.tableRef
                  return (
                    <button
                      key={table.tableRef}
                      type="button"
                      className={`dbqa-kb-item${active ? ' dbqa-kb-item--active' : ''}`}
                      title={table.tableRef}
                      onClick={() => void open({ part: 'table', tableRef: table.tableRef })}
                    >
                      <span className={dot.className} title={dot.label} aria-label={dot.label} />
                      {table.tableRef.slice(table.tableRef.indexOf('.') + 1) || table.dir}
                    </button>
                  )
                })}
              </div>
            ))}
          </aside>
          <section className="dbqa-kb-doc">
            {selection.part === 'index' ? (
              <h3>{t('dbqa.kb.index')}</h3>
            ) : (
              <div className="dbqa-kb-doc-head">
                <h3>{selection.tableRef}</h3>
              </div>
            )}
            {updatedAt !== null ? (
              <p className="dbqa-muted">
                {t('dbqa.kb.metaUpdated', { time: updatedAt })}
                {stale ? ` · ${t('dbqa.kb.stateStale')}` : ''}
              </p>
            ) : null}
            <div className="dbqa-kb-modes" role="tablist" aria-label={t('dbqa.kb.viewMode')}>
              <button
                type="button"
                role="tab"
                className={`dbqa-kb-tab${mode === 'render' ? ' dbqa-kb-tab--active' : ''}`}
                aria-selected={mode === 'render'}
                onClick={() => setMode('render')}
              >
                {t('dbqa.kb.viewRender')}
              </button>
              <button
                type="button"
                role="tab"
                className={`dbqa-kb-tab${mode === 'source' ? ' dbqa-kb-tab--active' : ''}`}
                aria-selected={mode === 'source'}
                onClick={() => setMode('source')}
              >
                {t('dbqa.kb.viewSource')}
              </button>
            </div>
            {linkError !== null ? <div className="dbqa-error-bar">{linkError}</div> : null}
            {loading ? <div className="dbqa-loading">{t('dbqa.kb.loading')}</div> : null}
            {!loading
              ? currentDocs.map((doc) => (
                  <section key={doc.path} className="dbqa-kb-section">
                    {doc.part === 'index' ? null : (
                      <h4 className="dbqa-kb-section-title">
                        {doc.part === 'schema' ? t('dbqa.kb.tabSchema') : t('dbqa.kb.tabBusiness')}
                      </h4>
                    )}
                    {mode === 'render' ? (
                      <Markdown
                        source={doc.content}
                        onLink={(href, event) => void followLink(doc.path, href, event)}
                      />
                    ) : (
                      <pre className="dbqa-md">{doc.content}</pre>
                    )}
                  </section>
                ))
              : null}
            {!loading && currentDocs.length === 0 && error === null ? (
              <div className="dbqa-empty">
                <h3>{t('dbqa.kb.emptyTitle')}</h3>
                <p>{t('dbqa.kb.emptyHint')}</p>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  )
}
