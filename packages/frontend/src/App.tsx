import { useEffect, useMemo, useState, useRef } from 'react'
import { http, WagmiProvider } from 'wagmi'
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

function DominanceChart({ oracleAddress, chainKey }: { oracleAddress: string, chainKey: 'base'|'baseSepolia' }) {
  const [tf, setTf] = useState<'5m'|'15m'|'1h'|'4h'|'1d'|'3d'|'1w'>('15m')
  const [candles, setCandles] = useState<Candle[]>([])
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const containerId = 'chart_container'

  // Build history from on-chain events and then poll live values
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base

  // Fetch pre-aggregated candle JSON; bootstrap from localStorage and refresh periodically
  useEffect(() => {
    let cancelled = false
    const key = chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'
    const lsKey = `btcd:candles:${key}:${tf}`
  // Use serverless API endpoint backed by DB
  const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
  const url = `${baseUrl}/api/candles?chain=${key}&tf=${tf}`
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
              if (!cancelled) setCandles(cs)
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
            if (!cancelled) setCandles(cs)
            try { localStorage.setItem(lsKey, JSON.stringify(cs)) } catch {}
          }
        }
      } catch (e) {
        console.warn('load candles failed', e)
      }
    }
    load()
    return () => { cancelled = true }
  }, [chainKey, tf])

  // Poll latestAnswer/latestTimestamp to append live points
  const { data: latestAns } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000, refetchIntervalInBackground: true }
  })
  const { data: latestTs } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestTimestamp',
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000, refetchIntervalInBackground: true }
  })
  useEffect(() => {
    if (typeof latestAns === 'bigint' && typeof latestTs === 'bigint') {
      const v = Number(formatUnits(latestAns, 8))
      const ts = Number(latestTs) as UTCTimestamp
      // Update only the last candle's close/high/low based on live price; we don't append a new candle here
      setCandles(prev => {
        if (!prev.length) return prev
        const bucketSec = tf === '5m' ? 300 : tf === '15m' ? 900 : tf === '1h' ? 3600 : tf === '4h' ? 14400 : tf === '1d' ? 86400 : tf === '3d' ? 259200 : 604800
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
          try { const key = (chainKey === 'baseSepolia' ? 'base-sepolia' : 'base'); localStorage.setItem(`btcd:candles:${key}:${tf}`, JSON.stringify(updated)) } catch {}
          return updated
        }
        // If we rolled into a new bucket, do nothing; cron history will backfill shortly
        return updated
      })
    }
  }, [latestAns, latestTs])

  // Initialize chart once
  useEffect(() => {
    const el = document.getElementById(containerId) as HTMLDivElement | null
    if (!el) return
    const chart = createChart(el, {
      width: el.clientWidth,
      height: 480,
      layout: { background: { type: ColorType.Solid, color: '#0b1221' }, textColor: '#DDD' },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    })
    chartRef.current = chart as any
    const series = chart.addCandlestickSeries({ upColor: '#16a34a', downColor: '#ef4444', borderVisible: false, wickUpColor: '#16a34a', wickDownColor: '#ef4444' })
    seriesRef.current = series as any
    const onResize = () => chart.applyOptions({ width: el.clientWidth })
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  // Removed legacy static history refresh (now using API candles exclusively)

  // Update series with pre-aggregated candles
  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(candles as any)
  }, [candles])

  return (
    <div className="card">
      <div className="card-header">
        <div className="tabs">
          {(['5m','15m','1h','4h','1d','3d','1w'] as const).map(k => (
            <button key={k} onClick={()=>setTf(k)} className={tf===k? 'tab active':'tab'}>{k}</button>
          ))}
        </div>
      </div>
      <div className="card-body p0">
        <div id={containerId} className="chart" />
      </div>
    </div>
  )
}

// Aggregation removed from client; candles served from pre-aggregated JSON

const queryClient = new QueryClient()

function AppInner() {
  const [chain, setChain] = useState<'base'|'baseSepolia'>('baseSepolia')
  const config = useMemo(() => getDefaultConfig({
    appName: 'BTCD Perps',
    projectId: 'btcd-temp',
    chains: [base, baseSepolia],
    transports: {
      [base.id]: http(),
      [baseSepolia.id]: http(),
    }
  }), [])

  // addresses from deployed mapping (read-only in UI)
  const [oracleAddress, setOracleAddress] = useState<string>('')
  const [perpsAddress, setPerpsAddress] = useState<string>('')

  useEffect(() => {
    const key = chain
    if ((deployed as any)?.[key]?.oracle) setOracleAddress((deployed as any)[key].oracle)
    if ((deployed as any)?.[key]?.perps) setPerpsAddress((deployed as any)[key].perps)
  }, [chain])

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
      <RainbowKitProvider>
        <div className="container">
          <header className="header">
            <div className="header-left">
              <div className="brand">BTC Dominance Perps</div>
              <div className="network-switcher">
                <span className="label">Network</span>
                <div className="segmented">
                  <button className={chain==='baseSepolia'?'seg active':'seg'} onClick={()=>setChain('baseSepolia')}>Base Sepolia</button>
                  <button className={chain==='base'?'seg active':'seg'} onClick={()=>setChain('base')}>Base</button>
                </div>
              </div>
              <NetworkHelper desired={chain} />
            </div>
            <div className="header-right"><ConnectButton /></div>
          </header>

          <main className="main">
            <section className="main-top">
              <DominanceChart oracleAddress={oracleAddress} chainKey={chain} />
            </section>

            <section className="main-grid">
              <div className="col">
                <TradePanel perpsAddress={perpsAddress} oracleAddress={oracleAddress} chainKey={chain} />
                <TreasuryCard perpsAddress={perpsAddress} desired={chain} />
                <ConfigCard oracleAddress={oracleAddress} perpsAddress={perpsAddress} />
              </div>
              <div className="col">
                <PositionCard perpsAddress={perpsAddress} oracleAddress={oracleAddress} />
                <LiquidationCard perpsAddress={perpsAddress} chainKey={chain} />
              </div>
            </section>
          </main>
        </div>
      </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useSwitchChain, useChainId, useSimulateContract, useBalance, useSendTransaction } from 'wagmi'
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
            <div className="segmented">
              <button className={isLong? 'seg active':'seg'} onClick={()=>setIsLong(true)}>Long</button>
              <button className={!isLong? 'seg active':'seg'} onClick={()=>setIsLong(false)}>Short</button>
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
      {simOpen.error && <div className="error">Simulación falló: {String((simOpen.error as any)?.shortMessage || simOpen.error.message)}</div>}
      {localError && <div className="error">{localError}</div>}
      {error && <div className="error">{String(error)}</div>}
      {(isPending || mining) && <div className="muted mt-8">Enviando transacción...</div>}
    </div>
  )
}

function MyPosition({ perpsAddress, oracleAddress }: { perpsAddress: string, oracleAddress: string }) {
  const { address } = useAccount()
  const { data: pos } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'positions',
    args: [address!],
    query: { enabled: Boolean(perpsAddress && address), refetchInterval: 15000 }
  }) as { data: any }
  const { data: priceRaw } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000 }
  })
  const { data: mmBps } = useReadContract({
    abi: perpsAbi as any,
    address: (perpsAddress || undefined) as any,
    functionName: 'maintenanceMarginRatioBps',
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
      <div className="stat"><span className="stat-label">Entrada</span><span className="stat-value">{entryPct.toFixed(4)}%</span></div>
      <div className="stat"><span className="stat-label">Precio</span><span className="stat-value">{pctIndex.toFixed(4)}%</span></div>
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
      {simClose.error && <div className="error">Simulación falló: {String((simClose.error as any)?.shortMessage || simClose.error.message)}</div>}
      {error && <div className="error">{String(error)}</div>}
      {(isPending || mining) && <div className="muted mt-8">Enviando transacción...</div>}
    </div>
  )
}

function StopsManager({ perpsAddress, chainKey, compact }: { perpsAddress: string, chainKey: 'base'|'baseSepolia', compact?: boolean }) {
  const { address } = useAccount()
  const desiredChain = chainKey === 'baseSepolia' ? baseSepolia : base
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
  const [slPct, setSlPct] = useState('')
  const [tpPct, setTpPct] = useState('')
  const { data: hash, writeContract, isPending, error } = useWriteContract()
  const { isLoading: mining } = useWaitForTransactionReceipt({ hash })
  const toScaled = (s: string) => {
    const v = parseFloat((s||'').replace(',','.'))
    if (isNaN(v) || v < 0 || v > 100) return null
    return BigInt(Math.round(v * 1e8))
  }
  const onSet = async () => {
    const sl = slPct ? toScaled(slPct) : 0n
    const tp = tpPct ? toScaled(tpPct) : 0n
    if (sl === null || tp === null) return
    await writeContract({
      abi: perpsAbi as any,
      address: perpsAddress as any,
      functionName: 'setStops',
      args: [sl as any, tp as any],
      chainId: desiredChain.id,
    })
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
  const [stopLoss, takeProfit] = (stops || []) as [bigint, bigint]
  const trigArr = (trig || []) as [boolean, boolean, boolean]
  const inner = (
    <div className="grid gap-8">
      <div className="muted">Stop Loss actual: {stopLoss ? (Number(stopLoss)/1e8).toFixed(4)+'%' : '—'} | Take Profit actual: {takeProfit ? (Number(takeProfit)/1e8).toFixed(4)+'%' : '—'}</div>
      <div className="row">
        <input className="input" placeholder="SL %" value={slPct} onChange={e=>setSlPct(e.target.value)} />
        <input className="input" placeholder="TP %" value={tpPct} onChange={e=>setTpPct(e.target.value)} />
        <button className="btn" disabled={!perpsAddress || isPending || mining} onClick={onSet}>Setear</button>
      </div>
      <div className="muted">Trigger: {String(trigArr?.[0])} | SL: {String(trigArr?.[1])} | TP: {String(trigArr?.[2])}</div>
      <button className="btn warning" disabled={!perpsAddress || !trigArr?.[0] || isPending || mining} onClick={onCloseNow}>Cerrar por stop ahora</button>
      {error && <div className="error">{String(error)}</div>}
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

function OraclePrice({ oracleAddress }: { oracleAddress: string }) {
  const { data } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000 }
  })
  const pct = typeof data === 'bigint' ? Number(formatUnits(data, 8)) : undefined
  return <div className="muted">BTC Dominance: {pct !== undefined ? `${pct.toFixed(2)}%` : '—'}</div>
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
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

function NetworkHelper({ desired }: { desired: 'base'|'baseSepolia' }) {
  const chainId = useChainId()
  const { switchChainAsync, isPending } = useSwitchChain()
  const targetId = desired === 'baseSepolia' ? baseSepolia.id : base.id
  if (chainId === targetId) return null
  return (
    <div className="inline-hint">
      <span className="warn">Red actual: {chainId}. Recomendado: {targetId}</span>
      <button className="btn sm" disabled={isPending} onClick={()=>switchChainAsync?.({ chainId: targetId })}>Cambiar red</button>
    </div>
  )
}

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
          <button className="btn" disabled={!perpsAddress || isPending} onClick={onFund}>Fondear contrato</button>
        </div>
        {localErr && <div className="error">{localErr}</div>}
        {error && <div className="error">{String(error)}</div>}
      </div>
    </div>
  )
}

// Combined, pro-looking panels
function TradePanel({ perpsAddress, oracleAddress, chainKey }: { perpsAddress: string, oracleAddress: string, chainKey: 'base'|'baseSepolia' }) {
  const [isLong, setIsLong] = useState(true)
  const [leverage, setLeverage] = useState(10)
  const [marginEth, setMarginEth] = useState('0.1')
  return (
    <div className="card">
      <div className="card-body grid gap-12">
        <div>
          <div className="muted small">Precio BTC.D (oráculo)</div>
          <OraclePrice oracleAddress={oracleAddress} />
        </div>
        <div className="segmented">
          <button className={isLong? 'seg long-btn active':'seg long-btn'} onClick={()=>setIsLong(true)}>Long</button>
          <button className={!isLong? 'seg short-btn active':'seg short-btn'} onClick={()=>setIsLong(false)}>Short</button>
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
        <StopsManager perpsAddress={perpsAddress} chainKey={chainKey} compact />
        <div className="muted small">Fees: 0.10% al abrir y 0.10% al cerrar</div>
      </div>
    </div>
  )
}

function PositionCard({ perpsAddress, oracleAddress }: { perpsAddress: string, oracleAddress: string }) {
  return (
    <div className="card">
      <div className="card-header"><h3>Mi posición</h3></div>
      <div className="card-body">
        <MyPosition perpsAddress={perpsAddress} oracleAddress={oracleAddress} />
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

function StopsCard({ perpsAddress, chainKey }: { perpsAddress: string, chainKey: 'base'|'baseSepolia' }) {
  return <StopsManager perpsAddress={perpsAddress} chainKey={chainKey} />
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

function CopyBtn({ text }: { text: string }) {
  return <button className="btn sm" onClick={()=>navigator.clipboard?.writeText(text || '')}>Copiar</button>
}
