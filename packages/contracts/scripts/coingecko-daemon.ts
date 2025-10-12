import axios from 'axios'
import * as dotenv from 'dotenv'
import { ethers } from 'hardhat'

dotenv.config()

async function fetchBTCD(): Promise<number> {
  const resp = await axios.get('https://api.coingecko.com/api/v3/global')
  const pct = resp.data?.data?.market_cap_percentage?.btc
  if (typeof pct !== 'number') throw new Error('Invalid response from CoinGecko')
  return pct
}

async function runOnce(oracleAddr: string, last?: { v: number }): Promise<number> {
  const pct = await fetchBTCD()
  const minChange = Number(process.env.MIN_CHANGE || '0') // in percentage points, e.g. 0.01 = 1bp
  if (last && Math.abs(pct - last.v) < minChange) {
    console.log(new Date().toISOString(), 'no significant change', pct.toFixed(6), '% (minChange', minChange, ')')
    return last.v
  }
  const priceScaled = ethers.parseUnits(pct.toFixed(8), 8)
  const oracle = await ethers.getContractAt('BTCDOracle', oracleAddr)
  const tx = await oracle.pushPrice(priceScaled)
  console.log(new Date().toISOString(), 'BTC.D', pct.toFixed(6), '% tx=', tx.hash)
  await tx.wait()
  return pct
}

async function main() {
  const oracleAddr = process.env.ORACLE
  const intervalSec = Number(process.env.CG_INTERVAL_SEC || '300')
  if (!oracleAddr) throw new Error('Set ORACLE in .env')
  // eslint-disable-next-line no-constant-condition
  let last: { v: number } | undefined = undefined
  while (true) {
    try {
      const v = await runOnce(oracleAddr, last)
      last = { v }
    } catch (e: any) {
      const status = e?.response?.status
      const backoff = status === 429 ? Math.min(intervalSec * 2, 600) : Math.max(5, Math.floor(intervalSec/2))
      console.error('tick error', e?.message || e)
      await new Promise(r => setTimeout(r, backoff*1000))
      continue
    }
    // jitter +/- 10%
    const jitter = Math.floor(intervalSec * (0.9 + Math.random()*0.2))
    await new Promise(r => setTimeout(r, jitter*1000))
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
