import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  actionHint,
  canRunAction,
  downloadEntries,
  listBatchEntries,
  moduleMeta,
  runAction as applyAction,
  setTransactionFaultForTest,
} from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('batch')
const columns = [
  "任务编号",
  "输入路径",
  "处理脚本",
  "输出路径",
  "分区覆盖",
  "依赖上游",
  "重试策略",
  "超时终止"
]
const actions = [
  "提交调度",
  "启动任务",
  "终止任务",
  "归档结果",
  "重试任务"
]
const statuses = [
  "草稿",
  "待调度",
  "运行中",
  "已完成",
  "已失败"
]

export default function BatchView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [lastResult, setLastResult] = useState<ActionResult | null>(null)
  const [lastTaskId, setLastTaskId] = useState<number | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    try {
      const payload = listBatchEntries(filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '批量转换列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 多窗口共享 localStorage：另一个窗口写入后，本窗口重新读取并刷新列表。
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
    // 每次点击生成独立请求号：双击或多窗口同时点击时，服务层只保留首个有效请求。
    const requestId = `UI-batch-${String(row.id)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = applyAction(meta.key, Number(row.id), action, { requestId })
    setLastResult(result)
    setLastTaskId(Number(row.id))
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNotice(result.message)
    }
    reload()
  }

  const pendingCount = useMemo(() => rows.filter((row) => row.pending).length, [rows])

  const counts = useMemo(() => {
    const count = (status: string) => rows.filter((row) => String(row.status) === status).length
    return {
      running: count('运行中'),
      completed: count('已完成'),
    }
  }, [rows])

  const emptyReason = Object.values(filters).some((value) => value.trim() !== '')
    ? '没有匹配当前筛选条件的批处理任务，可调整或重置筛选条件'
    : '暂无批处理任务数据，可先登记批处理任务（登记入口尚未接入审批流）'

  return (
    <section className="page" data-module="batch">
      <header className="page-head">
        <div>
          <h2>批量转换管理</h2>
          <p className="page-desc">维护批量转换任务的输入、执行约束与结果记录，为批量转换提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('批处理任务登记入口尚未接入审批流')}>
            登记批处理任务
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出批量转换清单
          </button>
          <button className="btn ghost" type="button" onClick={reload}>刷新</button>
          <button
            className="btn ghost"
            type="button"
            title="模拟一次本地存储写入失败，用来验证事务回滚：任务会退回运行中并保留失败分区"
            onClick={() => {
              setTransactionFaultForTest(true)
              setNotice('已开启一次性事务故障注入，下一次动作将回滚')
            }}
          >
            故障注入（测试）
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">批处理任务总数</span>
          <strong className="stat-value">{total}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">运行中任务</span>
          <strong className="stat-value">{counts.running}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已完成任务</span>
          <strong className="stat-value">{counts.completed}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待处理（草稿/待调度）</span>
          <strong className="stat-value">{pendingCount}</strong>
        </article>
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
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
            <th>作业阶段</th>
            <th>当前状态</th>
            <th>结论</th>
            <th>终止/归档结果</th>
            <th>失败分区</th>
            <th>已完成分区</th>
            <th>异常原因</th>
            <th>可执行动作</th>
            <th>执行详情</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)} className={lastTaskId === Number(row.id) ? 'row-active' : undefined}>
              {columns.map((column) => <td key={column}>{cellText(row[column])}</td>)}
              <td>{String(row['阶段'] ?? row.status)}</td>
              <td>{row.status}</td>
              <td className={`conclusion-${tone(String(row['结论'] ?? row.status))}`}>{String(row['结论'] ?? row.status)}</td>
              <td>{String(row['终止结果展示'] ?? '—')}</td>
              <td>{String(row['失败分区展示'] ?? '—')}</td>
              <td>{String(row['已完成分区展示'] ?? '—')}</td>
              <td>
                {String(row['异常原因展示'] ?? '—')}
                {String(row['冲突说明'] ?? '—') !== '—' && (
                  <span className="conflict-note">{String(row['冲突说明'])}</span>
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
              <td>
                <Link className="link" to={`/batch/${String(row.id)}`}>查看执行详情</Link>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 9}>{emptyReason}</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条批处理任务记录；阶段只能逐级推进，终止仅作用于运行中任务并落入失败结果</span>
        <span className="page-messages">
          {lastResult && lastResult.ok && lastResult.resultType && (
            <span className="task-tag">本次动作结果：{lastResult.resultType}</span>
          )}
          {notice && <span className="notice-text">{notice}</span>}
          {errorMessage && <span className="error-text">{errorMessage}</span>}
        </span>
      </footer>
    </section>
  )
}

function tone(conclusion: string): string {
  if (conclusion === '已完成') return 'ok'
  if (conclusion === '已失败') return 'bad'
  if (conclusion === '运行中') return 'running'
  return 'muted'
}

/** 列表单元格：分区用 JSON 数组存储，展示时转成顿号串，避免用户看到 ["2026-11-01"]。 */
function cellText(value: EntryRow[string] | undefined): string {
  if (value === undefined || value === '') return '—'
  const text = String(value)
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed.length > 0 ? parsed.map(String).join('、') : '—'
    } catch {
      return text
    }
  }
  return text
}
