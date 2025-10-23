import { useEffect, useMemo, useState, useRef } from 'react'
import { http, WagmiProvider, useSwitchChain, useAccount } from 'wagmi'
import { base, baseSepolia } from 'viem/chains'
import { RainbowKitProvider, ConnectButton, getDefaultConfig } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@rainbow-me/rainbowkit/styles.css'
import './styles.css'
import { deployed } from './addresses'

// Oracle event ABI for on-chain history and live updates
const oracleEventAbi = [
  {
    "type": "event",
    "name": "PriceUpdated",
    "inputs": [
      { "name": "price", "type": "int256", "indexed": false },
      { "name": "timestamp", "type": "uint256", "indexed": false }
    ],
    "anonymous": false
  }
 ] as const

// Minimal ABI for our contracts
const oracleAbi = [
  { "inputs": [], "name": "latestAnswer", "outputs": [{"internalType":"int256","name":"","type":"int256"}], "stateMutability":"view", "type":"function" },
  { "inputs": [], "name": "latestTimestamp", "outputs": [{"internalType":"uint256","name":"","type":"uint256"}], "stateMutability":"view", "type":"function" }
] as const
const perpsAbi = [
  { "inputs": [{"internalType":"bool","name":"isLong","type":"bool"},{"internalType":"uint256","name":"leverage","type":"uint256"}], "name":"openPosition", "outputs": [], "stateMutability":"payable","type":"function" },
  { "inputs": [], "name":"closePosition", "outputs": [], "stateMutability":"nonpayable","type":"function" },
  { "inputs": [{"internalType":"address","name":"trader","type":"address"}], "name":"liquidate", "outputs": [], "stateMutability":"nonpayable","type":"function" },
  { "inputs": [{"internalType":"address","name":"trader","type":"address"}], "name":"canLiquidate", "outputs": [{"internalType":"bool","name":"","type":"bool"}], "stateMutability":"view","type":"function" },
  { "inputs": [{"internalType":"address","name":"","type":"address"}], "name":"positions", "outputs": [
    {"internalType":"bool","name":"isOpen","type":"bool"},
    {"internalType":"bool","name":"isLong","type":"bool"},
    {"internalType":"uint256","name":"leverage","type":"uint256"},
    {"internalType":"uint256","name":"margin","type":"uint256"},
    {"internalType":"uint256","name":"entryPrice","type":"uint256"},
    {"internalType":"uint256","name":"lastUpdate","type":"uint256"}
  ], "stateMutability":"view","type":"function" },
  { "inputs": [], "name": "maintenanceMarginRatioBps", "outputs": [{"internalType":"uint256","name":"","type":"uint256"}], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "takerFeeBps", "outputs": [{"internalType":"uint256","name":"","type":"uint256"}], "stateMutability": "view", "type": "function" },
  { "inputs": [{"internalType":"uint256","name":"stopLoss","type":"uint256"},{"internalType":"uint256","name":"takeProfit","type":"uint256"}], "name":"setStops", "outputs": [], "stateMutability":"nonpayable","type":"function" },
  { "inputs": [{"internalType":"address","name":"trader","type":"address"}], "name":"getStops", "outputs": [{"internalType":"uint256","name":"","type":"uint256"},{"internalType":"uint256","name":"","type":"uint256"}], "stateMutability": "view", "type": "function" },
  { "inputs": [{"internalType":"address","name":"trader","type":"address"}], "name":"shouldClose", "outputs": [{"internalType":"bool","name":"","type":"bool"},{"internalType":"bool","name":"","type":"bool"},{"internalType":"bool","name":"","type":"bool"}], "stateMutability": "view", "type": "function" },
  { "inputs": [{"internalType":"address","name":"trader","type":"address"}], "name":"closeIfTriggered", "outputs": [], "stateMutability":"nonpayable","type":"function" }
] as const

import { createChart, ColorType, Time, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'

type Tick = { time: UTCTimestamp, value: number }
type Candle = { time: UTCTimestamp, open: number, high: number, low: number, close: number }

// Shared: map sport name to an emoji (covers the 4 sports)
const sportEmoji = (s?: string) => ({
  football: '⚽️',
  soccer: '⚽️',
  basketball: '🏀',
  volleyball: '🏐',
  handball: '🤾',
  random: '🎲',
} as any)[String(s||'').toLowerCase()] || ''

// Helper: timeframe seconds
function tfSeconds(tf: '1m'|'5m'|'15m'|'1h'|'4h'|'1d'|'3d'|'1w'): number {
  switch (tf) {
    case '1m': return 60
    case '5m': return 300
    case '15m': return 900
    case '1h': return 3600
    case '4h': return 14400
    case '1d': return 86400
    case '3d': return 259200
    case '1w': return 604800
  }
}

// Ensure continuity: each candle opens where the previous closed
function normalizeContinuity(cs: Candle[]): Candle[] {
  if (!cs?.length) return cs
  const out: Candle[] = [ { ...cs[0] } ]
  for (let i=1;i<cs.length;i++) {
    const prev = out[i-1]
    const curr = { ...cs[i] }
    const desiredOpen = prev.close
    if (Math.abs(curr.open - desiredOpen) > 1e-9) {
      curr.open = desiredOpen
      // keep high/low inclusive of new open
      curr.high = Math.max(curr.high, curr.open)
      curr.low = Math.min(curr.low, curr.open)
    }
    out.push(curr)
  }
  return out
}

function DominanceChart({ oracleAddress, chainKey, market }: { oracleAddress: string, chainKey: 'base'|'baseSepolia', market: 'btcd'|'random'|'localaway' }) {
  const [tf, setTf] = useState<'1m'|'5m'|'15m'|'1h'|'4h'|'1d'|'3d'|'1w'>('15m')
  const [candles, setCandles] = useState<Candle[]>([])
  const [remaining, setRemaining] = useState<number>(0)
  const [overlayTop, setOverlayTop] = useState<number>(8)
  const [livePrice, setLivePrice] = useState<number | null>(null)
  // Events banner state (LocalAway only)
  const [bannerEvents, setBannerEvents] = useState<Array<{ time:number, value:number, meta:any }>>([])
  const [bannerLoading, setBannerLoading] = useState<boolean>(false)
  const [bannerHadCache, setBannerHadCache] = useState<boolean>(false)
  // Random banner state (Random only)
  const [randBanner, setRandBanner] = useState<Array<{ time:number, value:number }>>([])
  const [randLoading, setRandLoading] = useState<boolean>(false)
  const [randHadCache, setRandHadCache] = useState<boolean>(false)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const chartWrapRef = useRef<HTMLDivElement | null>(null)
  const containerId = useMemo(() => `chart_container_${market}`, [market])

  // Reset local state when switching markets to show a fresh chart
  useEffect(() => {
    setCandles([])
    setLivePrice(null)
  }, [market])

  // Build history from on-chain events and then poll live values
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
  const chainParam = chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'

  // Fetch pre-aggregated candle JSON; bootstrap from localStorage
  useEffect(() => {
    let cancelled = false
    const key = chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'
    const lsKey = `btcd:candles:${key}:${market}:${tf}`
  // Use serverless API endpoint backed by DB
  const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
  const url = `${baseUrl}/api/candles?chain=${key}&tf=${tf}&market=${market}${market==='localaway' ? '&metric=delta' : ''}`
    const load = async () => {
      try {
        // localStorage bootstrap
        try {
          const raw = localStorage.getItem(lsKey)
          if (raw) {
            const arr = JSON.parse(raw)
            if (Array.isArray(arr)) {
              const cs: Candle[] = arr.map((c:any) => ({ time: Number(c.time) as UTCTimestamp, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
              cs.sort((a,b)=>a.time-b.time)
              if (!cancelled) setCandles(normalizeContinuity(cs))
            }
          }
        } catch {}
        // fetch cloud JSON
        const res = await fetch(url, { cache: 'no-store' })
        if (res.ok) {
          const j = await res.json()
          if (Array.isArray(j.candles)) {
            const cs: Candle[] = j.candles.map((c:any) => ({ time: Number(c.time) as UTCTimestamp, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
            cs.sort((a,b)=>a.time-b.time)
            const norm = normalizeContinuity(cs)
            if (!cancelled) setCandles(norm)
            try { localStorage.setItem(lsKey, JSON.stringify(norm)) } catch {}
          }
        }
      } catch (e) {
        console.warn('load candles failed', e)
      }
    }
    load()
    return () => { cancelled = true }
  }, [chainKey, tf, market])

  // Auto-refresh candles from API every 60s (no page reload)
  useEffect(() => {
  const key = chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'
  const lsKey = `btcd:candles:${key}:${market}:${tf}`
    const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
  const url = `${baseUrl}/api/candles?chain=${key}&tf=${tf}&market=${market}${market==='localaway' ? '&metric=delta' : ''}`
    let t: number | undefined
    const tick = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' })
        if (res.ok) {
          const j = await res.json()
          if (Array.isArray(j.candles)) {
            const cs: Candle[] = j.candles.map((c:any) => ({ time: Number(c.time) as UTCTimestamp, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
            cs.sort((a,b)=>a.time-b.time)
            const norm = normalizeContinuity(cs)
            setCandles(norm)
            try { localStorage.setItem(lsKey, JSON.stringify(norm)) } catch {}
          }
        }
      } catch {}
      t = window.setTimeout(tick, 60000)
    }
    t = window.setTimeout(tick, 60000)
    return () => { if (t) window.clearTimeout(t) }
  }, [chainKey, tf, market])

  // Load events for banner (LocalAway only) — always show the banner
  useEffect(() => {
    if (market !== 'localaway') { setBannerEvents([]); setBannerHadCache(false); return }
    let cancel = false
    const limit = 20
    const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
    const url = `${baseUrl}/api/events?chain=${chainParam}&market=localaway&limit=${limit}`
    const lsKey = `btcd:banner:${chainParam}:localaway`
    const load = async () => {
      try {
        setBannerLoading(true)
        // Bootstrap from localStorage so the banner shows "last known" events immediately
        try {
          const raw = localStorage.getItem(lsKey)
          if (raw && !cancel) {
            const arr = JSON.parse(raw)
            if (Array.isArray(arr) && arr.length) {
              setBannerEvents(arr)
              setBannerHadCache(true)
            }
          }
        } catch {}
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        const evs = Array.isArray(j?.events) ? j.events : []
        if (!cancel) {
          if (evs.length) {
            setBannerEvents(evs)
            setBannerHadCache(false)
            try { localStorage.setItem(lsKey, JSON.stringify(evs)) } catch {}
          } else {
            // If API returns empty, keep whatever we had (cache or previous fetch)
            // If we had no cache and nothing fetched, banner will still render as empty container
          }
        }
      } catch {}
      setBannerLoading(false)
    }
    load()
    const t = window.setInterval(load, 60000)
    return () => { cancel = true; window.clearInterval(t) }
  }, [market, chainParam])

  // Load recent random numbers for banner (Random only) — always show the banner
  useEffect(() => {
    if (market !== 'random') { setRandBanner([]); setRandHadCache(false); return }
    let cancel = false
    const limit = 20
    const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
    const url = `${baseUrl}/api/events?chain=${chainParam}&market=random&limit=${limit}&oracle=${encodeURIComponent(oracleAddress||'')}`
    const lsKey = `btcd:banner:${chainParam}:random`
    const load = async () => {
      try {
        setRandLoading(true)
        // Bootstrap from localStorage
        try {
          const raw = localStorage.getItem(lsKey)
          if (raw && !cancel) {
            const arr = JSON.parse(raw)
            if (Array.isArray(arr) && arr.length) {
              setRandBanner(arr)
              setRandHadCache(true)
            }
          }
        } catch {}
        const res = await fetch(url, { cache: 'no-store' })
        if (res.ok) {
          const j = await res.json()
          const evs = Array.isArray(j?.events) ? j.events : []
          // Normalize to {time,value} newest-first
          const rows = evs.map((e:any)=> ({ time: Number(e?.time)||0, value: Number(e?.value) }))
            .filter((r: { time:number, value:number })=> Number.isFinite(r.time) && Number.isFinite(r.value))
            .sort((a: { time:number }, b: { time:number })=> b.time - a.time)
          if (!cancel) {
            if (rows.length) {
              setRandBanner(rows)
              setRandHadCache(false)
              try { localStorage.setItem(lsKey, JSON.stringify(rows)) } catch {}
            } else {
              // Keep cache if API empty; optional: fallback to on-chain scan (heavy)
            }
          }
        }
      } catch {}
      setRandLoading(false)
    }
    load()
    const t = window.setInterval(load, 60000)
    return () => { cancel = true; window.clearInterval(t) }
  }, [market, chainParam, oracleAddress])

  // Poll latestAnswer/latestTimestamp to append live points
  const { data: latestAns } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    chainId: desiredChain.id,
    query: { enabled: Boolean(oracleAddress), refetchInterval: 60000, refetchIntervalInBackground: true }
  })
  const { data: latestTs } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestTimestamp',
    chainId: desiredChain.id,
    query: { enabled: Boolean(oracleAddress), refetchInterval: 60000, refetchIntervalInBackground: true }
  })
  useEffect(() => {
    if (typeof latestAns === 'bigint' && typeof latestTs === 'bigint') {
      const v = Number(formatUnits(latestAns, 8))
      const ts = Number(latestTs) as UTCTimestamp
      setLivePrice(v)
      // Update only the last candle's close/high/low based on live price; we don't append a new candle here
      setCandles(prev => {
        if (!prev.length) return prev
        const bucketSec = tfSeconds(tf)
        const lastBucket = Math.floor((prev[prev.length-1].time as number) / bucketSec) * bucketSec
        const currBucket = Math.floor((ts as number) / bucketSec) * bucketSec
        const updated = [...prev]
        if (currBucket === lastBucket) {
          const last = { ...updated[updated.length - 1] }
          last.close = v
          last.high = Math.max(last.high, v)
          last.low = Math.min(last.low, v)
          updated[updated.length - 1] = last
          // persist
          try { const key = (chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'); localStorage.setItem(`btcd:candles:${key}:${market}:${tf}`, JSON.stringify(updated)) } catch {}
          return updated
        }
        // Rolled into a new bucket: start a new candle that opens at previous close
        if (currBucket > lastBucket) {
          const prevLast = updated[updated.length - 1]
          const open = prevLast.close
          const nc: Candle = { time: currBucket as UTCTimestamp, open, high: Math.max(open, v), low: Math.min(open, v), close: v }
          updated.push(nc)
          // persist
          try { const key = (chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'); localStorage.setItem(`btcd:candles:${key}:${market}:${tf}`, JSON.stringify(updated)) } catch {}
          return updated
        }
        return updated
      })
    }
  }, [latestAns, latestTs])

  // Position the timer label just below the current price on the right, like TradingView
  useEffect(() => {
    const el = chartWrapRef.current
    const series = seriesRef.current
    if (!el || !series) return
    const price = (typeof livePrice === 'number' && !Number.isNaN(livePrice))
      ? livePrice
      : (candles.length ? candles[candles.length-1].close : null)
    if (price === null) { setOverlayTop(8); return }
    const y = series.priceToCoordinate(price)
    const h = el.clientHeight || 480
    const top = y !== null && y !== undefined ? y + 18 : 8
    const clamped = Math.min(Math.max(top, 6), h - 46)
    setOverlayTop(clamped)
  }, [livePrice, candles, tf])

  // Initialize chart; recreate when market changes to ensure a fresh chart per market
  useEffect(() => {
    const el = document.getElementById(containerId) as HTMLDivElement | null
    if (!el) return
    // Defensive: if a previous chart instance exists or children remain, clean up fully before creating a new one
    try {
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
      seriesRef.current = null
      while (el.firstChild) el.removeChild(el.firstChild)
    } catch {}
    const chart = createChart(el, {
      width: el.clientWidth,
      height: 480,
      layout: { background: { type: ColorType.Solid, color: '#0b1221' }, textColor: '#DDD' },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart as any
    const isRandom = market === 'random'
    const series = chart.addCandlestickSeries(
      isRandom
        ? { upColor: '#3b82f6', downColor: '#1d4ed8', borderVisible: false, wickUpColor: '#60a5fa', wickDownColor: '#60a5fa' }
        : { upColor: '#16a34a', downColor: '#ef4444', borderVisible: false, wickUpColor: '#16a34a', wickDownColor: '#ef4444' }
    )
    seriesRef.current = series as any
    const onResize = () => chart.applyOptions({ width: el.clientWidth })
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [market])

  // Removed legacy static history refresh (now using API candles exclusively)

  // Update series with pre-aggregated candles
  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(candles as any)
  }, [candles])

  // Countdown: update remaining seconds for current candle and display as overlay
  useEffect(() => {
    let id: number | undefined
    const loop = () => {
      try {
        if (candles.length) {
          const last = candles[candles.length - 1]
          const now = Math.floor(Date.now() / 1000)
          const bucket = tfSeconds(tf)
          const end = (Math.floor((last.time as number) / bucket) * bucket) + bucket
          const rem = Math.max(0, end - now)
          setRemaining(rem)
        } else {
          setRemaining(0)
        }
      } catch { setRemaining(0) }
      id = window.setTimeout(loop, 1000)
    }
    id = window.setTimeout(loop, 1000)
    return () => { if (id) window.clearTimeout(id) }
  }, [candles, tf])

  return (
    <div className="card">
      <div className="card-header">
        <div className="tabs" style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ fontSize:12, fontWeight:600, opacity:0.8 }}>
            {market==='btcd' ? 'BTC Dominance' : (market==='random' ? 'Random Index' : 'Home/Away Index')}
          </div>
          {(['1m','5m','15m','1h','4h','1d','3d','1w'] as const).map(k => (
            <button key={k} onClick={()=>setTf(k)} className={tf===k? 'tab active':'tab'}>{k}</button>
          ))}
        </div>
      </div>
      <div className="card-body p0">
        <div ref={chartWrapRef} style={{ position:'relative' }}>
          {/* Events banner over the candlestick chart (LocalAway) — always visible */}
          {market==='localaway' && (
            <div style={{ position:'absolute', top:6, left:6, right:6, zIndex:3 }}>
              <div style={{
                background:'rgba(12,18,33,0.9)',
                border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:6,
                padding:'6px 10px',
                overflow:'hidden',
                whiteSpace:'nowrap',
                display:'flex',
                gap:16,
                alignItems:'center',
                minHeight: 28
              }}>
                {bannerEvents.length > 0 ? (
                  bannerEvents.slice(0, 8).map((e, idx) => {
                    const lg = e.meta?.league || ''
                    const home = e.meta?.home?.name || 'Home'
                    const away = e.meta?.away?.name || 'Away'
                    const scHome = e.meta?.score?.home ?? '?'
                    const scAway = e.meta?.score?.away ?? '?'
                    const inferredSport = String(e.meta?.sport || (String(e.meta?.type||'').toLowerCase()==='goal' ? 'football' : ''))
                    const emoji = (e.meta?.emoji && String(e.meta?.emoji).length>0) ? e.meta.emoji : sportEmoji(inferredSport)
                    const type = String(e.meta?.type || '')
                    const side = type === 'goal' ? (e.meta?.side === 'home' ? 'local' : (e.meta?.side === 'away' ? 'visitante' : '')) : ''
                    return (
                      <div key={idx} style={{ display:'inline-flex', alignItems:'center', gap:8, minWidth:0 }}>
                        <div style={{ width:20, textAlign:'center' }}>{emoji}</div>
                        <div className="muted small" style={{ opacity:0.85, textOverflow:'ellipsis', overflow:'hidden' }}><strong>{lg}</strong></div>
                        <div style={{ fontSize:13 }}>
                          {home} <strong>{scHome}-{scAway}</strong> {away}
                        </div>
                        {side && <span className="badge" style={{ marginLeft:4 }}>{side}</span>}
                      </div>
                    )
                  })
                ) : (
                  <div className="muted small" style={{ opacity:0.8 }}>
                    {bannerLoading ? 'Cargando eventos…' : (bannerHadCache ? 'Mostrando últimos registrados' : 'Sin eventos recientes')}
                  </div>
                )}
              </div>
            </div>
          )}
          {/* Numbers banner over the candlestick chart (Random) — always visible */}
          {market==='random' && (
            <div style={{ position:'absolute', top:6, left:6, right:6, zIndex:3 }}>
              <div style={{
                background:'rgba(12,18,33,0.9)',
                border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:6,
                padding:'6px 10px',
                overflow:'hidden',
                whiteSpace:'nowrap',
                display:'flex',
                gap:16,
                alignItems:'center',
                minHeight: 28
              }}>
                {randBanner.length > 0 ? (
                  randBanner.slice(0, 8).map((r, idx) => {
                    const prev = randBanner[idx+1]?.value
                    const stepBps = (typeof prev === 'number' && prev > 0)
                      ? Math.round(((r.value - prev) / prev) * 10000)
                      : null
                    const sign = stepBps !== null ? (stepBps > 0 ? `+${stepBps}` : `${stepBps}`) : '—'
                    const rounded = Math.round(r.value)
                    return (
                      <div key={idx} style={{ display:'inline-flex', alignItems:'center', gap:8, minWidth:0 }}>
                        <div style={{ width:20, textAlign:'center' }}>🎲</div>
                        <div style={{ fontSize:13, display:'flex', alignItems:'baseline', gap:8 }}>
                          <strong>{r.value.toFixed(4)}</strong>
                          <span className={stepBps !== null ? (stepBps >= 0 ? 'pnl up small' : 'pnl down small') : 'muted small'}>
                            ({sign} bps)
                          </span>
                          <span className="muted small">≈ {rounded}</span>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <div className="muted small" style={{ opacity:0.8 }}>
                    {randLoading ? 'Cargando números…' : (randHadCache ? 'Mostrando últimos registrados' : 'Sin números recientes')}
                  </div>
                )}
              </div>
            </div>
          )}
          <div id={containerId} className="chart" />
          {/* Scroll guards around the chart to ease page scrolling */}
          <div className="chart-guard top" title="Arrastra aquí para desplazar la página" />
          <div className="chart-guard bottom" title="Arrastra aquí para desplazar la página" />
          <div className="chart-guard left" title="Arrastra aquí para desplazar la página" />
          <div className="chart-guard right" title="Arrastra aquí para desplazar la página" />
          <div style={{ position:'absolute', top: overlayTop, right: 6, background:'#fff', color:'#111', border:'1px solid #d1d5db', boxShadow:'0 1px 3px rgba(0,0,0,0.25)', padding:'4px 8px', borderRadius:4, fontSize:12, lineHeight:1.15, fontWeight:600, minWidth:64, textAlign:'right' }}>
            <div>
              {(() => {
                const val = (typeof livePrice === 'number' ? livePrice : (candles[candles.length-1]?.close ?? 0));
                return `${val.toFixed(2)}${market==='btcd' ? '%' : ''}`
              })()}
            </div>
            <div style={{ fontWeight:500 }}>{`${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Aggregation removed from client; candles served from pre-aggregated JSON

const queryClient = new QueryClient()

function AppInner({ routeMarket }: { routeMarket: 'btcd'|'random'|'localaway' }) {
  const market: 'btcd'|'random'|'localaway' = routeMarket
  const config = useMemo(() => getDefaultConfig({
    appName: 'Perp-it',
    projectId: 'btcd-temp',
    chains: [base, baseSepolia],
    transports: {
      [base.id]: http(),
      [baseSepolia.id]: http(),
    }
  }), [])

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={baseSepolia}>
          <AppContent market={market} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

function AppContent({ market }: { market: 'btcd'|'random'|'localaway' }) {
  // Wallet and chain management
  const chainId = useChainId()
  const { isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  // UI chain override to allow switching even when disconnected (persisted)
  const [uiChain, setUiChain] = useState<'base'|'baseSepolia' | null>(() => {
    try {
      const raw = localStorage.getItem('btcd:ui:chain')
      if (raw === 'base' || raw === 'baseSepolia') return raw
    } catch {}
    return null
  })
  // Effective chain: wallet chain if connected, else UI override or default Base Sepolia
  const chain: 'base'|'baseSepolia' = isConnected
    ? (chainId === base.id ? 'base' : 'baseSepolia')
    : (uiChain || 'baseSepolia')

  // addresses from deployed mapping (read-only in UI)
  const [oracleAddress, setOracleAddress] = useState<string>('')
  const [perpsAddress, setPerpsAddress] = useState<string>('')

  useEffect(() => {
    const entry = (deployed as any)?.[chain]?.[market]
    setOracleAddress(entry?.oracle || '')
    setPerpsAddress(entry?.perps || '')
  }, [chain, market])

  return (
    <div className={"container " + (market === 'btcd' ? 'market-btcd' : (market === 'random' ? 'market-random' : 'market-localaway'))}>
      <header className="header">
        <div className="header-left" style={{ flexDirection:'column', alignItems:'flex-start', gap:8 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%' }}>
            <div className="brand">Perp-it</div>
            {/* Network menu: Live (Base) / Test (Base Sepolia) */}
            <div className="network-menu">
              <div className="segmented">
                <button
                  className={(chain==='base' ? 'seg active' : 'seg')}
                  onClick={async ()=>{
                    try { localStorage.setItem('btcd:ui:chain','base') } catch {}
                    setUiChain('base')
                    if (isConnected) {
                      try { await switchChainAsync?.({ chainId: base.id }) } catch {}
                    }
                  }}
                >Live Perps</button>
                <button
                  className={(chain==='baseSepolia' ? 'seg active' : 'seg')}
                  onClick={async ()=>{
                    try { localStorage.setItem('btcd:ui:chain','baseSepolia') } catch {}
                    setUiChain('baseSepolia')
                    if (isConnected) {
                      try { await switchChainAsync?.({ chainId: baseSepolia.id }) } catch {}
                    }
                  }}
                >Test Perps</button>
              </div>
            </div>
          </div>
          {/* Page selector moved below the title */}
          <div className="network-switcher" style={{ marginTop: 4 }}>
            <span className="label">Page</span>
            <div className="segmented">
              <a href="#btcd" className={market==='btcd'?'seg active':'seg'}>BTC.D</a>
              <a href="#random" className={market==='random'?'seg active':'seg'}>Random</a>
              <a href="#localaway" className={market==='localaway'?'seg active':'seg'}>Home/Away</a>
            </div>
          </div>
        </div>
        {/* The ConnectButton includes a chain switcher; switching there auto-updates the page */}
        <div className="header-right"><ConnectButton /></div>
      </header>

      <main className="main">
        <section className="main-top">
          <DominanceChart oracleAddress={oracleAddress} chainKey={chain} market={market} />
        </section>

        <section className="main-grid">
          <div className="col">
            <TradePanel perpsAddress={perpsAddress} oracleAddress={oracleAddress} chainKey={chain} market={market} />
            <TreasuryCard perpsAddress={perpsAddress} desired={chain} />
            <ConfigCard oracleAddress={oracleAddress} perpsAddress={perpsAddress} />
          </div>
          <div className="col">
            <PositionCard perpsAddress={perpsAddress} oracleAddress={oracleAddress} market={market} chainKey={chain} />
            {market === 'random' && (
              <RandomCard chainKey={chain} oracleAddress={oracleAddress} />
            )}
            {market === 'localaway' && (
              <GoalsCard chainKey={chain} />
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId, useSimulateContract, useBalance, useSendTransaction } from 'wagmi'
import { parseEther, formatUnits, formatEther, createPublicClient, http as viemHttp } from 'viem'

type OpenControlled = { isLong: boolean; setIsLong: (v:boolean)=>void; leverage: number; setLeverage: (n:number)=>void; marginEth: string; setMarginEth: (s:string)=>void }
function OpenPosition({ perpsAddress, chainKey, compact, controlled }: { perpsAddress: string, chainKey: 'base'|'baseSepolia', compact?: boolean, controlled?: OpenControlled }) {
  const { address } = useAccount()
  const [isLongLocal, setIsLongLocal] = useState(true)
  const [leverageLocal, setLeverageLocal] = useState(10)
  const [marginEthLocal, setMarginEthLocal] = useState('0.1')
  const isLong = controlled ? controlled.isLong : isLongLocal
  const setIsLong = controlled ? controlled.setIsLong : setIsLongLocal
  const leverage = controlled ? controlled.leverage : leverageLocal
  const setLeverage = controlled ? controlled.setLeverage : setLeverageLocal
  const marginEth = controlled ? controlled.marginEth : marginEthLocal
  const setMarginEth = controlled ? controlled.setMarginEth : setMarginEthLocal
  const [localError, setLocalError] = useState<string>('')
  const { data: hash, writeContract, isPending, error } = useWriteContract()
  const { isLoading: mining } = useWaitForTransactionReceipt({ hash })

  const safeParseEther = (s: string) => {
    try {
      const normalized = (s || '0').replace(',', '.').trim()
      return parseEther(normalized)
    } catch {
      return null
    }
  }
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
  const parsedMargin = safeParseEther(marginEth)
  const { data: pos } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'positions',
    args: [address!],
    query: { enabled: Boolean(perpsAddress && address), refetchInterval: 15000 }
  }) as { data: any }
  const hasPos = Array.isArray(pos) ? Boolean(pos[0]) : false
  const simOpen = useSimulateContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'openPosition',
    args: [isLong, BigInt(leverage)] as const,
    value: parsedMargin === null ? undefined : parsedMargin,
    chainId: desiredChain.id,
    query: { enabled: Boolean(address && perpsAddress && parsedMargin !== null) }
  })

  return (
    <div className={!compact ? 'card' : ''}>
      {!compact && (
        <>
          <div className="card-header"><h3>Abrir posición</h3><span className="muted">Fee: 0.10% al abrir</span></div>
          <div className="card-body grid gap-8">
            <div className="row" style={{ gap: 8 }}>
              <button className={'btn long-btn' + (isLong ? ' active' : '')} onClick={()=>setIsLong(true)}>Long</button>
              <button className={'btn short-btn' + (!isLong ? ' active' : '')} onClick={()=>setIsLong(false)}>Short</button>
            </div>
            <div className="field">
              <label>Leverage: <strong>x{leverage}</strong></label>
              <input type="range" min={1} max={150} step={1} value={leverage} onChange={e=>setLeverage(parseInt(e.target.value||'1'))} />
            </div>
            <div className="field">
              <label>Margin (ETH)</label>
              <input className="input" value={marginEth} onChange={e=>setMarginEth(e.target.value)} />
            </div>
            {hasPos && <div className="warn">Ya tienes una posición abierta. Debes cerrarla antes de abrir otra.</div>}
          </div>
        </>
      )}
      <button className="btn primary w-full" disabled={!address || !perpsAddress || isPending || mining || hasPos} onClick={async ()=>{
        setLocalError('')
        const value = safeParseEther(marginEth)
        if (value === null) { setLocalError('Monto inválido (usa punto como separador decimal).'); return }
        try {
          if (simOpen.data?.request) {
            await writeContract(simOpen.data.request as any)
          } else {
            await writeContract({
              abi: perpsAbi as any,
              address: perpsAddress as any,
              functionName: 'openPosition',
              args: [isLong, BigInt(leverage)],
              value,
              chainId: desiredChain.id,
              gas: 500000n,
            })
          }
        } catch (e: any) {
          setLocalError(e?.shortMessage || e?.message || String(e))
        }
      }}>Abrir</button>
      {/* Mensajes de simulación en hover */}
      {simOpen.error && <HoverInfo label="Simulación falló" tip={String((simOpen.error as any)?.shortMessage || simOpen.error.message)} />}
      {localError && <HoverInfo label="Error" tip={localError} />}
      {error && <HoverInfo label="Error" tip={String(error)} />}
      {(isPending || mining) && <div className="muted mt-8">Enviando transacción...</div>}
    </div>
  )
}

function MyPosition({ perpsAddress, oracleAddress, market, chainKey }: { perpsAddress: string, oracleAddress: string, market: 'btcd'|'random'|'localaway', chainKey: 'base'|'baseSepolia' }) {
  const { address } = useAccount()
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
  const { data: pos } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'positions',
    args: [address!],
    chainId: desiredChain.id,
    query: { enabled: Boolean(perpsAddress && address), refetchInterval: 15000 }
  }) as { data: any }
  const { data: priceRaw } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    chainId: desiredChain.id,
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000 }
  })
  const { data: mmBps } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'maintenanceMarginRatioBps',
    chainId: desiredChain.id,
    query: { enabled: Boolean(perpsAddress) }
  })

  if (!address) return <div className="muted">Conecta tu wallet.</div>
  if (!perpsAddress) return <div className="muted">Configura la dirección de Perps.</div>
  if (!pos) return <div className="muted">Cargando…</div>

  const [isOpen, isLong, leverage, margin, entryPrice] = pos as [boolean, boolean, bigint, bigint, bigint]
  if (!isOpen) return <div className="muted">No tienes una posición abierta.</div>

  const price = typeof priceRaw === 'bigint' ? priceRaw : 0n
  const notional = margin * leverage
  let pnl: bigint = 0n
  if (entryPrice && price) {
    if (isLong) {
      pnl = notional * (price - entryPrice) / entryPrice
    } else {
      pnl = notional * (entryPrice - price) / entryPrice
    }
  }
  const equity = (margin as bigint) + pnl
  const mmRatio = typeof mmBps === 'bigint' ? Number(mmBps) : 625
  const maintenance = (notional * BigInt(mmRatio)) / 10000n

  const pctIndex = Number(formatUnits(price, 8))
  const entryPct = Number(formatUnits(entryPrice, 8))
  const pnlEth = Number(formatEther(pnl < 0n ? -pnl : pnl)) * (pnl < 0n ? -1 : 1)
  const marginEth = Number(formatEther(margin))
  const equityEth = Number(formatEther(equity < 0n ? 0n : equity))
  const notionalEth = Number(formatEther(notional))
  const maintenanceEth = Number(formatEther(maintenance))

  const roi = marginEth > 0 ? (pnlEth / marginEth) * 100 : 0

  return (
    <div className="stats-grid">
      <div className="stat"><span className="stat-label">Lado</span><span className={isLong ? 'badge long':'badge short'}>{isLong ? 'Long' : 'Short'}</span></div>
      <div className="stat"><span className="stat-label">Leverage</span><span className="stat-value">x{String(leverage)}</span></div>
  <div className="stat"><span className="stat-label">Entrada</span><span className="stat-value">{entryPct.toFixed(4)}{market==='btcd' ? '%' : ''}</span></div>
  <div className="stat"><span className="stat-label">Precio</span><span className="stat-value">{pctIndex.toFixed(4)}{market==='btcd' ? '%' : ''}</span></div>
      <div className="stat"><span className="stat-label">Margen</span><span className="stat-value">{marginEth.toFixed(6)} ETH</span></div>
      <div className="stat"><span className="stat-label">Notional</span><span className="stat-value">{notionalEth.toFixed(6)} ETH</span></div>
      <div className="stat"><span className="stat-label">MM Ratio</span><span className="stat-value">{mmRatio/100}%</span></div>
      <div className="stat"><span className="stat-label">Mantenimiento</span><span className="stat-value">{maintenanceEth.toFixed(6)} ETH</span></div>
      <div className="stat span-2"><span className="stat-label">PnL</span><span className={pnlEth >= 0 ? 'pnl up':'pnl down'}>{pnlEth.toFixed(6)} ETH ({roi.toFixed(2)}%)</span></div>
      <div className="stat span-2"><span className="stat-label">Equity</span><span className="stat-value">{equityEth.toFixed(6)} ETH</span></div>
    </div>
  )
}

function ClosePosition({ perpsAddress, oracleAddress, chainKey, minimal }: { perpsAddress: string, oracleAddress: string, chainKey: 'base'|'baseSepolia', minimal?: boolean }) {
  const { data: hash, writeContract, isPending, error } = useWriteContract()
  const { isLoading: mining } = useWaitForTransactionReceipt({ hash })
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
  const { address } = useAccount()
  const { data: pos } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'positions',
    args: [address!],
    query: { enabled: Boolean(perpsAddress && address), refetchInterval: 15000 }
  }) as { data: any }
  const hasPos = Array.isArray(pos) ? Boolean(pos[0]) : false
  const [ , isLong, leverage, margin, entryPrice] = (pos || []) as [boolean, boolean, bigint, bigint, bigint]
  const { data: currPrice } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000 }
  })
  const { data: feeBpsRaw } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'takerFeeBps',
    query: { enabled: Boolean(perpsAddress) }
  })
  const takerFeeBps = typeof feeBpsRaw === 'bigint' ? feeBpsRaw : 10n
  // Estimar payout necesario (margin + max(pnl,0) - fee)
  let payoutEst: bigint | null = null
  try {
    if (hasPos && typeof currPrice === 'bigint' && entryPrice && margin && leverage) {
      const notional = margin * leverage
      const fee = (notional * takerFeeBps) / 10000n
      const price = currPrice as bigint
      const pnl = isLong
        ? (notional * (price - entryPrice)) / entryPrice
        : (notional * (entryPrice - price)) / entryPrice
      const settle = (margin as bigint) + pnl - (fee as bigint)
      payoutEst = settle > 0n ? settle : 0n
    }
  } catch {}
  const { data: treasury } = useBalance({ address: (perpsAddress || undefined) as any, chainId: desiredChain.id, query: { enabled: Boolean(perpsAddress) } })
  const treasuryWei = BigInt(treasury?.value || 0n)
  const insufficientTreasury = hasPos && payoutEst !== null && treasuryWei < (payoutEst as bigint)
  const simClose = useSimulateContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'closePosition',
    args: [],
    chainId: desiredChain.id,
    query: { enabled: Boolean(perpsAddress) }
  })
  return (
    <div className={minimal ? '' : 'card'}>
      {!minimal && (
        <div className="card-header"><h3>Cerrar posición</h3><span className="muted">Fee: 0.10% al cerrar</span></div>
      )}
      {!minimal && insufficientTreasury && <div className="error">El contrato no tiene saldo suficiente para pagarte el cierre estimado. Fondea en Config o espera a que el PnL sea menor.</div>}
      {!minimal && !hasPos && <div className="warn">No tienes una posición abierta para cerrar.</div>}
      <button className="btn danger w-full" disabled={!perpsAddress || isPending || mining || !hasPos || insufficientTreasury} onClick={async ()=>{
        try {
          if (simClose.data?.request) {
            await writeContract(simClose.data.request as any)
          } else {
            await writeContract({
              abi: perpsAbi as any,
              address: perpsAddress as any,
              functionName: 'closePosition',
              args: [],
              chainId: desiredChain.id,
              gas: 300000n,
            })
          }
        } catch {}
      }}>Cerrar</button>
      {/* Ocultamos mensajes debajo de Cerrar para no ensuciar la UI */}
      {(isPending || mining) && <div className="muted mt-8">Enviando transacción...</div>}
    </div>
  )
}

function StopsManager({ perpsAddress, chainKey, market, compact }: { perpsAddress: string, chainKey: 'base'|'baseSepolia', market: 'btcd'|'random'|'localaway', compact?: boolean }) {
  const { address } = useAccount()
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
  const { data: pos } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'positions',
    args: [address!],
    query: { enabled: Boolean(perpsAddress && address), refetchInterval: 15000 }
  }) as { data: any }
  const { data: stops } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'getStops',
    args: [address!],
    query: { enabled: Boolean(perpsAddress && address), refetchInterval: 15000 }
  }) as { data: any }
  const { data: trig } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'shouldClose',
    args: [address!],
    query: { enabled: Boolean(perpsAddress && address), refetchInterval: 15000 }
  })
  const [mode, setMode] = useState<'absolute'|'relative'>('absolute')
  const [slInput, setSlInput] = useState('')
  const [tpInput, setTpInput] = useState('')
  const { data: hash, writeContract, isPending, error } = useWriteContract()
  const { isLoading: mining } = useWaitForTransactionReceipt({ hash })
  // Per-market validation and scaling
  const toScaledAbs = (v: number) => {
    if (isNaN(v)) return null
    if (market === 'btcd') {
      // BTC.D is a percentage index [0,100]
      if (v < 0 || v > 100) return null
    } else {
      // Random/LocalAway are arbitrary positive indexes (>0). Allow large values.
      if (v <= 0) return null
    }
    return BigInt(Math.round(v * 1e8))
  }
  const entryVal = (() => {
    try { return pos ? Number(formatUnits((pos as any)[4] || 0n, 8)) : undefined } catch { return undefined }
  })()
  const hasPos = Array.isArray(pos) ? Boolean((pos as any)[0]) : false
  // Limpiar inputs cuando no hay posición
  useEffect(() => {
    if (!hasPos) { setSlInput(''); setTpInput('') }
  }, [hasPos])
  const computeAbs = (raw: string, isSL: boolean): number | null => {
    const parsed = parseFloat((raw||'').replace(',','.'))
    if (isNaN(parsed)) return null
    if (mode === 'absolute') {
      return parsed
    } else {
      // relative delta from entry (can be negative or positive)
      if (entryVal === undefined) return null
      const abs = entryVal + parsed
      return abs
    }
  }
  // Read current stops to preserve the other value when setting just one
  const [stopLoss, takeProfit] = (stops || []) as [bigint, bigint]

  const onSetSL = async () => {
    const slAbs = slInput ? computeAbs(slInput, true) : 0
    if (slAbs === null) return
    const sl = slAbs ? toScaledAbs(slAbs) : 0n
    if (sl === null) return
    const tpKeep = (typeof takeProfit === 'bigint') ? takeProfit : 0n
    try {
      await writeContract({
        abi: perpsAbi as any,
        address: perpsAddress as any,
        functionName: 'setStops',
        args: [sl as any, tpKeep as any],
        chainId: desiredChain.id,
      })
    } catch (e:any) {
      await writeContract({
        abi: perpsAbi as any,
        address: perpsAddress as any,
        functionName: 'setStops',
        args: [sl as any, tpKeep as any],
        chainId: desiredChain.id,
        gas: 200000n,
      })
    }
  }

  const onSetTP = async () => {
    const tpAbs = tpInput ? computeAbs(tpInput, false) : 0
    if (tpAbs === null) return
    const tp = tpAbs ? toScaledAbs(tpAbs) : 0n
    if (tp === null) return
    const slKeep = (typeof stopLoss === 'bigint') ? stopLoss : 0n
    try {
      await writeContract({
        abi: perpsAbi as any,
        address: perpsAddress as any,
        functionName: 'setStops',
        args: [slKeep as any, tp as any],
        chainId: desiredChain.id,
      })
    } catch (e:any) {
      await writeContract({
        abi: perpsAbi as any,
        address: perpsAddress as any,
        functionName: 'setStops',
        args: [slKeep as any, tp as any],
        chainId: desiredChain.id,
        gas: 200000n,
      })
    }
  }
  const onCloseNow = async () => {
    await writeContract({
      abi: perpsAbi as any,
      address: perpsAddress as any,
      functionName: 'closeIfTriggered',
      args: [address!],
      chainId: desiredChain.id,
      gas: 350000n,
    })
  }
  const trigArr = (trig || []) as [boolean, boolean, boolean]
  const slPreview = slInput ? computeAbs(slInput, true) : null
  const tpPreview = tpInput ? computeAbs(tpInput, false) : null
  const inner = (
    <div className="grid gap-8">
      {/* Encabezado y valores actuales arriba de inputs */}
      <div style={{ fontWeight: 700, fontSize: 14 }}>Stops (SL / TP)</div>
      <div className="muted small">SL actual: {stopLoss ? (market==='btcd' ? (Number(stopLoss)/1e8).toFixed(4)+'%' : (Number(stopLoss)/1e8).toFixed(4)) : '—'} | TP actual: {takeProfit ? (market==='btcd' ? (Number(takeProfit)/1e8).toFixed(4)+'%' : (Number(takeProfit)/1e8).toFixed(4)) : '—'}</div>
      <div className="segmented">
        <button className={mode==='absolute' ? 'seg active':'seg'} onClick={()=>setMode('absolute')}>{market==='btcd' ? 'Absoluto (%)' : 'Absoluto (índice)'}</button>
        <button className={mode==='relative' ? 'seg active':'seg'} onClick={()=>setMode('relative')}>{market==='btcd' ? 'Relativo (Δ%)' : 'Relativo (Δ índice)'}</button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div className="grid gap-6">
          <input className="input" placeholder={mode==='absolute' ? (market==='btcd' ? 'SL % (ej 60.10)' : 'SL abs (ej 995.5)') : (market==='btcd' ? 'SL Δ% (ej -1.0)' : 'SL Δ (ej -5)')} value={slInput} onChange={e=>setSlInput(e.target.value)} />
          {(() => {
            const slAbsV = slInput ? computeAbs(slInput, true) : 0
            const slOk = slAbsV === 0 || (slAbsV !== null && toScaledAbs(slAbsV) !== null)
            const disabled = !perpsAddress || isPending || mining || !slOk || !hasPos
            return <button className="btn" disabled={disabled} onClick={onSetSL}>Setear SL</button>
          })()}
        </div>
        <div className="grid gap-6">
          <input className="input" placeholder={mode==='absolute' ? (market==='btcd' ? 'TP % (ej 61.20)' : 'TP abs (ej 1002.0)') : (market==='btcd' ? 'TP Δ% (ej +1.5)' : 'TP Δ (ej +8)')} value={tpInput} onChange={e=>setTpInput(e.target.value)} />
          {(() => {
            const tpAbsV = tpInput ? computeAbs(tpInput, false) : 0
            const tpOk = tpAbsV === 0 || (tpAbsV !== null && toScaledAbs(tpAbsV) !== null)
            const disabled = !perpsAddress || isPending || mining || !tpOk || !hasPos
            return <button className="btn" disabled={disabled} onClick={onSetTP}>Setear TP</button>
          })()}
        </div>
      </div>
      <div className="muted small">
        {mode==='relative' ? (
          <>
            {entryVal !== undefined ? (market==='btcd'
              ? `Previews → SL: ${slPreview!==null ? slPreview.toFixed(4)+'%' : '—'} | TP: ${tpPreview!==null ? tpPreview.toFixed(4)+'%' : '—'}`
              : `Previews → SL: ${slPreview!==null ? slPreview.toFixed(4) : '—'} | TP: ${tpPreview!==null ? tpPreview.toFixed(4) : '—'}`)
              : 'Abre una posición para usar relativo'}
          </>
        ) : (
          <>
            {market==='btcd' ? 'Usa valores absolutos del índice BTC.D (0–100%), p.ej. 60.10' : 'Usa valores absolutos del índice (>0)'}
          </>
        )}
      </div>
      {/* Button removed visually to save space: 'Cerrar por stop ahora' */}
      {error && <HoverInfo label="Error" tip={String(error)} />}
      {(isPending || mining) && <div className="muted">Enviando transacción...</div>}
    </div>
  )
  if (compact) return inner
  return (
    <div className="card">
      <div className="card-header"><h3>Stops (SL / TP)</h3></div>
      <div className="card-body">{inner}</div>
    </div>
  )
}

function LiquidateSelf({ perpsAddress, chainKey }: { perpsAddress: string, chainKey: 'base'|'baseSepolia' }) {
  const { address } = useAccount()
  const { data: hash, writeContract, isPending, error } = useWriteContract()
  const { isLoading: mining } = useWaitForTransactionReceipt({ hash })
  const { data: canLiq } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'canLiquidate',
    args: [address!],
    query: { enabled: Boolean(perpsAddress && address) }
  })
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
  const simLiq = useSimulateContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'liquidate',
    args: [address!] as const,
    chainId: desiredChain.id,
    query: { enabled: Boolean(perpsAddress && address) }
  })
  return (
    <div>
      <div className="muted mb-8">¿Puede liquidarse? {String(canLiq)}</div>
      <button className="btn danger w-full" disabled={!perpsAddress || !address || isPending || mining || !canLiq} onClick={async ()=>{
        try {
          if (simLiq.data?.request) {
            await writeContract(simLiq.data.request as any)
          } else {
            await writeContract({
              abi: perpsAbi as any,
              address: perpsAddress as any,
              functionName: 'liquidate',
              args: [address!],
              chainId: desiredChain.id,
              gas: 400000n,
            })
          }
        } catch {}
      }}>Liquidar mi posición</button>
      {simLiq.error && <div className="error">Simulación falló: {String((simLiq.error as any)?.shortMessage || simLiq.error.message)}</div>}
      {error && <div className="error">{String(error)}</div>}
      {(isPending || mining) && <div className="muted">Enviando transacción...</div>}
    </div>
  )
}

function OraclePrice({ oracleAddress, market, chainKey }: { oracleAddress: string, market: 'btcd'|'random'|'localaway', chainKey: 'base'|'baseSepolia' }) {
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
  const { data } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    chainId: desiredChain.id,
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000 }
  })
  const pct = typeof data === 'bigint' ? Number(formatUnits(data, 8)) : undefined
  if (market === 'btcd') {
    return <div className="muted">BTC Dominance: {pct !== undefined ? `${pct.toFixed(2)}%` : '—'}</div>
  }
  return <div className="muted">{market==='random' ? 'Random Index' : 'Home/Away Index'}: {pct !== undefined ? `${pct.toFixed(2)}` : '—'}</div>
}

export default function App() {
  // Tiny hash router: #btcd (default) or #random
  const [route, setRoute] = useState<'btcd' | 'random' | 'localaway'>(() => {
    const h = (typeof window !== 'undefined' ? window.location.hash : '') || ''
    const hv = h.replace('#', '')
    return hv === 'random' ? 'random' : (hv === 'localaway' ? 'localaway' : 'btcd')
  })
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash || ''
      const hv = h.replace('#', '')
      setRoute(hv === 'random' ? 'random' : (hv === 'localaway' ? 'localaway' : 'btcd'))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return (
    <ErrorBoundary>
      <AppInner routeMarket={route} />
    </ErrorBoundary>
  )
}

function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const [err, setErr] = useState<Error | null>(null)
  // very small boundary to surface runtime errors
  if (err) return <div className="error" style={{ padding: 12 }}>Error: {err.message}</div>
  try {
    return <>{children}</>
  } catch (e: any) {
    setErr(e)
    return null
  }
}

// NetworkHelper removed: the page now follows the wallet network directly via ConnectButton's switch

function ContractTreasury({ perpsAddress, desired }: { perpsAddress: string, desired: 'base'|'baseSepolia' }) {
  const chain = desired === 'baseSepolia' ? baseSepolia : base
  const { data: bal } = useBalance({ address: (perpsAddress || undefined) as any, chainId: chain.id, query: { enabled: Boolean(perpsAddress) } })
  const [amt, setAmt] = useState('0.1')
  const { sendTransactionAsync, isPending, error } = useSendTransaction()
  const [localErr, setLocalErr] = useState<string>('')
  const onFund = async () => {
    try {
      setLocalErr('')
      const val = parseEther((amt || '0').replace(',', '.'))
      const isAddr = /^0x[0-9a-fA-F]{40}$/.test(perpsAddress)
      if (!isAddr) { setLocalErr('Dirección de contrato inválida.'); return }
      try {
        await sendTransactionAsync?.({ chainId: chain.id, to: perpsAddress as any, value: val })
      } catch (e: any) {
        // Reintento con gas fijo por si la estimación falló
        try {
          await sendTransactionAsync?.({ chainId: chain.id, to: perpsAddress as any, value: val, gas: 60000n })
        } catch (e2: any) {
          setLocalErr(e2?.shortMessage || e2?.message || String(e2))
        }
      }
    } catch (e:any) {
      setLocalErr(e?.shortMessage || e?.message || String(e))
    }
  }
  return (
    <div className="card">
      <div className="card-header"><h3>Treasury</h3></div>
      <div className="card-body grid gap-8">
        <div><strong>Saldo:</strong> {bal ? `${Number(formatEther(bal.value)).toFixed(6)} ETH` : '—'}</div>
        <div className="row">
          <input className="input" placeholder="0.1" value={amt} onChange={e=>setAmt(e.target.value)} />
          <button className="btn" onClick={onFund} disabled={!perpsAddress || isPending || !amt.trim()} style={{ marginLeft: 8 }}>Depositar al tesoro</button>
        </div>
        {localErr && <div className="error">{localErr}</div>}
        {error && <div className="error">{String(error)}</div>}
      </div>
    </div>
  )
}

// Combined, pro-looking panels
function TradePanel({ perpsAddress, oracleAddress, chainKey, market }: { perpsAddress: string, oracleAddress: string, chainKey: 'base'|'baseSepolia', market: 'btcd'|'random'|'localaway' }) {
  const [isLong, setIsLong] = useState(true)
  const [leverage, setLeverage] = useState(10)
  const [marginEth, setMarginEth] = useState('0.1')
  return (
    <div className="card">
      <div className="card-body grid gap-12">
        <div>
          <div className="muted small">{market==='btcd' ? 'Precio BTC.D (oráculo)' : (market==='random' ? 'Precio Random (oráculo)' : 'Home/Away Index (oráculo)')}</div>
          <OraclePrice oracleAddress={oracleAddress} market={market} chainKey={chainKey} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className={'btn long-btn' + (isLong ? ' active' : '')} onClick={()=>setIsLong(true)}>Long</button>
          <button className={'btn short-btn' + (!isLong ? ' active' : '')} onClick={()=>setIsLong(false)}>Short</button>
        </div>
        <div className="field">
          <label>Leverage: <strong>x{leverage}</strong></label>
          <input type="range" min={1} max={150} step={1} value={leverage} onChange={e=>setLeverage(parseInt(e.target.value||'1'))} />
        </div>
        <div className="field">
          <label>Margin (ETH)</label>
          <input className="input" value={marginEth} onChange={e=>setMarginEth(e.target.value)} />
        </div>
        <div className="row">
          <OpenPosition perpsAddress={perpsAddress} chainKey={chainKey} compact controlled={{ isLong, setIsLong, leverage, setLeverage, marginEth, setMarginEth }} />
          <div style={{ width: 8 }} />
          <ClosePosition perpsAddress={perpsAddress} oracleAddress={oracleAddress} chainKey={chainKey} minimal />
        </div>
        <div className="muted small">Fees: 0.10% al abrir y 0.10% al cerrar</div>
      </div>
    </div>
  )
}

function PositionCard({ perpsAddress, oracleAddress, market, chainKey }: { perpsAddress: string, oracleAddress: string, market: 'btcd'|'random'|'localaway', chainKey: 'base'|'baseSepolia' }) {
  return (
    <div className="card">
      <div className="card-header"><h3>Mi posición</h3></div>
      <div className="card-body grid gap-12">
        <MyPosition perpsAddress={perpsAddress} oracleAddress={oracleAddress} market={market} chainKey={chainKey} />
        {/* Mover Stops (SL/TP) aquí para agrupar con Mi posición */}
        <div>
          <StopsManager perpsAddress={perpsAddress} chainKey={chainKey} market={market} compact />
        </div>
      </div>
    </div>
  )
}

function OracleCard({ oracleAddress }: { oracleAddress: string }) {
  return null
}

function LiquidationCard({ perpsAddress, chainKey }: { perpsAddress: string, chainKey: 'base'|'baseSepolia' }) {
  return (
    <div className="card">
      <div className="card-header"><h3>Liquidación</h3></div>
      <div className="card-body">
        <LiquidateSelf perpsAddress={perpsAddress} chainKey={chainKey} />
      </div>
    </div>
  )
}

function StopsCard({ perpsAddress, chainKey, market }: { perpsAddress: string, chainKey: 'base'|'baseSepolia', market: 'btcd'|'random'|'localaway' }) {
  return <StopsManager perpsAddress={perpsAddress} chainKey={chainKey} market={market} />
}

function ConfigCard({ oracleAddress, perpsAddress }: { oracleAddress: string, perpsAddress: string }) {
  return (
    <div className="card">
      <div className="card-header"><h3>Contracts</h3></div>
      <div className="card-body grid gap-8">
        <div className="field">
          <label>Oracle</label>
          <div className="code-row"><span className="mono small">{oracleAddress || '—'}</span><CopyBtn text={oracleAddress} /></div>
        </div>
        <div className="field">
          <label>Perps</label>
          <div className="code-row"><span className="mono small">{perpsAddress || '—'}</span><CopyBtn text={perpsAddress} /></div>
        </div>
      </div>
    </div>
  )
}

function TreasuryCard({ perpsAddress, desired }: { perpsAddress: string, desired: 'base'|'baseSepolia' }) {
  return <ContractTreasury perpsAddress={perpsAddress} desired={desired} />
}

function HoverInfo({ label, tip }: { label: string, tip: string }) {
  if (!tip) return null
  return (
    <span className="muted small" title={tip} style={{ marginLeft: 8, cursor: 'help', display: 'inline-block' }}>ⓘ {label}</span>
  )
}

function CopyBtn({ text }: { text: string }) {
  return <button className="btn sm" onClick={()=>navigator.clipboard?.writeText(text || '')}>Copiar</button>
}

function GoalsCard({ chainKey }: { chainKey: 'base'|'baseSepolia' }) {
  const [events, setEvents] = useState<Array<{ time:number, value:number, meta:any }>>([])
  const [loading, setLoading] = useState(false)
  const chain = chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'
  const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
  const limit = 100
  const url = `${baseUrl}/api/events?chain=${chain}&market=localaway&limit=${limit}`
  const lsKey = `btcd:events:${chain}:localaway`
  useEffect(() => {
    let cancel = false
    const load = async () => {
      try {
        setLoading(true)
        // Bootstrap from localStorage: never show an empty recent-events menu
        try {
          const raw = localStorage.getItem(lsKey)
          if (raw && !cancel) {
            const arr = JSON.parse(raw)
            if (Array.isArray(arr) && arr.length) {
              setEvents(arr)
            }
          }
        } catch {}
        const res = await fetch(url, { cache: 'no-store' })
        if (res.ok) {
          const j = await res.json()
          const evs = Array.isArray(j.events) ? j.events : []
          if (!cancel) {
            if (evs.length) {
              // Merge with existing, de-dup by stable meta.id or derived key
              const map = new Map<string, any>()
              const keyOf = (e:any) => String(e?.meta?.id || `${e?.meta?.sport||'na'}:${e?.meta?.fixtureId||e?.meta?.leagueId||'na'}:${e?.time||0}:${e?.meta?.delta?.home||0}:${e?.meta?.delta?.away||0}`)
              for (const e of events) map.set(keyOf(e), e)
              for (const e of evs) map.set(keyOf(e), e)
              const merged = Array.from(map.values()).sort((a:any,b:any)=> (b?.time||0) - (a?.time||0)).slice(0, 200)
              setEvents(merged)
              try { localStorage.setItem(lsKey, JSON.stringify(merged)) } catch {}
            } else {
              // Keep displaying whatever we already had (from cache or earlier fetch)
            }
          }
          // Fallback: if empty, try alternate chain key once
          if (!cancel && (!evs || evs.length === 0)) {
            const alt = chain === 'base-sepolia' ? 'base' : 'base-sepolia'
            try {
              const res2 = await fetch(`${baseUrl}/api/events?chain=${alt}&market=localaway&limit=${limit}`, { cache: 'no-store' })
              if (res2.ok) {
                const j2 = await res2.json()
                const evs2 = Array.isArray(j2.events) ? j2.events : []
                if (!cancel && evs2.length) {
                  const map = new Map<string, any>()
                  const keyOf = (e:any) => String(e?.meta?.id || `${e?.meta?.sport||'na'}:${e?.meta?.fixtureId||e?.meta?.leagueId||'na'}:${e?.time||0}:${e?.meta?.delta?.home||0}:${e?.meta?.delta?.away||0}`)
                  for (const e of events) map.set(keyOf(e), e)
                  for (const e of evs2) map.set(keyOf(e), e)
                  const merged = Array.from(map.values()).sort((a:any,b:any)=> (b?.time||0) - (a?.time||0)).slice(0, 200)
                  setEvents(merged)
                  try { localStorage.setItem(lsKey, JSON.stringify(merged)) } catch {}
                }
              }
            } catch {}
          }
        }
      } catch {}
      setLoading(false)
    }
    load()
    const t = window.setInterval(load, 60000)
    return () => { cancel = true; window.clearInterval(t) }
  }, [url])
  // Use shared sportEmoji helper for consistent mapping
  return (
    <div className="card">
      <div className="card-header"><h3>Eventos (recientes)</h3></div>
      <div className="card-body">
        {!events.length && !loading ? (
          <div className="muted">No hay eventos recientes.</div>
        ) : (
          <div className="list">
            {events.map((e, idx) => {
              const dt = new Date((e.time||0)*1000).toLocaleString()
              const lg = e.meta?.league || '—'
              const home = e.meta?.home?.name || 'Home'
              const away = e.meta?.away?.name || 'Away'
              const scHome = e.meta?.score?.home ?? '?'
              const scAway = e.meta?.score?.away ?? '?'
              const sport = String(e.meta?.sport || (String(e.meta?.type||'').toLowerCase()==='goal' ? 'football' : ''))
              const emoji = (e.meta?.emoji && String(e.meta?.emoji).length>0) ? e.meta.emoji : sportEmoji(sport)
              const type = String(e.meta?.type || '')
              const dH = Number(e.meta?.delta?.home ?? 0) || 0
              const dA = Number(e.meta?.delta?.away ?? 0) || 0
              const pct = typeof e.meta?.deltaPct === 'number' ? e.meta.deltaPct : (Number(e.meta?.deltaPct) || 0)
              const pctStr = pct ? `${(pct*100).toFixed(3)}%` : ''
              // label side only for football goal-type
              const side = type === 'goal' ? (e.meta?.side === 'home' ? 'local' : (e.meta?.side === 'away' ? 'visitante' : '')) : ''
              return (
                <div key={idx} className="row" style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 0', borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
                  <div className="mono small" style={{ width: 162, opacity:0.8 }}>{dt}</div>
                  <div style={{ width: 24, textAlign:'center' }}>{emoji}</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, opacity:0.85 }}><strong>{lg}</strong> <span className="muted small" style={{ marginLeft:6 }}>{sport || ''}</span></div>
                    <div style={{ fontSize:14, display:'flex', gap:8, alignItems:'baseline' }}>
                      <div>{home} <strong>{scHome}-{scAway}</strong> {away}</div>
                      {side && <span className="badge" style={{ marginLeft:6 }}>{side}</span>}
                      {(dH || dA) ? (
                        <span className="muted small">ΔH:{dH} ΔA:{dA}{pctStr ? ` (${pctStr})` : ''}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function RandomCard({ chainKey, oracleAddress }: { chainKey: 'base'|'baseSepolia', oracleAddress: string }) {
  const [items, setItems] = useState<Array<{ time:number, value:number }>>([])
  const [loading, setLoading] = useState(false)
  const chain = chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'
  const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
  const url = `${baseUrl}/api/events?chain=${chain}&market=random&limit=30&oracle=${encodeURIComponent(oracleAddress||'')}`
  useEffect(() => {
    let cancel = false
    const load = async () => {
      try {
        setLoading(true)
        const res = await fetch(url, { cache: 'no-store' })
        if (res.ok) {
          const j = await res.json()
          const evs = Array.isArray(j.events) ? j.events : []
          // Normalize to time/value only, newest-first
          const rows = evs.map((e:any)=> ({ time: Number(e?.time)||0, value: Number(e?.value) }))
            .filter((r: { time:number, value:number })=> Number.isFinite(r.time) && Number.isFinite(r.value))
            .sort((a: { time:number }, b: { time:number })=> b.time - a.time)
          if (!cancel) setItems(rows)
          // Fallback to on-chain logs if empty or missing
          if (!cancel && (!rows || rows.length === 0) && oracleAddress) {
            try {
              const desired = (chainKey === 'baseSepolia' ? baseSepolia : base)
              const client = createPublicClient({ chain: desired as any, transport: viemHttp() })
              const latest = await client.getBlockNumber()
              // scan ~20k blocks back (tweakable)
              const from = latest > 20000n ? (latest - 20000n) : 0n
              const logs = await client.getLogs({
                address: oracleAddress as any,
                events: [{
                  type: 'event',
                  name: 'PriceUpdated',
                  inputs: [
                    { name: 'price', type: 'int256', indexed: false },
                    { name: 'timestamp', type: 'uint256', indexed: false },
                  ],
                  anonymous: false,
                }] as any,
                fromBlock: from,
                toBlock: latest,
              }) as any[]
              const mapped = logs.map((l:any)=>{
                const args = l?.args || {}
                const raw = typeof args?.price === 'bigint' ? args.price : BigInt(args?.price || 0)
                const ts = Number(args?.timestamp || 0)
                const dec = Number(formatUnits(raw, 8))
                return { time: ts, value: dec, _raw: raw }
              }).filter((r:any)=> Number.isFinite(r.time) && Number.isFinite(r.value))
                .sort((a:any,b:any)=> b.time - a.time)
              if (!cancel && mapped.length) setItems(mapped)
            } catch {}
          }
        }
      } catch {}
      setLoading(false)
    }
    load()
    const t = window.setInterval(load, 60000)
    return () => { cancel = true; window.clearInterval(t) }
  }, [url])
  return (
    <div className="card">
      <div className="card-header"><h3>Números aleatorios (recientes)</h3></div>
      <div className="card-body">
        {!items.length && !loading ? (
          <div className="muted">No hay números recientes.</div>
        ) : (
          <div className="list">
            {items.map((r, idx)=>{
              // Compute step in bps versus the immediately older value (same data as chart)
              const prev = items[idx+1]?.value
              const stepBps = (typeof prev === 'number' && prev > 0)
                ? Math.round(((r.value - prev) / prev) * 10000)
                : null
              const sign = stepBps !== null ? (stepBps > 0 ? `+${stepBps}` : `${stepBps}`) : '—'
              const rounded = Math.round(r.value)
              return (
                <div key={idx} className="row" style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 0', borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
                  {/* No date, no label; show the number itself with step bps */}
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, display:'flex', alignItems:'baseline', gap:8 }}>
                      <strong>{r.value.toFixed(4)}</strong>
                      <span className={stepBps !== null ? (stepBps >= 0 ? 'pnl up small' : 'pnl down small') : 'muted small'}>
                        ({sign} bps)
                      </span>
                      <span className="muted small">≈ {rounded}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
