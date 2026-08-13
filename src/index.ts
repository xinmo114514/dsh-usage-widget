/**
 * Host half of dsh-usage-widget.
 *
 * Responsibilities:
 *   1) After mount, asynchronously scan all session logs and fold token
 *      usage (per session + per local day).
 *   2) Multi-source scan: sessionQuery (listSessions + readSession) first;
 *      fall back to sessionPersistence (list + readFrom(id, 0)).
 *   3) ctx.on('session/event') live incremental fold with a per-session
 *      maxSeq watermark for dedupe.
 *   4) Periodic self-healing re-scan every 60s (watermark keeps it idempotent).
 *   5) POST /usage/api/snapshot — JSON API for the client half. Request:
 *      { sessionId?: string | null }; response { ok: true, value: <snapshot> }.
 *
 * Data source: assistant/message events whose data.usage.inputTokens is a
 * number. total = input + output + cacheRead + cacheWrite (no reasoning).
 *
 * Runtime imports: node builtins only — every DSH service arrives through the
 * cordis inject list.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'dsh-usage-widget'

/** Services required before mounting. */
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'timer']

/** One aggregate counter set. */
function newAgg() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0,
  }
}

/** Local-midnight epoch ms for a timestamp (avoids UTC drift). */
function localMidnight(timeMs: number): number {
  const d = new Date(timeMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function ink(agg: ReturnType<typeof newAgg>, u: Record<string, unknown>): void {
  const input = (u.inputTokens as number) || 0
  const output = (u.outputTokens as number) || 0
  const cacheRead = (u.cacheReadTokens as number) || 0
  const cacheWrite = (u.cacheWriteTokens as number) || 0
  const reasoning = (u.reasoningTokens as number) || 0
  agg.input += input
  agg.output += output
  agg.cacheRead += cacheRead
  agg.cacheWrite += cacheWrite
  agg.reasoning += reasoning
  agg.total += input + output + cacheRead + cacheWrite
  agg.calls += 1
}

function usable(event: any): boolean {
  return !!event && event.type === 'assistant/message' &&
    !!event.data && !!event.data.usage &&
    typeof event.data.usage.inputTokens === 'number'
}

const msgOf = (e: unknown): string =>
  (e && typeof e === 'object' && (e as any).message) ? String((e as any).message) : String(e)
const shortOf = (id: string): string =>
  typeof id === 'string' && id.length > 12 ? id.slice(0, 12) + '…' : String(id)

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > 1 << 20) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { reject(new Error('request body is not valid JSON')) }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

export function apply(ctx: any): void {
  // ---- in-memory aggregate store ----
  const store = {
    sessions: new Map<string, any>(), // sessionId -> { daily: Map, allAgg, maxSeq }
    allAgg: newAgg(),
    allDaily: new Map<number, ReturnType<typeof newAgg>>(),
    scanning: false,
    scans: 0,
    failed: 0,                    // 本轮扫描中无法读取的会话数（部分数据提示）
    lastError: null as string | null, // 最近一次会话级失败详情（tooltip 用）
    scanError: null as string | null, // 灾难级错误（会话清单获取失败等）
    lastScanAt: 0,
  }

  function dayAgg(map: Map<number, any>, day: number) {
    let a = map.get(day)
    if (!a) { a = newAgg(); map.set(day, a) }
    return a
  }

  function ensureSession(id: string) {
    let info = store.sessions.get(id)
    if (!info) {
      info = { daily: new Map(), allAgg: newAgg(), maxSeq: -1 }
      store.sessions.set(id, info)
    }
    return info
  }

  function foldUsage(info: any, timeMs: number, u: Record<string, unknown>): void {
    const day = localMidnight(timeMs)
    ink(dayAgg(info.daily, day), u)
    ink(info.allAgg, u)
    ink(dayAgg(store.allDaily, day), u)
    ink(store.allAgg, u)
  }

  function foldSessionEvents(id: string, events: any[]): void {
    const info = ensureSession(id)
    if (!Array.isArray(events)) return
    for (const ev of events) {
      if (!usable(ev)) continue
      if (typeof ev.seq === 'number' && ev.seq <= info.maxSeq) continue
      foldUsage(info, ev.time, ev.data.usage)
      if (typeof ev.seq === 'number') info.maxSeq = Math.max(info.maxSeq, ev.seq)
    }
  }

  async function scanOnce(options: { initial?: boolean }): Promise<void> {
    const initial = !!(options && options.initial)
    if (initial) store.scanning = true
    store.scans += 1
    store.lastScanAt = Date.now()
    // 每轮扫描独立计数失败会话；全部成功则清除历史错误（自愈）
    store.failed = 0
    try {
      const query = ctx.get('sessionQuery')
      const persist = ctx.get('sessionPersistence')

      // 1) session list: sessionQuery first; fall back to sessionPersistence.list()
      let records: any[] = []
      if (query) {
        try {
          records = await query.listSessions()
          if (!Array.isArray(records)) records = []
        } catch (e) {
          store.scanError = 'listSessions: ' + msgOf(e)
          records = []
        }
      }
      if ((!Array.isArray(records) || records.length === 0) && persist) {
        try {
          const headers = await persist.list()
          records = Array.isArray(headers) ? headers.map((h: any) => ({ header: h })) : []
          if (records.length > 0) store.scanError = null
        } catch (e) {
          store.scanError = 'persistence.list: ' + msgOf(e)
        }
      }

      const idOf = (rec: any): string | undefined => {
        if (!rec) return undefined
        if (rec.header && typeof rec.header.id === 'string') return rec.header.id
        if (typeof rec.id === 'string') return rec.id
        return undefined
      }
      const ids: string[] = records.map(idOf).filter((x): x is string => !!x)

      // 2) per-session read: sessionQuery.readSession first; fall back to readFrom(id, 0)
      let i = 0
      async function worker(): Promise<void> {
        while (i < ids.length) {
          const id = ids[i]; i += 1
          let sessionFailed = false
          try {
            let events: any[] | null = null
            if (query) {
              try {
                const snap = await query.readSession(id)
                events = snap && Array.isArray(snap.events) ? snap.events : null
              } catch (e) {
                store.lastError = 'readSession ' + shortOf(id) + ': ' + msgOf(e)
                sessionFailed = true
                events = null
              }
            }
            if (events === null && persist) {
              try {
                const r = await persist.readFrom(id, 0)
                events = r && Array.isArray(r.events) ? r.events : []
              } catch (e) {
                store.lastError = 'readFrom ' + shortOf(id) + ': ' + msgOf(e)
                sessionFailed = true
                events = []
              }
            }
            if (events && events.length) foldSessionEvents(id, events)
          } catch (e) {
            store.lastError = 'session ' + shortOf(id) + ': ' + msgOf(e)
            sessionFailed = true
          }
          if (sessionFailed) store.failed += 1
        }
      }

      const n = Math.max(1, Math.min(4, ids.length || 1))
      const workers: Promise<void>[] = []
      for (let k = 0; k < n; k += 1) workers.push(worker())
      await Promise.all(workers.map((w) => w.catch((e) => { store.lastError = 'worker: ' + msgOf(e); store.failed += 1 })))
    } finally {
      // 本轮无失败会话 → 清除历史标记（自愈：日志可读性恢复后自动消失）
      if (store.failed === 0) { store.lastError = null; store.scanError = null }
      if (initial) store.scanning = false
    }
  }

  // ---- live listener first (no events missed during the initial scan) ----
  ctx.on('session/event', (session: any, event: any) => {
    const id = session && typeof session.id === 'string' ? session.id : undefined
    if (!id) return
    if (!usable(event)) return
    const info = ensureSession(id)
    if (typeof event.seq === 'number' && event.seq <= info.maxSeq) return
    foldUsage(info, event.time, event.data.usage)
    if (typeof event.seq === 'number') info.maxSeq = Math.max(info.maxSeq, event.seq)
  })

  scanOnce({ initial: true }).catch((e) => console.error('[usage] initial scan failed', e))

  // ---- periodic self-healing re-scan (60s) ----
  const timer = ctx.get('timer')
  if (timer && typeof timer.interval === 'function') {
    timer.interval(() => {
      scanOnce({ initial: false }).catch((e) => console.error('[usage] sweep failed', e))
    }, 60000)
  }

  // ---- snapshot building ----
  function buildSeries(dailyMap: Map<number, any>): any[] {
    const out: any[] = []
    for (const [day, agg] of dailyMap) {
      out.push({
        t: day, input: agg.input, output: agg.output,
        cacheRead: agg.cacheRead, cacheWrite: agg.cacheWrite,
        reasoning: agg.reasoning, calls: agg.calls,
      })
    }
    out.sort((a, b) => a.t - b.t)
    return out
  }

  function usageOf(agg: any) {
    return {
      input: agg.input, output: agg.output, cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite, reasoning: agg.reasoning, total: agg.total,
    }
  }

  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }

  function snapshot(sessionId: string | null): any {
    let sessionsWithUsage = 0
    for (const info of store.sessions.values()) {
      if (info.allAgg.calls > 0) sessionsWithUsage += 1
    }
    const allAgg = store.allAgg
    const allSeries = buildSeries(store.allDaily)
    let current: any = null
    let currentSeries: any[] = []
    if (sessionId) {
      const info = store.sessions.get(sessionId)
      if (info) {
        current = { id: sessionId, calls: info.allAgg.calls, usage: usageOf(info.allAgg) }
        currentSeries = buildSeries(info.daily)
      } else {
        current = { id: sessionId, calls: 0, usage: { ...zeroUsage } }
        currentSeries = []
      }
    }
    return {
      ok: true,
      scanning: store.scanning,
      scans: store.scans,
      failed: store.failed,
      lastError: store.lastError,
      scanError: store.scanError,
      lastScanAt: store.lastScanAt,
      time: Date.now(),
      sessions: sessionsWithUsage,
      current,
      all: { calls: allAgg.calls, usage: usageOf(allAgg) },
      series: { all: allSeries, current: currentSeries },
    }
  }

  // ---- JSON API route: POST /usage/api/snapshot ----
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/usage/api',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/usage/api/')
          ? pathname.slice('/usage/api/'.length)
          : undefined
        if (method === undefined || method.includes('/')) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown usage API method' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        try {
          const payload = await readJsonBody(req) as Record<string, unknown>
          if (method === 'snapshot') {
            const raw = payload.sessionId
            const sessionId = (typeof raw === 'string' && raw.length > 0) ? raw : null
            writeOk(res, snapshot(sessionId))
            return
          }
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown usage API method "${method}"` } })
        } catch (error) {
          writeError(res, error)
        }
      },
    }), 'dsh-usage-widget: /usage/api routes')
  }
}
