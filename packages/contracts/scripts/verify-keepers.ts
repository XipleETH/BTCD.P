import * as dotenv from 'dotenv'
dotenv.config()

async function lazyHardhat() {
  const hh = await import('hardhat')
  return hh
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const PERPS = (process.env.PERPS || '').trim()
  if (!PERPS) throw new Error('Set PERPS=0x... (BTCDPerps) in env')

  const { ethers } = await lazyHardhat()
  const provider = ethers.provider
  const [signer] = await ethers.getSigners()
  const perps = await ethers.getContractAt('BTCDPerps', PERPS, signer)

  const DEBUG = String(process.env.DEBUG_VERIFY || '').toLowerCase() === 'true'
  const START_BLOCK = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined
  const SCAN_CHUNK = Number(process.env.SCAN_CHUNK || '5000')
  const LIMIT_STOPS = Number(process.env.LIMIT_STOPS || '10')

  let open = new Set<string>()

  // Initialize scan range
  let lastScan = 0
  if (START_BLOCK) {
    lastScan = START_BLOCK - 1
  } else {
    const latest = await provider.getBlockNumber()
    lastScan = Math.max(0, latest - 20_000)
  }

  // Build open set by scanning events
  const latestBlock = await provider.getBlockNumber()
  if (DEBUG) console.log(`Scanning ${lastScan + 1} -> ${latestBlock}`)
  const addOpen = (t: string) => { if (/^0x[0-9a-fA-F]{40}$/.test(t)) open.add(t.toLowerCase()) }
  const removeOpen = (t: string) => { open.delete(t.toLowerCase()) }
  for (let start = lastScan + 1; start <= latestBlock; start += SCAN_CHUNK) {
    const end = Math.min(start + SCAN_CHUNK - 1, latestBlock)
    const [posOpened, posClosed, liqs, stopClosed, stopsUpd] = await Promise.all([
      perps.queryFilter(perps.filters.PositionOpened as any, start, end),
      perps.queryFilter(perps.filters.PositionClosed as any, start, end),
      perps.queryFilter(perps.filters.Liquidated as any, start, end),
      perps.queryFilter(perps.filters.StopClosed as any, start, end),
      perps.queryFilter(perps.filters.StopsUpdated as any, start, end),
    ])
    for (const ev of posOpened) {
      const anyEv: any = ev as any
      const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '')
      addOpen(trader)
    }
    for (const ev of posClosed) {
      const anyEv: any = ev as any
      const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '')
      removeOpen(trader)
    }
    for (const ev of liqs) {
      const anyEv: any = ev as any
      const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '')
      removeOpen(trader)
    }
    for (const ev of stopClosed) {
      const anyEv: any = ev as any
      const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '')
      removeOpen(trader)
    }
    for (const ev of stopsUpd) {
      const anyEv: any = ev as any
      const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '')
      addOpen(trader)
    }
  }

  console.log(`Open traders detected: ${open.size}`)
  const traders = Array.from(open)
  if (!traders.length) {
    console.log('No open positions found in scanned range. If you recently opened positions, increase LOOKBACK range or set START_BLOCK env to include those blocks.')
  }

  // Inspect each open trader for SL/TP and liquidation readiness
  for (const addr of traders) {
    try {
      const pos = await perps.positions(addr)
      if (!pos.isOpen) continue
      const [sl, tp] = await perps.getStops(addr)
      const [trig, hitSl, hitTp] = await perps.shouldClose(addr)
      const canLiq = await perps.canLiquidate(addr)
      // Compute quick stats
      const isLong: boolean = Boolean(pos.isLong)
      const lev = Number(pos.leverage)
      const marginEth = Number(ethers.formatEther(pos.margin))
      const entryPct = Number(pos.entryPrice) / 1e8
      const slPct = sl ? Number(sl) / 1e8 : 0
      const tpPct = tp ? Number(tp) / 1e8 : 0

      console.log('—')
      console.log(`Trader: ${addr}`)
      console.log(`  Open: ${pos.isOpen}  Side: ${isLong ? 'LONG':'SHORT'}  Lev: x${lev}  Margin: ${marginEth.toFixed(6)} ETH  Entry: ${entryPct.toFixed(4)}%`)
      console.log(`  Stops: SL ${sl ? slPct.toFixed(4)+'%' : '—'} | TP ${tp ? tpPct.toFixed(4)+'%' : '—'}`)
      console.log(`  shouldClose: ${trig} (SL=${hitSl}, TP=${hitTp})  canLiquidate: ${canLiq}`)
    } catch (e: any) {
      console.warn('Error inspecting', addr, e?.message || e)
    }
  }

  // Optional: show recent StopClosed events
  try {
    const latest = await provider.getBlockNumber()
    const from = Math.max(0, latest - 50_000)
    const recent = await perps.queryFilter(perps.filters.StopClosed as any, from, latest)
    console.log(`\nRecent StopClosed events (last ${Math.min(LIMIT_STOPS, recent.length)}):`)
    for (const ev of recent.slice(-LIMIT_STOPS)) {
      const anyEv: any = ev as any
      const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || '')
      const exitPrice = Number(anyEv?.args?.exitPrice || 0) / 1e8
      const txHash = anyEv?.transactionHash
      console.log(`  ${ev.blockNumber} ${txHash} trader=${trader} exit=${exitPrice.toFixed(4)}%`)
    }
  } catch {}
}

main().catch((e)=>{ console.error(e); process.exit(1) })
