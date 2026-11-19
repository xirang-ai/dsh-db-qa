/**
 * 宿主侧文案：与浏览器共用同一份 `locale/*.json` 字典。
 *
 * Remote 方法会带上调用方当前的 locale id，这里只负责选表与占位符替换；
 * 字典缺失时回退英文，再回退 key 本身。
 *
 * @module
 */
import en from '../locale/en.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }

/** 插件当前支持的语言；新增语言时在这里加表即可。 */
export type Locale = 'en' | 'zh'

const DICTIONARIES: Record<Locale, Record<string, string>> = { en, zh }

/**
 * 把浏览器传来的 BCP 47 id 收敛到本插件支持的两种语言。
 * @param input - 例如 `zh`、`zh-CN`、`en-US`；空值按英文处理。
 */
export function normalizeLocale(input: string | null | undefined): Locale {
  return typeof input === 'string' && /^zh\b/i.test(input.trim()) ? 'zh' : 'en'
}

/**
 * 翻译一条宿主侧文案。
 * @param locale - 调用方传入的 locale id；未知值走英文。
 * @param key - 与前端共用的字典键。
 * @param params - `{name}` 占位符的替换值。
 */
export function translate(
  locale: string | null | undefined,
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  const template = DICTIONARIES[normalizeLocale(locale)][key] ?? DICTIONARIES.en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : match,
  )
}

/**
 * 同时给出中英文文案。
 *
 * 工具执行上下文里拿不到界面语言，而只读闸门的拒绝原因必须双语可读
 * （验收标准 AC-8 / AC-15），所以这里把两份文案拼在一起。
 * @param key - 字典键。
 * @param params - `{name}` 占位符的替换值。
 */
export function translateBilingual(
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  return `${translate('zh', key, params)} / ${translate('en', key, params)}`
}
