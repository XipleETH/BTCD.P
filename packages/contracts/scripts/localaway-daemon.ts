import { ethers, network } from 'hardhat'
import axios from 'axios'

// Env:
//  LOCALAWAY_ORACLE (required for on-chain)
//  LOCALAWAY_PRIVATE_KEY (recommended dedicated key)
//  API_BASE (required) -> e.g., https://your-vercel-app.vercel.app/api/football-live-goals
//  API_SECRET (optional; must match Vercel env if configured)
//  CHAIN (e.g., base-sepolia)
//  INGEST_URL / INGEST_SECRET (optional for chart DB sync)
//  MARKET=localaway (default)
//  INTERVAL_MS (poll cadence; default 5000)

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

function toScaled(n: number): bigint {
  return BigInt(Math.round(n * 1e8))
}

async function fetchNetIndex(apiBase: string, secret?: string): Promise<number> {
  const url = new URL(apiBase)
  if (secret) url.searchParams.set('secret', secret)
  const resp = await axios.get(url.toString(), { timeout: 12000 })
  const fixtures = Array.isArray(resp.data?.fixtures) ? resp.data.fixtures : []
  let net = 0 // +1 per home goal, -1 per away goal
  for (const f of fixtures) {
    const goals = Array.isArray(f?.goals) ? f.goals : []
    for (const g of goals) {
      if (g?.team === 'home') net += 1
      else if (g?.team === 'away') net -= 1
    }
  }
  // Index = 10000 + net, cannot go below 1
  const base = 10000 + net
  return base > 1 ? base : 1
}

async function main() {
  const oracleAddr = (process.env.LOCALAWAY_ORACLE || '').trim()
  if (!oracleAddr) throw new Error('LOCALAWAY_ORACLE not set')
  const apiBase = (process.env.API_BASE || '').trim()
  if (!apiBase) throw new Error('API_BASE not set (point to /api/football-live-goals)')
  const apiSecret = (process.env.API_SECRET || '').trim()

  // Prefer dedicated signer
  const altPkRaw = (process.env.LOCALAWAY_PRIVATE_KEY || '').trim()
  let signer = (await ethers.getSigners())[0]
  if (altPkRaw) {
    const pk = altPkRaw.startsWith('0x') ? altPkRaw : ('0x' + altPkRaw)
    signer = new (ethers as any).Wallet(pk, ethers.provider)
  }
  const oracle = await ethers.getContractAt('LocalAwayOracle', oracleAddr, signer as any)
  console.log('LocalAway daemon on', network.name, 'oracle', oracleAddr, 'as', await (signer as any).getAddress())

  const interval = Number(process.env.INTERVAL_MS || '5000')

  // Optional DB ingest for shared chart
  const ingestUrl = (process.env.INGEST_URL || '').trim()
  const ingestSecret = (process.env.INGEST_SECRET || '').trim()
  const chain = (process.env.CHAIN || (network.name === 'baseSepolia' ? 'base-sepolia' : (network.name === 'base' ? 'base' : network.name))).toLowerCase()
  const market = (process.env.MARKET || 'localaway').toLowerCase()

  while (true) {
    try {
      const indexValue = await fetchNetIndex(apiBase, apiSecret)
      const scaled = toScaled(indexValue)
      const tx = await oracle.pushPrice(scaled)
      await tx.wait()
      console.log(new Date().toISOString(), 'index', indexValue, 'tx', tx.hash)

      // sync to DB for chart
      if (ingestUrl && ingestSecret) {
        try {
          const time = Math.floor(Date.now() / 1000)
          const value = indexValue
          await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value }, { timeout: 8000 })
        } catch (e: any) {
          console.warn('ingest sync failed', e?.message || e)
        }
      }
    } catch (e: any) {
      console.error('tick error', e?.message || e)
    }
    await sleep(interval)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
