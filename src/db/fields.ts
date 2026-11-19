/**
 * 分类型字段定义的唯一来源。
 *
 * 表单渲染（Remote 下发的 `FieldDefView`）与连接装配（适配器读
 * {@link ResolvedConfig}）都读这一份数组，避免两处各写一套字段名。
 * 三种数据库的字段清单见《技术设计》§5，依赖规则见 §5.4。
 *
 * 敏感字段（口令、私钥口令）只接受 `env:VAR` 引用；本模块既不读环境变量，
 * 也不把明文写进返回值——{@link resolveConfig} 才按 `env` 取值。
 *
 * @module
 */
import { DbqaError } from '../errors.ts'

/** 支持的数据库类型。 */
export type DbType = 'mysql' | 'postgresql' | 'sqlite'

/** 表单值域。 */
export type FieldValue = string | number | boolean | readonly string[] | readonly AttachmentRef[]

/** SQLite 的 ATTACH 附件。 */
export interface AttachmentRef {
  readonly alias: string
  readonly filePath: string
}

/** 环境变量引用：值在连接时从进程环境读取。 */
export interface EnvSecretRef {
  readonly kind: 'env'
  readonly var: string
}

/** 明文口令：只落在 `secret_ref_json`，编辑时原样回显，不进 `config_json`。 */
export interface PlainSecretRef {
  readonly kind: 'plain'
  readonly value: string
}

/** 敏感字段的引用：`env:VAR` 或本地加密前的明文。 */
export type SecretRef = EnvSecretRef | PlainSecretRef

/** 下发给面板的引用视图：环境变量引用或原样回显的明文。 */
export type SecretRefView = SecretRef

/** 字段分组，决定表单里的分段顺序。 */
export type FieldGroup = 'basic' | 'conn' | 'auth' | 'tls' | 'ssh' | 'session'

/** 控件类型。 */
export type FieldType = 'text' | 'number' | 'password' | 'path' | 'enum' | 'switch' | 'list'

/** 一个可见性 / 必填条件。 */
export interface FieldCondition {
  readonly field: string
  readonly equals: string | readonly string[]
}

/** 字段定义。 */
export interface FieldDef {
  /** config_json / secret_ref_json 的键。 */
  readonly key: string
  readonly group: FieldGroup
  /** i18n key，如 `dbqa.field.mysql.host`。 */
  readonly labelKey: string
  readonly type: FieldType
  readonly required?: boolean
  readonly default?: FieldValue
  readonly options?: readonly string[]
  /** 低于此版本置灰，如 `8.0`。 */
  readonly minVersion?: string
  /** 高于此版本置灰（保留给已废弃字段）。 */
  readonly maxVersion?: string
  /** true 时只进 secret_ref_json，可填 `env:VAR` 或明文。 */
  readonly secret?: boolean
  readonly multiline?: boolean
  /** type === 'list' 时的子字段。 */
  readonly listItemFields?: readonly FieldDef[]
  /** 全部条件满足才渲染；不满足的字段不参与校验。 */
  readonly visibleWhen?: readonly FieldCondition[]
  /** 全部条件满足时必填。 */
  readonly requiredWhen?: readonly FieldCondition[]
  /** 输入提示的 i18n key。 */
  readonly hintKey?: string
}

/** 下发给表单的字段视图，多了版本与选项的裁决结果。 */
export interface FieldDefView extends FieldDef {
  /** 当前服务端版本不支持该字段（置灰，不参与校验）。 */
  readonly disabledByVersion: boolean
  /** 按版本收窄后的选项。 */
  readonly options?: readonly string[]
  /** 未收窄的完整选项；已存值可能来自旧版本或默认值，校验以它为准。 */
  readonly allOptions?: readonly string[]
}

/** 校验问题；文案由客户端按 `messageKey` 本地化。 */
export interface ValidationIssue {
  readonly field: string
  readonly code: string
  readonly messageKey: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** 校验通过后的持久化形态。 */
export interface StoredDraft {
  readonly name: string
  readonly dbType: DbType
  readonly config: Readonly<Record<string, FieldValue>>
  readonly secrets: Readonly<Record<string, SecretRef>>
}

/** 把表单原始值拆成持久化形态的结果。 */
export type SplitResult =
  | { readonly ok: true; readonly value: StoredDraft }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * 校验并解析一个敏感值：`env:VAR` 走环境变量，其他非空文本按明文保存。
 * 空 `env:` 或非字符串返回 `'invalid'`。
 */
export function parseSecretRef(value: unknown): SecretRef | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return 'invalid'
  if (value.trim() === '') return undefined
  if (value.trimStart().toLowerCase().startsWith('env:')) {
    const match = ENV_REF.exec(value.trim())
    return match === null ? 'invalid' : { kind: 'env', var: match[1] as string }
  }
  return { kind: 'plain', value }
}

/**
 * 把敏感引用还原成输入框文本：环境变量显示 `env:VAR`，明文原样回显。
 */
export function formatSecretRef(ref: SecretRef | undefined): string {
  if (ref === undefined) return ''
  return ref.kind === 'env' ? `env:${ref.var}` : ref.value
}

/** 表单里显示用的字段集合：默认值 + 隐藏字段清除。 */
export function initialValues(type: DbType): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const def of FIELD_DEFS[type]) {
    if (def.secret) continue
    if (def.default !== undefined) values[def.key] = def.default
    else if (def.type === 'switch') values[def.key] = false
    else if (def.type === 'list') values[def.key] = []
  }
  return values
}

/** 共享 SSH 段；MySQL 与 PostgreSQL 完全一致。 */
const SSH_FIELDS: readonly FieldDef[] = Object.freeze([
  {
    key: 'useSsh',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.useSsh',
    type: 'switch',
    default: false,
    hintKey: 'dbqa.field.ssh.useSsh.hint',
  },
  {
    key: 'sshHost',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshHost',
    type: 'text',
    requiredWhen: [{ field: 'useSsh', equals: 'true' }],
    visibleWhen: [{ field: 'useSsh', equals: 'true' }],
  },
  {
    key: 'sshPort',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshPort',
    type: 'number',
    default: 22,
    requiredWhen: [{ field: 'useSsh', equals: 'true' }],
    visibleWhen: [{ field: 'useSsh', equals: 'true' }],
  },
  {
    key: 'sshUser',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshUser',
    type: 'text',
    requiredWhen: [{ field: 'useSsh', equals: 'true' }],
    visibleWhen: [{ field: 'useSsh', equals: 'true' }],
  },
  {
    key: 'sshAuth',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshAuth',
    type: 'enum',
    default: 'privateKey',
    options: ['privateKey', 'password'],
    requiredWhen: [{ field: 'useSsh', equals: 'true' }],
    visibleWhen: [{ field: 'useSsh', equals: 'true' }],
  },
  {
    key: 'sshPassword',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshPassword',
    type: 'password',
    secret: true,
    requiredWhen: [
      { field: 'useSsh', equals: 'true' },
      { field: 'sshAuth', equals: 'password' },
    ],
    visibleWhen: [
      { field: 'useSsh', equals: 'true' },
      { field: 'sshAuth', equals: 'password' },
    ],
  },
  {
    key: 'sshPrivateKeyPath',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshPrivateKeyPath',
    type: 'path',
    requiredWhen: [
      { field: 'useSsh', equals: 'true' },
      { field: 'sshAuth', equals: 'privateKey' },
    ],
    visibleWhen: [
      { field: 'useSsh', equals: 'true' },
      { field: 'sshAuth', equals: 'privateKey' },
    ],
  },
  {
    key: 'sshKeyPassphrase',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshKeyPassphrase',
    type: 'password',
    secret: true,
    visibleWhen: [
      { field: 'useSsh', equals: 'true' },
      { field: 'sshAuth', equals: 'privateKey' },
    ],
  },
  {
    key: 'sshHostFingerprint',
    group: 'ssh',
    labelKey: 'dbqa.field.ssh.sshHostFingerprint',
    type: 'text',
    visibleWhen: [{ field: 'useSsh', equals: 'true' }],
    hintKey: 'dbqa.field.ssh.sshHostFingerprint.hint',
  },
])

/** MySQL 字段（《技术设计》§5.1）。 */
const MYSQL_FIELDS: readonly FieldDef[] = Object.freeze([
  { key: 'name', group: 'basic', labelKey: 'dbqa.field.name', type: 'text', required: true },
  {
    key: 'transport',
    group: 'conn',
    labelKey: 'dbqa.field.mysql.transport',
    type: 'enum',
    default: 'tcp',
    options: ['tcp', 'socket'],
    required: true,
  },
  {
    key: 'host',
    group: 'conn',
    labelKey: 'dbqa.field.mysql.host',
    type: 'text',
    default: '127.0.0.1',
    requiredWhen: [{ field: 'transport', equals: 'tcp' }],
    visibleWhen: [{ field: 'transport', equals: 'tcp' }],
  },
  {
    key: 'port',
    group: 'conn',
    labelKey: 'dbqa.field.mysql.port',
    type: 'number',
    default: 3306,
    requiredWhen: [{ field: 'transport', equals: 'tcp' }],
    visibleWhen: [{ field: 'transport', equals: 'tcp' }],
  },
  {
    key: 'socketPath',
    group: 'conn',
    labelKey: 'dbqa.field.mysql.socketPath',
    type: 'path',
    default: '/tmp/mysql.sock',
    requiredWhen: [{ field: 'transport', equals: 'socket' }],
    visibleWhen: [{ field: 'transport', equals: 'socket' }],
  },
  {
    key: 'database',
    group: 'conn',
    labelKey: 'dbqa.field.mysql.database',
    type: 'text',
    hintKey: 'dbqa.field.mysql.database.hint',
  },
  { key: 'user', group: 'auth', labelKey: 'dbqa.field.mysql.user', type: 'text', required: true },
  { key: 'password', group: 'auth', labelKey: 'dbqa.field.mysql.password', type: 'password', secret: true },
  { key: 'authPlugin', group: 'auth', labelKey: 'dbqa.field.mysql.authPlugin', type: 'text', minVersion: '8.0' },
  {
    key: 'serverPublicKeyPath',
    group: 'auth',
    labelKey: 'dbqa.field.mysql.serverPublicKeyPath',
    type: 'path',
    minVersion: '8.0',
  },
  {
    key: 'getServerPublicKey',
    group: 'auth',
    labelKey: 'dbqa.field.mysql.getServerPublicKey',
    type: 'switch',
    default: false,
    minVersion: '8.0',
  },
  {
    key: 'sslMode',
    group: 'tls',
    labelKey: 'dbqa.field.mysql.sslMode',
    type: 'enum',
    default: 'DISABLED',
    options: ['DISABLED', 'PREFERRED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'],
    required: true,
  },
  { key: 'sslCa', group: 'tls', labelKey: 'dbqa.field.mysql.sslCa', type: 'path' },
  { key: 'sslCaPath', group: 'tls', labelKey: 'dbqa.field.mysql.sslCaPath', type: 'path' },
  { key: 'sslCert', group: 'tls', labelKey: 'dbqa.field.mysql.sslCert', type: 'path' },
  { key: 'sslKey', group: 'tls', labelKey: 'dbqa.field.mysql.sslKey', type: 'path' },
  {
    key: 'sslKeyPassphrase',
    group: 'tls',
    labelKey: 'dbqa.field.mysql.sslKeyPassphrase',
    type: 'password',
    secret: true,
  },
  { key: 'tlsVersions', group: 'tls', labelKey: 'dbqa.field.mysql.tlsVersions', type: 'list', options: ['TLSv1.2', 'TLSv1.3'], minVersion: '5.7' },
  { key: 'tlsCiphersuites', group: 'tls', labelKey: 'dbqa.field.mysql.tlsCiphersuites', type: 'text', minVersion: '8.0' },
  { key: 'sslCipher', group: 'tls', labelKey: 'dbqa.field.mysql.sslCipher', type: 'text' },
  { key: 'sslCrl', group: 'tls', labelKey: 'dbqa.field.mysql.sslCrl', type: 'path' },
  ...SSH_FIELDS,
  { key: 'charset', group: 'session', labelKey: 'dbqa.field.mysql.charset', type: 'text' },
  {
    key: 'connectTimeoutMs',
    group: 'session',
    labelKey: 'dbqa.field.connectTimeoutMs',
    type: 'number',
    default: 10000,
    required: true,
  },
  {
    key: 'compress',
    group: 'session',
    labelKey: 'dbqa.field.mysql.compress',
    type: 'enum',
    default: 'uncompressed',
    options: ['uncompressed', 'zlib', 'zstd'],
    minVersion: '8.0',
  },
])

/** PostgreSQL 字段（《技术设计》§5.2）。 */
const POSTGRESQL_FIELDS: readonly FieldDef[] = Object.freeze([
  { key: 'name', group: 'basic', labelKey: 'dbqa.field.name', type: 'text', required: true },
  {
    key: 'host',
    group: 'conn',
    labelKey: 'dbqa.field.postgresql.host',
    type: 'text',
    default: '127.0.0.1',
    hintKey: 'dbqa.field.postgresql.host.hint',
  },
  {
    key: 'port',
    group: 'conn',
    labelKey: 'dbqa.field.postgresql.port',
    type: 'number',
    default: 5432,
    required: true,
  },
  {
    key: 'database',
    group: 'conn',
    labelKey: 'dbqa.field.postgresql.database',
    type: 'text',
    required: true,
  },
  {
    key: 'searchPath',
    group: 'conn',
    labelKey: 'dbqa.field.postgresql.searchPath',
    type: 'text',
    default: 'public',
  },
  { key: 'user', group: 'auth', labelKey: 'dbqa.field.postgresql.user', type: 'text', required: true },
  { key: 'password', group: 'auth', labelKey: 'dbqa.field.postgresql.password', type: 'password', secret: true },
  {
    key: 'targetSessionAttrs',
    group: 'auth',
    labelKey: 'dbqa.field.postgresql.targetSessionAttrs',
    type: 'enum',
    default: 'read-only',
    options: ['any', 'read-only', 'prefer-standby'],
  },
  {
    key: 'sslMode',
    group: 'tls',
    labelKey: 'dbqa.field.postgresql.sslMode',
    type: 'enum',
    default: 'prefer',
    options: ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'],
    required: true,
  },
  {
    key: 'sslRootCert',
    group: 'tls',
    labelKey: 'dbqa.field.postgresql.sslRootCert',
    type: 'path',
    requiredWhen: [{ field: 'sslMode', equals: ['verify-ca', 'verify-full'] }],
    hintKey: 'dbqa.field.postgresql.sslRootCert.hint',
  },
  { key: 'sslCert', group: 'tls', labelKey: 'dbqa.field.postgresql.sslCert', type: 'path' },
  { key: 'sslKey', group: 'tls', labelKey: 'dbqa.field.postgresql.sslKey', type: 'path' },
  {
    key: 'sslKeyPassphrase',
    group: 'tls',
    labelKey: 'dbqa.field.postgresql.sslKeyPassphrase',
    type: 'password',
    secret: true,
  },
  { key: 'sslCrl', group: 'tls', labelKey: 'dbqa.field.postgresql.sslCrl', type: 'path' },
  {
    key: 'sslMinProtocolVersion',
    group: 'tls',
    labelKey: 'dbqa.field.postgresql.sslMinProtocolVersion',
    type: 'enum',
    options: ['TLSv1.2', 'TLSv1.3'],
    minVersion: '12',
  },
  {
    key: 'sslMaxProtocolVersion',
    group: 'tls',
    labelKey: 'dbqa.field.postgresql.sslMaxProtocolVersion',
    type: 'enum',
    options: ['TLSv1.2', 'TLSv1.3'],
    minVersion: '12',
  },
  {
    key: 'sslNegotiation',
    group: 'tls',
    labelKey: 'dbqa.field.postgresql.sslNegotiation',
    type: 'enum',
    default: 'postgres',
    options: ['postgres', 'direct'],
    minVersion: '17',
  },
  {
    key: 'channelBinding',
    group: 'tls',
    labelKey: 'dbqa.field.postgresql.channelBinding',
    type: 'enum',
    options: ['disable', 'prefer', 'require'],
    minVersion: '13',
  },
  ...SSH_FIELDS,
  {
    key: 'applicationName',
    group: 'session',
    labelKey: 'dbqa.field.postgresql.applicationName',
    type: 'text',
    default: 'dsh-db-qa',
  },
  {
    key: 'connectTimeoutMs',
    group: 'session',
    labelKey: 'dbqa.field.connectTimeoutMs',
    type: 'number',
    default: 10000,
    required: true,
  },
])

/** SQLite 字段（《技术设计》§5.3）。 */
const SQLITE_FIELDS: readonly FieldDef[] = Object.freeze([
  { key: 'name', group: 'basic', labelKey: 'dbqa.field.name', type: 'text', required: true },
  {
    key: 'filePath',
    group: 'conn',
    labelKey: 'dbqa.field.sqlite.filePath',
    type: 'path',
    required: true,
    hintKey: 'dbqa.field.sqlite.filePath.hint',
  },
  {
    key: 'immutable',
    group: 'conn',
    labelKey: 'dbqa.field.sqlite.immutable',
    type: 'switch',
    default: false,
    minVersion: '3.22',
    hintKey: 'dbqa.field.sqlite.immutable.hint',
  },
  {
    key: 'attachments',
    group: 'conn',
    labelKey: 'dbqa.field.sqlite.attachments',
    type: 'list',
    listItemFields: [
      { key: 'alias', group: 'conn', labelKey: 'dbqa.field.sqlite.attachment.alias', type: 'text', required: true },
      { key: 'filePath', group: 'conn', labelKey: 'dbqa.field.sqlite.attachment.filePath', type: 'path', required: true },
    ],
  },
  {
    key: 'busyTimeoutMs',
    group: 'session',
    labelKey: 'dbqa.field.sqlite.busyTimeoutMs',
    type: 'number',
    default: 5000,
    required: true,
  },
])

/** 三种类型的字段定义。 */
export const FIELD_DEFS: Readonly<Record<DbType, readonly FieldDef[]>> = Object.freeze({
  mysql: MYSQL_FIELDS,
  postgresql: POSTGRESQL_FIELDS,
  sqlite: SQLITE_FIELDS,
})

/** 分组顺序，表单据此分段。 */
export const FIELD_GROUPS: readonly FieldGroup[] = Object.freeze(['basic', 'conn', 'auth', 'tls', 'ssh', 'session'])

/** 把 `8.0` / `3.22` 这类版本串折成可比较数字。 */
export function parseVersionNumber(version: string): number {
  const parts = version
    .trim()
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0))
  const [major = 0, minor = 0, patch = 0] = parts
  return major * 10_000 + minor * 100 + patch
}

/** 某一类型的字段定义，按服务端版本裁决置灰与选项。 */
export function fieldsFor(type: DbType, versionNum?: number | null): readonly FieldDefView[] {
  return FIELD_DEFS[type].map((def) => {
    const disabledByVersion =
      versionNum !== null &&
      versionNum !== undefined &&
      ((def.minVersion !== undefined && versionNum < parseVersionNumber(def.minVersion)) ||
        (def.maxVersion !== undefined && versionNum > parseVersionNumber(def.maxVersion)))
    const options = narrowOptions(type, def, versionNum)
    return {
      ...def,
      disabledByVersion,
      options,
      ...(options === def.options ? {} : { allOptions: def.options }),
    }
  })
}

/** MySQL < 8.0 的 sslMode 收敛为三档（§1）。 */
function narrowOptions(type: DbType, def: FieldDef, versionNum?: number | null): readonly string[] | undefined {
  if (type !== 'mysql' || def.key !== 'sslMode' || versionNum === null || versionNum === undefined) return def.options
  if (versionNum >= parseVersionNumber('8.0')) return def.options
  return ['DISABLED', 'REQUIRED', 'VERIFY_CA']
}

/** 条件是否成立（布尔值按 `true` / `false` 比较）。 */
function conditionHolds(condition: FieldCondition, values: Readonly<Record<string, unknown>>): boolean {
  const actual = values[condition.field]
  const text = typeof actual === 'boolean' ? String(actual) : actual === undefined || actual === null ? '' : String(actual)
  const expected = typeof condition.equals === 'string' ? [condition.equals] : condition.equals
  return expected.includes(text)
}

/** 字段是否渲染。 */
export function isVisible(def: FieldDef, values: Readonly<Record<string, unknown>>): boolean {
  return def.visibleWhen === undefined || def.visibleWhen.every((condition) => conditionHolds(condition, values))
}

/** 字段是否必填。 */
export function isRequired(def: FieldDef, values: Readonly<Record<string, unknown>>): boolean {
  if (def.required === true) return true
  return def.requiredWhen !== undefined && def.requiredWhen.every((condition) => conditionHolds(condition, values))
}

/** 空值判定：空串、null、undefined、空数组都算空。 */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** 单个字段的校验。 */
function validateField(
  def: FieldDefView,
  values: Readonly<Record<string, unknown>>,
  versionNum: number | null | undefined,
  issues: ValidationIssue[],
): void {
  if (def.disabledByVersion) return
  if (versionNum !== null && versionNum !== undefined && def.minVersion !== undefined) {
    if (versionNum < parseVersionNumber(def.minVersion)) return
  }
  if (!isVisible(def, values)) return

  const raw = values[def.key]
  // 有默认值的字段留空即取默认值，不算「必填缺失」。
  const required = isRequired(def, values) && def.default === undefined

  if (def.secret === true) {
    const parsed = parseSecretRef(raw)
    if (parsed === 'invalid') {
      issues.push({
        field: def.key,
        code: 'secret',
        messageKey: 'dbqa.validation.secret',
        params: { field: def.labelKey },
      })
    } else if (required && parsed === undefined) {
      issues.push({
        field: def.key,
        code: 'required',
        messageKey: 'dbqa.validation.required',
        params: { field: def.labelKey },
      })
    }
    return
  }

  if (isEmpty(raw)) {
    if (required) {
      issues.push({
        field: def.key,
        code: 'required',
        messageKey: 'dbqa.validation.required',
        params: { field: def.labelKey },
      })
    }
    return
  }

  switch (def.type) {
    case 'number': {
      const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(numeric)) {
        issues.push({
          field: def.key,
          code: 'number',
          messageKey: 'dbqa.validation.number',
          params: { field: def.labelKey },
        })
        return
      }
      if (def.key.toLowerCase().includes('port') && (numeric < 1 || numeric > 65_535 || !Number.isInteger(numeric))) {
        issues.push({
          field: def.key,
          code: 'number',
          messageKey: 'dbqa.validation.port',
          params: { field: def.labelKey },
        })
      }
      return
    }
    case 'enum': {
      const allowed = def.allOptions ?? def.options
      if (allowed !== undefined && !allowed.includes(String(raw))) {
        issues.push({
          field: def.key,
          code: 'enum',
          messageKey: 'dbqa.validation.enum',
          params: { field: def.labelKey },
        })
      }
      return
    }
    case 'switch': {
      if (typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
        issues.push({
          field: def.key,
          code: 'enum',
          messageKey: 'dbqa.validation.enum',
          params: { field: def.labelKey },
        })
      }
      return
    }
    case 'list': {
      if (!Array.isArray(raw)) {
        issues.push({
          field: def.key,
          code: 'enum',
          messageKey: 'dbqa.validation.enum',
          params: { field: def.labelKey },
        })
        return
      }
      if (def.listItemFields !== undefined) {
        const aliases = new Set<string>()
        for (const item of raw) {
          const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
          for (const child of def.listItemFields) {
            if (child.required === true && isEmpty(record[child.key])) {
              issues.push({
                field: def.key,
                code: 'required',
                messageKey: 'dbqa.validation.attachmentField',
                params: { field: child.labelKey },
              })
            }
          }
          const alias = typeof record['alias'] === 'string' ? record['alias'].trim() : ''
          if (alias !== '') {
            if (aliases.has(alias)) {
              issues.push({
                field: def.key,
                code: 'duplicate',
                messageKey: 'dbqa.validation.attachmentDuplicate',
                params: { alias },
              })
            }
            aliases.add(alias)
          }
        }
      } else if (def.options !== undefined) {
        for (const item of raw) {
          if (!def.options.includes(String(item))) {
            issues.push({
              field: def.key,
              code: 'enum',
              messageKey: 'dbqa.validation.enum',
              params: { field: def.labelKey },
            })
            break
          }
        }
      }
      return
    }
    default:
      return
  }
}

/**
 * 依赖规则 D3–D10（D1/D2/D6/D8 已落在字段的 visibleWhen/requiredWhen/secret 上）。
 */
function validateDependencies(
  type: DbType,
  values: Readonly<Record<string, unknown>>,
  issues: ValidationIssue[],
): void {
  const text = (key: string): string => (values[key] === undefined || values[key] === null ? '' : String(values[key]).trim())

  if (type === 'mysql') {
    const sslMode = text('sslMode')
    if ((sslMode === 'VERIFY_CA' || sslMode === 'VERIFY_IDENTITY') && text('sslCa') === '' && text('sslCaPath') === '') {
      issues.push({
        field: 'sslCa',
        code: 'tlsCa',
        messageKey: 'dbqa.validation.tlsCa',
        params: { field: 'dbqa.field.mysql.sslCa' },
      })
    }
    if (text('transport') === 'socket' && text('useSsh') === 'true') {
      issues.push({
        field: 'useSsh',
        code: 'sshSocket',
        messageKey: 'dbqa.validation.sshSocket',
        params: { field: 'dbqa.field.ssh.useSsh' },
      })
    }
  }

  if (type === 'postgresql') {
    const sslMode = text('sslMode')
    if ((sslMode === 'verify-ca' || sslMode === 'verify-full') && text('sslRootCert') === '') {
      issues.push({
        field: 'sslRootCert',
        code: 'tlsRootCert',
        messageKey: 'dbqa.validation.tlsRootCert',
        params: { field: 'dbqa.field.postgresql.sslRootCert' },
      })
    }
    if (text('sslNegotiation') === 'direct' && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
      issues.push({
        field: 'sslNegotiation',
        code: 'sslNegotiation',
        messageKey: 'dbqa.validation.sslNegotiation',
        params: { field: 'dbqa.field.postgresql.sslNegotiation' },
      })
    }
  }

  const cert = text('sslCert')
  const key = text('sslKey')
  if (cert !== '' && key === '') {
    issues.push({
      field: 'sslKey',
      code: 'pair',
      messageKey: 'dbqa.validation.pair',
    })
  } else if (key !== '' && cert === '') {
    issues.push({
      field: 'sslCert',
      code: 'pair',
      messageKey: 'dbqa.validation.pair',
    })
  }
}

/** 校验一个草稿；返回按字段顺序排列的问题列表。 */
export function validateDraft(
  type: DbType,
  values: Readonly<Record<string, unknown>>,
  versionNum?: number | null,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const def of fieldsFor(type, versionNum)) {
    validateField(def, values, versionNum, issues)
  }
  validateDependencies(type, values, issues)
  return issues
}

/** 把表单值转成持久化值（去掉隐藏字段、类型归一）。 */
export function normalizeValues(
  type: DbType,
  values: Readonly<Record<string, unknown>>,
  versionNum?: number | null,
): Record<string, FieldValue> {
  const view = fieldsFor(type, versionNum)
  const output: Record<string, FieldValue> = {}
  for (const def of view) {
    if (def.secret === true || def.key === 'name') continue
    if (def.disabledByVersion) continue
    if (!isVisible(def, values)) continue
    const raw = values[def.key]
    if (isEmpty(raw)) continue
    switch (def.type) {
      case 'number':
        output[def.key] = typeof raw === 'number' ? raw : Number(String(raw).trim())
        break
      case 'switch':
        output[def.key] = raw === true || raw === 'true'
        break
      case 'list':
        output[def.key] = Array.isArray(raw) ? (raw as readonly AttachmentRef[]) : []
        break
      default:
        output[def.key] = String(raw).trim()
    }
  }
  return output
}

/** 把表单值拆成「名称 + 非敏感配置 + 敏感引用」；校验不通过时返回问题。 */
export function splitDraft(
  type: DbType,
  values: Readonly<Record<string, unknown>>,
  versionNum?: number | null,
): SplitResult {
  const issues = validateDraft(type, values, versionNum)
  if (issues.length > 0) return { ok: false, issues }

  const name = String(values['name'] ?? '').trim()
  const config = normalizeValues(type, values, versionNum)
  const secrets: Record<string, SecretRef> = {}
  for (const def of fieldsFor(type, versionNum)) {
    if (def.secret !== true) continue
    if (!isVisible(def, values)) continue
    const parsed = parseSecretRef(values[def.key])
    if (parsed !== undefined && parsed !== 'invalid') secrets[def.key] = parsed
  }
  return { ok: true, value: { name, dbType: type, config, secrets } }
}

/** MySQL 的 SSL 段。 */
export interface MysqlSslConfig {
  readonly mode: string
  readonly ca?: string
  readonly caPath?: string
  readonly cert?: string
  readonly key?: string
  readonly keyPassphrase?: string
  readonly crl?: string
  readonly kind: 'mysql'
}

/** PostgreSQL 的 SSL 段。 */
export interface PostgresSslConfig {
  readonly mode: string
  readonly rootCert?: string
  readonly cert?: string
  readonly key?: string
  readonly keyPassphrase?: string
  readonly crl?: string
  readonly minProtocolVersion?: string
  readonly maxProtocolVersion?: string
  readonly negotiation?: string
  readonly channelBinding?: string
  readonly kind: 'postgresql'
}

/** SSH 跳板配置；未启用时 `useSsh=false`。 */
export interface SshConfig {
  readonly useSsh: boolean
  readonly host?: string
  readonly port?: number
  readonly user?: string
  readonly auth?: 'password' | 'privateKey'
  readonly password?: string
  readonly privateKeyPath?: string
  readonly keyPassphrase?: string
  readonly hostFingerprint?: string
  readonly connectTimeoutMs: number
}

/** MySQL 连接装配结果。 */
export interface ResolvedMysql {
  readonly type: 'mysql'
  readonly name: string
  readonly transport: 'tcp' | 'socket'
  readonly host?: string
  readonly port?: number
  readonly socketPath?: string
  readonly database?: string
  readonly user: string
  readonly password?: string
  readonly authPlugin?: string
  readonly serverPublicKeyPath?: string
  readonly getServerPublicKey: boolean
  readonly ssl: MysqlSslConfig
  readonly ssh: SshConfig
  readonly charset?: string
  readonly connectTimeoutMs: number
  readonly compress?: 'uncompressed' | 'zlib' | 'zstd'
}

/** PostgreSQL 连接装配结果。 */
export interface ResolvedPostgres {
  readonly type: 'postgresql'
  readonly name: string
  readonly host?: string
  readonly port: number
  readonly database: string
  readonly searchPath?: string
  readonly user: string
  readonly password?: string
  readonly targetSessionAttrs?: string
  readonly ssl: PostgresSslConfig
  readonly ssh: SshConfig
  readonly applicationName?: string
  readonly connectTimeoutMs: number
}

/** SQLite 连接装配结果。 */
export interface ResolvedSqlite {
  readonly type: 'sqlite'
  readonly name: string
  readonly filePath: string
  readonly immutable: boolean
  readonly attachments: readonly AttachmentRef[]
  readonly busyTimeoutMs: number
}

/** 三种适配器共用的装配结果。 */
export type ResolvedConfig = ResolvedMysql | ResolvedPostgres | ResolvedSqlite

/** 装配上下文。 */
export interface ResolveOptions {
  /** 读取环境变量；测试可传入固定表。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 字段未填连接超时时的兜底值。 */
  readonly defaultConnectTimeoutMs?: number
}

/** 取一个普通字段的字符串值。 */
function textOf(config: Readonly<Record<string, FieldValue>>, key: string): string {
  const value = config[key]
  if (value === undefined || value === null || typeof value === 'boolean') return ''
  if (Array.isArray(value)) return ''
  return String(value).trim()
}

/** 取数字字段。 */
function numberOf(config: Readonly<Record<string, FieldValue>>, key: string, fallback?: number): number | undefined {
  const value = config[key]
  if (value === undefined || value === null || value === '') return fallback
  const numeric = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(numeric) ? numeric : fallback
}

/**
 * 编辑时合并敏感字段：新提交为空的键保留旧值。
 * 明文会回显，但清空输入仍表示「不修改」，不能因此清掉已存口令。
 */
export function mergeSecrets(
  type: DbType,
  submitted: Readonly<Record<string, SecretRef>>,
  existing: Readonly<Record<string, SecretRef>>,
  versionNum?: number | null,
): Record<string, SecretRef> {
  const merged: Record<string, SecretRef> = { ...submitted }
  for (const def of fieldsFor(type, versionNum)) {
    if (def.secret !== true || merged[def.key] !== undefined) continue
    const previous = existing[def.key]
    if (previous !== undefined) merged[def.key] = previous
  }
  return merged
}

/** 取开关字段。 */
function switchOf(config: Readonly<Record<string, FieldValue>>, key: string, fallback = false): boolean {
  const value = config[key]
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true'
}

/**
 * 把敏感引用解析成真实值。
 * @throws `DBQA_ENV_MISSING`：变量未定义时在建立任何连接之前失败。
 */
function resolveSecret(
  key: string,
  fieldLabel: string,
  secrets: Readonly<Record<string, SecretRef>>,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const ref = secrets[key]
  if (ref === undefined) return undefined
  if (ref.kind === 'plain') return ref.value
  const value = env[ref.var]
  if (value === undefined || value === '') {
    throw new DbqaError(
      'DBQA_ENV_MISSING',
      `dbqa: environment variable "${ref.var}" referenced by ${fieldLabel} is not defined`,
      { var: ref.var },
    )
  }
  return value
}

/** 组装 SSH 段。 */
function resolveSsh(
  type: 'mysql' | 'postgresql',
  config: Readonly<Record<string, FieldValue>>,
  secrets: Readonly<Record<string, SecretRef>>,
  env: Readonly<Record<string, string | undefined>>,
  defaultConnectTimeoutMs: number,
): SshConfig {
  const useSsh = switchOf(config, 'useSsh')
  const connectTimeoutMs = numberOf(config, 'connectTimeoutMs', defaultConnectTimeoutMs) ?? defaultConnectTimeoutMs
  if (!useSsh) return { useSsh: false, connectTimeoutMs }
  return {
    useSsh: true,
    host: textOf(config, 'sshHost'),
    port: numberOf(config, 'sshPort', 22),
    user: textOf(config, 'sshUser'),
    auth: textOf(config, 'sshAuth') === 'password' ? 'password' : 'privateKey',
    password: resolveSecret('sshPassword', `${type}.sshPassword`, secrets, env),
    privateKeyPath: textOf(config, 'sshPrivateKeyPath') || undefined,
    keyPassphrase: resolveSecret('sshKeyPassphrase', `${type}.sshKeyPassphrase`, secrets, env),
    hostFingerprint: textOf(config, 'sshHostFingerprint') || undefined,
    connectTimeoutMs,
  }
}

/**
 * 把持久化配置 + 环境变量装配成适配器可用的结构。
 * @throws {DbqaError} `DBQA_ENV_MISSING` 或 `DBQA_INVALID_CONFIG`。
 */
export function resolveConfig(
  type: DbType,
  name: string,
  config: Readonly<Record<string, FieldValue>>,
  secrets: Readonly<Record<string, SecretRef>>,
  options: ResolveOptions = {},
): ResolvedConfig {
  const env = options.env ?? process.env
  const defaultTimeout = options.defaultConnectTimeoutMs ?? 10_000

  if (type === 'sqlite') {
    const filePath = textOf(config, 'filePath')
    if (filePath === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: sqlite datasource has no filePath')
    }
    return {
      type: 'sqlite',
      name,
      filePath,
      immutable: switchOf(config, 'immutable'),
      attachments: Array.isArray(config['attachments']) ? (config['attachments'] as readonly AttachmentRef[]) : [],
      busyTimeoutMs: numberOf(config, 'busyTimeoutMs', 5_000) ?? 5_000,
    }
  }

  const secret = (key: string): string | undefined => resolveSecret(key, `${type}.${key}`, secrets, env)

  if (type === 'mysql') {
    const transport = textOf(config, 'transport') === 'socket' ? 'socket' : 'tcp'
    const connectTimeoutMs = numberOf(config, 'connectTimeoutMs', defaultTimeout) ?? defaultTimeout
    return {
      type: 'mysql',
      name,
      transport,
      host: transport === 'tcp' ? textOf(config, 'host') : undefined,
      port: transport === 'tcp' ? numberOf(config, 'port', 3306) : undefined,
      socketPath: transport === 'socket' ? textOf(config, 'socketPath') : undefined,
      database: textOf(config, 'database') || undefined,
      user: textOf(config, 'user'),
      password: secret('password'),
      authPlugin: textOf(config, 'authPlugin') || undefined,
      serverPublicKeyPath: textOf(config, 'serverPublicKeyPath') || undefined,
      getServerPublicKey: switchOf(config, 'getServerPublicKey'),
      ssl: {
        kind: 'mysql',
        mode: textOf(config, 'sslMode') || 'DISABLED',
        ca: textOf(config, 'sslCa') || undefined,
        caPath: textOf(config, 'sslCaPath') || undefined,
        cert: textOf(config, 'sslCert') || undefined,
        key: textOf(config, 'sslKey') || undefined,
        keyPassphrase: secret('sslKeyPassphrase'),
        crl: textOf(config, 'sslCrl') || undefined,
      },
      ssh: resolveSsh('mysql', config, secrets, env, defaultTimeout),
      charset: textOf(config, 'charset') || undefined,
      connectTimeoutMs,
      compress: (textOf(config, 'compress') as 'uncompressed' | 'zlib' | 'zstd') || 'uncompressed',
    }
  }

  const port = numberOf(config, 'port', 5432)
  if (port === undefined) throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: postgresql datasource has no port')
  return {
    type: 'postgresql',
    name,
    host: textOf(config, 'host') || undefined,
    port,
    database: textOf(config, 'database'),
    searchPath: textOf(config, 'searchPath') || undefined,
    user: textOf(config, 'user'),
    password: secret('password'),
    targetSessionAttrs: textOf(config, 'targetSessionAttrs') || undefined,
    ssl: {
      kind: 'postgresql',
      mode: textOf(config, 'sslMode') || 'prefer',
      rootCert: textOf(config, 'sslRootCert') || undefined,
      cert: textOf(config, 'sslCert') || undefined,
      key: textOf(config, 'sslKey') || undefined,
      keyPassphrase: secret('sslKeyPassphrase'),
      crl: textOf(config, 'sslCrl') || undefined,
      minProtocolVersion: textOf(config, 'sslMinProtocolVersion') || undefined,
      maxProtocolVersion: textOf(config, 'sslMaxProtocolVersion') || undefined,
      negotiation: textOf(config, 'sslNegotiation') || undefined,
      channelBinding: textOf(config, 'channelBinding') || undefined,
    },
    ssh: resolveSsh('postgresql', config, secrets, env, defaultTimeout),
    applicationName: textOf(config, 'applicationName') || undefined,
    connectTimeoutMs: numberOf(config, 'connectTimeoutMs', defaultTimeout) ?? defaultTimeout,
  }
}

/** 对外展示的一个端点摘要（SQLite 只给文件名）。 */
export function endpointHint(type: DbType, config: Readonly<Record<string, FieldValue>>): string {
  if (type === 'sqlite') {
    const file = textOf(config, 'filePath')
    return file === '' ? '' : file.split(/[\\/]/).at(-1) ?? file
  }
  const transport = textOf(config, 'transport')
  if (type === 'mysql' && transport === 'socket') {
    const socket = textOf(config, 'socketPath')
    return socket === '' ? '' : socket.split('/').at(-1) ?? socket
  }
  const host = textOf(config, 'host')
  const port = textOf(config, 'port')
  return host === '' ? '' : port === '' ? host : `${host}:${port}`
}
