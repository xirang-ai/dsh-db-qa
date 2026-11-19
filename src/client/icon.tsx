/**
 * 侧栏入口图标：一个圆柱数据库。
 *
 * @module
 */
import type { JSX } from 'react'

/** 侧栏图标；颜色跟随当前文字色。 */
export function DbqaIcon(props: { readonly size?: number; readonly active?: boolean }): JSX.Element {
  const size = props.size ?? 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
      <path d="M4.5 11.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
    </svg>
  )
}
