import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  actionHint,
  canRunAction,
  listBatchTransactions,
  loadBatchDetail,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import type { ActionResult, BatchExecutionDetail } from '@/data/types'

const meta = moduleMeta('batch')
const actions = ["提交调度", "启动任务", "终止任务", "归档结果", "重试任务"]

export default function BatchDetailView() {
  const params = useParams()
  const taskId = Number(params.id)
  const [detail, setDetail] = useState<BatchExecutionDetail | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [lastResult, setLastResult] = useState<ActionResult | null>(null)

  const reload = useCallback(() => {
    if (!Number.isFinite(taskId) || taskId <= 0) {
      setDetail(null)
      setErrorMessage('执行详情的任务编号无效，请从批处理任务清单进入')
      return
    }
    try {
      const payload = loadBatchDetail(taskId)
      if (!payload) {
        setDetail(null)
        setErrorMessage(`没有找到编号为 ${taskId} 的批处理任务，可能已被清理`)
        return
      }
      setDetail(payload)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '执行详情读取失败')
    }
  }, [taskId])

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

  const transactions = useMemo(() => {
    if (!detail) return []
    return listBatchTransactions(detail.taskCode)
  }, [detail])

  function runAction(action: string) {
    if (!detail) return
    setErrorMessage('')
    setNotice('')
    const requestId = `UI-batch-detail-${detail.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = applyAction(meta.key, detail.taskId, action, { requestId })
    setLastResult(result)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNotice(result.message)
    }
    reload()
  }

  if (!detail) {
    return (
      <section className="page" data-module="batch">
        <header className="page-head">
          <div>
            <h2>批处理任务执行详情</h2>
            <p className="page-desc">查看任务动作、执行批次与编排回写结果。</p>
          </div>
          <div className="page-actions">
            <Link className="btn" to="/batch">{'<'} 返回任务清单</Link>
          </div>
        </header>
        <p className="empty-state">{errorMessage || '暂无执行详情数据'}</p>
      </section>
    )
  }

  const isTerminated = detail.taskStatus === '已失败'
  const isCompleted = detail.taskStatus === '已完成'

  return (
    <section className="page" data-module="batch">
      <header className="page-head">
        <div>
          <h2>批处理任务执行详情 · {detail.taskCode}</h2>
          <p className="page-desc">
            作业阶段：{detail.runStage} / 当前状态：{detail.taskStatus} / 有效结论：{detail.effectiveConclusion}
            {detail.currentBatch ? ` / 当前批次：${detail.currentBatch}` : ''}
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/batch">{'<'} 返回任务清单</Link>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">有效结论</span>
          <strong className={`stat-value conclusion-${tone(detail.effectiveConclusion)}`}>{detail.effectiveConclusion}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">终止/归档结果</span>
          <strong className="stat-value small">{detail.terminationResult}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">失败分区（断点）</span>
          <strong className="stat-value small">{detail.failedPartitions.join('、') || '—'}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已完成分区</span>
          <strong className="stat-value small">{detail.completedPartitions.join('、') || '—'}</strong>
        </article>
      </div>

      {detail.conflictNote && (
        <p className="conflict-banner"><strong>结论冲突说明：</strong>{detail.conflictNote}</p>
      )}
      {detail.legacy && (
        <p className="legacy-banner">
          该任务包含历史记录：历史结论按旧规则回放，展示时只标记有效性，不修改历史值。
        </p>
      )}

      <div className="detail-actions">
        {actions.map((action) => {
          const allowed = canRunAction(meta.key, { status: detail.taskStatus }, action)
          return (
            <button
              key={action}
              className="btn small"
              type="button"
              disabled={!allowed}
              title={allowed ? '' : actionHint(meta.key, action)}
              onClick={() => runAction(action)}
            >
              {action}
            </button>
          )
        })}
      </div>

      {(errorMessage || notice || lastResult) && (
        <div className="detail-messages">
          {lastResult && (
            <p className="detail-line">
              本次请求：{lastResult.requestId || '—'} / 结果类型：{lastResult.resultType || '—'}
            </p>
          )}
          {lastResult?.planSummary && (
            <p className="detail-line">
              编排回写：计划 {lastResult.planSummary.planCode} 批次结论「{lastResult.planSummary.conclusion}」
            </p>
          )}
          {notice && <p className="notice-text">{notice}</p>}
          {errorMessage && <p className="error-text">{errorMessage}</p>}
        </div>
      )}

      {(isTerminated || isCompleted) && (
        <div className={isTerminated ? 'result-banner result-banner-bad' : 'result-banner result-banner-ok'}>
          {isTerminated
            ? `终止失败：任务在运行中收到终止请求，最终落入失败结果；异常原因「${detail.exceptionReason}」，失败分区断点 ${detail.failedPartitions.join('、') || '—'} 已保留。`
            : `正常归档：任务在运行中完成结果归档，本次归档分区 ${detail.completedPartitions.join('、') || '—'}；已完成分区不会被重试重新覆盖。`}
          {detail.retryHint && <span className="retry-hint">{detail.retryHint}</span>}
        </div>
      )}

      {detail.legacyFailedPartitions.length > 0 && (
        <p className="legacy-banner">
          历史无效终止记录里还登记着失败分区 {detail.legacyFailedPartitions.join('、')}（旧版本留下，按旧规则保留），
          与任务当前结论无关：未回填到任务行，也不会让重试重新覆盖已完成分区。
        </p>
      )}

      <h3 className="section-title">执行批次记录</h3>
      {detail.emptyReason && <p className="empty-state">{detail.emptyReason}</p>}
      {!detail.emptyReason && (
        <table className="data-table">
          <thead>
            <tr>
              <th>批次编号</th>
              <th>阶段</th>
              <th>结论</th>
              <th>结果类型</th>
              <th>失败分区</th>
              <th>已完成分区</th>
              <th>异常原因</th>
              <th>请求编号</th>
              <th>有效性</th>
              <th>有效性说明</th>
              <th>事件时间</th>
            </tr>
          </thead>
          <tbody>
            {detail.records.map((record) => (
              <tr key={String(record.id)} className={record.有效性 === '无效' ? 'row-invalid' : undefined}>
                <td>{String(record.批次编号)}</td>
                <td>{String(record.阶段)}</td>
                <td className={`conclusion-${tone(String(record.结论))}`}>{String(record.结论)}</td>
                <td>{String(record.结果类型)}</td>
                <td>{asList(record.失败分区)}</td>
                <td>{asList(record.已完成分区)}</td>
                <td>{String(record.异常原因) || '—'}</td>
                <td>{String(record.请求编号) || '—'}</td>
                <td>
                  <span className={record.有效性 === '无效' ? 'tag tag-bad' : 'tag tag-ok'}>{record.有效性}</span>
                </td>
                <td>{record.有效性说明}</td>
                <td>{String(record.事件时间)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="section-title">事务记录（回滚核对）</h3>
      {transactions.length === 0 ? (
        <p className="empty-state">该任务还没有事务记录：尚未执行动作，或动作发生在旧版本中（旧版本不记录事务）</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>事务编号</th>
              <th>动作</th>
              <th>请求编号</th>
              <th>状态</th>
              <th>原因</th>
              <th>事件时间</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={String(tx.id)}>
                <td>{String(tx['事务编号'])}</td>
                <td>{String(tx['动作'])}</td>
                <td>{String(tx['请求编号']) || '—'}</td>
                <td>
                  <span className={String(tx['状态']) === '已回滚' ? 'tag tag-bad' : 'tag tag-ok'}>{String(tx['状态'])}</span>
                </td>
                <td>{String(tx['原因']) || '—'}</td>
                <td>{String(tx['事件时间'])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer className="page-foot">
        <span>
          所属编排计划：{detail.planCodes.join('、') || '—'}；分区断点与结论均由服务层统一判定，列表与详情口径一致
        </span>
      </footer>
    </section>
  )
}

function asList(value: unknown): string {
  const text = String(value ?? '')
  if (!text || text === '[]') return '—'
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return parsed.join('、')
  } catch {
    return text
  }
  return text
}

function tone(conclusion: string): string {
  if (conclusion === '已完成') return 'ok'
  if (conclusion === '已失败') return 'bad'
  if (conclusion === '运行中') return 'running'
  return 'muted'
}
