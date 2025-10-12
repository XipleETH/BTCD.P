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
  const priceScaled = ethers.parseUnits(pct.toFixed(8), 8)
  const oracle = await ethers.getContractAt('BTCDOracle', oracleAddr)
  const tx = await oracle.pushPrice(priceScaled)
  console.log('Pushing BTC.D', pct.toFixed(2), '% tx=', tx.hash)
  await tx.wait()
  console.log('Done')
}

main().catch((e)=>{ console.error(e); process.exit(1) })
