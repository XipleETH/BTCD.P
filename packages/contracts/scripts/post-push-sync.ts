import axios from 'axios'
import * as dotenv from 'dotenv'
import { ethers, network } from 'hardhat'

dotenv.config()

async function main() {
  const oracleAddr = process.env.ORACLE
  if (!oracleAddr) throw new Error('Set ORACLE in .env')
  const ingestUrl = process.env.INGEST_URL
  const ingestSecret = process.env.INGEST_SECRET
  if (!ingestUrl || !ingestSecret) {
    console.log('No INGEST_URL/INGEST_SECRET configured; skipping DB sync')
    return
  }
  const o = await ethers.getContractAt('BTCDOracle', oracleAddr)
  const latest: bigint = await (o as any).latestAnswer()
  const ts: bigint = await (o as any).latestTimestamp()
  const value = Number(ethers.formatUnits(latest, 8))
  const time = Number(ts)
  const netName = network.name
  const chain = (netName === 'baseSepolia') ? 'base-sepolia' : (netName === 'base' ? 'base' : netName)
  if (!Number.isFinite(value) || !Number.isFinite(time) || !time) return
  await axios.post(ingestUrl, { secret: ingestSecret, chain, time, value }, { timeout: 10000 })
  console.log('Synced tick to DB:', chain, time, value)
}

main().catch((e)=>{ console.error(e); process.exit(1) })