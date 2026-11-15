/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/**
 * 单个动作的流转约束。
 * from：允许发起该动作的状态白名单（没有列出的状态一律拒绝，避免草稿越级终止/归档）。
 * to：动作成功后的目标状态。
 * reason：被拒绝时返回给用户的原因，页面直接展示，不再各自写文案。
 */
export type ActionRule = {
  from: string[]
  to: string
  reason: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 声明了约束的动作按 from/to 执行；未声明的动作沿用旧行为，保证既有模块兼容。 */
  actionRules?: Record<string, ActionRule>
  /** 终态记录不可再被任何动作改写，用于保护历史完成记录。 */
  terminalStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

/** 动作结果码：页面据此区分成功、重复请求、越级拒绝与事务回滚。 */
export type ActionResultCode =
  | 'ok'
  | 'duplicate'
  | 'conflict'
  | 'invalid-action'
  | 'invalid-status'
  | 'not-found'
  | 'input-path-occupied'
  | 'transaction-failed'
  | 'storage-error'

export type ActionResult = {
  ok: boolean
  message: string
  code?: ActionResultCode
  requestId?: string
  /** 本次动作产生的批次结果类型（终止失败 / 正常归档 / 事务回滚 / 重试…）。 */
  resultType?: string
  /** 回写后的编排计划批次结论，页面列表直接展示。 */
  planSummary?: { planCode: string; conclusion: string }
  /** 失败或回滚时的现场信息（失败分区、回滚状态等），仅用于展示和核对。 */
  detail?: Record<string, string | number | boolean>
}

export type RunActionOptions = {
  /** 一次用户操作的请求号：重复点击/多窗口同时点击时用于识别首个有效请求。 */
  requestId?: string
  /** 终止/失败时显式给出的失败原因，缺省由服务层按分区断点生成。 */
  reason?: string
  /** 终止时可显式给出已失败/未完成的分区，缺省按分区覆盖推算。 */
  failedPartitions?: string[]
  /** 测试或巡检时可以指定动作时间，缺省取当前时间。 */
  at?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 批处理任务的执行批次记录。字段与 EntryRow 兼容，和业务行存在同一份本地数据里。 */
export type ExecutionRecord = EntryRow & {
  批次编号: string
  任务编号: string
  所属计划: string
  阶段: string
  结论: string
  结果类型: string
  失败分区: string
  已完成分区: string
  异常原因: string
  请求编号: string
  事件时间: string
  有效: string
  无效原因?: string
}

export type TransactionState = '已提交' | '已回滚'

export type TransactionRecord = EntryRow & {
  事务编号: string
  任务编号: string
  动作: string
  请求编号: string
  状态: TransactionState
  原因: string
  事件时间: string
}

export type ExecutionRecordView = ExecutionRecord & {
  有效性: string
  有效性说明: string
  记录来源: string
}

export type BatchExecutionDetail = {
  taskId: number
  taskCode: string
  taskStatus: string
  runStage: string
  effectiveConclusion: string
  terminationResult: string
  exceptionReason: string
  retryHint: string
  failedPartitions: string[]
  /** 仅存在于历史无效终止记录中的断点，只用于核对提示，不参与重试/回填。 */
  legacyFailedPartitions: string[]
  completedPartitions: string[]
  remainingPartitions: string[]
  processingPartitions: string[]
  currentBatch: string
  records: ExecutionRecordView[]
  emptyReason: string
  legacy: boolean
  conflictNote: string
  planCodes: string[]
  retryable: boolean
}

export type ScheduleBatchSummary = {
  planCode: string
  planId: number
  planStatus: string
  executionBatch: string
  conclusion: string
  completed: number
  failed: number
  running: number
  waiting: number
  draft: number
  linkedTaskCodes: string[]
  updatedAt: string
  emptyReason: string
}
