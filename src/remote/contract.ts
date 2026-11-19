/**
 * Remote 契约：面板与宿主之间唯一的数据通道。
 *
 * 方法按「资源.动作」命名，namespace 固定 `dbqa`；参数与结果都必须是纯
 * JSON。契约同时被宿主注册（`TYPERT_MANIFEST`）与客户端挂载
 * （`REMOTE_CONTRIBUTION`）使用，避免两边各写一份描述。
 *
 * @module
 */
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

import type { DatasourceRecord, DatasourceSummary } from '../store/datasource.ts'
import type { DbType, FieldGroup, SecretRefView, ValidationIssue } from '../db/fields.ts'
import type { StartupReport } from '../store/db.ts'
import type { KnowledgeStatus } from '../knowledge/service.ts'

/** 包名，同时是 Remote descriptor id 的前缀。 */
export const PACKAGE_NAME = '@xirang-ai/dsh-db-qa'
/** 宿主服务键。 */
export const SERVICE_KEY = 'dbqaWorkbench'
/** 面板侧 Remote 命名空间。 */
export const NAMESPACE = 'dbqa'

/** 一条 JSON 值编解码器；面板不传二进制。 */
const JSON_CODEC = {
  mode: 'strict',
  typeSymbol: `${PACKAGE_NAME}/types#JsonValue`,
  schema: { parse: (value: unknown) => value },
  create: () => ({ parse: (value: unknown) => value }),
} as const

/** 构造一个「一个 payload 参数」的 descriptor。 */
function unary(method: string, implementation: string, description: string): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#${method}`,
    service: SERVICE_KEY,
    namespace: NAMESPACE,
    method,
    implementation,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'payload',
        wire: 'payload',
        source: 'json',
        codec: JSON_CODEC,
        description,
      },
    ],
    result: JSON_CODEC,
  }
}

/** 无参数方法。 */
function nullary(method: string, implementation: string): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#${method}`,
    service: SERVICE_KEY,
    namespace: NAMESPACE,
    method,
    implementation,
    invocation: { kind: 'direct' },
    parameters: [],
    result: JSON_CODEC,
  }
}

/** 描述表；加方法时只改这里。 */
export const DESCRIPTORS: readonly InvocationDescriptor[] = Object.freeze([
  nullary('datasource.list', 'datasourceList'),
  unary('datasource.get', 'datasourceGet', 'Read one datasource'),
  unary('datasource.save', 'datasourceSave', 'Create or update a datasource'),
  unary('datasource.remove', 'datasourceRemove', 'Delete a datasource'),
  unary('datasource.test', 'datasourceTest', 'Test a draft or saved datasource'),
  unary('datasource.fieldDefs', 'datasourceFieldDefs', 'Field definitions for one database type'),
  unary('conversation.markActive', 'conversationMarkActive', 'Bind or refresh the datasource of a session'),
  unary('conversation.get', 'conversationGet', 'Read the datasource binding of a session'),
  unary('conversation.list', 'conversationList', 'List saved questions by tab and page'),
  unary('conversation.setFavorite', 'conversationSetFavorite', 'Favorite or unfavorite one saved question'),
  unary('knowledge.status', 'knowledgeStatus', 'Scan the knowledge base of one datasource'),
  unary('knowledge.read', 'knowledgeRead', 'Read one knowledge document'),
])

/** 客户端挂载用的 contribution。 */
export const REMOTE_CONTRIBUTION = Object.freeze({
  package: PACKAGE_NAME,
  descriptors: DESCRIPTORS,
})

/** 宿主注册用的 manifest。 */
export const TYPERT_MANIFEST = Object.freeze({
  package: PACKAGE_NAME,
  face: 'host' as const,
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: DESCRIPTORS,
})

/** 面板拿到的数据源列表。 */
export interface DatasourceListPayload {
  readonly datasources: readonly DatasourceSummary[]
  readonly startup: StartupReport
  /** 配置里的默认界面语言；空串表示跟随宿主。 */
  readonly defaultLocale: string
}

/** 详情请求。 */
export interface DatasourceIdPayload {
  readonly id: string
}

/** 详情结果。 */
/** 详情里敏感字段回引用；明文引用带值，供编辑表单回显。 */
export type DatasourceDetail = Omit<DatasourceRecord, 'secrets'> & {
  readonly secrets: Readonly<Record<string, SecretRefView>>
}

export interface DatasourceGetResult {
  readonly datasource: DatasourceDetail
}

/** 删除结果。 */
export interface DatasourceRemoveResult {
  readonly removed: boolean
}

/** 表单草稿：原始值原样上传，宿主用同一份字段定义再校验一次。 */
export interface DatasourceDraftPayload {
  readonly dbType: DbType
  readonly values: Readonly<Record<string, unknown>>
}

/** 保存请求；`id` 为空表示新建。 */
export interface DatasourceSavePayload {
  readonly id?: string
  readonly draft: DatasourceDraftPayload
}

/** 保存结果：校验不过时 `saved` 为空，问题就地返回。 */
export interface DatasourceSaveResult {
  readonly saved: DatasourceSummary | null
  readonly issues: readonly ValidationIssue[]
}

/** 测试连接请求：二选一，给 `id` 用已保存配置，否则测草稿。 */
export interface DatasourceTestPayload {
  readonly id?: string
  readonly draft?: DatasourceDraftPayload
}

/** 一次测试的可展示结果。 */
export interface DatasourceTestView {
  readonly ok: boolean
  readonly versionRaw: string | null
  readonly latencyMs: number
  readonly readOnlyConfirmed: boolean
  readonly errorCode: string | null
  /** 已脱敏的一行原因。 */
  readonly errorDetail: string | null
}

/** 测试结果 + 校验问题（草稿不完整时没有结果）。 */
export interface DatasourceTestResult {
  readonly result: DatasourceTestView | null
  readonly issues: readonly ValidationIssue[]
}

/** 字段定义请求。 */
export interface FieldDefsPayload {
  readonly dbType: DbType
  readonly versionNum?: number | null
}

/** 字段定义结果。 */
export interface FieldDefsResult {
  readonly fields: readonly unknown[]
  readonly groups: readonly FieldGroup[]
}

/** 会话绑定的可展示形态。 */
export interface ConversationBindingView {
  readonly sessionId: string
  readonly datasourceId: string
  readonly datasourceName: string | null
  readonly agentKind: 'query' | 'analysis'
}

/** 建立 / 刷新绑定；`datasourceId` 省略时只刷新标题与活跃时间。 */
export interface ConversationMarkActivePayload {
  readonly sessionId: string
  readonly datasourceId?: string
  readonly title?: string
  readonly agentKind?: 'query' | 'analysis'
}

export interface ConversationMarkActiveResult {
  readonly binding: ConversationBindingView | null
}

export interface ConversationGetPayload {
  readonly sessionId: string
}

export interface ConversationGetResult {
  readonly binding: ConversationBindingView | null
}

/**
 * 问题列表的一行；数据源被删除时 `datasourceName` 为 null。
 *
 * `createdAt` 只作兜底：列表显示的时间取宿主会话的最后更新时间，会话被删掉时
 * 才退回索引行的建立时间。
 */
export interface ConversationItemView {
  readonly id: string
  readonly sessionId: string
  readonly title: string
  readonly createdAt: number
  readonly favoritedAt: number | null
  readonly isFavorite: boolean
  readonly datasourceId: string | null
  readonly datasourceName: string | null
}

/** 问题列表请求：两个 Tab 用两个排序字段。 */
export interface ConversationListPayload {
  readonly tab: 'all' | 'favorite'
  readonly page: number
  readonly pageSize: number
}

export interface ConversationListResult {
  readonly items: readonly ConversationItemView[]
  readonly total: number
  readonly page: number
}

/** 收藏 / 取消收藏请求。 */
export interface ConversationSetFavoritePayload {
  readonly id: string
  readonly favorite: boolean
}

export interface ConversationSetFavoriteResult {
  readonly isFavorite: boolean
  readonly favoritedAt: number | null
}

export interface KnowledgeStatusPayload {
  readonly datasourceId: string
}

export interface KnowledgeStatusResult {
  readonly datasourceName: string | null
  readonly status: KnowledgeStatus
  /** 该数据源是否已有分析会话在运行。 */
  readonly analyzing: boolean
}

export interface KnowledgeReadPayload {
  readonly datasourceId: string
  readonly tableRef?: string
  readonly part?: 'business' | 'schema' | 'both'
}

export interface KnowledgeDocumentView {
  readonly part: 'index' | 'business' | 'schema'
  readonly path: string
  readonly content: string
  readonly updatedAt: number
}

export interface KnowledgeReadResult {
  readonly tableRef: string | null
  readonly documents: readonly KnowledgeDocumentView[]
  readonly missingParts: readonly string[]
}
