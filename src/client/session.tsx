/**
 * 会话页上的数据源 + Agent 选择器。
 *
 * 只在查询 / 分析两个 preset 的会话里出现：两种会话都可在会话存续期间
 * 改选数据源，绑定更新由 ConversationStore.markActive 落库。
 * Agent 由会话的 preset 自动选中，这里只做展示；数据源下拉支持键入过滤。
 * 组件是纯 props，宿主会话身份由槽位以标准 Session props 传入。
 *
 * @module
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationBindingView, DatasourceListPayload } from '../remote/contract.ts'
import type { DbqaRemote } from './remote.ts'
import { unwrapRemote } from './remote.ts'
import type { TranslateFn, UseSessions } from './context.ts'
import { STYLES } from './styles.ts'

/** 槽位传入的会话标准 props（只列本组件用到的字段）。 */
export interface SessionScopeProps {
  readonly sessionId: string
  readonly useSessions: UseSessions
}

type DatasourceSummary = DatasourceListPayload['datasources'][number]

/** 下拉浮层相对视口的位置；会话头 `overflow: clip`，只能挂到 body 上再定位。 */
interface MenuAnchor {
  readonly left: number
  readonly top: number
  readonly width: number
}

/** 条带注入的业务 props。 */
export interface DbqaSessionStripProps extends SessionScopeProps {
  readonly t: TranslateFn
  readonly data: () => Promise<DbqaRemote>
}

/** 判断某个 preset 是否属于本插件。 */
function isDbqaPreset(preset: string | undefined): preset is 'dbqa-query' | 'dbqa-analysis' {
  return preset === 'dbqa-query' || preset === 'dbqa-analysis'
}

/** 数据源类型的展示名；只展示类型，不展示任何连接串。 */
function typeLabel(dbType: string): string {
  return dbType === 'postgresql' ? 'PostgreSQL' : dbType === 'mysql' ? 'MySQL' : 'SQLite'
}

/** 会话页数据源 + Agent 选择器。 */
export function DbqaSessionStrip(props: DbqaSessionStripProps): JSX.Element | null {
  const { t, data, sessionId, useSessions } = props
  const preset = useSessions((state) => {
    const listed = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof listed === 'string' ? listed : undefined
  })
  const title = useSessions((state) => {
    const listed = state.byId[sessionId]?.title
    return typeof listed === 'string' && listed.trim() !== '' ? listed : undefined
  })
  const [datasources, setDatasources] = useState<readonly DatasourceSummary[] | null>(null)
  const [binding, setBinding] = useState<ConversationBindingView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLSpanElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const menuId = useId()
  // 最近一次写回问题索引的标题；宿主在首条提问后才会给会话命名。
  const pushedTitle = useRef<string | null>(null)

  const active = isDbqaPreset(preset) ? preset : null
  const analysis = active === 'dbqa-analysis'

  const load = useCallback(async (): Promise<void> => {
    try {
      const remote = await data()
      const listed = unwrapRemote(await remote['datasource.list']())
      const bound = unwrapRemote(await remote['conversation.get']({ sessionId }))
      setDatasources(listed.datasources)
      setBinding(bound.binding)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [data, sessionId])

  useEffect(() => {
    if (active === null) return
    void load()
  }, [active, load])

  useEffect(() => {
    if (!open) return
    filterRef.current?.focus()
    const closeOnPointer = (event: MouseEvent): void => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) === true) return
      // 浮层挂在 body 上，点选项时不能被当成外部点击。
      if (menuRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOnPointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  // 会话头是 `overflow: clip` 的固定高度条带，浮层必须按按钮位置做 fixed 定位。
  useEffect(() => {
    if (!open) return
    const update = (): void => {
      const button = buttonRef.current
      if (button === null) return
      const rect = button.getBoundingClientRect()
      const width = Math.max(rect.width, 220)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      setAnchor({ left, top: rect.bottom + 4, width })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const choose = useCallback(async (datasourceId: string): Promise<void> => {
    setOpen(false)
    setFilter('')
    pushedTitle.current = title ?? null
    const remote = await data()
    setBusy(true)
    try {
      const result = unwrapRemote(
        await remote['conversation.markActive']({
          sessionId,
          ...(datasourceId === '' ? {} : { datasourceId }),
          // 会话标题由宿主的会话列表给出；写回问题索引，缺省时不覆盖已有标题。
          ...(title === undefined ? {} : { title }),
          agentKind: analysis ? 'analysis' : 'query',
        }),
      )
      setBinding(result.binding)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [analysis, data, sessionId, title])

  // 会话标题由宿主在首条提问后才确定；一旦出现就补写问题索引，保持标题与对话一致。
  useEffect(() => {
    if (binding === null || title === undefined || pushedTitle.current === title) return
    pushedTitle.current = title
    void (async () => {
      try {
        const remote = await data()
        const result = unwrapRemote(
          await remote['conversation.markActive']({ sessionId, title }),
        )
        setBinding(result.binding)
      } catch (reason) {
        // 写回失败不影响会话本身；下次标题变化时重试。
        pushedTitle.current = null
        console.warn('dbqa: failed to write the conversation title back', reason)
      }
    })()
  }, [binding, data, sessionId, title])

  const visible = useMemo(() => {
    if (datasources === null) return []
    const needle = filter.trim().toLowerCase()
    if (needle === '') return datasources
    return datasources.filter((item) =>
      item.name.toLowerCase().includes(needle)
      || item.dbType.toLowerCase().includes(needle)
      || typeLabel(item.dbType).toLowerCase().includes(needle))
  }, [datasources, filter])

  if (active === null) return null

  const boundName = binding === null
    ? null
    : datasources?.find((item) => item.id === binding.datasourceId)?.name ?? null
  const agentName = analysis ? t('dbqa.session.agentAnalysis') : t('dbqa.session.agentQuery')

  const agentChip = (
    <span className="dbqa-session-agent" title={t('dbqa.session.agent')}>
      <span className="dbqa-session-pick-label">{t('dbqa.session.agent')}</span>
      <span className="dbqa-session-agent-name">{agentName}</span>
    </span>
  )

  const selected = binding === null
    ? null
    : boundName ?? t('dbqa.session.datasourceDeleted')
  const label = selected ?? t('dbqa.session.pickDatasourceHint')

  return (
    <span className="dbqa-session-pick" ref={rootRef}>
      <style>{STYLES}</style>
      {agentChip}
      <span className="dbqa-session-pick-label">{t('dbqa.session.datasource')}</span>
      {datasources === null ? (
        <span className="dbqa-hint">{t('dbqa.session.loading')}</span>
      ) : datasources.length === 0 ? (
        <span className="dbqa-hint">{t('dbqa.session.noDatasources')}</span>
      ) : (
        <>
          <button
            ref={buttonRef}
            type="button"
            className="dbqa-session-pick-button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            disabled={busy}
            title={label}
            onClick={() => {
              setFilter('')
              setOpen((value) => !value)
            }}
          >
            <span className={selected === null ? 'dbqa-session-pick-value is-empty' : 'dbqa-session-pick-value'}>
              {label}
            </span>
            <span className="dbqa-session-pick-chevron" aria-hidden="true">⌄</span>
          </button>
          {open && anchor !== null ? createPortal(
            <span
              ref={menuRef}
              id={menuId}
              className="dbqa-session-menu"
              role="listbox"
              style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
            >
              <input
                ref={filterRef}
                className="dbqa-session-menu-filter"
                type="text"
                value={filter}
                placeholder={t('dbqa.session.filterPlaceholder')}
                aria-label={t('dbqa.session.filterPlaceholder')}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setOpen(false)
                    return
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    const first = visible[0]
                    if (first !== undefined) void choose(first.id)
                  }
                }}
              />
              {visible.length === 0 ? (
                <span className="dbqa-session-menu-empty">{t('dbqa.session.noMatch')}</span>
              ) : visible.map((item) => {
                const isSelected = binding?.datasourceId === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={isSelected ? 'dbqa-session-menu-item is-selected' : 'dbqa-session-menu-item'}
                    onClick={() => void choose(item.id)}
                  >
                    <span className="dbqa-session-menu-name">{item.name}</span>
                    <span className="dbqa-session-menu-type">{typeLabel(item.dbType)}</span>
                    {isSelected ? <span className="dbqa-session-menu-check" aria-hidden="true">✓</span> : null}
                  </button>
                )
              })}
            </span>,
            document.body,
          ) : null}
        </>
      )}
      {error === null ? null : <span className="dbqa-session-error">{error}</span>}
    </span>
  )
}
