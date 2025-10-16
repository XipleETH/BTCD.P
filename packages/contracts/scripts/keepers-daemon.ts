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

  const DEBUG = String(process.env.DEBUG_KEEPERS || '').toLowerCase() === 'true'
  const LOOP_SEC = Number(process.env.KEEPERS_INTERVAL_SEC || '10')
  const SCAN_EVERY_SEC = Number(process.env.SCAN_EVERY_SEC || '60')
  const START_BLOCK = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined
  const MAX_TX_PER_LOOP = Number(process.env.MAX_TX_PER_LOOP || '5')
  const GAS_LIMIT = process.env.GAS_LIMIT ? BigInt(process.env.GAS_LIMIT) : undefined
  const SCAN_CHUNK = Number(process.env.SCAN_CHUNK || '2000')
  const LOOKBACK_BLOCKS = Number(process.env.LOOKBACK_BLOCKS || '20000')

  let open = new Set<string>()
  let lastScan = 0
  let lastScanAt = 0

  // Initialize scan range
  if (START_BLOCK) {
    lastScan = START_BLOCK - 1
  } else {
    const latest = await provider.getBlockNumber()
    // Default: go back a tunable window to reconstruct
    lastScan = Math.max(0, latest - LOOKBACK_BLOCKS)
  }

  async function getWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let attempt = 0
    while (true) {
      try {
        return await fn()
      } catch (e: any) {
        attempt++
        const msg = e?.shortMessage || e?.message || String(e)
        if (DEBUG) console.warn(`${label} failed (attempt ${attempt})`, msg)
        // Detect provider backend hiccups or rate limits, backoff
        const lower = msg.toLowerCase()
        const isHiccup = lower.includes('no backend is currently healthy') || lower.includes('429') || lower.includes('rate')
        const backoff = isHiccup ? Math.min(5 * attempt, 30) : Math.min(2 * attempt, 10)
        await sleep(backoff * 1000)
        if (attempt >= 5) throw e
      }
    }
  }

  async function scanNewLogs() {
    const now = Date.now()
    if (now - lastScanAt < SCAN_EVERY_SEC * 1000) return
    const toBlock = await provider.getBlockNumber()
    if (toBlock <= lastScan) return
    const fromBlock = lastScan + 1
    try {
      if (DEBUG) console.log(`Scanning logs ${fromBlock} -> ${toBlock} (chunk ${SCAN_CHUNK})`)
      const addOpen = (t: string) => { if (/^0x[0-9a-f]{40}$/.test(t)) open.add(t) }
      const removeOpen = (t: string) => { if (open.has(t)) open.delete(t) }

      for (let start = fromBlock; start <= toBlock; start += SCAN_CHUNK) {
        const end = Math.min(start + SCAN_CHUNK - 1, toBlock)
        const [posOpened, posClosed, liqs, stopClosed, stopsUpd] = await Promise.all([
          getWithRetry(() => perps.queryFilter(perps.filters.PositionOpened as any, start, end), 'PositionOpened'),
          getWithRetry(() => perps.queryFilter(perps.filters.PositionClosed as any, start, end), 'PositionClosed'),
          getWithRetry(() => perps.queryFilter(perps.filters.Liquidated as any, start, end), 'Liquidated'),
          getWithRetry(() => perps.queryFilter(perps.filters.StopClosed as any, start, end), 'StopClosed'),
          getWithRetry(() => perps.queryFilter(perps.filters.StopsUpdated as any, start, end), 'StopsUpdated'),
        ])
        for (const ev of posOpened) {
          const anyEv: any = ev as any
          const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
          addOpen(trader)
        }
        for (const ev of posClosed) {
          const anyEv: any = ev as any
          const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
          removeOpen(trader)
        }
        for (const ev of liqs) {
          const anyEv: any = ev as any
          const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
          removeOpen(trader)
        }
        for (const ev of stopClosed) {
          const anyEv: any = ev as any
          const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
          removeOpen(trader)
        }
        for (const ev of stopsUpd) {
          const anyEv: any = ev as any
          const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
          addOpen(trader)
        }
      }
      lastScan = toBlock
      lastScanAt = now
      if (DEBUG) console.log(`Open traders: ${open.size}`)
    } catch (e: any) {
      console.warn('scan logs error', e?.message || e)
      // back off next scan
      lastScanAt = now - Math.max(0, (SCAN_EVERY_SEC * 1000 - 5000))
    }
  }

  // Main loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await scanNewLogs()
    let sent = 0
    // Copy set to array to avoid mutation during iteration
    const traders = Array.from(open)
    for (const trader of traders) {
      if (sent >= MAX_TX_PER_LOOP) break
      try {
        const canLiq: boolean = await perps.canLiquidate(trader)
        if (canLiq) {
          const tx = await perps.liquidate(trader, GAS_LIMIT ? { gasLimit: GAS_LIMIT } : {})
          console.log(new Date().toISOString(), 'liquidate', trader, tx.hash)
          sent++
          continue
        }
        const res = await perps.shouldClose(trader)
        const trig: boolean = Boolean((res as any)[0])
        if (trig) {
          const tx = await perps.closeIfTriggered(trader, GAS_LIMIT ? { gasLimit: GAS_LIMIT } : {})
          console.log(new Date().toISOString(), 'closeIfTriggered', trader, tx.hash)
          sent++
          continue
        }
      } catch (e: any) {
        if (DEBUG) console.warn('keeper loop error for', trader, e?.shortMessage || e?.message || e)
      }
    }
    await sleep(LOOP_SEC * 1000)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
