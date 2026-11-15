import type { BatchExecutionDetail, EntryRow, ExecutionRecord, ExecutionRecordView, ScheduleBatchSummary } from './types'

/**
 * 批量转换的调用链：任务动作 -> 批处理任务行 -> 执行批次记录(batch_executions)
 * -> 编排执行记录(schedule_executions) / 编排计划派生字段。
 *
 * 这里只放纯函数，落盘与事务在 api/local-service.ts，避免页面各自判断状态。
 */

export const BATCH_KEY = 'batch'
export const BATCH_EXEC_KEY = 'batch_executions'
export const SCHEDULE_KEY = 'schedule'
export const SCHEDULE_EXEC_KEY = 'schedule_executions'

export const STAGE = {
  draft: '草稿',
  queued: '待调度',
  running: '运行中',
  completed: '已完成',
  failed: '已失败',
} as const

/** 编排计划没有「已完成/已失败」状态，用派生的执行批次结论表达。 */
export const TERMINAL_CONCLUSIONS = ['已完成', '已失败', '已停止']

export const RESULT_TYPE = {
  archive: '正常归档',
  terminate: '终止失败',
  rollback: '事务回滚',
  retry: '重试',
  submit: '提交调度',
  start: '启动任务',
  legacy: '历史记录',
} as const

export type TaskView = {
  row: EntryRow
  taskCode: string
  partitions: string[]
  completedPartitions: string[]
  failedPartitions: string[]
  /** 仅残留在历史无效终止记录里的断点：用于核对，不参与重试与状态判定。 */
  legacyFailedPartitions: string[]
  remainingPartitions: string[]
  processingPartitions: string[]
  batchId: string
  stage: string
  conclusion: string
  resultType: string
  terminationResult: string
  terminationRequestId: string
  exceptionReason: string
  lastExceptionReason: string
  retryCount: number
  legacy: boolean
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
}

/** 兼容逗号串、顿号串和 JSON 数组三种写法（旧记录多为逗号串）。 */
export function parseList(value: unknown): string[] {
  if (typeof value !== 'string') {
    return []
  }
  const text = value.trim()
  if (!text) {
    return []
  }
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        return unique(parsed.map((item) => String(item)))
      }
    } catch {
      // 落到按分隔符拆分的旧格式
    }
  }
  return unique(text.split(/[,，、;；\s]+/))
}

export function formatList(list: string[]): string {
  return JSON.stringify(unique(list))
}

export function displayList(list: string[]): string {
  return list.length > 0 ? list.join('、') : '—'
}

export function taskCodeOf(row: EntryRow): string {
  return String(row['任务编号'] ?? `任务-${row.id}`)
}

export function toTaskView(row: EntryRow): TaskView {
  const partitions = parseList(row['分区覆盖'])
  const completedPartitions = parseList(row['已完成分区']).filter((item) => partitions.length === 0 || partitions.includes(item))
  const failedPartitions = parseList(row['失败分区']).filter((item) => !completedPartitions.includes(item))
  const legacyFailedPartitions = parseList(row['上次失败分区']).filter((item) => !completedPartitions.includes(item))
  const remainingPartitions = partitions.filter((item) => !completedPartitions.includes(item))
  const storedProcessing = parseList(row['本次处理分区'])
  // 重试时只处理「未完成分区」：已完成分区是断点，不能被重新覆盖。
  const processingPartitions = storedProcessing.length > 0
    ? storedProcessing.filter((item) => !completedPartitions.includes(item))
    : remainingPartitions
  const stage = String(row['阶段'] ?? row.status ?? STAGE.draft)
  const legacy = !row['执行批次'] && (row.status === STAGE.completed || row.status === STAGE.failed)
  return {
    row,
    taskCode: taskCodeOf(row),
    partitions,
    completedPartitions,
    failedPartitions,
    legacyFailedPartitions,
    remainingPartitions,
    processingPartitions,
    batchId: String(row['执行批次'] ?? ''),
    stage,
    conclusion: String(row['结论'] ?? row.status ?? ''),
    resultType: String(row['结果类型'] ?? ''),
    terminationResult: String(row['终止结果'] ?? ''),
    terminationRequestId: String(row['终止请求编号'] ?? ''),
    exceptionReason: String(row['异常原因'] ?? ''),
    lastExceptionReason: String(row['上次异常原因'] ?? ''),
    retryCount: Number(row['重试次数'] ?? 0),
    legacy,
  }
}

export function isTerminationRecord(record: EntryRow): boolean {
  const resultType = String(record['结果类型'] ?? '')
  return resultType.includes('终止') || resultType.includes('回滚')
}

export function isArchiveRecord(record: EntryRow): boolean {
  const resultType = String(record['结果类型'] ?? '')
  return resultType.includes('归档') || (!isTerminationRecord(record) && String(record['结论'] ?? record.status) === STAGE.completed)
}

export function recordStage(record: EntryRow): string {
  return String(record['阶段'] ?? record.status ?? '')
}

export function recordConclusion(record: EntryRow): string {
  return String(record['结论'] ?? record.status ?? '')
}

/**
 * 记录有效性：
 * - 新记录带「有效」字段，按字段判定；
 * - 旧记录按旧规则回放：终止只能落在运行中，所以草稿/待调度阶段的终止结论无效，
 *   历史归档结论保持有效。判定只用于展示，不回写旧值。
 */
export function recordValidity(record: EntryRow): { valid: boolean; reason: string; legacy: boolean } {
  const explicit = String(record['有效'] ?? '')
  const legacy = explicit.trim() === ''
  if (explicit === '无效') {
    return { valid: false, reason: String(record['无效原因'] ?? '记录已标记为无效'), legacy: true }
  }
  if (explicit === '有效') {
    return { valid: true, reason: '', legacy: false }
  }
  const stage = recordStage(record)
  const conclusion = recordConclusion(record)
  if (isTerminationRecord(record) && conclusion === STAGE.failed && !['运行中', '已完成'].includes(stage)) {
    return {
      valid: false,
      reason: `历史记录按旧规则回放：终止只能作用于运行中任务，${stage}阶段的终止结论无效`,
      legacy: true,
    }
  }
  if (isArchiveRecord(record) && conclusion === STAGE.completed && stage === STAGE.draft) {
    return {
      valid: false,
      reason: '历史记录按旧规则回放：草稿阶段没有完成归档的合法来源，归档结论无效',
      legacy: true,
    }
  }
  return { valid: true, reason: '历史记录按旧规则保留', legacy: true }
}

export function viewRecord(record: EntryRow): ExecutionRecordView {
  const validity = recordValidity(record)
  return {
    ...(record as ExecutionRecord),
    有效性: validity.valid ? '有效' : '无效',
    有效性说明: validity.reason || '—',
    记录来源: validity.legacy ? '历史记录' : '本系统',
  }
}

/**
 * 冲突判定（任务详情与列表共用）：
 * 1) 任务当前已是「已完成」，历史完成归档有效，任何阶段的终止记录都不能把结论改成失败；
 * 2) 只有有效终止记录（运行中发生）才能让结论落在「已失败」；
 * 3) 草稿/待调度阶段的终止记录判定无效，仅作为历史留档展示。
 */
export function effectiveConclusion(view: TaskView, records: EntryRow[]): {
  conclusion: string
  conflictNote: string
  terminationDisplay: string
  validTermination?: EntryRow
  invalidTermination?: EntryRow
} {
  const viewed = records.map((record) => ({ record, validity: recordValidity(record) }))
  const validTermination = viewed.find((item) => item.validity.valid && isTerminationRecord(item.record) && recordConclusion(item.record) === STAGE.failed)?.record
  const invalidTermination = viewed.find((item) => !item.validity.valid && isTerminationRecord(item.record))?.record
  const validArchive = viewed.find((item) => item.validity.valid && isArchiveRecord(item.record) && recordConclusion(item.record) === STAGE.completed)?.record

  if (String(view.row.status) === STAGE.completed) {
    const note = invalidTermination
      ? '草稿阶段的终止结论与完成归档冲突：完成归档有效，终止结论无效，历史完成记录保持原值未被改写'
      : ''
    return {
      conclusion: STAGE.completed,
      conflictNote: note,
      terminationDisplay: invalidTermination
        ? `正常归档（有效）；${recordStage(invalidTermination)}阶段的终止记录无效，未改写完成结论`
        : validTermination
          ? '终止后又被完成归档覆盖（历史记录，不改写）'
          : '正常归档（未发起有效终止）',
      validTermination,
      invalidTermination,
    }
  }
  if (String(view.row.status) === STAGE.failed) {
    return {
      conclusion: STAGE.failed,
      conflictNote: invalidTermination && !validTermination
        ? '终止记录来自非运行中阶段，按新规则无效；任务按既有失败结论保留'
        : '',
      terminationDisplay: validTermination
        ? `终止失败（已失败，请求 ${String(validTermination['请求编号'] ?? '—')}）`
        : invalidTermination
          ? `终止记录无效（${recordStage(invalidTermination)}阶段）`
          : `失败（${view.exceptionReason || '原因未记录'}）`,
      validTermination,
      invalidTermination,
    }
  }
  const legacyFailed = invalidTermination ? view.legacyFailedPartitions : []
  const notes: string[] = []
  if (validArchive) {
    notes.push('存在历史完成归档记录，但任务当前阶段不是已完成，按现状展示且不改写历史值')
  }
  if (invalidTermination) {
    notes.push(
      `存在${recordStage(invalidTermination)}阶段的终止记录，按新规则无效；该记录里的失败分区 ${displayList(legacyFailed)} 属旧版本写入，未回填到任务行`,
    )
  }
  return {
    conclusion: String(view.row.status),
    conflictNote: notes.join('；'),
    terminationDisplay: invalidTermination && !view.terminationResult
      ? `终止记录无效（${recordStage(invalidTermination)}阶段不能终止），当前未发起有效终止`
      : view.terminationResult || '未发起终止',
    validTermination,
    invalidTermination,
  }
}

export function buildBatchDetail(row: EntryRow, records: EntryRow[]): BatchExecutionDetail {
  const view = toTaskView(row)
  const sorted = [...records].sort((a, b) => {
    const timeA = String(a['事件时间'] ?? '')
    const timeB = String(b['事件时间'] ?? '')
    if (timeA !== timeB) return timeA.localeCompare(timeB)
    return Number(a.id) - Number(b.id)
  })
  const conclusion = effectiveConclusion(view, sorted)

  // 本轮执行详情只看当前批次；「任务清单的终止结果」也来自同一批判定，保证两处对得上。
  const currentBatchRecords = view.batchId
    ? sorted.filter((record) => String(record['批次编号'] ?? '') === view.batchId)
    : []
  const batchConclusion = currentBatchRecords.length > 0
    ? effectiveConclusion(view, currentBatchRecords)
    : conclusion
  // 当前批次没有失败结论，但任务行带失败结果时（历史行/异常中断），以有效记录或行状态为准。
  const hasFailed = batchConclusion.conclusion === STAGE.failed
    || sorted.some((record) => recordValidity(record).valid && isTerminationRecord(record))
  const hasLegacy = sorted.some((record) => recordValidity(record).legacy)
  let emptyReason = ''
  if (sorted.length === 0) {
    if (row.status === STAGE.draft) {
      emptyReason = '该任务仍是草稿，尚未提交调度，因此没有执行批次记录'
    } else if (row.status === STAGE.queued) {
      emptyReason = '该任务已提交调度但尚未启动，还没有运行批次结果'
    } else {
      emptyReason = '本地存储中没有该任务的执行批次明细，可能由旧版本写入或记录已被清理'
    }
  }
  const retryable = row.status === STAGE.failed
  const retryHint = retryable
    ? `可重试：上次异常「${view.exceptionReason || '未记录'}」；重试只处理未完成分区 ${displayList(view.processingPartitions)}，已完成分区 ${displayList(view.completedPartitions)} 不会被重新覆盖`
    : hasFailed && row.status === STAGE.completed
      ? '历史已完成记录：存在终止或失败留档，但完成归档有效，不允许重试改写'
      : ''
  return {
    taskId: Number(row.id),
    taskCode: view.taskCode,
    taskStatus: String(row.status),
    runStage: view.stage,
    effectiveConclusion: conclusion.conclusion,
    terminationResult: batchConclusion.terminationDisplay,
    exceptionReason: view.exceptionReason || '—',
    retryHint,
    failedPartitions: view.failedPartitions,
    legacyFailedPartitions: view.legacyFailedPartitions,
    completedPartitions: view.completedPartitions,
    remainingPartitions: view.remainingPartitions,
    processingPartitions: view.processingPartitions,
    currentBatch: view.batchId,
    records: sorted.map(viewRecord),
    emptyReason,
    legacy: hasLegacy,
    conflictNote: conclusion.conflictNote,
    planCodes: parseList(row['所属计划']),
    retryable,
  }
}

export function planTaskCodes(plan: EntryRow): string[] {
  return parseList(plan['任务列表'])
}

/** 编排计划按修正后的批次结果重新计算，只派生结论，不覆盖历史终态记录。 */
export function deriveScheduleSummary(
  plan: EntryRow,
  tasks: EntryRow[],
  updatedAt: string,
): ScheduleBatchSummary {
  const planCode = String(plan['计划编号'] ?? `计划-${plan.id}`)
  const linkedTaskCodes = planTaskCodes(plan)
  const completed = tasks.filter((task) => task.status === STAGE.completed).length
  const failed = tasks.filter((task) => task.status === STAGE.failed).length
  const running = tasks.filter((task) => task.status === STAGE.running).length
  const waiting = tasks.filter((task) => task.status === STAGE.queued).length
  const draft = tasks.filter((task) => task.status === STAGE.draft).length

  let conclusion: string = STAGE.draft
  if (linkedTaskCodes.length === 0) {
    conclusion = '未关联任务'
  } else if (running > 0) {
    conclusion = STAGE.running
  } else if (failed > 0) {
    conclusion = STAGE.failed
  } else if (completed > 0 && completed === tasks.length) {
    conclusion = STAGE.completed
  } else if (waiting > 0) {
    conclusion = STAGE.queued
  } else if (draft > 0) {
    conclusion = STAGE.draft
  }

  let emptyReason = ''
  if (linkedTaskCodes.length === 0) {
    emptyReason = '该计划的任务列表为空，尚未关联批处理任务，无法计算执行批次结论'
  } else if (tasks.length === 0) {
    emptyReason = `任务列表引用的 ${linkedTaskCodes.join('、')} 在批处理任务清单中不存在，可能已被清理`
  }

  return {
    planCode,
    planId: Number(plan.id),
    planStatus: String(plan.status),
    executionBatch: String(plan['执行批次'] ?? ''),
    conclusion,
    completed,
    failed,
    running,
    waiting,
    draft,
    linkedTaskCodes,
    updatedAt,
    emptyReason,
  }
}
