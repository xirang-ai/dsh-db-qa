/**
 * Remote 实现：面板能做的四类事——列数据源、读写一条、删一条、测连接。
 *
 * 服务本身不碰 UI：所有失败都折成可序列化的结果或带错误码的
 * {@link DbqaError}，文案由客户端按 `messageKey` / 错误码本地化。
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { Config } from '../config.ts'
import type { DatasourceStore, DatasourceSummary } from '../store/datasource.ts'
import type { DbqaDatabase } from '../store/db.ts'
import type { ProbeResult } from '../db/adapter.ts'
import {
  fieldsFor,
  mergeSecrets,
  splitDraft,
  validateDraft,
  type DbType,
  type FieldValue,
  type SecretRef,
} from '../db/fields.ts'
import { testConnection } from '../db/probe.ts'
import { DbqaError } from '../errors.ts'
import {
  NAMESPACE,
  SERVICE_KEY,
  type DatasourceGetResult,
  type DatasourceListPayload,
  type DatasourceRemoveResult,
  type DatasourceSavePayload,
  type DatasourceSaveResult,
  type DatasourceTestPayload,
  type DatasourceTestResult,
  type DatasourceTestView,
  type FieldDefsPayload,
  type FieldDefsResult,
  type ConversationBindingView,
  type ConversationGetResult,
  type ConversationListPayload,
  type ConversationListResult,
  type ConversationMarkActivePayload,
  type ConversationMarkActiveResult,
  type ConversationSetFavoritePayload,
  type ConversationSetFavoriteResult,
  type KnowledgeReadPayload,
  type KnowledgeReadResult,
  type KnowledgeStatusPayload,
  type KnowledgeStatusResult,
} from './contract.ts'

/** 表单名称冲突的文案键。 */
const NAME_TAKEN_KEY = 'dbqa.validation.nameTaken'

/** 未保存草稿最多记住几次测试结论；超出按先进先出丢弃。 */
const DRAFT_PROBE_LIMIT = 4

/** 一次「测试连接」的结论，保存同一份草稿时补写进数据源行。 */
interface DraftProbe {
  readonly ok: boolean
  readonly versionRaw: string | null
  readonly versionNum: number | null
  readonly errorCode: string | null
}

/** 同一份草稿的指纹：类型、名称、非敏感字段与敏感引用都参与。 */
function draftProbeKey(
  type: DbType,
  name: string,
  config: Readonly<Record<string, FieldValue>>,
  secrets: Readonly<Record<string, SecretRef>>,
): string {
  return createHash('sha256').update(JSON.stringify([type, name, config, secrets])).digest('hex')
}

/** 面板的数据通道实现。 */
export class DbqaWorkbenchService extends TypertRemoteService {
  // 用普通属性而不是 `#` 私有字段：Cordis 调用方法时会把 service 包一层
  // `Object.create(this)`，私有字段不会随原型链继承，普通属性可以。
  private readonly storeRef: DatasourceStore
  private readonly databaseRef: DbqaDatabase
  private readonly configRef: Config
  private readonly dataDir: string
  private readonly ctxRef: Context
  private readonly abort = new AbortController()
  /** 面板刚测过、还没保存的草稿结论，按指纹等保存时认领。 */
  private readonly draftProbes = new Map<string, DraftProbe>()

  constructor(ctx: Context, database: DbqaDatabase, config: Config) {
    super(ctx, SERVICE_KEY, { namespace: NAMESPACE })
    this.databaseRef = database
    this.storeRef = database.store
    this.configRef = config
    this.ctxRef = ctx
    this.dataDir = dirname(database.file)
    ctx.effect(() => () => this.abort.abort())
  }

  /** 列表 + 启动状态；面板每次进入配置页都重新拉。 */
  datasourceList(): DatasourceListPayload {
    return {
      datasources: this.storeRef.list(),
      startup: this.databaseRef.report,
      defaultLocale: this.configRef.defaultLocale,
    }
  }

  /** 读一条详情；敏感字段回 `env:VAR` 引用或明文，供编辑时回显。 */
  datasourceGet(payload: { id?: string }): DatasourceGetResult {
    if (typeof payload?.id !== 'string' || payload.id === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: datasource.get needs an id')
    }
    const record = this.storeRef.get(payload.id)
    return { datasource: { ...record, secrets: record.secrets } }
  }

  /** 新建或更新；校验不过时把问题原样带回，不写任何行。 */
  datasourceSave(payload: DatasourceSavePayload): DatasourceSaveResult {
    const draft = payload?.draft
    if (draft === undefined || draft === null) {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: datasource.save needs a draft')
    }
    const existing =
      typeof payload.id === 'string' && payload.id !== '' ? this.storeRef.get(payload.id) : undefined
    const versionNum = existing?.serverVersionNum ?? null
    const split = splitDraft(draft.dbType, draft.values, versionNum)
    if (!split.ok) return { saved: null, issues: split.issues }

    if (existing !== undefined && existing.dbType !== draft.dbType) {
      return {
        saved: null,
        issues: [{ field: 'dbType', code: 'immutable', messageKey: 'dbqa.validation.typeImmutable' }],
      }
    }
    if (this.storeRef.nameTaken(split.value.name, existing?.id)) {
      return { saved: null, issues: [{ field: 'name', code: 'taken', messageKey: NAME_TAKEN_KEY }] }
    }

    // 编辑时留空的敏感字段保留已存值；清空输入表示不修改。
    const secrets =
      existing === undefined
        ? split.value.secrets
        : mergeSecrets(existing.dbType, split.value.secrets, existing.secrets, versionNum)

    const saved: DatasourceSummary =
      existing === undefined
        ? this.storeRef.create({
            name: split.value.name,
            dbType: split.value.dbType,
            config: split.value.config,
            secrets,
          })
        : this.storeRef.update(existing.id, {
            name: split.value.name,
            dbType: split.value.dbType,
            config: split.value.config,
            secrets,
          })
    // 面板通常先测连接再保存；保存的若正是刚测过的草稿，把结论一并落库，
    // 免得列表刚建好就显示「未测试」。草稿改过时指纹不同，不会误用旧结论。
    this.applyProbe(saved.id, draftProbeKey(draft.dbType, split.value.name, split.value.config, secrets))
    return { saved: this.storeRef.list().find((row) => row.id === saved.id) ?? saved, issues: [] }
  }

  /** 删除；不存在时返回 `removed: false`，让面板提示而不是报错。 */
  async datasourceRemove(payload: { id?: string }): Promise<DatasourceRemoveResult> {
    if (typeof payload?.id !== 'string' || payload.id === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: datasource.remove needs an id')
    }
    if (this.isAnalyzing(payload.id)) {
      throw new DbqaError('DBQA_ANALYSIS_RUNNING', 'dbqa: this datasource is being analyzed')
    }
    const removed = this.storeRef.remove(payload.id)
    if (removed) await this.databaseRef.knowledge.removeDatasource(payload.id)
    return { removed }
  }

  /** 分析会话是否还在运行：按绑定行找会话，再问宿主 Agent 状态。 */
  private isAnalyzing(datasourceId: string): boolean {
    const agents = this.ctxRef.get('agents') as
      | { get(id: string): { status?: string } | undefined }
      | undefined
    if (agents === undefined) return false
    return this.databaseRef.conversations
      .listAnalysis(datasourceId)
      .some((row) => agents.get(row.sessionId)?.status === 'running')
  }

  /** 绑定 / 刷新会话的数据源；带 datasourceId 时改选，省略时保留。 */
  conversationMarkActive(payload: ConversationMarkActivePayload): ConversationMarkActiveResult {
    if (typeof payload?.sessionId !== 'string' || payload.sessionId === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: conversation.markActive needs a session id')
    }
    if (payload.datasourceId !== undefined) this.storeRef.get(payload.datasourceId)
    const binding = this.databaseRef.conversations.markActive({
      sessionId: payload.sessionId,
      ...(payload.datasourceId === undefined ? {} : { datasourceId: payload.datasourceId }),
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.agentKind === undefined ? {} : { agentKind: payload.agentKind }),
    })
    return { binding: binding === null ? null : this.bindingView(binding) }
  }

  /** 读一个会话的绑定；未绑定返回 null。 */
  conversationGet(payload: { sessionId?: string }): ConversationGetResult {
    if (typeof payload?.sessionId !== 'string' || payload.sessionId === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: conversation.get needs a session id')
    }
    const row = this.databaseRef.conversations.getBySession(payload.sessionId)
    if (row === null || row.datasourceId === null) return { binding: null }
    return {
      binding: {
        sessionId: row.sessionId,
        datasourceId: row.datasourceId,
        datasourceName: this.datasourceName(row.datasourceId),
        agentKind: row.agentKind,
      },
    }
  }

  /**
   * 问题列表取数：全部与收藏两个 Tab 各自分页。
   *
   * 展示时间来自宿主的会话列表，只有面板能拿到，所以面板会取全量后自己排序；
   * 这里保持稳定的分页顺序即可。
   */
  conversationList(payload: ConversationListPayload): ConversationListResult {
    const tab = payload?.tab === 'favorite' ? 'favorite' : 'all'
    const pageSize =
      typeof payload?.pageSize === 'number' && payload.pageSize >= 1 ? Math.min(100, Math.trunc(payload.pageSize)) : 20
    const page = typeof payload?.page === 'number' && payload.page >= 1 ? Math.trunc(payload.page) : 1
    const result = this.databaseRef.conversations.listPage({ tab, page, pageSize })
    return {
      items: result.items.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        title: row.title,
        createdAt: row.createdAt,
        favoritedAt: row.favoritedAt,
        isFavorite: row.isFavorite,
        datasourceId: row.datasourceId,
        datasourceName: row.datasourceId === null ? null : this.datasourceName(row.datasourceId),
      })),
      total: result.total,
      page: result.page,
    }
  }

  /** 收藏 / 取消收藏；按行 id 定位，重复调用幂等。 */
  conversationSetFavorite(payload: ConversationSetFavoritePayload): ConversationSetFavoriteResult {
    if (typeof payload?.id !== 'string' || payload.id === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: conversation.setFavorite needs an id')
    }
    const row = this.databaseRef.conversations.setFavorite(payload.id, payload.favorite === true)
    if (row === null) throw new DbqaError('DBQA_NOT_FOUND', 'dbqa: conversation not found')
    return { isFavorite: row.isFavorite, favoritedAt: row.favoritedAt }
  }

  /** 扫盘 + 索引，返回知识库状态。 */
  async knowledgeStatus(payload: KnowledgeStatusPayload): Promise<KnowledgeStatusResult> {
    if (typeof payload?.datasourceId !== 'string' || payload.datasourceId === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: knowledge.status needs a datasource id')
    }
    const datasource = this.storeRef.get(payload.datasourceId)
    return {
      datasourceName: datasource.name,
      status: await this.databaseRef.knowledge.status(payload.datasourceId),
      analyzing: this.isAnalyzing(payload.datasourceId),
    }
  }

  /** 读一份知识库文档；路径与内容原样返回。 */
  async knowledgeRead(payload: KnowledgeReadPayload): Promise<KnowledgeReadResult> {
    if (typeof payload?.datasourceId !== 'string' || payload.datasourceId === '') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: knowledge.read needs a datasource id')
    }
    this.storeRef.get(payload.datasourceId)
    const result = await this.databaseRef.knowledge.read(
      payload.datasourceId,
      payload.tableRef,
      payload.part,
    )
    return {
      tableRef: result.tableRef,
      documents: result.documents.map((document) => ({
        part: document.part,
        path: document.relPath,
        content: document.content,
        updatedAt: document.updatedAt,
      })),
      missingParts: result.missingParts,
    }
  }

  private datasourceName(datasourceId: string): string | null {
    try {
      return this.storeRef.get(datasourceId).name
    } catch {
      // 数据源可能刚被删除：绑定行会被外键置 NULL，这里只做展示兜底。
      return null
    }
  }

  private bindingView(binding: {
    sessionId: string
    datasourceId: string
    agentKind: 'query' | 'analysis'
  }): ConversationBindingView {
    return {
      sessionId: binding.sessionId,
      datasourceId: binding.datasourceId,
      datasourceName: this.datasourceName(binding.datasourceId),
      agentKind: binding.agentKind,
    }
  }

  /** 测试已保存的数据源或当前草稿；成功与失败都返回可读原因。 */
  async datasourceTest(payload: DatasourceTestPayload): Promise<DatasourceTestResult> {
    let type: DbType
    let values: Record<string, unknown>
    let versionNum: number | null = null
    let savedId: string | undefined

    if (typeof payload?.id === 'string' && payload.id !== '') {
      const record = this.storeRef.get(payload.id)
      savedId = record.id
      type = record.dbType
      versionNum = record.serverVersionNum
      values = { ...record.config, name: record.name }
      // 敏感字段用已存的引用，不要求面板回传。
      for (const [key, ref] of Object.entries(record.secrets)) {
        values[key] = ref.kind === 'env' ? `env:${ref.var}` : ref.value
      }
    } else if (payload?.draft !== undefined) {
      type = payload.draft.dbType
      values = payload.draft.values
    } else {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: datasource.test needs an id or a draft')
    }

    const issues = validateDraft(type, values, versionNum)
    if (issues.length > 0) return { result: null, issues }

    const split = splitDraft(type, values, versionNum)
    if (!split.ok) return { result: null, issues: split.issues }

    const probe = await testConnection(
      type,
      split.value.name,
      split.value.config,
      split.value.secrets,
      {
        dataDir: this.dataDir,
        signal: this.abort.signal,
        defaultConnectTimeoutMs: this.configRef.connectTimeoutMs,
      },
    )

    const view: DatasourceTestView = {
      ok: probe.ok,
      versionRaw: probe.versionRaw,
      latencyMs: probe.latencyMs,
      readOnlyConfirmed: probe.readOnlyConfirmed,
      errorCode: probe.errorCode,
      errorDetail: probe.errorDetail,
    }

    if (savedId !== undefined) {
      this.storeRef.recordTest(savedId, {
        ok: probe.ok,
        ...(probe.versionRaw === null ? {} : { versionRaw: probe.versionRaw }),
        ...(probe.versionNum === null ? {} : { versionNum: probe.versionNum }),
        ...(probe.errorCode === null ? {} : { errorCode: probe.errorCode }),
      })
    } else {
      this.rememberProbe(draftProbeKey(type, split.value.name, split.value.config, split.value.secrets), probe)
    }
    return { result: view, issues: [] }
  }

  /** 记住一次草稿探针结论，等待同一份草稿的保存认领。 */
  private rememberProbe(key: string, probe: ProbeResult): void {
    this.draftProbes.set(key, {
      ok: probe.ok,
      versionRaw: probe.versionRaw,
      versionNum: probe.versionNum,
      errorCode: probe.errorCode,
    })
    while (this.draftProbes.size > DRAFT_PROBE_LIMIT) {
      const oldest = this.draftProbes.keys().next().value
      if (oldest === undefined) break
      this.draftProbes.delete(oldest)
    }
  }

  /** 保存的草稿刚测过时，把这次结论写进数据源行；每份草稿只认领一次。 */
  private applyProbe(id: string, key: string): void {
    const probe = this.draftProbes.get(key)
    if (probe === undefined) return
    this.draftProbes.delete(key)
    this.storeRef.recordTest(id, {
      ok: probe.ok,
      ...(probe.versionRaw === null ? {} : { versionRaw: probe.versionRaw }),
      ...(probe.versionNum === null ? {} : { versionNum: probe.versionNum }),
      ...(probe.errorCode === null ? {} : { errorCode: probe.errorCode }),
    })
  }

  /** 字段定义；版本已知时顺带给出置灰与收窄后的选项。 */
  datasourceFieldDefs(payload: FieldDefsPayload): FieldDefsResult {
    if (payload?.dbType !== 'mysql' && payload?.dbType !== 'postgresql' && payload?.dbType !== 'sqlite') {
      throw new DbqaError('DBQA_INVALID_CONFIG', 'dbqa: datasource.fieldDefs needs a known database type')
    }
    return {
      fields: fieldsFor(payload.dbType, payload.versionNum ?? null),
      groups: ['basic', 'conn', 'auth', 'tls', 'ssh', 'session'],
    }
  }
}
