import {
  BATCH_EXEC_KEY,
  BATCH_KEY,
  SCHEDULE_EXEC_KEY,
  SCHEDULE_KEY,
  STAGE,
  buildBatchDetail,
  deriveScheduleSummary,
  displayList,
  formatList,
  isArchiveRecord,
  isTerminationRecord,
  parseList,
  planTaskCodes,
  recordConclusion,
  recordStage,
  recordValidity,
  taskCodeOf,
  toTaskView,
  viewRecord,
} from '@/data/execution'
import { allRows, invalidateCache, listRows, resetRows, saveRows, saveRowsTransaction } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type {
  ActionResult,
  ActionResultCode,
  BatchExecutionDetail,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RunActionOptions,
  ScheduleBatchSummary,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const TX_KEY = 'batch_transactions'
const REQUEST_KEY = 'batch_requests'

/** 测试与巡检用的故障注入开关：模拟 localStorage 写失败，验证事务回滚（一次性）。 */
let transactionFault = false
export function setTransactionFaultForTest(enabled: boolean): void {
  transactionFault = enabled
}
function takeTransactionFault(): boolean {
  const enabled = transactionFault
  transactionFault = false
  return enabled
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function nowStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  ].join('T')
}

function datePart(stamp: string): string {
  return stamp.slice(0, 10).replace(/-/g, '')
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function requestId(options: RunActionOptions, prefix: string): string {
  if (options.requestId && options.requestId.trim()) {
    return options.requestId.trim()
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function fail(code: ActionResultCode, message: string, detail?: ActionResult['detail']): ActionResult {
  return { ok: false, code, message, detail }
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function recordsOfTask(row: EntryRow): EntryRow[] {
  const code = taskCodeOf(row)
  return listRows(BATCH_EXEC_KEY).filter((record) => String(record['任务编号'] ?? '') === code)
}

/** 批量转换列表：在业务行上补齐派生字段，页面不做业务判断。 */
export function listBatchEntries(filters: Record<string, string> = {}): PageResult {
  const items = filterRows(listRows(BATCH_KEY), filters).map((row) => {
    const detail = buildBatchDetail(row, recordsOfTask(row))
    const derived: EntryRow = {
      ...row,
      阶段: detail.runStage,
      结论: detail.effectiveConclusion,
      终止结果展示: detail.terminationResult,
      异常原因展示: detail.exceptionReason,
      失败分区展示: displayList(detail.failedPartitions),
      已完成分区展示: displayList(detail.completedPartitions),
      可重试: detail.retryable ? '是' : '—',
      执行详情: detail.records.length > 0 ? `${detail.records.length} 条记录` : (detail.emptyReason || '—'),
      冲突说明: detail.conflictNote || '—',
    }
    return derived
  })
  return { items, total: items.length, page: 1, size: items.length }
}

/** 某个动作在当前状态下是否可执行：页面据此置灰按钮，避免用户越级点击后才看到报错。 */
export function canRunAction(key: string, row: Pick<EntryRow, 'status'>, action: string): boolean {
  const meta = moduleMeta(key)
  const rule = meta.actionRules?.[action]
  if (!rule) {
    return meta.actionTargets[action] !== undefined && String(row.status) !== meta.actionTargets[action]
  }
  return rule.from.includes(String(row.status))
}

/** 动作被拒的原因（用于按钮提示）。 */
export function actionHint(key: string, action: string): string {
  return moduleMeta(key).actionRules?.[action]?.reason ?? ''
}

/**
 * 统一动作入口。
 * - batch 走完整调用链：任务动作 -> 执行批次 -> 编排执行回写。
 * - 其他模块沿用旧的流转方式；带 actionRules 的模块按约束执行，未声明则完全旧行为。
 */
export function runAction(key: string, id: number, action: string, options: RunActionOptions = {}): ActionResult {
  if (key === BATCH_KEY) {
    return runBatchAction(id, action, options)
  }
  return runGenericAction(key, id, action)
}

function runGenericAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return fail('invalid-action', `${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('not-found', `没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)
  const rule = meta.actionRules?.[action]
  if (rule && !rule.from.includes(current)) {
    return fail('invalid-status', `当前状态「${current}」不能执行「${action}」：${rule.reason}`)
  }
  if (meta.terminalStatuses?.includes(current)) {
    return fail('invalid-status', `${meta.entity}已处于终态「${current}」，不能再执行「${action}」`)
  }
  if (current === target) {
    return fail('duplicate', `${meta.entity}已经是「${target}」，不用重复操作`)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, code: 'ok', message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 输入路径占用核对：同模块里已有运行中任务使用同一输入路径时不允许再提交/启动/重试。 */
function inputPathConflict(rows: EntryRow[], task: EntryRow): EntryRow | undefined {
  const path = String(task['输入路径'] ?? '').trim()
  if (!path) {
    return undefined
  }
  return rows.find((row) => {
    if (Number(row.id) === Number(task.id)) return false
    if (String(row.status) !== STAGE.running) return false
    return String(row['输入路径'] ?? '').trim() === path
  })
}

function activeBatchOf(row: EntryRow): string {
  return String(row['执行批次'] ?? '') || `${taskCodeOf(row)}-${datePart(nowStamp())}-live`
}

function buildExecutionRecord(params: {
  id: number
  task: EntryRow
  stage: string
  conclusion: string
  resultType: string
  failedPartitions: string[]
  completedPartitions: string[]
  reason: string
  requestId: string
  at: string
  batchId?: string
  valid?: string
  invalidReason?: string
}): EntryRow {
  const taskCode = taskCodeOf(params.task)
  const batchId = params.batchId || activeBatchOf(params.task)
  return {
    id: params.id,
    status: params.conclusion,
    pending: false,
    abnormal: params.conclusion === STAGE.failed,
    批次编号: batchId,
    任务编号: taskCode,
    所属计划: parseList(params.task['所属计划']).join(','),
    阶段: params.stage,
    结论: params.conclusion,
    结果类型: params.resultType,
    失败分区: formatList(params.failedPartitions),
    已完成分区: formatList(params.completedPartitions),
    异常原因: params.reason,
    请求编号: params.requestId,
    事件时间: params.at,
    有效: params.valid ?? '有效',
    无效原因: params.invalidReason ?? '',
  }
}

function buildTransaction(params: {
  id: number
  taskCode: string
  action: string
  requestId: string
  state: '已提交' | '已回滚'
  reason: string
  at: string
}): EntryRow {
  return {
    id: params.id,
    status: params.state,
    pending: false,
    abnormal: params.state === '已回滚',
    // 事务号带时间戳与请求号尾段：多窗口/高频操作也不会撞号。
    事务编号: `TX-${datePart(params.at)}-${String(params.id).padStart(3, '0')}-${params.requestId.slice(-4)}`,
    任务编号: params.taskCode,
    动作: params.action,
    请求编号: params.requestId,
    状态: params.state,
    原因: params.reason,
    事件时间: params.at,
  }
}

type SchedulePatches = {
  plans: EntryRow[]
  executions: EntryRow[]
}

/**
 * 编排回写：按修正后的批处理任务行重新计算计划摘要，并同步当前执行批次的记录。
 * - 计划的生命周期状态（草稿/待校验/运行中/已停止）不在这里改写；
 * - 已是「已完成」的历史编排执行记录不再改写，新的修正另起批次留档。
 */
function buildSchedulePatches(tasks: EntryRow[], changedCodes: string[], at: string): SchedulePatches {
  const plans = listRows(SCHEDULE_KEY).map((row) => ({ ...row }))
  const executions = listRows(SCHEDULE_EXEC_KEY).map((row) => ({ ...row }))
  let execId = nextId(executions)

  for (const plan of plans) {
    const linked = planTaskCodes(plan)
    if (linked.length === 0) {
      continue
    }
    if (!changedCodes.some((code) => linked.includes(code))) {
      continue
    }
    const planTasks = tasks.filter((task) => linked.includes(taskCodeOf(task)))
    const summary = deriveScheduleSummary(plan, planTasks, at)
    const failedTasks = planTasks.filter((task) => task.status === STAGE.failed).map(taskCodeOf)
    const completedTasks = planTasks.filter((task) => task.status === STAGE.completed).map(taskCodeOf)
    const currentBatch = String(plan['执行批次'] ?? '')
    const note = `按修正后的批次结果重算：${changedCodes.join('、')} 变更；已完成 ${summary.completed}，已失败 ${summary.failed}，运行中 ${summary.running}`
    const existing = currentBatch
      ? executions.find(
          (record) => String(record['计划编号'] ?? '') === summary.planCode && String(record['执行批次'] ?? '') === currentBatch,
        )
      : undefined

    const executionPatch = {
      计划编号: summary.planCode,
      任务列表: linked.join(','),
      批次结论: summary.conclusion,
      批次说明: note,
      失败任务: failedTasks.join(','),
      已完成任务: completedTasks.join(','),
      回写时间: at,
    }

    let targetBatch = currentBatch
    const shouldAppend = !existing || String(existing['批次结论'] ?? '') === STAGE.completed
    if (shouldAppend) {
      // 没有批次号，或当前批次是历史已完成记录（不能被偷改）：另起一个新批次承接修正结论。
      targetBatch = `${summary.planCode}-${datePart(at)}-${String(execId).padStart(2, '0')}`
      executions.push({
        id: execId,
        status: summary.conclusion,
        pending: summary.conclusion === STAGE.running || summary.conclusion === STAGE.queued,
        abnormal: summary.conclusion === STAGE.failed,
        执行批次: targetBatch,
        ...executionPatch,
      })
      execId += 1
    } else {
      Object.assign(existing, {
        ...executionPatch,
        status: summary.conclusion,
        pending: summary.conclusion === STAGE.running || summary.conclusion === STAGE.queued,
        abnormal: summary.conclusion === STAGE.failed,
      })
    }

    Object.assign(plan, {
      执行批次: targetBatch,
      批次结论: summary.conclusion,
      批次说明: note,
      计划更新时间: at,
    })
  }

  return { plans, executions }
}

function isDuplicateRequest(task: EntryRow, action: string, reqId: string): { duplicate: boolean; message: string } {
  const ledger = listRows(REQUEST_KEY)
  const seen = ledger.find(
    (entry) => String(entry['请求编号'] ?? '') === reqId && String(entry['任务编号'] ?? '') === taskCodeOf(task),
  )
  if (seen) {
    return {
      duplicate: true,
      message: `请求 ${reqId} 已处理（${String(seen['动作'] ?? '')} -> ${String(seen['结果'] ?? '')}），重复请求已忽略，不产生第二次结果`,
    }
  }
  if (action === '终止任务' && String(task['终止请求编号'] ?? '') && String(task['终止请求编号'] ?? '') !== reqId) {
    return {
      duplicate: true,
      message: `已有首个有效终止请求 ${String(task['终止请求编号'])}，本次请求 ${reqId} 被忽略`,
    }
  }
  return { duplicate: false, message: '' }
}

function runBatchAction(id: number, action: string, options: RunActionOptions): ActionResult {
  // 多窗口共享 localStorage：动作前重新读取最新快照，保证「首个有效请求」胜出。
  invalidateCache()
  const meta = moduleMeta(BATCH_KEY)
  const rule = meta.actionRules?.[action]
  if (!rule) {
    return fail('invalid-action', `${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(BATCH_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('not-found', `没有找到编号为 ${id} 的${meta.entity}`)
  }
  const task = rows[index]
  const view = toTaskView(task)
  const at = options.at ?? nowStamp()
  const reqId = requestId(options, action === '终止任务' ? 'TERM' : 'BATCH')
  const current = String(task.status)

  const duplicate = isDuplicateRequest(task, action, reqId)
  if (duplicate.duplicate) {
    return fail('duplicate', duplicate.message, { requestId: reqId, status: current })
  }
  if (action === '终止任务' && current === STAGE.failed && String(task['终止请求编号'] ?? '')) {
    return fail('duplicate', `任务已由终止请求 ${String(task['终止请求编号'])} 落入失败结果，后续终止请求被忽略`, {
      requestId: reqId,
      status: current,
    })
  }
  if (current === STAGE.completed && action === '归档结果') {
    return fail('duplicate', '任务已完成归档，重复归档请求被忽略，历史完成记录保持不变', {
      requestId: reqId,
      status: current,
    })
  }
  if (!rule.from.includes(current)) {
    return fail(
      'invalid-status',
      `当前阶段「${view.stage}」/ 状态「${current}」不能执行「${action}」：${rule.reason}`,
      { requestId: reqId, status: current, stage: view.stage },
    )
  }

  if (action === '提交调度' || action === '启动任务' || action === '重试任务') {
    const occupied = inputPathConflict(rows, task)
    if (occupied) {
      return fail(
        'input-path-occupied',
        `输入路径「${String(task['输入路径'])}」正被运行中任务 ${taskCodeOf(occupied)} 占用，请等待其结束或终止后再${action}`,
        { requestId: reqId, occupiedBy: taskCodeOf(occupied) },
      )
    }
  }

  const batchRecords = listRows(BATCH_EXEC_KEY).map((record) => ({ ...record }))
  const transactions = listRows(TX_KEY).map((record) => ({ ...record }))
  const ledger = listRows(REQUEST_KEY).map((record) => ({ ...record }))
  const updated: EntryRow = { ...task }
  let message = ''
  let resultType = ''
  let recordStageValue = view.stage
  let failedPartitions = view.failedPartitions
  let completedPartitions = view.completedPartitions
  let reason = ''
  let batchId: string | undefined

  if (action === '提交调度') {
    const liveCount = batchRecords.filter((record) => String(record['任务编号'] ?? '') === view.taskCode).length
    batchId = `${view.taskCode}-${datePart(at)}-${String(liveCount + 1).padStart(2, '0')}`
    Object.assign(updated, {
      status: STAGE.queued,
      pending: true,
      abnormal: false,
      阶段: STAGE.queued,
      结论: STAGE.queued,
      结果类型: '提交调度',
      异常原因: '',
      上次异常原因: view.exceptionReason || String(task['上次异常原因'] ?? ''),
      执行批次: batchId,
      本次处理分区: '',
      终止请求编号: '',
    })
    if (view.failedPartitions.length > 0) {
      updated['失败分区'] = formatList(view.failedPartitions)
    }
    resultType = '提交调度'
    recordStageValue = STAGE.draft
    message = view.failedPartitions.length > 0
      ? `任务已重新提交调度，保留失败分区断点 ${displayList(view.failedPartitions)}，已完成分区 ${displayList(view.completedPartitions)} 不会被重新覆盖`
      : '任务已提交调度，进入待调度阶段'
  } else if (action === '启动任务') {
    const processing = view.processingPartitions
    if (processing.length === 0 && view.partitions.length > 0) {
      return fail(
        'invalid-status',
        `没有待处理分区：已完成分区 ${displayList(view.completedPartitions)} 不会被重新覆盖，请核对分区覆盖配置`,
        { requestId: reqId },
      )
    }
    Object.assign(updated, {
      status: STAGE.running,
      pending: false,
      abnormal: false,
      阶段: STAGE.running,
      结论: STAGE.running,
      结果类型: '启动任务',
      异常原因: '',
      本次处理分区: formatList(processing),
    })
    resultType = '启动任务'
    recordStageValue = STAGE.queued
    message = `任务已启动，本次处理分区 ${displayList(processing)}（已完成分区 ${displayList(view.completedPartitions)} 不重复覆盖）`
  } else if (action === '终止任务') {
    failedPartitions = parseList(formatList([
      ...view.failedPartitions,
      ...view.remainingPartitions,
      ...(options.failedPartitions ?? []),
    ]))
    completedPartitions = view.completedPartitions
    reason = options.reason?.trim()
      || `任务在运行中被终止，失败分区 ${displayList(failedPartitions)} 已保留断点`
    Object.assign(updated, {
      status: STAGE.failed,
      pending: false,
      abnormal: true,
      // 阶段仍是「运行中」：终止只能发生在运行中，结论才会落入已失败。
      阶段: STAGE.running,
      结论: STAGE.failed,
      结果类型: '终止失败',
      终止结果: '终止失败',
      终止请求编号: reqId,
      失败分区: formatList(failedPartitions),
      异常原因: reason,
      本次处理分区: formatList(view.processingPartitions),
    })
    resultType = '终止失败'
    recordStageValue = STAGE.running
    message = `任务已终止，落入失败结果；保留失败分区断点 ${displayList(failedPartitions)}，已完成分区 ${displayList(completedPartitions)} 保持不变`
  } else if (action === '归档结果') {
    completedPartitions = parseList(formatList([
      ...view.completedPartitions,
      ...(view.processingPartitions.length > 0 ? view.processingPartitions : view.remainingPartitions),
    ]))
    if (completedPartitions.length === 0) {
      return fail('invalid-status', '没有可归档的分区：任务没有处理分区或分区覆盖为空', { requestId: reqId })
    }
    failedPartitions = view.failedPartitions.filter((partition) => !completedPartitions.includes(partition))
    Object.assign(updated, {
      status: STAGE.completed,
      pending: false,
      abnormal: false,
      阶段: STAGE.running,
      结论: STAGE.completed,
      结果类型: '正常归档',
      终止结果: '正常归档',
      已完成分区: formatList(completedPartitions),
      失败分区: formatList(failedPartitions),
      异常原因: failedPartitions.length > 0 ? `仍有未完成分区 ${displayList(failedPartitions)}` : '',
      本次处理分区: '',
    })
    resultType = '正常归档'
    recordStageValue = STAGE.running
    message = `结果已归档，任务完成；本次归档分区 ${displayList(completedPartitions)}，未重新覆盖任何已完成分区`
  } else if (action === '重试任务') {
    Object.assign(updated, {
      status: STAGE.queued,
      pending: true,
      abnormal: false,
      阶段: STAGE.queued,
      结论: STAGE.queued,
      结果类型: '重试',
      上次异常原因: view.exceptionReason || '未记录',
      异常原因: '',
      重试次数: view.retryCount + 1,
      本次处理分区: formatList(view.processingPartitions),
      终止请求编号: '',
    })
    resultType = '重试'
    reason = `重试原因：${view.exceptionReason || '未记录'}`
    message = `已按异常原因「${view.exceptionReason || '未记录'}」重试，重试只处理未完成分区 ${displayList(view.processingPartitions)}，已完成分区 ${displayList(completedPartitions)} 不会被覆盖`
  } else {
    return fail('invalid-action', `${meta.entity}没有登记「${action}」这个动作`)
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  const record = buildExecutionRecord({
    id: nextId(batchRecords),
    task: updated,
    stage: recordStageValue,
    conclusion: String(updated.status),
    resultType,
    failedPartitions,
    completedPartitions,
    reason,
    requestId: reqId,
    at,
    batchId,
  })
  batchRecords.push(record)

  const schedule = buildSchedulePatches(nextRows, [view.taskCode], at)
  const planCodes = parseList(updated['所属计划'])
  const summaryForTask = schedule.plans.find(
    (plan) => planTaskCodes(plan).includes(view.taskCode)
      && (planCodes.length === 0 || planCodes.includes(String(plan['计划编号'] ?? ''))),
  )

  transactions.push(buildTransaction({
    id: nextId(transactions),
    taskCode: view.taskCode,
    action,
    requestId: reqId,
    state: '已提交',
    reason: '任务行、执行批次、编排执行记录一并写入成功',
    at,
  }))
  ledger.push({
    id: nextId(ledger),
    status: '已处理',
    pending: false,
    abnormal: false,
    请求编号: reqId,
    任务编号: view.taskCode,
    动作: action,
    结果: `${resultType}（${String(updated.status)}）`,
    事件时间: at,
  })

  const failure = takeTransactionFault()
    ? '模拟事务失败（测试开关已开启）'
    : saveRowsTransaction({
        [BATCH_KEY]: nextRows,
        [BATCH_EXEC_KEY]: batchRecords,
        [SCHEDULE_KEY]: schedule.plans,
        [SCHEDULE_EXEC_KEY]: schedule.executions,
        [TX_KEY]: transactions,
        [REQUEST_KEY]: ledger,
      })

  if (failure) {
    return rollbackBatchAction({
      task,
      rows,
      action,
      requestId: reqId,
      reason: failure,
      at,
      stage: view.stage,
    })
  }

  const extra = summaryForTask
    ? `；编排计划 ${String(summaryForTask['计划编号'])} 执行批次结论按修正后结果重算为「${String(summaryForTask['批次结论'])}」`
    : ''
  return {
    ok: true,
    code: 'ok',
    requestId: reqId,
    resultType,
    message: `${message}${extra}`,
    detail: {
      requestId: reqId,
      status: String(updated.status),
      stage: String(updated['阶段']),
      resultType,
      failedPartitions: displayList(failedPartitions),
      completedPartitions: displayList(completedPartitions),
    },
    planSummary: summaryForTask
      ? {
          planCode: String(summaryForTask['计划编号']),
          conclusion: String(summaryForTask['批次结论'] ?? ''),
        }
      : undefined,
  }
}

/**
 * 事务回滚：任务状态退回动作前的状态（终止/归档来自运行中，因此退回运行中），
 * 失败分区断点原样保留，并追加一条「事务回滚」批次记录和一条已回滚事务。
 */
function rollbackBatchAction(params: {
  task: EntryRow
  rows: EntryRow[]
  action: string
  requestId: string
  reason: string
  at: string
  stage: string
}): ActionResult {
  const previousStatus = String(params.task.status)
  const previousStage = String(params.task['阶段'] ?? previousStatus)
  const failedPartitions = parseList(params.task['失败分区'])
  const completedPartitions = parseList(params.task['已完成分区'])
  const reverted: EntryRow = {
    ...params.task,
    status: previousStatus,
    pending: ['草稿', '待调度'].includes(previousStatus),
    abnormal: previousStatus === STAGE.failed,
    阶段: previousStage,
    结论: previousStatus,
    结果类型: '事务回滚',
    异常原因: `事务失败已回滚：${params.reason}`,
    失败分区: formatList(failedPartitions),
  }
  const taskCode = taskCodeOf(params.task)
  const nextRows = params.rows.map((row) => (Number(row.id) === Number(params.task.id) ? reverted : row))

  const txs = listRows(TX_KEY).map((row) => ({ ...row }))
  txs.push(buildTransaction({
    id: nextId(txs),
    taskCode,
    action: params.action,
    requestId: params.requestId,
    state: '已回滚',
    reason: params.reason,
    at: params.at,
  }))
  const records = listRows(BATCH_EXEC_KEY).map((row) => ({ ...row }))
  records.push(buildExecutionRecord({
    id: nextId(records),
    task: reverted,
    stage: params.stage || previousStatus,
    conclusion: previousStatus,
    resultType: '事务回滚',
    failedPartitions,
    completedPartitions,
    reason: `事务失败已回滚：${params.reason}`,
    requestId: params.requestId,
    at: params.at,
  }))
  const schedule = buildSchedulePatches(nextRows, [taskCode], params.at)
  const rollbackFailure = saveRowsTransaction({
    [BATCH_KEY]: nextRows,
    [BATCH_EXEC_KEY]: records,
    [SCHEDULE_KEY]: schedule.plans,
    [SCHEDULE_EXEC_KEY]: schedule.executions,
    [TX_KEY]: txs,
  })
  if (rollbackFailure) {
    // 回滚写入也失败时，至少让当前窗口内存里看到退回后的状态，磁盘保持旧快照。
    saveRows(BATCH_KEY, nextRows)
    saveRows(TX_KEY, txs)
  }
  return fail(
    'transaction-failed',
    `动作「${params.action}」写入失败，事务已回滚：任务退回「${previousStatus}」，失败分区断点 ${displayList(failedPartitions)} 已保留。原因：${params.reason}${rollbackFailure ? `（回滚写入也失败：${rollbackFailure}）` : ''}`,
    {
      requestId: params.requestId,
      status: previousStatus,
      failedPartitions: displayList(failedPartitions),
      completedPartitions: displayList(completedPartitions),
      rollbackFailure: rollbackFailure ?? '',
    },
  )
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 批处理执行详情：任务清单、执行批次、终止结果与冲突判定都在这里统一给出。 */
export function loadBatchDetail(taskId: number): BatchExecutionDetail | null {
  const row = listRows(BATCH_KEY).find((item) => Number(item.id) === taskId)
  if (!row) {
    return null
  }
  return buildBatchDetail(row, recordsOfTask(row))
}

/** 编排计划执行摘要：按修正后的批处理任务结果实时派生，旧错误结论不参与计算。 */
export function listScheduleSummaries(): {
  plans: EntryRow[]
  summaries: ScheduleBatchSummary[]
  stale: Record<string, string>
} {
  const tasks = listRows(BATCH_KEY)
  const plans = listRows(SCHEDULE_KEY).map((row) => ({ ...row }))
  const stale: Record<string, string> = {}
  const summaries = plans.map((plan) => {
    const linked = planTaskCodes(plan)
    const summary = deriveScheduleSummary(
      plan,
      tasks.filter((task) => linked.includes(taskCodeOf(task))),
      String(plan['计划更新时间'] ?? ''),
    )
    const stored = String(plan['批次结论'] ?? '')
    if (stored && stored !== summary.conclusion) {
      stale[summary.planCode] = stored
    }
    return summary
  })
  return { plans, summaries, stale }
}

export function listScheduleExecutions(planCode?: string): EntryRow[] {
  const rows = listRows(SCHEDULE_EXEC_KEY)
    .filter((row) => (planCode ? String(row['计划编号'] ?? '') === planCode : true))
  return [...rows].sort((a, b) => String(a['回写时间'] ?? '').localeCompare(String(b['回写时间'] ?? '')))
}

export function listBatchTransactions(taskCode?: string): EntryRow[] {
  return listRows(TX_KEY).filter((row) => (taskCode ? String(row['任务编号'] ?? '') === taskCode : true))
}

export function batchTaskCodeOf(row: EntryRow): string {
  return taskCodeOf(row)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

export { STAGE, displayList, parseList, recordValidity, viewRecord, isTerminationRecord, isArchiveRecord, recordStage, recordConclusion }
