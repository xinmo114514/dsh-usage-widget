/**
 * Host half of dsh-usage-widget.
 *
 * Responsibilities:
 *   1) After mount, asynchronously scan ALL session logs and fold token
 *      usage (per session + per local day).
 *   2) RAW-first scan: walk ~/.dsh/sessions, decompress every
 *      session.jsonl.zstd (multi-frame zstd via the `zstd` CLI; Node's zlib
 *      only surfaces the first frame) and fold assistant/message usage
 *      directly — immune to the harness interpreter's unknown-event refusals
 *      (a newer harness may write event types this build does not know) and
 *      verified byte-exact against an independent log audit.
 *   3) Harness fallback: when RAW decode fails (e.g. a still-writing trailing
 *      frame), fall back to sessionQuery.readSession / readFrom(id, 0).
 *   4) ctx.on('session/event') live incremental fold with a per-session
 *      maxSeq watermark for dedupe (all assistant/message events carry seq).
 *   5) Periodic self-healing re-scan every 60s, guarded by a reentrancy lock
 *      so scans never overlap (watermark keeps re-folds idempotent).
 *   6) POST /usage/api/snapshot — JSON API for the client half. Request:
 *      { sessionId?: string | null }; response { ok: true, value: <snapshot> }.
 *      The route is read-only aggregate stats, fenced to loopback Hosts
 *      (DNS-rebinding / cross-site defense), like the DSH sidebar routes.
 *
 * Data source: assistant/message events whose data.usage.inputTokens is a
 * number. total = input + output + cacheRead + cacheWrite (no reasoning).
 *
 * Runtime imports: node builtins only — every DSH service arrives through the
 * cordis inject list.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

// ============================================================
// Raw-log recovery helpers
// ============================================================
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/** Decompress a session log. Session logs are CONCATENATED zstd frames (one
 *  frame per append); Node's zlib only surfaces the first frame, so use the
 *  `zstd` CLI which handles concatenated frames natively. */
function zstdToText(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('zstd', ['-d', '-c', filePath], { maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Parse an NDJSON log body into events (malformed lines are skipped). */
function parseLogLines(text: string): any[] {
  const events: any[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t)) } catch { /* skip */ }
  }
  return events
}

/** Recursively discover every session log under the sessions root (depth ≤3):
 *  map sessionId -> log path. Also locates bare-id and encoded-workspace dirs. */
function findSessionLogs(root: string, depth: number, out: Map<string, string>): void {
  if (depth > 3) return
  let entries: string[]
  try { entries = readdirSync(root) } catch { return }
  for (const entry of entries) {
    const p = join(root, entry)
    let st: any
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      findSessionLogs(p, depth + 1, out)
    } else if (entry === 'session.jsonl.zstd') {
      const id = root.split('/').pop() || ''
      if (id) out.set(id, p)
    }
  }
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

/** DNS-rebinding / cross-site defense for the JSON API: only loopback
 *  authorities may call it (the DSH web server binds 127.0.0.1). */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  let hostname = hostHeader
  const at = hostHeader.lastIndexOf('@')
  if (at !== -1) hostname = hostHeader.slice(at + 1)
  if (hostname.startsWith('[')) {
    // [::1]:port or [::1]
    const end = hostname.indexOf(']')
    return end !== -1 && hostname.slice(1, end) === '::1'
  }
  if (hostname === '::1') return true
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && hostname.indexOf(']') === -1 && hostname.indexOf(':') === colon) {
    hostname = hostname.slice(0, colon)
  }
  if (hostname === 'localhost') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function apply(ctx: any): void {
  // ---- 双通道自动去重（profile 通道 / 注册表通道）----
  // 两个通道可能同时挂载（各有一份 lib/index.js，但共享同一进程的
  // globalThis）。先到者生效，后到者自动待命；生效者卸载时让位，
  // 下一次组合加载（重启/重启用）时由存活的通道接管。
  const g = globalThis as any
  if (g.__dshUsageWidgetHostActive) {
    console.log('[dsh-usage-widget] standby: another channel is active — host mount skipped')
    return
  }
  g.__dshUsageWidgetHostActive = true
  ctx.effect(() => () => { g.__dshUsageWidgetHostActive = false }, 'dsh-usage-widget: host dedup claim')

  // ---- in-memory aggregate store ----
  const store = {
    sessions: new Map<string, any>(), // sessionId -> { daily: Map, allAgg, maxSeq }
    allAgg: newAgg(),
    allDaily: new Map<number, ReturnType<typeof newAgg>>(),
    scanning: false,
    running: false,               // 扫描防重入锁
    scans: 0,
    failed: 0,                    // 本轮 RAW 与 harness 均无法读取的会话数
    rawSessions: 0,               // 通过 RAW 日志（zstd 直接解析）折叠的会话数
    harnessSessions: 0,           // 通过 harness 解释器兜底折叠的会话数
    foldedEvents: 0,              // 已折叠的用量事件总数（审计用）
    dedupSkipped: 0,              // 水位去重跳过的事件数（审计用）
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
      if (typeof ev.seq === 'number' && ev.seq <= info.maxSeq) { store.dedupSkipped += 1; continue }
      foldUsage(info, ev.time, ev.data.usage)
      store.foldedEvents += 1
      if (typeof ev.seq === 'number') info.maxSeq = Math.max(info.maxSeq, ev.seq)
    }
  }

  async function scanOnce(options: { initial?: boolean }): Promise<void> {
    const initial = !!(options && options.initial)
    if (initial) store.scanning = true
    // 防重入：扫描不重叠（初始扫描与 60s 自愈重扫互斥）
    if (store.running) return
    store.running = true
    store.scans += 1
    store.lastScanAt = Date.now()
    // 每轮扫描独立计数；全部成功则清除历史错误（自愈）
    store.failed = 0
    store.rawSessions = 0
    store.harnessSessions = 0
    try {
      const query = ctx.get('sessionQuery')
      const persist = ctx.get('sessionPersistence')

      // 1) session id 全集 = 磁盘上的原始日志 ∪ harness 会话清单。
      //    原始日志（RAW）是本插件的首选数据源：直接解压会话自己的
      //    session.jsonl.zstd（多帧 zstd，zstd CLI），只提取
      //    assistant/message 的 usage —— 不受 harness 解释器的
      //    未知事件拒读/口径影响，审计验证 32/32 会话 100% 可读。
      const logPaths = new Map<string, string>()
      findSessionLogs(SESSIONS_ROOT, 0, logPaths)
      const ids = new Set<string>(logPaths.keys())

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
      for (const rec of records) {
        const id = idOf(rec)
        if (id) ids.add(id)
      }
      const idList: string[] = [...ids]

      // 2) per-session: RAW first（完整、不受解释器限制），失败则 harness 兜底
      let i = 0
      async function worker(): Promise<void> {
        while (i < idList.length) {
          const id = idList[i]; i += 1
          try {
            // 2a) RAW path: decompress the session's own log. 解码成功即视为
            //     可读（即使 0 条可用事件——那只是"没有用量"的会话，不是失败）。
            const rawPath = logPaths.get(id)
            if (rawPath) {
              try {
                const text = await zstdToText(rawPath)
                const parsed = parseLogLines(text)
                foldSessionEvents(id, parsed)
                store.rawSessions += 1
                continue
              } catch (e) {
                store.lastError = 'raw ' + shortOf(id) + ': ' + msgOf(e)
              }
            }
            // 2b) harness fallback: sessionQuery.readSession / persistence.readFrom
            let events: any[] | null = null
            if (query) {
              try {
                const snap = await query.readSession(id)
                events = snap && Array.isArray(snap.events) ? snap.events : null
              } catch (e) {
                store.lastError = 'readSession ' + shortOf(id) + ': ' + msgOf(e)
                events = null
              }
            }
            if (events === null && persist) {
              try {
                const r = await persist.readFrom(id, 0)
                events = r && Array.isArray(r.events) ? r.events : []
              } catch (e) {
                store.lastError = 'readFrom ' + shortOf(id) + ': ' + msgOf(e)
                events = null
              }
            }
            if (events && events.length) {
              foldSessionEvents(id, events)
              store.harnessSessions += 1
            } else if (events === null) {
              // RAW 失败 且 harness 也报错 → 才算失败；空会话（events=[]）不算
              store.failed += 1
            }
          } catch (e) {
            store.lastError = 'session ' + shortOf(id) + ': ' + msgOf(e)
            store.failed += 1
          }
        }
      }

      const n = Math.max(1, Math.min(4, idList.length || 1))
      const workers: Promise<void>[] = []
      for (let k = 0; k < n; k += 1) workers.push(worker())
      await Promise.all(workers.map((w) => w.catch((e) => { store.lastError = 'worker: ' + msgOf(e); store.failed += 1 })))
    } finally {
      // 本轮无失败会话 → 清除历史标记（自愈：日志可读性恢复后自动消失）
      if (store.failed === 0) { store.lastError = null; store.scanError = null }
      if (initial) store.scanning = false
      store.running = false
    }
  }

  // ---- live listener first (no events missed during the initial scan) ----
  ctx.on('session/event', (session: any, event: any) => {
    const id = session && typeof session.id === 'string' ? session.id : undefined
    if (!id) return
    if (!usable(event)) return
    const info = ensureSession(id)
    if (typeof event.seq === 'number' && event.seq <= info.maxSeq) { store.dedupSkipped += 1; return }
    foldUsage(info, event.time, event.data.usage)
    store.foldedEvents += 1
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
      rawSessions: store.rawSessions,
      harnessSessions: store.harnessSessions,
      foldedEvents: store.foldedEvents,
      dedupSkipped: store.dedupSkipped,
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
        // 信任围栏：仅回环 Host 可访问（防 DNS 重绑定 / 跨站探测）
        if (!isLoopbackHost(req.headers.host)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
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
