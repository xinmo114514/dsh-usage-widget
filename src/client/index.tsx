/**
 * Client half of dsh-usage-widget: the floating usage widget.
 *
 * - Registers into the shell.overlay slot (same cell id `uw-usage-widget`
 *   as the old dynamic plugin, so it replaces it without duplication).
 * - The window and the dot are both draggable (position:fixed + pointer
 *   capture); the window drag was previously broken because the CSS lacked
 *   a position declaration (static elements ignore left/top) — the fix is
 *   baked into the styles below.
 * - Data comes from the host half via POST /usage/api/snapshot every 4s.
 *
 * Plain createElement (no JSX) to keep the bundle trivially safe.
 */
import { createElement, useEffect, useMemo, useRef, useState } from 'react'

export const inject = ['slots']

// ============================================================
// Small pure helpers
// ============================================================
const fmt = (n: number | null | undefined): string => {
  if (n == null || isNaN(n as number)) return '--'
  const trim = (v: number, d: number): string => String(v.toFixed(d)).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
  if (n >= 1e8) { const v = n / 1e8; return trim(v, v >= 100 ? 0 : v >= 10 ? 1 : 2) + '亿' }
  if (n >= 1e4) { const v = n / 1e4; return trim(v, v >= 100 ? 0 : v >= 10 ? 1 : 2) + '万' }
  return String(Math.round(n))
}

const fmtFull = (n: number | null | undefined): string => {
  if (n == null || isNaN(n as number)) return '--'
  return Math.round(n).toLocaleString('en-US')
}

const shortId = (id: string): string => {
  if (!id) return '--'
  const s = String(id)
  return s.length > 10 ? s.slice(0, 6) + '…' + s.slice(-4) : s
}

// total = input + output + cacheRead + cacheWrite (no reasoning)
const dayTotal = (b: any): number => ((b && (b.input || b.output || b.cacheRead || b.cacheWrite))
  ? (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0)
  : 0)

const hitRateOf = (u: any): number | null => {
  if (!u) return null
  const denom = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
  if (denom <= 0) return null
  return Math.round(((u.cacheRead || 0) / denom) * 1000) / 10
}

const pctOf = (v: number | null | undefined): string => (v === null || v === undefined || isNaN(v as number)) ? '--' : v + '%'
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
const dayLabel = (t: number): string => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() }

// Catmull-Rom -> cubic Bezier smooth path
const smoothPath = (pts: number[][]): string => {
  if (!pts || pts.length === 0) return ''
  if (pts.length === 1) return 'M' + pts[0][0] + ',' + pts[0][1]
  let d = 'M' + pts[0][0] + ',' + pts[0][1]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6) + ',' + (p1[1] + (p2[1] - p0[1]) / 6) + ' '
      + (p2[0] - (p3[0] - p1[0]) / 6) + ',' + (p2[1] - (p3[1] - p1[1]) / 6) + ' '
      + p2[0] + ',' + p2[1]
  }
  return d
}

// Build day (or weekly) buckets for a chosen range
const buildSet = (series: any[], range: string): any => {
  const days = range === '7d' ? 7 : range === '14d' ? 14 : range === '30d' ? 30 : null
  const raw = (series && series.length ? series : [])
  const map: Record<number, any> = {}
  raw.forEach((p) => { if (p && p.t != null) map[p.t] = p })
  const todayStart = startOfDay(Date.now())
  const zero = (t: number) => ({ t, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 })

  let buckets: any[]
  if (days !== null) {
    buckets = []
    for (let i = days - 1; i >= 0; i--) {
      const t = todayStart - i * 86400000
      buckets.push(Object.assign(zero(t), map[t] || {}))
    }
  } else {
    let spanDays = 1
    if (raw.length > 0) {
      let firstT = todayStart
      raw.forEach((p) => { if (p.t != null && p.t < firstT) firstT = p.t })
      spanDays = Math.max(1, Math.round((todayStart - startOfDay(firstT)) / 86400000))
    }
    if (spanDays > 63) {
      const weekday = new Date(todayStart).getDay()
      const anchor = todayStart - weekday * 86400000
      const weekOf = (t: number): number => {
        const d0 = startOfDay(t)
        const diff = (d0 - anchor) / 86400000
        return anchor + Math.floor(diff / 7) * 7 * 86400000
      }
      const endWeek = weekOf(todayStart)
      const firstT = todayStart - spanDays * 86400000
      const fw = weekOf(firstT)
      const weekList: number[] = []
      for (let w = fw; w <= endWeek; w += 7 * 86400000) weekList.push(w)
      if (weekList.length === 0) weekList.push(endWeek)
      buckets = weekList.map((w) => zero(w))
      const wmap: Record<number, any> = {}
      buckets.forEach((b) => { wmap[b.t] = b })
      raw.forEach((p) => {
        if (p.t == null) return
        const w = weekOf(p.t)
        const b = wmap[w]
        if (b) {
          b.input += p.input || 0; b.output += p.output || 0
          b.cacheRead += p.cacheRead || 0; b.cacheWrite += p.cacheWrite || 0
          b.reasoning += p.reasoning || 0; b.calls += p.calls || 0
        }
      })
    } else {
      buckets = []
      for (let i = spanDays; i >= 0; i--) {
        const t = todayStart - i * 86400000
        buckets.push(Object.assign(zero(t), map[t] || {}))
      }
    }
  }

  let total = 0, input = 0, output = 0, cacheRead = 0, calls = 0
  buckets.forEach((b) => {
    total += dayTotal(b)
    input += b.input || 0; output += b.output || 0
    cacheRead += b.cacheRead || 0; calls += b.calls || 0
  })
  const hitDenom = input + cacheRead
  return {
    buckets, total, input, output, cacheRead, calls,
    hitRate: hitDenom > 0 ? Math.round((cacheRead / hitDenom) * 1000) / 10 : null,
  }
}

// ============================================================
// Styles (prefixed with uwx-)
// ============================================================
const CSS = `
.uwx-root{position:fixed;z-index:2147483000;font-family:inherit;-webkit-font-smoothing:antialiased}
.uwx-window{position:fixed;z-index:2147483000;left:0;top:0;
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1c1c1e);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:14px;
  box-shadow:0 12px 32px rgba(0,0,0,.12);width:300px;
  display:flex;flex-direction:column;font-size:12px;touch-action:none;cursor:grab;
  transition:transform .18s ease,opacity .18s ease;animation:uwx-pop .18s ease}
.uwx-window:active{cursor:grabbing}
.uwx-window[data-dark="1"]{background:var(--dsw-alias-bg-layer-1,#1d1d1f);box-shadow:0 16px 44px rgba(0,0,0,.5)}
@keyframes uwx-pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
.uwx-dot{position:fixed;z-index:2147483000;width:56px;height:56px;border-radius:50%;
  background:var(--dsw-alias-bg-overlay,#fff);border:1.5px solid var(--dsw-alias-brand-primary,#4d6bfe);
  box-shadow:0 8px 20px rgba(0,0,0,.15);cursor:pointer;display:flex;flex-direction:column;
  align-items:center;justify-content:center;touch-action:none;
  transition:transform .18s ease,box-shadow .18s ease;
  animation:uwx-pop .18s ease}
.uwx-dot[data-dark="1"]{background:var(--dsw-alias-bg-layer-1,#1d1d1f)}
.uwx-dot:hover{transform:scale(1.06)}
.uwx-dot-val{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary,#1c1c1e);
  font-variant-numeric:tabular-nums;line-height:1}
.uwx-dot-line{width:34px;height:6px;margin-top:4px}
.uwx-header{display:flex;align-items:center;padding:10px 12px;cursor:grab;user-select:none;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:14px 14px 0 0}
.uwx-header:active{cursor:grabbing}
.uwx-title{font-size:13px;font-weight:600;flex:1;color:var(--dsw-alias-label-primary,#1c1c1e)}
.uwx-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);
  cursor:pointer;transition:background .15s ease,color .15s ease;margin-left:4px;padding:0}
.uwx-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary,#6e6e73) 12%,transparent)}
.uwx-btn.active{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.uwx-body{display:flex;flex-direction:column;overflow-y:auto;max-height:520px;touch-action:pan-y}
.uwx-card{margin:10px 12px;padding:13px 14px;background:var(--dsw-alias-bg-layer-1,#f6f6f7);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:14px}
.uwx-window[data-dark="1"] .uwx-card{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#262629) 60%,transparent)}
.uwx-card-label{font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);display:flex;
  align-items:center;justify-content:space-between;margin-bottom:10px}
.uwx-card-id{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);
  display:block;margin:-2px 0 8px}
.uwx-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.uwx-cell-v{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#1c1c1e)}
.uwx-cell-k{font-size:10px;margin-top:2px;color:var(--dsw-alias-label-secondary,#6e6e73)}
.uwx-card-foot{margin-top:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);
  font-variant-numeric:tabular-nums}
.uwx-no-session{font-size:11px;color:var(--dsw-alias-label-secondary,#6e6e73);text-align:center;padding:8px 0}
.uwx-chips{display:flex;gap:4px;padding:0 12px}
.uwx-chip{flex:1;text-align:center;padding:6px 0;border:1px solid transparent;background:transparent;
  font-size:11px;font-family:inherit;color:var(--dsw-alias-label-secondary,#6e6e73);cursor:pointer;
  border-radius:7px;transition:all .15s ease}
.uwx-chip.uwx-on{color:var(--dsw-alias-brand-primary,#4d6bfe);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent)}
.uwx-ctrl{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 12px 0}
.uwx-seg{display:flex;padding:2px;background:var(--dsw-alias-bg-layer-1,#f2f2f4);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:9px}
.uwx-seg button{flex:1;background:transparent;border:none;padding:5px 8px;border-radius:7px;font-size:11px;
  color:var(--dsw-alias-label-secondary,#6e6e73);cursor:pointer;transition:all .15s ease;font-family:inherit}
.uwx-seg button.uwx-on{background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1c1c1e);
  font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.uwx-seg.mini{flex:0 0 auto;padding:1.5px}
.uwx-seg.mini button{padding:3px 7px;font-size:10px;border-radius:6px}
.uwx-viz{display:flex;gap:6px}
.uwx-vbtn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  background:transparent;border-radius:8px;padding:4px 10px;font-size:11px;font-family:inherit;
  color:var(--dsw-alias-label-secondary,#6e6e73);cursor:pointer;transition:all .15s ease}
.uwx-vbtn.uwx-on{color:var(--dsw-alias-brand-primary,#4d6bfe);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.uwx-vbtn svg{display:block}
.uwx-chart{padding:12px 12px 4px;position:relative}
.uwx-svg{display:block;width:100%}
.uwx-gridline{stroke:var(--dsw-alias-border-l1,rgba(0,0,0,.1));stroke-dasharray:3 4}
.uwx-axis-label{font-size:10px;fill:var(--dsw-alias-label-secondary,#6e6e73)}
.uwx-heat{display:grid;gap:4px}
.uwx-hcell{border-radius:4px;height:18px;min-width:8px}
.uwx-h0{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.uwx-h1{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.uwx-h2{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}
.uwx-h3{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent)}
.uwx-h4{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.uwx-h5{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 68%,transparent)}
.uwx-h6{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 82%,transparent)}
.uwx-h7{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 95%,transparent)}
.uwx-hlbl{font-size:10px;fill:var(--dsw-alias-label-secondary,#6e6e73)}
.uwx-tip{position:absolute;pointer-events:none;background:var(--dsw-alias-bg-overlay,#fff);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:8px;padding:6px 8px;
  font-size:11px;color:var(--dsw-alias-label-primary,#1c1c1e);box-shadow:0 6px 18px rgba(0,0,0,.14);
  z-index:2147483001;white-space:nowrap}
.uwx-window[data-dark="1"] .uwx-tip{background:var(--dsw-alias-bg-layer-1,#262629)}
.uwx-tip b{font-variant-numeric:tabular-nums}
.uwx-footer{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 12px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-size:11px;
  color:var(--dsw-alias-label-secondary,#6e6e73);font-variant-numeric:tabular-nums;border-radius:0 0 14px 14px}
.uwx-footer b{color:var(--dsw-alias-label-primary,#1c1c1e);font-size:12px}
.uwx-scan{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.uwx-footer-left{display:flex;flex-direction:column;gap:2px;min-width:0}
.uwx-total-label{font-size:10px;color:var(--dsw-alias-label-secondary,#6e6e73);letter-spacing:.5px;display:flex;align-items:center;gap:6px}
.uwx-total-big{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#1c1c1e);line-height:1.2;white-space:nowrap}
.uwx-scan-badge{font-size:10px;color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:help;
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);
  border-radius:6px;padding:0 5px;letter-spacing:0;line-height:1.4}
.uwx-empty{padding:16px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#6e6e73)}
`

// ============================================================
// Widget component
// ============================================================
function UsageWidget(props: { useSessions?: (selector: (s: any) => any) => any }): any {
  const { useSessions } = props

  const savedState = (() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem('uw-usage-widget')
        if (v) { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null }
      }
    } catch (e) { /* ignore */ }
    return null
  })()

  const [mode, setMode] = useState<string>(savedState && savedState.mode === 'dot' ? 'dot' : 'window')
  const [pinned, setPinned] = useState<boolean>(savedState && typeof savedState.pinned === 'boolean' ? savedState.pinned : true)
  const [pos, setPos] = useState<{ x: number; y: number }>(savedState && savedState.pos
    ? { x: typeof savedState.pos.x === 'number' ? savedState.pos.x : 0, y: typeof savedState.pos.y === 'number' ? savedState.pos.y : 0 }
    : { x: 0, y: 0 })
  const [range, setRange] = useState<string>('7d')
  const [viz, setViz] = useState<string>('curve')
  const [scope, setScope] = useState<string>('all')
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<boolean>(false)
  const [tip, setTip] = useState<any>(null)
  const [tipPos, setTipPos] = useState<any>(null)
  const tipRef = useRef<any>(null)
  const chartRef = useRef<any>(null)

  const sessionId: string | undefined = (typeof useSessions === 'function')
    ? useSessions((s: any) => s && s.current)
    : undefined

  const isDark = useMemo(() => {
    if (typeof document !== 'undefined' && document.documentElement) {
      return !!document.documentElement.getAttribute('data-theme')
    }
    return false
  }, [])

  // ---- data polling (4s) ----
  const payloadSessionId = scope === 'current' && sessionId ? sessionId : null
  useEffect(() => {
    let live = true
    setErr(false)
    const load = async () => {
      let parsed: any = null
      try {
        const response = await fetch('/usage/api/snapshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: payloadSessionId }),
        })
        parsed = await response.json().catch(() => null)
      } catch (e) {
        parsed = null
      }
      if (!live) return
      if (parsed && parsed.ok === true && parsed.value) { setData(parsed.value); setErr(false) }
      else { setErr(true); setData(null) }
    }
    load()
    const timerId = window.setInterval(load, 4000)
    return () => { live = false; window.clearInterval(timerId) }
  }, [payloadSessionId])

  // persist state
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('uw-usage-widget', JSON.stringify({ mode, pinned, pos }))
      }
    } catch (e) { /* ignore */ }
  }, [mode, pinned, pos])

  // ---- datasets ----
  const series: any[] = (data && data.ok && data.series)
    ? (scope === 'current' ? (data.series.current || []) : (data.series.all || []))
    : []
  const set = useMemo(() => buildSet(series, range), [series, range])
  const scanning = !!(data && data.ok && data.scanning)
  const current = (data && data.ok && data.current) ? data.current : null
  const sessions = (data && data.ok) ? (data.sessions || 0) : 0

  const todayTotal = useMemo(() => {
    const s = data && data.ok ? data.series.all : null
    if (s && s.length) {
      const today = startOfDay(Date.now())
      const ent = s[s.length - 1]
      if (ent && ent.t === today) return dayTotal(ent)
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i].t === today) return dayTotal(s[i])
        if (s[i].t < today) break
      }
    }
    return 0
  }, [data])

  // ---- curve geometry ----
  const curve = useMemo(() => {
    const b = set.buckets
    if (!b.length) return null
    const W = 276, H = 148, PAD = 6
    let max = 1
    b.forEach((x: any) => { const v = dayTotal(x); if (v > max) max = v })
    const pts = b.map((x: any, i: number) => {
      const v = dayTotal(x)
      const px = PAD + (W - 2 * PAD) * (b.length === 1 ? 0.5 : i / (b.length - 1))
      const py = H - PAD - (H - 2 * PAD) * (v / max)
      return [px, py, v]
    })
    const line = smoothPath(pts.map((p) => [p[0], p[1]]))
    const area = pts.length
      ? line + ' L' + pts[pts.length - 1][0] + ',' + (H - PAD) + ' L' + pts[0][0] + ',' + (H - PAD) + ' Z'
      : ''
    const hits = pts.map((p: any, i: number) => ({ cx: p[0], cy: p[1], v: p[2], label: dayLabel(b[i].t), b: b[i] }))
    return { line, area, W, H, hits }
  }, [set])

  // ---- heat cells ----
  const heat = useMemo(() => {
    const b = set.buckets
    if (!b.length) return { cols: 7, chunks: [] }
    const cols = Math.min(7, b.length)
    const chunks = b.map((x: any) => {
      const v = dayTotal(x)
      return { t: x.t, v, label: dayLabel(x.t), calls: x.calls || 0, input: x.input || 0, output: x.output || 0, cacheRead: x.cacheRead || 0 }
    })
    let max = 1
    chunks.forEach((c: any) => { if (c.v > max) max = c.v })
    chunks.forEach((c: any) => {
      const f = c.v / max
      c.lvl = f <= 0 ? 0 : Math.min(7, Math.max(1, Math.ceil(f * 7)))
    })
    return { cols, chunks, max }
  }, [set])

  // ---- viewport-aware geometry ----
  const vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1200
  const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 800
  const winW = 300, winH = Math.min(540, vh - 24)
  const PIN_Y = 88
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max))
  const effPos = pinned
    ? { x: vw - winW - 12, y: PIN_Y }
    : { x: clamp(pos.x, 8, vw - winW - 8), y: clamp(pos.y, 8, vh - winH - 8) }
  const dotPos = pinned
    ? { x: vw - 68, y: PIN_Y }
    : { x: clamp(pos.x, 8, vw - 72), y: clamp(pos.y, 8, vh - 72) }

  // ---- window drag ----
  const dragRef = useRef<any>(null)
  const onWindowDown = (e: any) => {
    if (e.target && e.target.closest && e.target.closest('button')) return
    if (e.stopPropagation) e.stopPropagation()
    const base = pinned ? { x: vw - winW - 12, y: PIN_Y } : pos
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: base.x, oy: base.y, startedPinned: pinned, unpinned: false }
    const t = e.currentTarget
    if (t && t.setPointerCapture) { try { t.setPointerCapture(e.pointerId) } catch (_) { /* ignore */ } }
    e.preventDefault()
  }
  const onWindowMove = (e: any) => {
    const d = dragRef.current
    if (!d) return
    e.preventDefault()
    const nx = d.ox + (e.clientX - d.sx)
    const ny = d.oy + (e.clientY - d.sy)
    if (d.startedPinned && !d.unpinned && (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4)) {
      d.unpinned = true
      setPinned(false)
    }
    setPos({ x: nx, y: ny })
  }
  const onWindowUp = (e: any) => {
    if (!dragRef.current) return
    dragRef.current = null
    const t = e.currentTarget
    if (t && t.releasePointerCapture) { try { t.releasePointerCapture(e.pointerId) } catch (_) { /* ignore */ } }
  }
  const onWindowCancel = (e: any) => {
    if (!dragRef.current) return
    dragRef.current = null
    const t = e.currentTarget
    if (t && t.releasePointerCapture) { try { t.releasePointerCapture(e.pointerId) } catch (_) { /* ignore */ } }
  }
  const stopBtnDown = (e: any) => { if (e && e.stopPropagation) e.stopPropagation() }

  // ---- dot drag ----
  const dotDragRef = useRef<any>(null)
  const onDotDown = (e: any) => {
    if (e.stopPropagation) e.stopPropagation()
    const base = pinned ? { x: vw - 68, y: PIN_Y } : pos
    dotDragRef.current = { sx: e.clientX, sy: e.clientY, ox: base.x, oy: base.y, moved: 0, startedPinned: pinned, unpinned: false }
    const t = e.currentTarget || e.target
    if (t && t.setPointerCapture) { try { t.setPointerCapture(e.pointerId) } catch (_) { /* ignore */ } }
    e.preventDefault()
  }
  const onDotCancel = (e: any) => {
    dotDragRef.current = null
    const t = e.currentTarget || e.target
    if (t && t.releasePointerCapture) { try { t.releasePointerCapture(e.pointerId) } catch (_) { /* ignore */ } }
  }
  const onDotMove = (e: any) => {
    const d = dotDragRef.current
    if (!d) return
    e.preventDefault()
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy))
    if (d.startedPinned && !d.unpinned && d.moved > 4) {
      d.unpinned = true
      setPinned(false)
    }
    setPos({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) })
  }
  const onDotUp = (e: any) => {
    const d = dotDragRef.current
    const t = e.currentTarget || e.target
    if (t && t.releasePointerCapture) { try { t.releasePointerCapture(e.pointerId) } catch (_) { /* ignore */ } }
    const wasDrag = !!d && d.moved > 4
    dotDragRef.current = null
    if (!wasDrag) setMode('window')
  }
  const minimize = (e: any) => {
    if (e && e.stopPropagation) e.stopPropagation()
    setMode('dot')
  }

  const tipFromEvent = (e: any) => {
    let x = 20, y = 20
    const el = chartRef.current
    if (el && typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect()
      x = e.clientX - r.left
      y = e.clientY - r.top
    }
    return { x, y }
  }

  useEffect(() => {
    if (!tip || !tipRef.current) { setTipPos(null); return }
    const w = tipRef.current.offsetWidth || 180
    const h = tipRef.current.offsetHeight || 44
    const chartW = 276
    let left = tip.x - w / 2
    left = Math.max(6, Math.min(left, chartW - w - 6))
    let top = tip.y - h - 10
    top = Math.max(6, Math.min(top, 140))
    setTipPos({ left, top })
  }, [tip])

  // ---- sparkline ----
  const spark = useMemo(() => {
    const b = set.buckets
    if (!b || !b.length) return '0,6 34,6'
    const W = 34, H = 6
    let max = 1
    b.forEach((x: any) => { const v = dayTotal(x); if (v > max) max = v })
    return b.map((x: any, i: number) => {
      const v = dayTotal(x)
      const px = b.length === 1 ? W / 2 : (W * i) / (b.length - 1)
      const py = H - (H * (v / max))
      return Math.round(px) + ',' + py.toFixed(1)
    }).join(' ')
  }, [set])

  // ---- render ----
  const dk = isDark ? '1' : '0'

  if (mode === 'dot') {
    return createElement('div', { className: 'uwx-root', 'data-dark': dk },
      createElement('div', {
        className: 'uwx-dot', 'data-dark': dk,
        style: { left: dotPos.x + 'px', top: dotPos.y + 'px' },
        onPointerDown: onDotDown, onPointerMove: onDotMove,
        onPointerUp: onDotUp, onPointerCancel: onDotCancel,
      },
        createElement('div', { className: 'uwx-dot-val' }, fmt(todayTotal)),
        createElement('svg', { className: 'uwx-dot-line', viewBox: '0 0 34 6', preserveAspectRatio: 'none' },
          createElement('polyline', {
            points: spark, fill: 'none',
            stroke: 'var(--dsw-alias-brand-primary,#4d6bfe)',
            strokeWidth: 1.5, strokeLinecap: 'round',
          }),
        ),
      ),
    )
  }

  const title = err ? '数据不可用' : (!data || !data.ok) ? '加载中…' : ''

  return createElement('div', { className: 'uwx-root', 'data-dark': dk },
    createElement('div', {
      className: 'uwx-window', 'data-dark': dk,
      style: { left: effPos.x + 'px', top: effPos.y + 'px' },
      onPointerDown: onWindowDown, onPointerMove: onWindowMove,
      onPointerUp: onWindowUp, onPointerCancel: onWindowCancel,
    },
      // header
      createElement('div', { className: 'uwx-header' },
        createElement('div', { className: 'uwx-title' }, '用量'),
        createElement('button', {
          className: 'uwx-btn' + (pinned ? ' active' : ''),
          title: pinned ? '取消置顶' : '置顶到右上角',
          onPointerDown: stopBtnDown,
          onClick: (e: any) => { e.stopPropagation(); setPinned(!pinned) },
        },
          createElement('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8' },
            createElement('path', { d: 'M12 2.5l3 6.5 3.5 2.5v2H5.5v-2L9 9l3-6.5z', strokeLinejoin: 'round' }),
            createElement('path', { d: 'M12 11.5V21', strokeLinecap: 'round' }),
          ),
        ),
        createElement('button', {
          className: 'uwx-btn',
          title: '最小化',
          onPointerDown: stopBtnDown,
          onClick: minimize,
        },
          createElement('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8' },
            createElement('path', { d: 'M5 12h14', strokeLinecap: 'round' }),
          ),
        ),
      ),

      // body
      createElement('div', { className: 'uwx-body' },
        createElement('div', { className: 'uwx-card' },
          createElement('div', { className: 'uwx-card-label' },
            createElement('span', null, scope === 'all' ? '全部会话' : '当前会话'),
            createElement('span', { className: 'uwx-seg mini' },
              createElement('button', { className: scope === 'all' ? 'uwx-on' : '', onClick: () => setScope('all') }, '全部会话'),
              createElement('button', { className: scope === 'current' ? 'uwx-on' : '', onClick: () => setScope('current') }, '当前会话'),
            ),
          ),
          scope === 'current'
            ? createElement('div', { className: 'uwx-card-id' },
                current ? shortId(current.id) : (sessionId ? shortId(sessionId) : ''),
              )
            : null,
          createElement('div', { className: 'uwx-grid3' },
            createElement('div', { className: 'uwx-cell' },
              createElement('div', { className: 'uwx-cell-v' }, fmt(set.input)),
              createElement('div', { className: 'uwx-cell-k' }, '输入')),
            createElement('div', { className: 'uwx-cell' },
              createElement('div', { className: 'uwx-cell-v' }, fmt(set.output)),
              createElement('div', { className: 'uwx-cell-k' }, '输出')),
            createElement('div', { className: 'uwx-cell' },
              createElement('div', { className: 'uwx-cell-v' }, pctOf(set.hitRate)),
              createElement('div', { className: 'uwx-cell-k' }, '缓存命中')),
          ),
          createElement('div', { className: 'uwx-card-foot' },
            '调用 ' + fmtFull(set.calls) + ' 次 · 命中 ' + fmt(set.cacheRead)),
        ),

        createElement('div', { className: 'uwx-chips' },
          [['7d', '7天'], ['14d', '2周'], ['30d', '1月'], ['all', '全部']].map(([k, lab]) =>
            createElement('button', {
              key: k,
              className: 'uwx-chip' + (range === k ? ' uwx-on' : ''),
              onClick: () => setRange(k),
            }, lab),
          ),
        ),

        createElement('div', { className: 'uwx-ctrl' },
          createElement('div', { className: 'uwx-viz' },
            createElement('button', {
              className: 'uwx-vbtn' + (viz === 'curve' ? ' uwx-on' : ''),
              onClick: () => setViz('curve'),
            },
              createElement('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8' },
                createElement('path', { d: 'M3 17l6-6 4 4 8-9', strokeLinecap: 'round', strokeLinejoin: 'round' }),
              ),
              createElement('span', null, '曲线'),
            ),
            createElement('button', {
              className: 'uwx-vbtn' + (viz === 'heat' ? ' uwx-on' : ''),
              onClick: () => setViz('heat'),
            },
              createElement('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8' },
                createElement('rect', { x: '3', y: '3', width: '8', height: '8', rx: '2' }),
                createElement('rect', { x: '13', y: '3', width: '8', height: '8', rx: '2', opacity: '.6' }),
                createElement('rect', { x: '3', y: '13', width: '8', height: '8', rx: '2', opacity: '.6' }),
                createElement('rect', { x: '13', y: '13', width: '8', height: '8', rx: '2', opacity: '.35' }),
              ),
              createElement('span', null, '热力'),
            ),
          ),
        ),

        createElement('div', {
          className: 'uwx-chart',
          ref: chartRef,
          onMouseLeave: () => setTip(null),
        },
          err
            ? createElement('div', { className: 'uwx-empty' }, '数据不可用，稍后重试')
            : (!data || !data.ok)
              ? createElement('div', { className: 'uwx-empty' }, '加载中…')
              : (series.length === 0 && !scanning)
                ? createElement('div', { className: 'uwx-empty' },
                    scope === 'current' ? '本会话暂无用量' : '暂无用量数据')
                : viz === 'curve' && curve
                ? createElement('svg', { className: 'uwx-svg', viewBox: '0 0 ' + curve.W + ' ' + curve.H },
                    [0.25, 0.5, 0.75].map((f) =>
                      createElement('line', {
                        key: 'g' + f, x1: 0, x2: curve.W,
                        y1: curve.H * f, y2: curve.H * f, className: 'uwx-gridline',
                      }),
                    ),
                    createElement('defs', null,
                      createElement('linearGradient', { id: 'uwx-area', x1: '0', y1: '0', x2: '0', y2: '1' },
                        createElement('stop', { offset: '0%', stopColor: 'var(--dsw-alias-brand-primary,#4d6bfe)', stopOpacity: '.28' }),
                        createElement('stop', { offset: '100%', stopColor: 'var(--dsw-alias-brand-primary,#4d6bfe)', stopOpacity: '0' }),
                      ),
                    ),
                    createElement('path', { d: curve.area, fill: 'url(#uwx-area)', stroke: 'none' }),
                    createElement('path', { d: curve.line, fill: 'none', stroke: 'var(--dsw-alias-brand-primary,#4d6bfe)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                    curve.hits.map((h: any, i: number) =>
                      createElement('g', {
                        key: 'h' + i,
                        onMouseEnter: (e: any) => { e.stopPropagation(); const p = tipFromEvent(e); setTip({ x: p.x, y: p.y, b: h.b, label: h.label }) },
                      },
                        createElement('circle', { cx: h.cx, cy: h.cy, r: 7, fill: 'transparent' }),
                        createElement('circle', { cx: h.cx, cy: h.cy, r: 2.5, fill: 'var(--dsw-alias-brand-primary,#4d6bfe)' }),
                      ),
                    ),
                    (function () {
                      const n = curve.hits.length
                      const idxs = n === 1 ? [0] : n === 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1]
                      return idxs.map((i: number, k: number) =>
                        createElement('text', {
                          key: 'l' + k, x: curve.hits[i].cx, y: curve.H - 3,
                          className: 'uwx-axis-label', textAnchor: 'middle',
                        }, curve.hits[i].label),
                      )
                    })(),
                  )
                : createElement('div', {
                    className: 'uwx-heat',
                    style: { gridTemplateColumns: 'repeat(' + heat.cols + ',1fr)' },
                  },
                    heat.chunks.map((c: any, i: number) =>
                      createElement('div', {
                        key: i,
                        className: 'uwx-hcell uwx-h' + c.lvl,
                        onMouseEnter: (e: any) => { e.stopPropagation(); const p = tipFromEvent(e); setTip({ x: p.x, y: p.y, b: c, v: c.v, label: c.label }) },
                      }),
                    ),
                  ),
          tip
            ? createElement('div', {
                ref: tipRef,
                className: 'uwx-tip',
                style: {
                  left: (tipPos ? tipPos.left : 0) + 'px',
                  top: (tipPos ? tipPos.top : 0) + 'px',
                  opacity: tipPos ? 1 : 0,
                },
              },
                createElement('div', null, tip.label),
                createElement('div', null,
                  '总 ',
                  createElement('b', null, fmtFull(tip.b ? dayTotal(tip.b) : tip.v)),
                  ' tokens' + (tip.b ? ' · 调 ' + fmtFull(tip.b.calls || 0) : '') +
                    (tip.b ? ' · 命中 ' + pctOf(hitRateOf(tip.b)) : ''),
                ),
              )
            : null,
        ),

        createElement('div', { className: 'uwx-footer' },
          createElement('div', { className: 'uwx-footer-left' },
            createElement('div', { className: 'uwx-total-label' },
              '总 tokens',
              (data && data.ok && ((data.failed && data.failed > 0) || data.scanError))
                ? createElement('span', {
                    className: 'uwx-scan-badge',
                    title: String(data.lastError || data.scanError || ''),
                  }, '缺 ' + ((data.failed && data.failed > 0) ? data.failed : 1) + ' 会话')
                : null,
            ),
            scanning
              ? createElement('div', { className: 'uwx-total-big uwx-scan' }, '扫描中…')
              : createElement('div', { className: 'uwx-total-big' },
                  fmtFull((data && data.ok && data.all && data.all.usage && typeof data.all.usage.total === 'number')
                    ? data.all.usage.total
                    : set.total)),
          ),
          createElement('span', null,
            ({ '7d': '近7天', '14d': '近2周', '30d': '近1月', all: '全部' } as Record<string, string>)[range] +
            ' · 命中 ' + pctOf(set.hitRate) + ' · 会话 ' + fmtFull(sessions),
          ),
        ),
      ),
    ),
  )
}

// ============================================================
// Plugin entry
// ============================================================
export function apply(ctx: any): void {
  // ---- 双通道自动去重（profile 通道 / 注册表通道）----
  // 两个 bundle 可能同时被页面加载（client.js 与 client-registry.js 共享
  // 同一 window）。先到者注册 UI，后到者自动待命；生效者卸载时让位，
  // 下一次页面加载时由存活的通道接管。避免双窗口。
  const g = (typeof window !== 'undefined' ? window : globalThis) as any
  if (g.__dshUsageWidgetClientActive) {
    console.log('[dsh-usage-widget] standby: another channel is active — client mount skipped')
    return
  }
  g.__dshUsageWidgetClientActive = true
  ctx.effect(() => () => { g.__dshUsageWidgetClientActive = false }, 'dsh-usage-widget: client dedup claim')

  // style injection owned by the plugin fiber
  ctx.effect(() => {
    if (typeof document === 'undefined') return
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin', 'dsh-usage-widget')
    tag.setAttribute('data-plugin-css', 'dsh-usage-widget/widget')
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { try { tag.remove() } catch (_) { /* ignore */ } }
  }, 'dsh-usage-widget: styles')

  const slots = ctx.get('slots')
  if (slots === undefined || typeof slots.inject !== 'function') return

  slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'uw-usage-widget',
  }, (props: any) => {
    const useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : undefined
    return createElement(UsageWidget, { useSessions })
  }))
}
