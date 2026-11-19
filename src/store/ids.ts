/**
 * 插件内部主键：Crockford Base32 的 ULID。
 *
 * 不引入依赖：只需要「按时间粗略有序 + 足够随机」，26 个字符足够。
 *
 * @module
 */
import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 把整数写成固定长度的 Base32。 */
function encode(value: number, length: number): string {
  let remaining = value
  let output = ''
  for (let index = 0; index < length; index += 1) {
    output = ALPHABET[remaining % 32] + output
    remaining = Math.floor(remaining / 32)
  }
  return output
}

/** 生成 48 位时间戳 + 80 位随机数的 ULID。 */
export function ulid(now: number = Date.now()): string {
  const time = encode(Math.max(0, Math.trunc(now)), 10)
  const random = randomBytes(10)
  let tail = ''
  for (const byte of random) tail += ALPHABET[byte % 32]
  return time + tail
}

/** 数据源 id。 */
export function datasourceId(now?: number): string {
  return `ds_${ulid(now)}`
}

/** 会话索引 id。 */
export function conversationId(now?: number): string {
  return `cv_${ulid(now)}`
}

/** 审计行 id。 */
export function auditId(now?: number): string {
  return `au_${ulid(now)}`
}
