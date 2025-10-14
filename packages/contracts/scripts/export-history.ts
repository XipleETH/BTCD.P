import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config()

// Event ABI to decode logs
const oracleEventAbi = [
  {
    type: 'event',
    name: 'PriceUpdated',
    inputs: [
      { name: 'price', type: 'int256', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false }
    ],
    anonymous: false
  }
] as const

const iface = new ethers.Interface(oracleEventAbi as any)

async function main() {
  const oracle = process.env.ORACLE
  if (!oracle) throw new Error('Set ORACLE env to the BTCDOracle address')

  const provider = ethers.provider
  const latest = await provider.getBlockNumber() // number

  const step = Number(process.env.HIST_STEP || '200000') // number of blocks per page
  const maxPages = Number(process.env.HIST_MAX_PAGES || '30')
  const startBlockEnv = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined

  let to = latest
  let pages = 0
  const acc: Array<{ time: number; value: number }> = []

  // Topic0 for PriceUpdated(int256,uint256)
  const topic = ethers.id('PriceUpdated(int256,uint256)')

  const lowerBound = startBlockEnv ?? 0
  while (to > lowerBound && pages < maxPages) {
    const from = Math.max(to - step, lowerBound)
    try {
      const logs = await provider.getLogs({
        address: oracle as `0x${string}`,
        fromBlock: from,
        toBlock: to,
        topics: [topic]
      })
      for (const l of logs) {
        try {
          const parsed = iface.parseLog(l as any)
          if (!parsed) continue
          const price: bigint = parsed.args[0] as bigint
          const ts: bigint = parsed.args[1] as bigint
          const value = Number(ethers.formatUnits(price, 8))
          const time = Number(ts)
          // Basic sanity
          if (time > 0 && value >= 0 && value <= 100) {
            acc.push({ time, value })
          }
        } catch {}
      }
    } catch (e: any) {
      console.warn('getLogs page failed', from.toString(), to.toString(), e?.message || e)
    }
    pages++
    if (from <= lowerBound) break
    to = from - 1
  }

  acc.sort((a, b) => a.time - b.time)
  const cap = Number(process.env.HIST_MAX_POINTS || '10000')
  const trimmed = acc.slice(-cap)

  // Write to frontend public history
  const chainKey = network.name === 'baseSepolia' ? 'base-sepolia' : (network.name === 'base' ? 'base' : network.name)
  const outDir = path.resolve(__dirname, '../../../packages/frontend/public/history')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${chainKey}-ticks.json`)
  const out = {
    chain: chainKey,
    updatedAt: new Date().toISOString(),
    points: trimmed
  }
  fs.writeFileSync(outPath, JSON.stringify(out))
  console.log('Wrote history:', outPath, 'points=', trimmed.length)

  // Also write pre-aggregated candles per timeframe for frontend consumption
  type Candle = { time: number; open: number; high: number; low: number; close: number }
  const aggregate = (points: Array<{time:number; value:number}>, bucketSec: number): Candle[] => {
    if (!points.length) return []
    const buckets = new Map<number, Candle>()
    for (const p of points) {
      const ts = Math.floor(p.time)
      const bucket = Math.floor(ts / bucketSec) * bucketSec
      const prev = buckets.get(bucket)
      if (!prev) {
        buckets.set(bucket, { time: bucket, open: p.value, high: p.value, low: p.value, close: p.value })
      } else {
        prev.high = Math.max(prev.high, p.value)
        prev.low = Math.min(prev.low, p.value)
        prev.close = p.value
      }
    }
    return Array.from(buckets.entries()).sort((a,b)=>a[0]-b[0]).map(([,c])=>c)
  }

  const tfs: Array<{ key: string; sec: number; cap?: number }> = [
    { key: '5m', sec: 300, cap: 4000 },
    { key: '15m', sec: 900, cap: 4000 },
    { key: '1h', sec: 3600, cap: 4000 },
    { key: '4h', sec: 14400, cap: 4000 },
    { key: '1d', sec: 86400, cap: 5000 },
    { key: '3d', sec: 259200, cap: 5000 },
    { key: '1w', sec: 604800, cap: 5000 },
  ]
  for (const tf of tfs) {
    const candles = aggregate(trimmed, tf.sec)
    const limited = tf.cap ? candles.slice(-tf.cap) : candles
    const candleOutPath = path.join(outDir, `${chainKey}-candles-${tf.key}.json`)
    const payload = {
      chain: chainKey,
      timeframe: tf.key,
      updatedAt: new Date().toISOString(),
      candles: limited,
    }
    fs.writeFileSync(candleOutPath, JSON.stringify(payload))
    console.log(`Wrote candles: ${candleOutPath} candles=${limited.length}`)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
