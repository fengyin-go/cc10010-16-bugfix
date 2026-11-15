import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  actionHint,
  canRunAction,
  downloadEntries,
  listScheduleExecutions,
  listScheduleSummaries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import type { ActionResult, EntryRow, ScheduleBatchSummary } from '@/data/types'

const meta = moduleMeta('schedule')
const columns = [
  "计划编号",
  "任务列表",
  "依赖图定义",
  "调度表达式",
  "并发上限",
  "失败处理",
  "超时秒数",
  "通知策略"
]
const actions = [
  "提交校验",
  "启动编排",
  "停止编排"
]
const statuses = [
  "草稿",
  "待校验",
  "运行中",
  "已停止"
]

export default function ScheduleView() {
  const [plans, setPlans] = useState<EntryRow[]>([])
  const [summaries, setSummaries] = useState<ScheduleBatchSummary[]>([])
  const [stale, setStale] = useState<Record<string, string>>({})
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listScheduleSummaries()
      setPlans(payload.plans)
      setSummaries(payload.summaries)
      setStale(payload.stale)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '编排调度列表读取失败')
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === storageKey()) {
        reload()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  const visible = useMemo(() => {
    const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
    return plans.filter((plan) => pairs.every(([field, value]) => String(plan[field] ?? '').includes(value.trim())))
  }, [plans, filters])

  const counts = useMemo(() => ({
    running: summaries.filter((item) => item.conclusion === '运行中').length,
    queued: summaries.filter((item) => item.conclusion === '待调度' || item.conclusion === '待校验').length,
  }), [summaries])

  const emptyReason = Object.values(filters).some((value) => value.trim() !== '')
    ? '没有匹配当前筛选条件的编排计划，可调整或重置筛选条件'
    : plans.length === 0
      ? '暂无编排计划数据，可先登记编排计划（登记入口尚未接入审批流）'
      : '当前计划的任务列表为空：没有关联批处理任务，无法计算执行批次结论'

  return (
    <section className="page" data-module="schedule">
      <header className="page-head">
        <div>
          <h2>编排调度管理</h2>
          <p className="page-desc">
            维护编排调度计划的输入、执行约束与结果记录；执行批次结论按修正后的批处理任务结果实时重算。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('编排计划登记入口尚未接入审批流')}>
            登记编排计划
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出编排调度清单
          </button>
          <button className="btn ghost" type="button" onClick={reload}>刷新</button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">编排计划总数</span>
          <strong className="stat-value">{plans.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">运行中计划</span>
          <strong className="stat-value">{counts.running}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待校验计划</span>
          <strong className="stat-value">{counts.queued}</strong>
        </article>
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{plans.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>计划状态</th>
            <th>执行批次</th>
            <th>批次结论（重算）</th>
            <th>完成/失败/运行中</th>
            <th>说明</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const summary = summaries.find((item) => item.planId === Number(row.id))
            const staleValue = summary ? stale[summary.planCode] : ''
            return (
              <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{row.status}</td>
                <td>{summary?.executionBatch || '—'}</td>
                <td className={`conclusion-${tone(summary?.conclusion ?? '')}`}>{summary?.conclusion ?? '—'}</td>
                <td>{summary ? `${summary.completed} / ${summary.failed} / ${summary.running}` : '—'}</td>
                <td>
                  {summary?.emptyReason || String(row['批次说明'] ?? '—')}
                  {staleValue && (
                    <span className="conflict-note">
                      存储中的旧结论「{staleValue}」与修正后批次结果不一致，已在页面按修正结果展示；历史结论按旧规则保留
                    </span>
                  )}
                </td>
                <td className="row-actions">
                  {actions.map((action) => {
                    const allowed = canRunAction(meta.key, row, action)
                    return (
                      <button
                        key={action}
                        className="link"
                        type="button"
                        disabled={!allowed}
                        title={allowed ? '' : actionHint(meta.key, action)}
                        onClick={() => runAction(action, row)}
                      >
                        {action}
                      </button>
                    )
                  })}
                </td>
              </tr>
            )
          })}
          {visible.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 6}>{emptyReason}</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">编排执行记录（按批次）</h3>
      {summaries.every((summary) => summary.linkedTaskCodes.length === 0) ? (
        <p className="empty-state">暂无编排执行记录：所有计划的任务列表都为空，尚未关联批处理任务</p>
      ) : (
        <ExecutionTables summaries={summaries} plans={plans} />
      )}

      <footer className="page-foot">
        <span>执行批次结论由批处理任务清单派生；历史已完成记录只读，不允许通过动作改写</span>
        <span className="page-messages">
          {notice && <span className="notice-text">{notice}</span>}
          {errorMessage && <span className="error-text">{errorMessage}</span>}
        </span>
      </footer>
    </section>
  )
}

function ExecutionTables({ summaries, plans }: { summaries: ScheduleBatchSummary[]; plans: EntryRow[] }) {
  const linked = summaries.filter((summary) => summary.linkedTaskCodes.length > 0)
  return (
    <>
      {linked.map((summary) => {
        const records = listScheduleExecutions(summary.planCode)
        const plan = plans.find((item) => Number(item.id) === summary.planId)
        return (
          <div key={summary.planCode} className="execution-block">
            <p className="detail-line">
              计划 {summary.planCode}（{String(plan?.status ?? '—')}）当前批次 {summary.executionBatch || '—'}，
              关联任务 {summary.linkedTaskCodes.join('、')}，修正后结论「{summary.conclusion}」
            </p>
            {records.length === 0 ? (
              <p className="empty-state">该计划还没有执行记录：关联任务尚未产生批次结果</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>执行批次</th>
                    <th>批次结论</th>
                    <th>已完成任务</th>
                    <th>失败任务</th>
                    <th>批次说明</th>
                    <th>回写时间</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={String(record.id)}>
                      <td>{String(record['执行批次'])}</td>
                      <td className={`conclusion-${tone(String(record['批次结论']))}`}>{String(record['批次结论'])}</td>
                      <td>{String(record['已完成任务']) || '—'}</td>
                      <td>{String(record['失败任务']) || '—'}</td>
                      <td>{String(record['批次说明']) || '—'}</td>
                      <td>{String(record['回写时间']) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
      <p className="detail-line">
        需要核对单个任务的分区断点与终止结果？
        <Link className="link" to="/batch">前往批量转换任务清单</Link>
      </p>
    </>
  )
}

function tone(conclusion: string): string {
  if (conclusion === '已完成') return 'ok'
  if (conclusion === '已失败') return 'bad'
  if (conclusion === '运行中') return 'running'
  return 'muted'
}
