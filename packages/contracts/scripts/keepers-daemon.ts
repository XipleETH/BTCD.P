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

  let open = new Set<string>()
  let lastScan = 0
  let lastScanAt = 0

  // Initialize scan range
  if (START_BLOCK) {
    lastScan = START_BLOCK - 1
  } else {
    const latest = await provider.getBlockNumber()
    // Default: go back some blocks to reconstruct open positions
    lastScan = Math.max(0, latest - 200_000)
  }

  async function scanNewLogs() {
    const now = Date.now()
    if (now - lastScanAt < SCAN_EVERY_SEC * 1000) return
    const toBlock = await provider.getBlockNumber()
    if (toBlock <= lastScan) return
    const fromBlock = lastScan + 1
    try {
      if (DEBUG) console.log(`Scanning logs ${fromBlock} -> ${toBlock}`)
      // Use typed event queries
      const posOpened = await perps.queryFilter(perps.filters.PositionOpened as any, fromBlock, toBlock)
      const posClosed = await perps.queryFilter(perps.filters.PositionClosed as any, fromBlock, toBlock)
      const liqs = await perps.queryFilter(perps.filters.Liquidated as any, fromBlock, toBlock)
      const stopClosed = await perps.queryFilter(perps.filters.StopClosed as any, fromBlock, toBlock)

      for (const ev of posOpened) {
        const anyEv: any = ev as any
        const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
        if (/^0x[0-9a-f]{40}$/.test(trader)) open.add(trader)
      }
      const removeTrader = (addr: string) => { if (open.has(addr)) open.delete(addr) }
      for (const ev of posClosed) {
        const anyEv: any = ev as any
        const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
        if (/^0x[0-9a-f]{40}$/.test(trader)) removeTrader(trader)
      }
      for (const ev of liqs) {
        const anyEv: any = ev as any
        const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
        if (/^0x[0-9a-f]{40}$/.test(trader)) removeTrader(trader)
      }
      for (const ev of stopClosed) {
        const anyEv: any = ev as any
        const trader = String(anyEv?.args?.trader || anyEv?.args?.[0] || anyEv?.topics?.[1] || '').toLowerCase()
        if (/^0x[0-9a-f]{40}$/.test(trader)) removeTrader(trader)
      }
      lastScan = toBlock
      lastScanAt = now
      if (DEBUG) console.log(`Open traders: ${open.size}`)
    } catch (e: any) {
      console.warn('scan logs error', e?.message || e)
      // back off next scan
      lastScanAt = now - (SCAN_EVERY_SEC * 1000 - 5000)
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
