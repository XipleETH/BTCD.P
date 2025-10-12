import axios from 'axios'
import * as dotenv from 'dotenv'
import { ethers } from 'hardhat'

dotenv.config()

async function fetchBTCD(): Promise<number> {
  // CoinGecko markets includes market cap share. Alternative: /global for market_cap_percentage.btc
  const resp = await axios.get('https://api.coingecko.com/api/v3/global')
  const pct = resp.data?.data?.market_cap_percentage?.btc
  if (typeof pct !== 'number') throw new Error('Invalid response from CoinGecko')
  return pct // e.g., 60.12
}

async function main() {
  const oracleAddr = process.env.ORACLE
  if (!oracleAddr) throw new Error('Set ORACLE in .env')
  const pct = await fetchBTCD()
  const oracle = await ethers.getContractAt('BTCDOracle', oracleAddr)

  // Optional guard: only push if change >= MIN_CHANGE vs on-chain latest
  const minChange = Number(process.env.MIN_CHANGE || '0') // percentage points
  if (minChange > 0) {
    try {
      const onchainRaw: bigint = await (oracle as any).latestAnswer()
      const onchain = Number(ethers.formatUnits(onchainRaw, 8))
      const diff = Math.abs(pct - onchain)
      if (diff < minChange) {
        console.log(`No push: |Δ|=${diff.toFixed(6)}% < MIN_CHANGE=${minChange}%. Current=${onchain.toFixed(6)}% Fetched=${pct.toFixed(6)}%`)
        return
      }
    } catch (e) {
      console.warn('Could not read latestAnswer, proceeding with push. Reason:', (e as any)?.message || e)
    }
  }

  const priceScaled = ethers.parseUnits(pct.toFixed(8), 8)
  const tx = await oracle.pushPrice(priceScaled)
  console.log('Pushing BTC.D', pct.toFixed(6), '% tx=', tx.hash)
  await tx.wait()
  console.log('Done')
}

main().catch((e)=>{ console.error(e); process.exit(1) })
