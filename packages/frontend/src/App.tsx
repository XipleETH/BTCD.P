import { useEffect, useMemo, useState, useRef, useContext, createContext, Component } from 'react'
import { http, WagmiProvider, useSwitchChain, useAccount } from 'wagmi'
import { base, baseSepolia } from 'viem/chains'
import { RainbowKitProvider, ConnectButton, getDefaultConfig } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import '@rainbow-me/rainbowkit/styles.css'
import './styles.css'
import { deployed } from './addresses'

// ---- Minimal i18n (ES default, EN optional) ----
type Lang = 'es' | 'en'
const translations: Record<Lang, Record<string, string>> = {
  es: {
    ui_network_live: 'Perps en Vivo',
    ui_network_test: 'Perps de Prueba',
  ui_perps_lab: "Perps’ Lab",
  lab_title: "Perps’ Lab",
  lab_form_name: 'Nombre',
  lab_form_desc: 'Descripción breve (cómo funciona)',
  lab_form_up: 'Cómo sube la vela',
  lab_form_down: 'Cómo baja la vela',
  lab_form_api_url: 'API (URL)',
  lab_form_api_cost: 'Costo de la API',
  lab_api_cost_none: '—',
  lab_api_cost_free: 'Gratis',
  lab_api_cost_paid: 'De pago',
  lab_form_formula: 'Fórmula / Ecuación',
  lab_submit: 'Proponer',
  lab_list_title: 'Propuestas',
  lab_loading: 'Cargando…',
  lab_empty: 'No hay propuestas aún.',
  lab_votes: 'Votos',
  lab_vote_btn: 'Votar',
  lab_voted: 'Votado',
  lab_new_test_in: 'Nuevo Test Perps en:',
  lab_getting_ready: 'Preparando para testing…',
  lab_winner: 'Ganadora:',
  lab_switch_to_sepolia: 'Cambia a Base Sepolia para votar',
  lab_list_up: 'Sube',
  lab_list_down: 'Baja',
  lab_list_api: 'API',
  lab_list_formula: 'Fórmula',
    chart_loading_events: 'Cargando eventos…',
    chart_showing_last: 'Mostrando últimos registrados',
    chart_no_events: 'Sin eventos recientes',
    chart_loading_numbers: 'Cargando números…',
    chart_no_numbers: 'Sin números recientes',
    chart_drag_here: 'Arrastra aquí para desplazar la página',

    open_title: 'Abrir posición',
    open_fee_open: 'Fee: 0.10% al abrir',
    open_has_pos: 'Ya tienes una posición abierta. Debes cerrarla antes de abrir otra.',
    open_invalid_amount: 'Monto inválido (usa punto como separador decimal).',
    open_open: 'Abrir',

    common_sim_failed: 'Simulación falló',
    common_error: 'Error',
    common_sending_tx: 'Enviando transacción...',
    common_copy: 'Copiar',

    mypos_connect_wallet: 'Conecta tu wallet.',
    mypos_set_perps_address: 'Configura la dirección de Perps.',
    mypos_loading: 'Cargando…',
    mypos_no_position: 'No tienes una posición abierta.',
    mypos_side: 'Lado',
    mypos_entry: 'Entrada',
    mypos_price: 'Precio',
    mypos_margin: 'Margen',
    mypos_notional: 'Notional',
    mypos_mm_ratio: 'MM Ratio',
    mypos_maintenance: 'Mantenimiento',
    mypos_pnl: 'PnL',
    mypos_equity: 'Equity',

    close_title: 'Cerrar posición',
    close_fee_close: 'Fee: 0.10% al cerrar',
    close_insuff_treasury: 'El contrato no tiene saldo suficiente para pagarte el cierre estimado. Fondea en Config o espera a que el PnL sea menor.',
    close_no_pos_to_close: 'No tienes una posición abierta para cerrar.',
    close_close: 'Cerrar',

    stops_title: 'Stops (SL / TP)',
    stops_current_sl: 'SL actual',
    stops_current_tp: 'TP actual',
    stops_abs_percent: 'Absoluto (%)',
    stops_abs_index: 'Absoluto (índice)',
    stops_rel_percent: 'Relativo (Δ%)',
    stops_rel_index: 'Relativo (Δ índice)',
    stops_sl_abs_percent_ph: 'SL % (ej 60.10)',
    stops_sl_abs_index_ph: 'SL abs (ej 995.5)',
    stops_sl_rel_percent_ph: 'SL Δ% (ej -1.0)',
    stops_sl_rel_index_ph: 'SL Δ (ej -5)',
    stops_tp_abs_percent_ph: 'TP % (ej 61.20)',
    stops_tp_abs_index_ph: 'TP abs (ej 1002.0)',
    stops_tp_rel_percent_ph: 'TP Δ% (ej +1.5)',
    stops_tp_rel_index_ph: 'TP Δ (ej +8)',
    stops_set_sl: 'Setear SL',
    stops_set_tp: 'Setear TP',
    stops_previews_label: 'Previews →',
    stops_open_to_use_relative: 'Abre una posición para usar relativo',
    stops_use_abs_btc: 'Usa valores absolutos del índice BTC.D (0–100%), p.ej. 60.10',
    stops_use_abs_index: 'Usa valores absolutos del índice (>0)',

    liq_title: 'Liquidación',
    liq_can_liquidate_q: '¿Puede liquidarse?',
    liq_btn: 'Liquidar mi posición',
    liq_sim_failed_prefix: 'Simulación falló:',

    treasury_title: 'Treasury',
    treasury_balance: 'Saldo:',
    treasury_deposit: 'Depositar al tesoro',
    invalid_contract_address: 'Dirección de contrato inválida.',

    trade_fees: 'Fees: 0.10% al abrir y 0.10% al cerrar',
    trade_price_btcd: 'Precio BTC.D (oráculo)',
    trade_price_random: 'Precio Random (oráculo)',
    trade_price_localaway: 'Home/Away Index (oráculo)',

    pos_title: 'Mi posición',

    goals_title: 'Eventos (recientes)',
    goals_none: 'No hay eventos recientes.',
    goals_side_home: 'local',
    goals_side_away: 'visitante',

    random_title: 'Números aleatorios (recientes)',
    random_none: 'No hay números recientes.',
    info_title: 'Info',
    info_btcd: 'BTC Dominance (BTC.D) es un índice que sigue la dominancia de BTC como porcentaje del mercado. En Perp‑it, lo aproximamos con una fórmula similar a TradingView agregando los 250 tokens principales. Los datos de mercado provienen de APIs públicas (CoinGecko) y nuestra API interna los resume para el oráculo y las velas.',
    info_random: 'Random genera un movimiento aleatorio en cada tick (en promedio cada ~7 segundos): un valor entre −0,10% y +0,10% se suma al índice. Es útil para probar estrategias y el flujo de trading sin depender de mercados externos.',
    info_localaway: 'Home/Away Index se mueve según los eventos de partido: suma cuando anota el equipo local y resta cuando anota el visitante. Soporta varios deportes (handball, basketball, football y volleyball). La magnitud por evento suele estar en el rango de −0,10% a +0,10% según el deporte y el contexto. Los eventos llegan desde una API de deportes y nuestra API interna los adapta.'
  },
  en: {
    ui_network_live: 'Live Perps',
    ui_network_test: 'Test Perps',
  ui_perps_lab: "Perps’ Lab",
  lab_title: "Perps’ Lab",
  lab_form_name: 'Name',
  lab_form_desc: 'Short description (how it works)',
  lab_form_up: 'How the candle goes up',
  lab_form_down: 'How the candle goes down',
  lab_form_api_url: 'API (URL)',
  lab_form_api_cost: 'API cost',
  lab_api_cost_none: '—',
  lab_api_cost_free: 'Free',
  lab_api_cost_paid: 'Paid',
  lab_form_formula: 'Formula / Equation',
  lab_submit: 'Submit',
  lab_list_title: 'Proposals',
  lab_loading: 'Loading…',
  lab_empty: 'No proposals yet.',
  lab_votes: 'Votes',
  lab_vote_btn: 'Vote',
  lab_voted: 'Voted',
  lab_new_test_in: 'New test perps in:',
  lab_getting_ready: 'Getting ready for testing…',
  lab_winner: 'Winner:',
  lab_switch_to_sepolia: 'Switch to Base Sepolia to vote',
  lab_list_up: 'Up',
  lab_list_down: 'Down',
  lab_list_api: 'API',
  lab_list_formula: 'Formula',
    chart_loading_events: 'Loading events…',
    chart_showing_last: 'Showing last recorded',
    chart_no_events: 'No recent events',
    chart_loading_numbers: 'Loading numbers…',
    chart_no_numbers: 'No recent numbers',
    chart_drag_here: 'Drag here to scroll the page',

    open_title: 'Open position',
    open_fee_open: 'Fee: 0.10% on open',
    open_has_pos: 'You already have an open position. Close it before opening another.',
    open_invalid_amount: 'Invalid amount (use dot as decimal separator).',
    open_open: 'Open',

    common_sim_failed: 'Simulation failed',
    common_error: 'Error',
    common_sending_tx: 'Sending transaction...',
    common_copy: 'Copy',

    mypos_connect_wallet: 'Connect your wallet.',
    mypos_set_perps_address: 'Set the Perps address.',
    mypos_loading: 'Loading…',
    mypos_no_position: 'You have no open position.',
    mypos_side: 'Side',
    mypos_entry: 'Entry',
    mypos_price: 'Price',
    mypos_margin: 'Margin',
    mypos_notional: 'Notional',
    mypos_mm_ratio: 'MM Ratio',
    mypos_maintenance: 'Maintenance',
    mypos_pnl: 'PnL',
    mypos_equity: 'Equity',

    close_title: 'Close position',
    close_fee_close: 'Fee: 0.10% on close',
    close_insuff_treasury: "The contract treasury doesn't have enough balance to pay the estimated close. Fund it in Config or wait until PnL is lower.",
    close_no_pos_to_close: 'You have no open position to close.',
    close_close: 'Close',

    stops_title: 'Stops (SL / TP)',
    stops_current_sl: 'Current SL',
    stops_current_tp: 'Current TP',
    stops_abs_percent: 'Absolute (%)',
    stops_abs_index: 'Absolute (index)',
    stops_rel_percent: 'Relative (Δ%)',
    stops_rel_index: 'Relative (Δ index)',
    stops_sl_abs_percent_ph: 'SL % (e.g. 60.10)',
    stops_sl_abs_index_ph: 'SL abs (e.g. 995.5)',
    stops_sl_rel_percent_ph: 'SL Δ% (e.g. -1.0)',
    stops_sl_rel_index_ph: 'SL Δ (e.g. -5)',
    stops_tp_abs_percent_ph: 'TP % (e.g. 61.20)',
    stops_tp_abs_index_ph: 'TP abs (e.g. 1002.0)',
    stops_tp_rel_percent_ph: 'TP Δ% (e.g. +1.5)',
    stops_tp_rel_index_ph: 'TP Δ (e.g. +8)',
    stops_set_sl: 'Set SL',
    stops_set_tp: 'Set TP',
    stops_previews_label: 'Previews →',
    stops_open_to_use_relative: 'Open a position to use relative mode',
    stops_use_abs_btc: 'Use absolute values of the BTC.D index (0–100%), e.g. 60.10',
    stops_use_abs_index: 'Use absolute index values (>0)',

    liq_title: 'Liquidation',
    liq_can_liquidate_q: 'Can be liquidated?',
    liq_btn: 'Liquidate my position',
    liq_sim_failed_prefix: 'Simulation failed:',

    treasury_title: 'Treasury',
    treasury_balance: 'Balance:',
    treasury_deposit: 'Deposit to treasury',
    invalid_contract_address: 'Invalid contract address.',

    trade_fees: 'Fees: 0.10% to open and 0.10% to close',
    trade_price_btcd: 'BTC.D price (oracle)',
    trade_price_random: 'Random price (oracle)',
    trade_price_localaway: 'Home/Away index (oracle)',

    pos_title: 'My position',

    goals_title: 'Events (recent)',
    goals_none: 'No recent events.',
    goals_side_home: 'home',
    goals_side_away: 'away',

    random_title: 'Random numbers (recent)',
    random_none: 'No recent numbers.',
    info_title: 'Info',
    info_btcd: 'BTC Dominance (BTC.D) tracks bitcoin’s dominance as a percentage of the market. In Perp‑it, we approximate it with a TradingView‑like formula by aggregating the top 250 tokens. Market data comes from public APIs (CoinGecko), and our internal API composes and summarizes it for the oracle and candles.',
    info_random: 'Random produces an artificial move on each tick (on average every ~7 seconds): a value between −0.10% and +0.10% is added to the index. It’s handy to test strategies and the trading flow without relying on external markets.',
    info_localaway: 'The Home/Away Index responds to match events: it goes up when the home team scores and down when the away team scores. It supports multiple sports (handball, basketball, football and volleyball). The per‑event magnitude is typically between −0.10% and +0.10%, depending on the sport and context. Events arrive from a sports API and our internal API adapts them.'
  }
}
const I18nContext = createContext<{ lang: Lang; t: (k: string) => string }>({ lang: 'es', t: (k)=> translations.es[k] || k })
function useI18n() { return useContext(I18nContext) }

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

function DominanceChart({ oracleAddress, chainKey, market, localawayEvents, localawayLoading, randomEvents, randomLoading }: { oracleAddress: string, chainKey: 'base'|'baseSepolia', market: 'btcd'|'random'|'localaway', localawayEvents?: Array<{time:number,value:number,meta:any}>, localawayLoading?: boolean, randomEvents?: Array<{time:number,value:number,meta?:any}>, randomLoading?: boolean }) {
  const { t, lang } = useI18n()
  const [tf, setTf] = useState<'1m'|'5m'|'15m'|'1h'|'4h'|'1d'|'3d'|'1w'>('15m')
  const [candles, setCandles] = useState<Candle[]>([])
  const [remaining, setRemaining] = useState<number>(0)
  const [overlayTop, setOverlayTop] = useState<number>(8)
  const [livePrice, setLivePrice] = useState<number | null>(null)
  // Events from parent hook
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const chartWrapRef = useRef<HTMLDivElement | null>(null)
  const bannerRef = useRef<HTMLDivElement | null>(null)
  const [bannerMeasured, setBannerMeasured] = useState(false)
  const [visibleBannerCount, setVisibleBannerCount] = useState<number>(6)
  const randBannerRef = useRef<HTMLDivElement | null>(null)
  const [randBannerMeasured, setRandBannerMeasured] = useState(false)
  const [randVisibleCount, setRandVisibleCount] = useState<number>(8)
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

  // No internal fetch: events provided by parent hook

  // No internal fetch: random events provided by parent hook

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

  // Recompute how many event chips fit in the banner without clipping (desktop/mobile)
  useEffect(() => {
    if (market !== 'localaway') return
    setBannerMeasured(false)
    const el = bannerRef.current
    if (!el) return
    const recompute = () => {
      try {
        const containerWidth = el.clientWidth || 0
        const chips = Array.from(el.querySelectorAll('.evt-chip')) as HTMLElement[]
        let used = 0
        let count = 0
        const GAP = 16
        for (let i = 0; i < chips.length; i++) {
          const w = chips[i].getBoundingClientRect().width || 0
          const next = used + (i > 0 ? GAP : 0) + w
          if (next <= containerWidth - 8) { used = next; count++ } else { break }
        }
        setVisibleBannerCount(count)
        setBannerMeasured(true)
      } catch {}
    }
    const raf1 = requestAnimationFrame(() => { const raf2 = requestAnimationFrame(recompute); (recompute as any)._raf2 = raf2 })
    const onWinResize = () => recompute()
    window.addEventListener('resize', onWinResize)
    const ro = (window as any).ResizeObserver ? new ResizeObserver(() => recompute()) : null
    if (ro) ro.observe(el)
    return () => {
      window.removeEventListener('resize', onWinResize)
      try { cancelAnimationFrame(raf1); if ((recompute as any)._raf2) cancelAnimationFrame((recompute as any)._raf2) } catch {}
      if (ro) ro.disconnect()
    }
  }, [market, localawayEvents])

  // Recompute how many random chips fit in the random banner without clipping
  useEffect(() => {
    if (market !== 'random') return
    setRandBannerMeasured(false)
    const el = randBannerRef.current
    if (!el) return
    const recompute = () => {
      try {
        const containerWidth = el.clientWidth || 0
        const chips = Array.from(el.querySelectorAll('.rnd-chip')) as HTMLElement[]
        let used = 0
        let count = 0
        const GAP = 16
        for (let i = 0; i < chips.length; i++) {
          const w = chips[i].getBoundingClientRect().width || 0
          const next = used + (i > 0 ? GAP : 0) + w
          if (next <= containerWidth - 8) { used = next; count++ } else { break }
        }
        setRandVisibleCount(count)
        setRandBannerMeasured(true)
      } catch {}
    }
    const raf1 = requestAnimationFrame(() => { const raf2 = requestAnimationFrame(recompute); (recompute as any)._raf2 = raf2 })
    const onWinResize = () => recompute()
    window.addEventListener('resize', onWinResize)
    const ro = (window as any).ResizeObserver ? new ResizeObserver(() => recompute()) : null
    if (ro) ro.observe(el)
    return () => {
      window.removeEventListener('resize', onWinResize)
      try { cancelAnimationFrame(raf1); if ((recompute as any)._raf2) cancelAnimationFrame((recompute as any)._raf2) } catch {}
      if (ro) ro.disconnect()
    }
  }, [market, randomEvents])

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
    const calcHeight = () => {
      const w = el.clientWidth || 480
      // responsive: taller on desktop, smaller on mobile
      if (w <= 420) return Math.max(240, Math.floor(w * 0.9))
      if (w <= 640) return Math.max(280, Math.floor(w * 0.7))
      return 480
    }
    const chart = createChart(el, {
      width: el.clientWidth,
      height: calcHeight(),
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
    const onResize = () => chart.applyOptions({ width: el.clientWidth, height: calcHeight() })
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
                display:'flex',
                flexWrap:'nowrap',
                gap:16,
                alignItems:'center',
                minHeight: 28
              }} ref={bannerRef}>
                {Array.isArray(localawayEvents) && localawayEvents.length > 0 ? (
                  localawayEvents.map((e, idx) => {
                    const lg = e.meta?.league || ''
                    const home = e.meta?.home?.name || 'Home'
                    const away = e.meta?.away?.name || 'Away'
                    const scHome = e.meta?.score?.home ?? '?'
                    const scAway = e.meta?.score?.away ?? '?'
                    const inferredSport = String(e.meta?.sport || (String(e.meta?.type||'').toLowerCase()==='goal' ? 'football' : ''))
                    const emoji = (e.meta?.emoji && String(e.meta?.emoji).length>0) ? e.meta.emoji : sportEmoji(inferredSport)
                    const type = String(e.meta?.type || '')
                    const side = type === 'goal' ? (e.meta?.side === 'home' ? t('goals_side_home') : (e.meta?.side === 'away' ? t('goals_side_away') : '')) : ''
                    return (
                      <div key={idx} className="evt-chip" style={{ display: (bannerMeasured && idx >= visibleBannerCount) ? 'none' : 'inline-flex', alignItems:'center', gap:8, flex:'0 0 auto' }}>
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
                    {localawayLoading ? t('chart_loading_events') : t('chart_no_events')}
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
                display:'flex',
                flexWrap:'nowrap',
                gap:16,
                alignItems:'center',
                minHeight: 28
              }} ref={randBannerRef}>
                {Array.isArray(randomEvents) && randomEvents.length > 0 ? (
                  randomEvents.map((r, idx) => {
                    const prev = randomEvents[idx+1]?.value
                    const stepBps = (typeof prev === 'number' && prev > 0)
                      ? Math.round(((Number(r.value) - prev) / prev) * 10000)
                      : null
                    const sign = stepBps !== null ? (stepBps > 0 ? `+${stepBps}` : `${stepBps}`) : '—'
                    const rounded = Math.round(Number(r.value))
                    return (
                      <div key={idx} className="rnd-chip" style={{ display: (randBannerMeasured && idx >= randVisibleCount) ? 'none' : 'inline-flex', alignItems:'center', gap:8, flex:'0 0 auto' }}>
                        <div style={{ width:20, textAlign:'center' }}>🎲</div>
                        <div style={{ fontSize:13, display:'flex', alignItems:'baseline', gap:8 }}>
                          <strong>{Number(r.value).toFixed(4)}</strong>
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
                    {randomLoading ? t('chart_loading_numbers') : t('chart_no_numbers')}
                  </div>
                )}
              </div>
            </div>
          )}
          <div id={containerId} className="chart" />
          {/* Scroll guards around the chart to ease page scrolling */}
          <div className="chart-guard top" title={t('chart_drag_here')} />
          <div className="chart-guard bottom" title={t('chart_drag_here')} />
          <div className="chart-guard left" title={t('chart_drag_here')} />
          <div className="chart-guard right" title={t('chart_drag_here')} />
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

function InfoCard({ market }: { market: 'btcd'|'random'|'localaway' }) {
  const { t } = useI18n()
  const bodyKey = market === 'btcd' ? 'info_btcd' : (market === 'random' ? 'info_random' : 'info_localaway')
  return (
    <div className="card">
      <div className="card-header"><h3>{t('info_title')}</h3></div>
      <div className="card-body">
        <div className="muted" style={{ whiteSpace:'pre-wrap', lineHeight: 1.5 }}>{t(bodyKey)}</div>
      </div>
    </div>
  )
}

// Aggregation removed from client; candles served from pre-aggregated JSON

const queryClient = new QueryClient()

function AppInner({ routeMarket, isLab }: { routeMarket: 'btcd'|'random'|'localaway', isLab?: boolean }) {
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
          <AppContent market={market} isLab={isLab} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

function AppContent({ market, isLab }: { market: 'btcd'|'random'|'localaway', isLab?: boolean }) {
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem('btcd:ui:lang') as Lang) === 'es' ? 'es' : 'en' } catch { return 'en' }
  })
  const t = (k: string) => (translations[lang]?.[k] ?? translations.es[k] ?? k)
  useEffect(() => {
    try { document.documentElement.lang = lang } catch {}
  }, [lang])
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

  // Shared events fetcher (avoids duplicate polling across components)
  const chainParam = chain === 'baseSepolia' ? 'base-sepolia' : 'base'
  const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''
  const useEvents = (mkt: 'localaway'|'random', enabled: boolean) => {
    const url = mkt === 'random'
      ? `${baseUrl}/api/events?chain=${chainParam}&market=random&limit=100&oracle=${encodeURIComponent(oracleAddress||'')}`
      : `${baseUrl}/api/events?chain=${chainParam}&market=localaway&limit=100`
    const lsKey = `btcd:events:${chainParam}:${mkt}`
    return useQuery({
      queryKey: ['events', chainParam, mkt, oracleAddress || ''],
      queryFn: async () => {
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) return [] as any[]
        const j = await res.json()
        const evs = Array.isArray(j?.events) ? j.events : []
        try { if (evs.length) localStorage.setItem(lsKey, JSON.stringify(evs)) } catch {}
        return evs
      },
      initialData: () => {
        try {
          const raw = localStorage.getItem(lsKey)
          if (!raw) return []
          const arr = JSON.parse(raw)
          return Array.isArray(arr) ? arr : []
        } catch { return [] }
      },
      staleTime: 45_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: false,
      enabled,
    })
  }

  const enableLocalAway = market === 'localaway'
  const enableRandom = market === 'random' && Boolean(oracleAddress)
  const { data: eventsLocalAway = [], isFetching: loadingLocalAway } = useEvents('localaway', enableLocalAway)
  const { data: eventsRandom = [], isFetching: loadingRandom } = useEvents('random', enableRandom)

  return (
    <I18nContext.Provider value={{ lang, t }}>
  <div className={"container " + (isLab ? 'market-lab' : (market === 'btcd' ? 'market-btcd' : (market === 'random' ? 'market-random' : 'market-localaway')))}>
      <header className="header">
        <div className="header-left" style={{ flexDirection:'column', alignItems:'flex-start', gap:8 }}>
          {/* Top row: Brand only (no fixed width so wallet can align right on the same row) */}
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div className="brand">Perp-it</div>
          </div>
          {/* Second row: Network menu under title */}
          <div className={`network-menu ${isLab ? 'lab-mode' : ''}`} style={{ marginTop: 2 }}>
            <div className="segmented">
              <button
                className={(isLab ? 'seg' : (chain==='base' ? 'seg active' : 'seg'))}
                onClick={async ()=>{
                  try { localStorage.setItem('btcd:ui:chain','base') } catch {}
                  setUiChain('base')
                  if (isConnected) {
                    try { await switchChainAsync?.({ chainId: base.id }) } catch {}
                  }
                  // If currently in Lab, exit to charts when switching network
                  if (isLab) { try { window.location.hash = '#btcd' } catch {} }
                }}
              >{t('ui_network_live')}</button>
              <button
                className={(isLab ? 'seg' : (chain==='baseSepolia' ? 'seg active' : 'seg'))}
                onClick={async ()=>{
                  try { localStorage.setItem('btcd:ui:chain','baseSepolia') } catch {}
                  setUiChain('baseSepolia')
                  if (isConnected) {
                    try { await switchChainAsync?.({ chainId: baseSepolia.id }) } catch {}
                  }
                  // If currently in Lab, exit to charts when switching network
                  if (isLab) { try { window.location.hash = '#btcd' } catch {} }
                }}
              >{t('ui_network_test')}</button>
            </div>
            <a href="#lab" className={"btn sm lab-btn " + (isLab ? 'active' : '')} style={{ marginLeft: 8 }}>{t('ui_perps_lab')}</a>
          </div>
          {/* Third row: Page selector below network menu (hidden when on Lab page) */}
          <div className="network-switcher" style={{ marginTop: 4 }}>
            {!isLab && (
              <div className="segmented">
                <a href="#btcd" className={market==='btcd'?'seg active':'seg'}>BTC.D</a>
                <a href="#random" className={market==='random'?'seg active':'seg'}>Random</a>
                <a href="#homeaway" className={market==='localaway'?'seg active':'seg'}>Home/Away</a>
              </div>
            )}
          </div>
        </div>
        {/* Right side: Wallet on top, language buttons below (right aligned) */}
        <div className="header-right">
          <ConnectButton />
          <div className="lang-menu">
            <div className="segmented">
              <button className={lang==='es' ? 'seg active':'seg'} onClick={()=>{ setLang('es'); try{localStorage.setItem('btcd:ui:lang','es')}catch{} }}>ES</button>
              <button className={lang==='en' ? 'seg active':'seg'} onClick={()=>{ setLang('en'); try{localStorage.setItem('btcd:ui:lang','en')}catch{} }}>EN</button>
            </div>
          </div>
        </div>
      </header>

      <main className="main">
        {isLab ? (
          <PerpsLab chainKey={chain} />
        ) : (
          <>
            <section className="main-top">
              <DominanceChart
                oracleAddress={oracleAddress}
                chainKey={chain}
                market={market}
                localawayEvents={market==='localaway' ? eventsLocalAway : undefined}
                localawayLoading={market==='localaway' ? loadingLocalAway : undefined}
                randomEvents={market==='random' ? eventsRandom : undefined}
                randomLoading={market==='random' ? loadingRandom : undefined}
              />
            </section>

            <section className="main-grid">
              <div className="col">
                <InfoCard market={market} />
                <TradePanel perpsAddress={perpsAddress} oracleAddress={oracleAddress} chainKey={chain} market={market} />
                <TreasuryCard perpsAddress={perpsAddress} desired={chain} />
                <ConfigCard oracleAddress={oracleAddress} perpsAddress={perpsAddress} />
              </div>
              <div className="col">
                <PositionCard perpsAddress={perpsAddress} oracleAddress={oracleAddress} market={market} chainKey={chain} />
                {market === 'random' && (
                  <RandomCard chainKey={chain} oracleAddress={oracleAddress} items={eventsRandom} loading={loadingRandom} />
                )}
                {market === 'localaway' && (
                  <GoalsCard chainKey={chain} events={eventsLocalAway} loading={loadingLocalAway} />
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
    </I18nContext.Provider>
  )
}

import { useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId, useSimulateContract, useBalance, useSendTransaction, useSignMessage } from 'wagmi'
import { parseEther, formatUnits, formatEther, createPublicClient, http as viemHttp } from 'viem'

type OpenControlled = { isLong: boolean; setIsLong: (v:boolean)=>void; leverage: number; setLeverage: (n:number)=>void; marginEth: string; setMarginEth: (s:string)=>void }
function OpenPosition({ perpsAddress, chainKey, compact, controlled }: { perpsAddress: string, chainKey: 'base'|'baseSepolia', compact?: boolean, controlled?: OpenControlled }) {
  const { t } = useI18n()
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
          <div className="card-header"><h3>{t('open_title')}</h3><span className="muted">{t('open_fee_open')}</span></div>
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
            {hasPos && <div className="warn">{t('open_has_pos')}</div>}
          </div>
        </>
      )}
      <button className="btn primary w-full" disabled={!address || !perpsAddress || isPending || mining || hasPos} onClick={async ()=>{
        setLocalError('')
        const value = safeParseEther(marginEth)
        if (value === null) { setLocalError(t('open_invalid_amount')); return }
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
      }}>{t('open_open')}</button>
      {/* Mensajes de simulación en hover */}
      {simOpen.error && <HoverInfo label={t('common_sim_failed')} tip={String((simOpen.error as any)?.shortMessage || simOpen.error.message)} />} 
      {localError && <HoverInfo label={t('common_error')} tip={localError} />}
      {error && <HoverInfo label={t('common_error')} tip={String(error)} />}
      {(isPending || mining) && <div className="muted mt-8">{t('common_sending_tx')}</div>}
    </div>
  )
}

function MyPosition({ perpsAddress, oracleAddress, market, chainKey }: { perpsAddress: string, oracleAddress: string, market: 'btcd'|'random'|'localaway', chainKey: 'base'|'baseSepolia' }) {
  const { t } = useI18n()
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

  if (!address) return <div className="muted">{t('mypos_connect_wallet')}</div>
  if (!perpsAddress) return <div className="muted">{t('mypos_set_perps_address')}</div>
  if (!pos) return <div className="muted">{t('mypos_loading')}</div>

  const [isOpen, isLong, leverage, margin, entryPrice] = pos as [boolean, boolean, bigint, bigint, bigint]
  if (!isOpen) return <div className="muted">{t('mypos_no_position')}</div>

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
      <div className="stat"><span className="stat-label">{t('mypos_side')}</span><span className={isLong ? 'badge long':'badge short'}>{isLong ? 'Long' : 'Short'}</span></div>
      <div className="stat"><span className="stat-label">Leverage</span><span className="stat-value">x{String(leverage)}</span></div>
      <div className="stat"><span className="stat-label">{t('mypos_entry')}</span><span className="stat-value">{entryPct.toFixed(4)}{market==='btcd' ? '%' : ''}</span></div>
      <div className="stat"><span className="stat-label">{t('mypos_price')}</span><span className="stat-value">{pctIndex.toFixed(4)}{market==='btcd' ? '%' : ''}</span></div>
      <div className="stat"><span className="stat-label">{t('mypos_margin')}</span><span className="stat-value">{marginEth.toFixed(6)} ETH</span></div>
      <div className="stat"><span className="stat-label">{t('mypos_notional')}</span><span className="stat-value">{notionalEth.toFixed(6)} ETH</span></div>
      <div className="stat"><span className="stat-label">{t('mypos_mm_ratio')}</span><span className="stat-value">{mmRatio/100}%</span></div>
      <div className="stat"><span className="stat-label">{t('mypos_maintenance')}</span><span className="stat-value">{maintenanceEth.toFixed(6)} ETH</span></div>
      <div className="stat span-2"><span className="stat-label">{t('mypos_pnl')}</span><span className={pnlEth >= 0 ? 'pnl up':'pnl down'}>{pnlEth.toFixed(6)} ETH ({roi.toFixed(2)}%)</span></div>
      <div className="stat span-2"><span className="stat-label">{t('mypos_equity')}</span><span className="stat-value">{equityEth.toFixed(6)} ETH</span></div>
    </div>
  )
}

function ClosePosition({ perpsAddress, oracleAddress, chainKey, minimal }: { perpsAddress: string, oracleAddress: string, chainKey: 'base'|'baseSepolia', minimal?: boolean }) {
  const { t } = useI18n()
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
        <div className="card-header"><h3>{t('close_title')}</h3><span className="muted">{t('close_fee_close')}</span></div>
      )}
      {!minimal && insufficientTreasury && <div className="error">{t('close_insuff_treasury')}</div>}
      {!minimal && !hasPos && <div className="warn">{t('close_no_pos_to_close')}</div>}
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
      }}>{t('close_close')}</button>
      {/* Ocultamos mensajes debajo de Cerrar para no ensuciar la UI */}
      {(isPending || mining) && <div className="muted mt-8">{t('common_sending_tx')}</div>}
    </div>
  )
}

function StopsManager({ perpsAddress, chainKey, market, compact }: { perpsAddress: string, chainKey: 'base'|'baseSepolia', market: 'btcd'|'random'|'localaway', compact?: boolean }) {
  const { t } = useI18n()
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
      <div style={{ fontWeight: 700, fontSize: 14 }}>{t('stops_title')}</div>
      <div className="muted small">{t('stops_current_sl')}: {stopLoss ? (market==='btcd' ? (Number(stopLoss)/1e8).toFixed(4)+'%' : (Number(stopLoss)/1e8).toFixed(4)) : '—'} | {t('stops_current_tp')}: {takeProfit ? (market==='btcd' ? (Number(takeProfit)/1e8).toFixed(4)+'%' : (Number(takeProfit)/1e8).toFixed(4)) : '—'}</div>
      <div className="segmented">
        <button className={mode==='absolute' ? 'seg active':'seg'} onClick={()=>setMode('absolute')}>{market==='btcd' ? t('stops_abs_percent') : t('stops_abs_index')}</button>
        <button className={mode==='relative' ? 'seg active':'seg'} onClick={()=>setMode('relative')}>{market==='btcd' ? t('stops_rel_percent') : t('stops_rel_index')}</button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div className="grid gap-6">
          <input className="input" placeholder={mode==='absolute' ? (market==='btcd' ? t('stops_sl_abs_percent_ph') : t('stops_sl_abs_index_ph')) : (market==='btcd' ? t('stops_sl_rel_percent_ph') : t('stops_sl_rel_index_ph'))} value={slInput} onChange={e=>setSlInput(e.target.value)} />
          {(() => {
            const slAbsV = slInput ? computeAbs(slInput, true) : 0
            const slOk = slAbsV === 0 || (slAbsV !== null && toScaledAbs(slAbsV) !== null)
            const disabled = !perpsAddress || isPending || mining || !slOk || !hasPos
            return <button className="btn" disabled={disabled} onClick={onSetSL}>{t('stops_set_sl')}</button>
          })()}
        </div>
        <div className="grid gap-6">
          <input className="input" placeholder={mode==='absolute' ? (market==='btcd' ? t('stops_tp_abs_percent_ph') : t('stops_tp_abs_index_ph')) : (market==='btcd' ? t('stops_tp_rel_percent_ph') : t('stops_tp_rel_index_ph'))} value={tpInput} onChange={e=>setTpInput(e.target.value)} />
          {(() => {
            const tpAbsV = tpInput ? computeAbs(tpInput, false) : 0
            const tpOk = tpAbsV === 0 || (tpAbsV !== null && toScaledAbs(tpAbsV) !== null)
            const disabled = !perpsAddress || isPending || mining || !tpOk || !hasPos
            return <button className="btn" disabled={disabled} onClick={onSetTP}>{t('stops_set_tp')}</button>
          })()}
        </div>
      </div>
      <div className="muted small">
        {mode==='relative' ? (
          <>
            {entryVal !== undefined ? (market==='btcd'
              ? `${t('stops_previews_label')} SL: ${slPreview!==null ? slPreview.toFixed(4)+'%' : '—'} | TP: ${tpPreview!==null ? tpPreview.toFixed(4)+'%' : '—'}`
              : `${t('stops_previews_label')} SL: ${slPreview!==null ? slPreview.toFixed(4) : '—'} | TP: ${tpPreview!==null ? tpPreview.toFixed(4) : '—'}`)
              : t('stops_open_to_use_relative')}
          </>
        ) : (
          <>
            {market==='btcd' ? t('stops_use_abs_btc') : t('stops_use_abs_index')}
          </>
        )}
      </div>
      {/* Button removed visually to save space: 'Cerrar por stop ahora' */}
      {error && <HoverInfo label={t('common_error')} tip={String(error)} />}
      {(isPending || mining) && <div className="muted">{t('common_sending_tx')}</div>}
    </div>
  )
  if (compact) return inner
  return (
    <div className="card">
      <div className="card-header"><h3>{t('stops_title')}</h3></div>
      <div className="card-body">{inner}</div>
    </div>
  )
}

function LiquidateSelf({ perpsAddress, chainKey }: { perpsAddress: string, chainKey: 'base'|'baseSepolia' }) {
  const { t } = useI18n()
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
      <div className="muted mb-8">{t('liq_can_liquidate_q')} {String(canLiq)}</div>
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
      }}>{t('liq_btn')}</button>
      {simLiq.error && <div className="error">{t('liq_sim_failed_prefix')} {String((simLiq.error as any)?.shortMessage || simLiq.error.message)}</div>}
      {error && <div className="error">{String(error)}</div>}
      {(isPending || mining) && <div className="muted">{t('common_sending_tx')}</div>}
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
  // Tiny hash router: supports #btcd (default), #random, #homeaway/#localaway, and #lab
  const [route, setRoute] = useState<'btcd' | 'random' | 'localaway' | 'lab'>(() => {
    const h = (typeof window !== 'undefined' ? window.location.hash : '') || ''
    const hv = h.replace('#', '').toLowerCase()
    if (hv === 'random') return 'random'
    if (hv === 'homeaway' || hv === 'localaway') return 'localaway'
    if (hv === 'lab' || hv === 'perpslab') return 'lab'
    return 'btcd'
  })
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash || ''
      const hv = h.replace('#', '').toLowerCase()
      setRoute(
        hv === 'random' ? 'random' :
        (hv === 'homeaway' || hv === 'localaway') ? 'localaway' :
        (hv === 'lab' || hv === 'perpslab') ? 'lab' : 'btcd'
      )
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return (
    <ErrorBoundary>
      <AppInner routeMarket={route === 'lab' ? 'btcd' : route} isLab={route === 'lab'} />
    </ErrorBoundary>
  )
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error }
  }
  componentDidCatch(error: any, info: any) {
    try { console.error('App error:', error, info) } catch {}
  }
  render() {
    if (this.state.hasError) {
      const msg = this.state?.error?.message || String(this.state.error || 'Unknown error')
      return <div className="error" style={{ padding: 12 }}>Error: {msg}</div>
    }
    return this.props.children as any
  }
}

// NetworkHelper removed: the page now follows the wallet network directly via ConnectButton's switch

function ContractTreasury({ perpsAddress, desired }: { perpsAddress: string, desired: 'base'|'baseSepolia' }) {
  const { t } = useI18n()
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
  if (!isAddr) { setLocalErr(t('invalid_contract_address')); return }
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
      <div className="card-header"><h3>{t('treasury_title')}</h3></div>
      <div className="card-body grid gap-8">
        <div><strong>{t('treasury_balance')}</strong> {bal ? `${Number(formatEther(bal.value)).toFixed(6)} ETH` : '—'}</div>
        <div className="row">
          <input className="input" placeholder="0.1" value={amt} onChange={e=>setAmt(e.target.value)} />
          <button className="btn" onClick={onFund} disabled={!perpsAddress || isPending || !amt.trim()} style={{ marginLeft: 8 }}>{t('treasury_deposit')}</button>
        </div>
        {localErr && <div className="error">{localErr}</div>}
        {error && <div className="error">{String(error)}</div>}
      </div>
    </div>
  )
}

// Combined, pro-looking panels
function TradePanel({ perpsAddress, oracleAddress, chainKey, market }: { perpsAddress: string, oracleAddress: string, chainKey: 'base'|'baseSepolia', market: 'btcd'|'random'|'localaway' }) {
  const { t } = useI18n()
  const [isLong, setIsLong] = useState(true)
  const [leverage, setLeverage] = useState(10)
  const [marginEth, setMarginEth] = useState('0.1')
  return (
    <div className="card">
      <div className="card-body grid gap-12">
        <div>
          <div className="muted small">{market==='btcd' ? t('trade_price_btcd') : (market==='random' ? t('trade_price_random') : t('trade_price_localaway'))}</div>
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
        <div className="muted small">{t('trade_fees')}</div>
      </div>
    </div>
  )
}

function PositionCard({ perpsAddress, oracleAddress, market, chainKey }: { perpsAddress: string, oracleAddress: string, market: 'btcd'|'random'|'localaway', chainKey: 'base'|'baseSepolia' }) {
  const { t } = useI18n()
  return (
    <div className="card">
      <div className="card-header"><h3>{t('pos_title')}</h3></div>
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
  const { t } = useI18n()
  return (
    <div className="card">
      <div className="card-header"><h3>{t('liq_title')}</h3></div>
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
  const { t } = useI18n()
  return <button className="btn sm" onClick={()=>navigator.clipboard?.writeText(text || '')}>{t('common_copy')}</button>
}

function GoalsCard({ chainKey, events, loading }: { chainKey: 'base'|'baseSepolia', events: Array<{ time:number, value:number, meta:any }>, loading: boolean }) {
  const { t } = useI18n()
  const [page, setPage] = useState(1)
  const pageSize = 10
  const total = Array.isArray(events) ? events.length : 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  useEffect(() => {
    // Clamp page if events length changed
    if (page > totalPages) setPage(totalPages)
  }, [totalPages])
  const start = (page - 1) * pageSize
  const current = (Array.isArray(events) ? events : []).slice(start, start + pageSize)
  // Use shared sportEmoji helper for consistent mapping
  return (
    <div className="card">
      <div className="card-header" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <h3>{t('goals_title')}</h3>
        <div className="segmented" style={{ display:'flex', alignItems:'center', gap:8 }}>
          <button className="seg" disabled={page<=1} onClick={()=>setPage(p=>Math.max(1, p-1))}>‹</button>
          <span className="muted small">{page} / {totalPages}</span>
          <button className="seg" disabled={page>=totalPages} onClick={()=>setPage(p=>Math.min(totalPages, p+1))}>›</button>
        </div>
      </div>
      <div className="card-body">
        {!current.length && !loading ? (
          <div className="muted">{t('goals_none')}</div>
        ) : (
          <div className="list">
            {current.map((e, idx) => {
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
              const side = type === 'goal' ? (e.meta?.side === 'home' ? t('goals_side_home') : (e.meta?.side === 'away' ? t('goals_side_away') : '')) : ''
              return (
                <div key={idx} className="row" style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 0', borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
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

function RandomCard({ chainKey, oracleAddress, items, loading }: { chainKey: 'base'|'baseSepolia', oracleAddress: string, items: Array<{ time:number, value:number }>, loading: boolean }) {
  const { t } = useI18n()
  return (
    <div className="card">
      <div className="card-header"><h3>{t('random_title')}</h3></div>
      <div className="card-body">
        {!items.length && !loading ? (
          <div className="muted">{t('random_none')}</div>
        ) : (
          <div className="list">
            {items.slice(0, 10).map((r, idx)=>{
              // Compute step in bps versus the immediately older value (same data as chart)
              const prev = items.slice(0, 10)[idx+1]?.value
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

// Perps Lab: propose new perps and vote
function PerpsLab({ chainKey }: { chainKey: 'base'|'baseSepolia' }) {
  const { t, lang } = useI18n()
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [upDesc, setUpDesc] = useState('')
  const [downDesc, setDownDesc] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [apiCost, setApiCost] = useState<'free'|'paid'|'none'>('none')
  const [formula, setFormula] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [page, setPage] = useState(1)
  const [votedIds, setVotedIds] = useState<Record<string, true>>({})
  const baseUrl = (import.meta as any).env?.VITE_API_BASE || ''

  // Biweekly countdown to Saturday 00:01 UTC based on an anchor epoch
  // Anchor chosen as a Saturday 00:01 UTC: 2025-10-25 00:01:00Z
  const EPOCH_MS = Date.parse('2025-10-25T00:01:00Z')
  const PERIOD_MS = 14 * 24 * 60 * 60 * 1000
  const nextBoundary = (nowMs: number) => {
    if (!Number.isFinite(nowMs)) nowMs = Date.now()
    if (nowMs <= EPOCH_MS) return EPOCH_MS
    const k = Math.ceil((nowMs - EPOCH_MS) / PERIOD_MS)
    return EPOCH_MS + k * PERIOD_MS
  }
  const [targetMs, setTargetMs] = useState<number>(() => nextBoundary(Date.now()))
  const [remainingMs, setRemainingMs] = useState<number>(Math.max(0, targetMs - Date.now()))
  useEffect(() => {
    let id: number | undefined
    const tick = () => {
      const now = Date.now()
      const rem = targetMs - now
      if (rem <= 0) {
        // roll to the next period so the counter continues
        const nxt = nextBoundary(now + 1000)
        setTargetMs(nxt)
        setRemainingMs(Math.max(0, nxt - now))
      } else {
        setRemainingMs(rem)
      }
      id = window.setTimeout(tick, 1000)
    }
    id = window.setTimeout(tick, 1000)
    return () => { if (id) window.clearTimeout(id) }
  }, [targetMs])
  const fmtCountdown = (ms: number) => {
    const totalSec = Math.max(0, Math.floor(ms / 1000))
    const days = Math.floor(totalSec / 86400)
    const rem = totalSec % 86400
    const hrs = Math.floor(rem / 3600)
    const rem2 = rem % 3600
    const mins = Math.floor(rem2 / 60)
    const secs = rem2 % 60
    const parts: string[] = []
    if (days > 0) parts.push(`${days}d`)
    parts.push(String(hrs).padStart(2,'0') + ':' + String(mins).padStart(2,'0') + ':' + String(secs).padStart(2,'0'))
    return parts.join(' ')
  }

  const proposalsQ = useQuery({
    queryKey: ['lab-proposals', address || ''],
    queryFn: async () => {
      const url = `${baseUrl}/api/lab-proposals${address ? `?address=${encodeURIComponent(address)}` : ''}`
      const r = await fetch(url, { cache: 'no-store' })
      if (!r.ok) {
        let txt = ''
        try { txt = await r.text() } catch {}
        throw new Error(`GET /api/lab-proposals ${r.status}${txt ? `: ${txt}` : ''}`)
      }
      const j = await r.json()
      return Array.isArray(j?.proposals) ? j.proposals as any[] : []
    },
    refetchInterval: 30000,
  })

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !description.trim() || !upDesc.trim() || !downDesc.trim() || !formula.trim()) return
    if (!isConnected || !address) {
      alert(lang==='es' ? 'Conecta tu wallet para proponer' : 'Connect your wallet to propose')
      return
    }
    try {
      setSubmitting(true)
      const ts = Math.floor(Date.now()/1000)
      const message = `Perps Lab proposal\nName: ${name}\nAuthor: ${address}\nTs: ${ts}`
      let signature = ''
      try {
        signature = await signMessageAsync({ message })
      } catch (err) {
        alert(lang==='es' ? 'Firma rechazada' : 'Signature rejected')
        return
      }
      const r = await fetch(`${baseUrl}/api/lab-proposals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description, upDesc, downDesc, apiUrl, apiCost: apiCost==='none'?'':apiCost, formula, author: address || '', address, message, signature })
      })
      if (r.ok) {
        setName(''); setDescription(''); setUpDesc(''); setDownDesc(''); setApiUrl(''); setApiCost('none'); setFormula('')
        proposalsQ.refetch()
      } else {
        const txt = await r.text().catch(()=> '')
        alert((lang==='es' ? 'No se pudo enviar propuesta: ' : 'Failed to submit proposal: ') + (txt || r.status))
      }
    } finally { setSubmitting(false) }
  }

  const vote = async (id: string) => {
    if (!address) return
    if (chainKey !== 'baseSepolia') {
      alert(lang==='es' ? 'Cambia a Base Sepolia para votar' : 'Switch to Base Sepolia to vote')
      return
    }
    try {
      const ts = Math.floor(Date.now()/1000)
      const message = `Perps Lab vote\nProposal: ${id}\nVoter: ${address}\nTs: ${ts}`
      let signature = ''
      try {
        signature = await signMessageAsync({ message })
      } catch (err) {
        alert(lang==='es' ? 'Firma rechazada' : 'Signature rejected')
        return
      }
      const res = await fetch(`${baseUrl}/api/lab-vote`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id, address, message, signature }) })
      if (res.ok) {
        // Optimistic: mark as voted so UI shows immediately
        setVotedIds(prev => ({ ...prev, [id]: true }))
      } else {
        const txt = await res.text().catch(()=> '')
        alert((lang==='es' ? 'No se pudo votar: ' : 'Failed to vote: ') + (txt || res.status))
      }
      proposalsQ.refetch()
    } catch {}
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-header" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
          <h3>{t('lab_title')}</h3>
          <div style={{ textAlign:'right' }}>
            {remainingMs > 0 ? (
              <div className="small" style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                <span className="muted">{t('lab_new_test_in')}</span>
                <strong>{fmtCountdown(remainingMs)}</strong>
              </div>
            ) : (
              <div className="small" style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                <span className="muted">{t('lab_getting_ready')}</span>
              </div>
            )}
            {/* Winner announcement near boundary: take top by votes (already sorted server-side); fallback to client sort */}
            {(() => {
              const all = (proposalsQ.data || []) as any[]
              if (!all.length) return null
              // Ensure top by votes desc, tie ts desc as fallback
              const sorted = [...all].sort((a,b)=>{
                const va = Number(a?.votes||0), vb = Number(b?.votes||0)
                if (vb !== va) return vb - va
                return Number(b?.ts||0) - Number(a?.ts||0)
              })
              const top = sorted[0]
              return (
                <div className="small" style={{ marginTop: 2 }}>
                  <span className="muted">{t('lab_winner')}</span> <strong>{top?.name || '—'}</strong>
                </div>
              )
            })()}
          </div>
        </div>
        <div className="card-body">
          <form className="grid" style={{ gap: 12 }} onSubmit={onSubmit}>
            <div className="field">
              <label>{t('lab_form_name')}</label>
              <input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder={lang==='es' ? 'Nombre del perp' : 'Perp name'} />
            </div>
            <div className="field">
              <label>{t('lab_form_desc')}</label>
              <textarea className="input" value={description} onChange={e=>setDescription(e.target.value)} placeholder={lang==='es' ? 'Resumen del mecanismo' : 'Mechanism summary'} />
            </div>
            <div className="field">
              <label>{t('lab_form_up')}</label>
              <textarea className="input" value={upDesc} onChange={e=>setUpDesc(e.target.value)} placeholder={lang==='es' ? 'Describe la condición de subida' : 'Describe the upward condition'} />
            </div>
            <div className="field">
              <label>{t('lab_form_down')}</label>
              <textarea className="input" value={downDesc} onChange={e=>setDownDesc(e.target.value)} placeholder={lang==='es' ? 'Describe la condición de bajada' : 'Describe the downward condition'} />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <div className="field" style={{ flex: 2 }}>
                <label>{t('lab_form_api_url')}</label>
                <input className="input" value={apiUrl} onChange={e=>setApiUrl(e.target.value)} placeholder="https://..." />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{t('lab_form_api_cost')}</label>
                <select className="input" value={apiCost} onChange={e=>setApiCost(e.target.value as any)}>
                  <option value="none">{t('lab_api_cost_none')}</option>
                  <option value="free">{t('lab_api_cost_free')}</option>
                  <option value="paid">{t('lab_api_cost_paid')}</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>{t('lab_form_formula')}</label>
              <textarea className="input" value={formula} onChange={e=>setFormula(e.target.value)} placeholder={lang==='es' ? 'Explica la ecuación requerida' : 'Explain the required equation'} />
            </div>
            <div>
              <button className="btn" type="submit" disabled={submitting || !name.trim() || !description.trim() || !upDesc.trim() || !downDesc.trim() || !formula.trim()}>
                {t('lab_submit')}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3>{t('lab_list_title')}</h3></div>
        <div className="card-body">
          {proposalsQ.isLoading ? (
            <div className="muted">{t('lab_loading')}</div>
          ) : proposalsQ.isError ? (
            <div className="error">
              {lang==='es' ? 'No se pudo cargar propuestas.' : 'Failed to load proposals.'}
              {(() => {
                const msg = (proposalsQ.error as any)?.message || ''
                return msg ? <div className="small" style={{ marginTop: 6, opacity: 0.9 }}>{String(msg)}</div> : null
              })()}
            </div>
          ) : (
            (() => {
              const all = (proposalsQ.data || []) as any[]
              const pageSize = 5
              const total = all.length
              const pageCount = Math.max(1, Math.ceil(total / pageSize))
              const current = Math.min(page, pageCount)
              const start = (current - 1) * pageSize
              const items = all.slice(start, start + pageSize)
              return (
                <>
                  <div className="grid" style={{ gap: 12 }}>
                    {items.map((p:any) => (
                      <div key={p.id} className="card" style={{ padding: 12 }}>
                        <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:8, flexWrap:'wrap' }}>
                              <strong>{p.name}</strong>
                              <span className="muted small">{new Date((p.ts||0)*1000).toLocaleString()}</span>
                            </div>
                            <div className="muted" style={{ marginTop:4 }}>{p.description}</div>
                            <div className="grid" style={{ gap:4, marginTop:8 }}>
                              <div className="small"><strong>{t('lab_list_up')}:</strong> {p.upDesc}</div>
                              <div className="small"><strong>{t('lab_list_down')}:</strong> {p.downDesc}</div>
                              <div className="small"><strong>{t('lab_list_api')}:</strong> {p.apiUrl || '—'} {p.apiCost ? `(${p.apiCost})` : ''}</div>
                              <div className="small"><strong>{t('lab_list_formula')}:</strong> <span style={{ whiteSpace:'pre-wrap' }}>{p.formula}</span></div>
                            </div>
                          </div>
                          <div style={{ width: 140, textAlign:'right' }}>
                            <div className="muted small">{t('lab_votes')}</div>
                            <div style={{ fontSize:18, marginBottom:8 }}><strong>{Number(p.votes||0)}</strong></div>
                            {(() => {
                              const already = Boolean((p as any).hasVoted) || Boolean(votedIds[p.id])
                              return (
                                <button className={already ? 'btn sm disabled' : 'btn sm'} disabled={!isConnected || already} onClick={()=>vote(p.id)}>
                                  {already ? t('lab_voted') : t('lab_vote_btn')}
                                </button>
                              )
                            })()}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {total === 0 && (
                    <div className="muted">{t('lab_empty')}</div>
                  )}
                  {total > pageSize && (
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop: 8 }}>
                      <button className="btn sm" disabled={current<=1} onClick={()=>setPage(Math.max(1, current-1))}>Prev</button>
                      <div className="small muted">Page {current} / {pageCount}</div>
                      <button className="btn sm" disabled={current>=pageCount} onClick={()=>setPage(Math.min(pageCount, current+1))}>Next</button>
                    </div>
                  )}
                </>
              )
            })()
          )}
        </div>
      </div>
    </div>
  )
}
