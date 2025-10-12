import { useEffect, useMemo, useState, useRef } from 'react'
import { http, WagmiProvider } from 'wagmi'
import { base, baseSepolia } from 'viem/chains'
import { RainbowKitProvider, ConnectButton, getDefaultConfig } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@rainbow-me/rainbowkit/styles.css'
import * as addressesModule from './addresses'

// Minimal ABI for our contracts
const oracleAbi = [
  { "inputs": [], "name": "latestAnswer", "outputs": [{"internalType":"int256","name":"","type":"int256"}], "stateMutability":"view", "type":"function" }
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
  { "inputs": [], "name": "takerFeeBps", "outputs": [{"internalType":"uint256","name":"","type":"uint256"}], "stateMutability": "view", "type": "function" }
] as const

import { createChart, ColorType, Time, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'

type Tick = { time: UTCTimestamp, value: number }
type Candle = { time: UTCTimestamp, open: number, high: number, low: number, close: number }

function DominanceChart({ oracleAddress }: { oracleAddress: string }) {
  const [ticks, setTicks] = useState<Tick[]>([])
  const [tf, setTf] = useState<'5m'|'15m'|'1h'|'4h'|'1d'|'3d'|'1w'>('15m')
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const containerId = 'chart_container'

  const { data: priceRaw } = useReadContract({
    abi: oracleAbi as any,
    address: (oracleAddress || undefined) as any,
    functionName: 'latestAnswer',
    query: { enabled: Boolean(oracleAddress), refetchInterval: 15000 }
  })

  // Load persisted ticks on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('btcd_ticks')
      if (raw) {
        const parsed: Tick[] = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setTicks(parsed)
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (typeof priceRaw === 'bigint') {
      const v = Number(formatUnits(priceRaw, 8))
  const point: Tick = { time: Math.floor(Date.now()/1000) as UTCTimestamp, value: v }
      setTicks(prev => {
        const next = [...prev, point].slice(-10000) // keep last 10k points
        try { localStorage.setItem('btcd_ticks', JSON.stringify(next)) } catch {}
        return next
      })
    }
  }, [priceRaw])

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

  // Aggregate ticks to candles according to timeframe and update series
  useEffect(() => {
    if (!seriesRef.current) return
    const bucketSec = tf === '5m' ? 300
      : tf === '15m' ? 900
      : tf === '1h' ? 3600
      : tf === '4h' ? 14400
      : tf === '1d' ? 86400
      : tf === '3d' ? 259200
      : 604800
    const candles = aggregateToCandles(ticks, bucketSec)
    seriesRef.current.setData(candles as any)
  }, [ticks, tf])

  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom: 8 }}>
        {(['5m','15m','1h','4h','1d','3d','1w'] as const).map(k => (
          <button key={k} onClick={()=>setTf(k)} style={{ padding:'4px 8px', background: tf===k?'#334155':'#1f2937', color:'#fff', borderRadius:4 }}>{k}</button>
        ))}
      </div>
      <div id={containerId} style={{ height: 480 }} />
    </div>
  )
}

function aggregateToCandles(points: Tick[], bucketSec: number): Candle[] {
  if (!points.length) return []
  const buckets = new Map<number, Candle>()
  for (const p of points) {
    const ts = p.time as number
    const bucket = Math.floor(ts / bucketSec) * bucketSec
    const existing = buckets.get(bucket)
    if (!existing) {
      buckets.set(bucket, { time: bucket as UTCTimestamp, open: p.value, high: p.value, low: p.value, close: p.value })
    } else {
      existing.high = Math.max(existing.high, p.value)
      existing.low = Math.min(existing.low, p.value)
      existing.close = p.value
    }
  }
  return Array.from(buckets.entries()).sort((a,b)=>a[0]-b[0]).map(([,c])=>c)
}

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

  // simple local state for addresses (fill after deploy)
  const [oracleAddress, setOracleAddress] = useState<string>('')
  const [perpsAddress, setPerpsAddress] = useState<string>('')

  useEffect(() => {
    const d: any = (addressesModule as any).deployed || (addressesModule as any).default || (addressesModule as any)
    const key = chain
    if (d?.[key]?.oracle) setOracleAddress(d[key].oracle)
    if (d?.[key]?.perps) setPerpsAddress(d[key].perps)
  }, [chain])

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
      <RainbowKitProvider>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>BTC Dominance Perps</h2>
            <ConnectButton />
          </header>

          <div style={{ marginTop: 16 }}>
            <DominanceChart oracleAddress={oracleAddress} />
          </div>

          <section style={{ marginTop: 16 }}>
            <h3>Config</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <input placeholder="Oracle address" value={oracleAddress} onChange={e=>setOracleAddress(e.target.value)} />
              <input placeholder="Perps address" value={perpsAddress} onChange={e=>setPerpsAddress(e.target.value)} />
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={()=>setChain('baseSepolia')}>Usar Base Sepolia</button>
                <button onClick={()=>setChain('base')}>Usar Base</button>
              </div>
              <NetworkHelper desired={chain} />
              <ContractTreasury perpsAddress={perpsAddress} desired={chain} />
            </div>
          </section>

          <section style={{ marginTop: 16 }}>
            <h3>Mi posición</h3>
            <MyPosition perpsAddress={perpsAddress} oracleAddress={oracleAddress} />
          </section>

          <section style={{ marginTop: 16 }}>
            <h3>Precio BTC.D (oráculo)</h3>
            <OraclePrice oracleAddress={oracleAddress} />
          </section>

          <section style={{ marginTop: 16 }}>
            <h3>Abrir posición</h3>
            <OpenPosition perpsAddress={perpsAddress} chainKey={chain} />
          </section>

          <section style={{ marginTop: 16 }}>
            <h3>Cerrar posición</h3>
            <ClosePosition perpsAddress={perpsAddress} chainKey={chain} />
          </section>

          <section style={{ marginTop: 16 }}>
            <h3>Liquidación</h3>
            <LiquidateSelf perpsAddress={perpsAddress} chainKey={chain} />
          </section>
        </div>
      </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useSwitchChain, useChainId, useSimulateContract, useBalance, useSendTransaction } from 'wagmi'
import { parseEther, formatUnits, formatEther } from 'viem'

function OpenPosition({ perpsAddress, chainKey }: { perpsAddress: string, chainKey: 'base'|'baseSepolia' }) {
  const { address } = useAccount()
  const [isLong, setIsLong] = useState(true)
  const [leverage, setLeverage] = useState(10)
  const [marginEth, setMarginEth] = useState('0.1')
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
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={()=>setIsLong(true)} style={{ background: isLong ? '#3b82f6':'#1f2937', color: 'white', padding: 8 }}>Long</button>
        <button onClick={()=>setIsLong(false)} style={{ background: !isLong ? '#ef4444':'#1f2937', color: 'white', padding: 8 }}>Short</button>
      </div>
      <label>Leverage (1-150)</label>
      <input type="number" min={1} max={150} value={leverage} onChange={e=>setLeverage(parseInt(e.target.value||'1'))}/>
      <label>Margin (ETH)</label>
      <input value={marginEth} onChange={e=>setMarginEth(e.target.value)} />
  {hasPos && <div style={{ color:'#fbbf24' }}>Ya tienes una posición abierta. Debes cerrarla antes de abrir otra.</div>}
  <button disabled={!address || !perpsAddress || isPending || mining || hasPos} onClick={async ()=>{
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
      {simOpen.error && <div style={{ color:'salmon' }}>Simulación falló: {String((simOpen.error as any)?.shortMessage || simOpen.error.message)}</div>}
      {localError && <div style={{ color:'salmon' }}>{localError}</div>}
      {error && <div style={{ color:'salmon' }}>{String(error)}</div>}
      {(isPending || mining) && <div>Enviando transacción...</div>}
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

  if (!address) return <div>Conecta tu wallet.</div>
  if (!perpsAddress) return <div>Configura la dirección de Perps.</div>
  if (!pos) return <div>Cargando…</div>

  const [isOpen, isLong, leverage, margin, entryPrice] = pos as [boolean, boolean, bigint, bigint, bigint]
  if (!isOpen) return <div>No tienes una posición abierta.</div>

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
    <div style={{ display:'grid', gap:8 }}>
      <div>Dirección: {address}</div>
      <div>Estado: {isLong ? 'Long' : 'Short'} x{String(leverage)}</div>
      <div>Precio entrada: {entryPct.toFixed(4)}%</div>
      <div>Precio actual: {pctIndex.toFixed(4)}%</div>
      <div>Margen: {marginEth.toFixed(6)} ETH</div>
      <div>Notional: {notionalEth.toFixed(6)} ETH</div>
      <div>MM Ratio: {mmRatio/100}% | Mantenimiento: {maintenanceEth.toFixed(6)} ETH</div>
      <div style={{ color: pnlEth >= 0 ? '#10b981' : '#ef4444' }}>PnL: {pnlEth.toFixed(6)} ETH ({roi.toFixed(2)}%)</div>
      <div>Equity: {equityEth.toFixed(6)} ETH</div>
    </div>
  )
}

function ClosePosition({ perpsAddress, oracleAddress, chainKey }: { perpsAddress: string, oracleAddress: string, chainKey: 'base'|'baseSepolia' }) {
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
    <div>
      {!hasPos && <div style={{ color:'#fbbf24' }}>No tienes una posición abierta para cerrar.</div>}
      {insufficientTreasury && <div style={{ color:'#f87171' }}>El contrato no tiene saldo suficiente para pagarte el cierre estimado. Fondea en Config o espera a que el PnL sea menor.</div>}
      <button disabled={!perpsAddress || isPending || mining || !hasPos || insufficientTreasury} onClick={async ()=>{
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
      {simClose.error && <div style={{ color:'salmon' }}>Simulación falló: {String((simClose.error as any)?.shortMessage || simClose.error.message)}</div>}
      {error && <div style={{ color:'salmon' }}>{String(error)}</div>}
      {(isPending || mining) && <div>Enviando transacción...</div>}
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
      <div style={{ marginBottom: 8 }}>¿Puede liquidarse? {String(canLiq)}</div>
      <button disabled={!perpsAddress || !address || isPending || mining || !canLiq} onClick={async ()=>{
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
      {simLiq.error && <div style={{ color:'salmon' }}>Simulación falló: {String((simLiq.error as any)?.shortMessage || simLiq.error.message)}</div>}
      {error && <div style={{ color:'salmon' }}>{String(error)}</div>}
      {(isPending || mining) && <div>Enviando transacción...</div>}
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
  return <div>BTC Dominance: {pct !== undefined ? `${pct.toFixed(2)}%` : '—'}</div>
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
  if (err) return <div style={{ color: 'salmon', padding: 12 }}>Error: {err.message}</div>
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
    <div style={{ display:'flex', gap:8, alignItems:'center' }}>
      <span style={{ color:'#fbbf24' }}>Red actual: {chainId}. Recomendado: {targetId}</span>
      <button disabled={isPending} onClick={()=>switchChainAsync?.({ chainId: targetId })}>
        Cambiar red en wallet
      </button>
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
    <div style={{ display:'grid', gap:8, marginTop: 8, padding: 8, background:'#0f172a', borderRadius: 8 }}>
      <div><strong>Saldo del contrato:</strong> {bal ? `${Number(formatEther(bal.value)).toFixed(6)} ETH` : '—'}</div>
      <div style={{ display:'flex', gap:8, alignItems:'center' }}>
        <input placeholder="0.1" value={amt} onChange={e=>setAmt(e.target.value)} />
        <button disabled={!perpsAddress || isPending} onClick={onFund}>Fondear contrato (ETH)</button>
      </div>
      {localErr && <div style={{ color:'salmon' }}>{localErr}</div>}
      {error && <div style={{ color:'salmon' }}>{String(error)}</div>}
    </div>
  )
}
