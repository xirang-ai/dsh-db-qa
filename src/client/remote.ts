/**
 * 面板与宿主之间的数据类型。
 *
 * 只放类型与挂载用的描述表引用，组件不直接开数据库、不 import 宿主实现。
 *
 * @module
 */
import type {
  DatasourceGetResult,
  DatasourceListPayload,
  DatasourceRemoveResult,
  DatasourceSavePayload,
  DatasourceSaveResult,
  DatasourceTestPayload,
  DatasourceTestResult,
  FieldDefsPayload,
  FieldDefsResult,
  ConversationGetResult,
  ConversationListPayload,
  ConversationListResult,
  ConversationMarkActivePayload,
  ConversationMarkActiveResult,
  ConversationSetFavoritePayload,
  ConversationSetFavoriteResult,
  KnowledgeReadPayload,
  KnowledgeReadResult,
  KnowledgeStatusPayload,
  KnowledgeStatusResult,
} from '../remote/contract.ts'

/** 挂载描述表所需的最小形状。 */
export interface RemoteContributionLike {
  readonly package: string
  readonly descriptors: readonly unknown[]
}

/** 网关把每次 Remote 调用折成这个信封；失败不会 reject。 */
export type RemoteEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code?: string; readonly message: string } }

/** 带错误码的失败，供面板统一翻译。 */
export interface RemoteFailure extends Error {
  readonly code?: string
}

/** 解开信封；失败时抛出带 `code` 的错误。 */
export function unwrapRemote<T>(envelope: RemoteEnvelope<T>): T {
  if (envelope.ok) return envelope.value
  const error = new Error(envelope.error.message) as RemoteFailure
  if (envelope.error.code !== undefined) Object.defineProperty(error, 'code', { value: envelope.error.code })
  throw error
}

/** `remote.dbqa` 命名空间的方法集合。 */
export interface DbqaRemote {
  readonly 'datasource.list': () => Promise<RemoteEnvelope<DatasourceListPayload>>
  readonly 'datasource.get': (payload: { readonly id: string }) => Promise<RemoteEnvelope<DatasourceGetResult>>
  readonly 'datasource.save': (payload: DatasourceSavePayload) => Promise<RemoteEnvelope<DatasourceSaveResult>>
  readonly 'datasource.remove': (payload: { readonly id: string }) => Promise<RemoteEnvelope<DatasourceRemoveResult>>
  readonly 'datasource.test': (payload: DatasourceTestPayload) => Promise<RemoteEnvelope<DatasourceTestResult>>
  readonly 'datasource.fieldDefs': (payload: FieldDefsPayload) => Promise<RemoteEnvelope<FieldDefsResult>>
  readonly 'conversation.markActive': (payload: ConversationMarkActivePayload) => Promise<RemoteEnvelope<ConversationMarkActiveResult>>
  readonly 'conversation.get': (payload: { readonly sessionId: string }) => Promise<RemoteEnvelope<ConversationGetResult>>
  readonly 'conversation.list': (payload: ConversationListPayload) => Promise<RemoteEnvelope<ConversationListResult>>
  readonly 'conversation.setFavorite': (
    payload: ConversationSetFavoritePayload,
  ) => Promise<RemoteEnvelope<ConversationSetFavoriteResult>>
  readonly 'knowledge.status': (payload: KnowledgeStatusPayload) => Promise<RemoteEnvelope<KnowledgeStatusResult>>
  readonly 'knowledge.read': (payload: KnowledgeReadPayload) => Promise<RemoteEnvelope<KnowledgeReadResult>>
}
