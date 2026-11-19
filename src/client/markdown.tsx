/**
 * 轻量 Markdown 渲染器。
 *
 * 知识库文档是模型生成的 Markdown，只用于只读预览。这里不引入第三方
 * 依赖、也不使用 `dangerouslySetInnerHTML`：先做块级切分，再把行内标记
 * 转成 React 节点，未识别的文本一律按纯文本输出。
 *
 * @module
 */
import type { JSX, MouseEvent, ReactNode } from 'react'

/** 行内链接点击回调；调用方负责决定是否 `preventDefault`。 */
export type MarkdownLinkHandler = (href: string, event: MouseEvent<HTMLAnchorElement>) => void

/** 行内渲染选项。 */
interface InlineOptions {
  readonly onLink?: MarkdownLinkHandler
}

/** 渲染一段 Markdown。 */
export function Markdown(props: {
  readonly source: string
  /** 提供时，链接点击先交给调用方；外部地址可以不拦截。 */
  readonly onLink?: MarkdownLinkHandler
}): JSX.Element {
  const options: InlineOptions = props.onLink === undefined ? {} : { onLink: props.onLink }
  return <div className="dbqa-md-rendered">{renderBlocks(props.source, options)}</div>
}

const FENCE = /^```/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*([-*_])\1{2,}\s*$/
const QUOTE = /^>\s?/
const UL = /^\s*[-*+]\s+/
const OL = /^\s*\d+[.)]\s+/
const TABLE_ROW = /^\s*\|/
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    UL.test(line) ||
    OL.test(line) ||
    TABLE_ROW.test(line)
  )
}

function renderBlocks(source: string, options: InlineOptions): ReactNode[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const nodes: ReactNode[] = []
  let index = 0
  let key = 0
  const next = (): string => `b${key++}`

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }

    if (FENCE.test(line)) {
      const language = line.slice(3).trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      nodes.push(
        <pre key={next()} className="dbqa-md-code" data-language={language || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(6, heading[1]?.length ?? 1)
      const content = inline(heading[2] ?? '', next(), options)
      const Tag = `h${level}` as 'h1'
      nodes.push(<Tag key={next()}>{content}</Tag>)
      index += 1
      continue
    }

    if (RULE.test(line)) {
      nodes.push(<hr key={next()} />)
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const parts: string[] = []
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        parts.push((lines[index] ?? '').replace(QUOTE, ''))
        index += 1
      }
      nodes.push(<blockquote key={next()}>{inline(parts.join(' '), next(), options)}</blockquote>)
      continue
    }

    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      const header = splitRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? '')) {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      nodes.push(
        <table key={next()}>
          <thead>
            <tr>
              {header.map((cell, cellIndex) => (
                <th key={`${cellIndex}`}>{inline(cell, next(), options)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {header.map((_, cellIndex) => (
                  <td key={cellIndex}>{inline(row[cellIndex] ?? '', next(), options)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line)
      const items: string[] = []
      while (index < lines.length) {
        const currentLine = lines[index] ?? ''
        if (ordered ? !OL.test(currentLine) : !UL.test(currentLine)) break
        items.push(currentLine.replace(ordered ? OL : UL, ''))
        index += 1
      }
      const content = items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, next(), options)}</li>)
      nodes.push(ordered ? <ol key={next()}>{content}</ol> : <ul key={next()}>{content}</ul>)
      continue
    }

    const parts: string[] = [line.trim()]
    index += 1
    while (index < lines.length) {
      const currentLine = lines[index] ?? ''
      if (currentLine.trim() === '' || isBlockStart(currentLine)) break
      parts.push(currentLine.trim())
      index += 1
    }
    nodes.push(<p key={next()}>{inline(parts.join(' '), next(), options)}</p>)
  }

  return nodes
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/** 行内标记：代码、粗体、斜体、链接。 */
function inline(text: string, keyPrefix: string, options: InlineOptions): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/
  let rest = text
  let index = 0
  while (rest !== '') {
    const match = pattern.exec(rest)
    if (match === null) {
      nodes.push(rest)
      break
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      const href = link?.[2] ?? '#'
      const onLink = options.onLink
      nodes.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={onLink === undefined ? undefined : (event) => onLink(href, event)}
        >
          {link?.[1] ?? token}
        </a>,
      )
    }
    rest = rest.slice(match.index + token.length)
  }
  return nodes
}
