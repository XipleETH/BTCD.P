import axios from 'axios'
import * as dotenv from 'dotenv'
import { ethers, network } from 'hardhat'

dotenv.config()

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
  const ingestUrl = process.env.INGEST_URL
  const ingestSecret = process.env.INGEST_SECRET
  if (!ingestUrl || !ingestSecret) throw new Error('Set INGEST_URL and INGEST_SECRET envs')

  const provider = ethers.provider
  const latest = await provider.getBlockNumber()

  const step = Number(process.env.HIST_STEP || '200000')
  const maxPages = Number(process.env.HIST_MAX_PAGES || '50')
  const startBlockEnv = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : 0
  const lowerBound = startBlockEnv
  let to = latest
  let pages = 0
  const topic = ethers.id('PriceUpdated(int256,uint256)')

  const chain = (network.name === 'baseSepolia') ? 'base-sepolia' : (network.name === 'base' ? 'base' : network.name)
  const batch: Array<{ time: number; value: number }> = []

  const flush = async () => {
    if (!batch.length) return
    const payloads = batch.splice(0, batch.length)
    for (const p of payloads) {
      try {
        await axios.post(ingestUrl!, { secret: ingestSecret, chain, time: p.time, value: p.value }, { timeout: 10000 })
      } catch (e: any) {
        console.warn('ingest failed', p.time, e?.message || e)
      }
    }
  }

  while (to > lowerBound && pages < maxPages) {
    const from = Math.max(to - step, lowerBound)
    try {
      const logs = await provider.getLogs({ address: oracle as `0x${string}`, fromBlock: from, toBlock: to, topics: [topic] })
      for (const l of logs) {
        try {
          const parsed = iface.parseLog(l as any)
          if (!parsed) continue
          const price: bigint = parsed.args[0] as bigint
          const ts: bigint = parsed.args[1] as bigint
          const value = Number(ethers.formatUnits(price, 8))
          const time = Number(ts)
          if (time > 0 && value >= 0 && value <= 100) batch.push({ time, value })
          if (batch.length >= 500) await flush()
        } catch {}
      }
      await flush()
    } catch (e: any) {
      console.warn('getLogs failed', from, to, e?.message || e)
    }
    pages++
    if (from <= lowerBound) break
    to = from - 1
  }
  await flush()
  console.log('Backfill completed for', chain)
}

main().catch((e)=>{ console.error(e); process.exit(1) })