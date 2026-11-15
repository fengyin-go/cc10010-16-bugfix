import { SEED_EXECUTIONS } from './execution-seed'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'lake-govern-config:entries'

// 执行批次、编排执行、事务记录单独放在同一份快照的扩展键里，
// 旧数据里没有这些键时用种子补齐；旧业务行保持原样。
const EXECUTION_KEYS = Object.keys(SEED_EXECUTIONS)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fallbackRows(): Record<string, EntryRow[]> {
  return clone({ ...SEED_ROWS, ...SEED_EXECUTIONS })
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = fallbackRows()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const stored = { ...fallback, ...parsed }
    // 兼容旧快照：执行批次相关键缺失时补种子，避免页面拿不到记录；
    // 业务键（含 batch/schedule）已有的旧值继续使用，不覆盖历史结论。
    for (const key of EXECUTION_KEYS) {
      if (!Array.isArray(stored[key])) {
        stored[key] = clone(SEED_EXECUTIONS[key] ?? [])
      }
    }
    return stored
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

/**
 * 多窗口共享同一份 localStorage：别的窗口写入后，本窗口缓存必须失效，
 * 否则列表与详情读到的是旧快照，终止结果会对不上。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 把整份快照写回 localStorage；写入失败会抛出，由调用方回滚。 */
function persist(snapshot: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  persist(next)
  cache = next
}

/**
 * 跨模块事务：先把整份快照写进 localStorage，成功后才更新内存缓存；
 * 任何一步失败都退回原快照（内存和存储都保持旧值）。返回失败原因，成功返回 null。
 *
 * 这里的「回滚」是真实生效的：localStorage 写失败会抛异常，调用方据此把任务退回运行中。
 */
export function saveRowsTransaction(patches: Record<string, EntryRow[]>): string | null {
  const previous = allRows()
  const next: Record<string, EntryRow[]> = { ...previous, ...patches }
  const raw = JSON.stringify(next)
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, raw)
      // 部分浏览器配额满时会静默失败：写后校验一次，不一致就按失败处理。
      const written = window.localStorage.getItem(STORAGE_KEY)
      if (written !== raw) {
        return '本地存储写入后校验不一致，已取消本次操作'
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : '本地存储写入失败'
  }
  cache = next
  return null
}

/** 仅供测试/巡检使用：强制下一轮从 localStorage 重新读取。 */
export function invalidateCache(): void {
  cache = null
}

export function resetRows(key: string): EntryRow[] {
  const fallback: Record<string, EntryRow[]> = { ...SEED_ROWS, ...SEED_EXECUTIONS }
  const rows = clone(fallback[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}


