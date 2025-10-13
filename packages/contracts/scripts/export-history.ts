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

  while (to > 0 && pages < maxPages) {
    const from = to > step ? to - step : 0
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
    if (startBlockEnv !== undefined && from === 0) break
    if (from === 0) break
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
}

main().catch((e)=>{ console.error(e); process.exit(1) })
