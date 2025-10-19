import { ethers } from 'hardhat'
import * as dotenv from 'dotenv'

dotenv.config()

async function main() {
  const oracle = process.env.ORACLE
  if (!oracle) throw new Error('Set ORACLE env')
  const [signer] = await ethers.getSigners()
  const addr = await signer.getAddress()
  // Try detect oracle type based on KIND or introspection; default BTCDOracle
  const kind = (process.env.KIND || '').toLowerCase()
  const name = kind === 'random' ? 'RandomOracle' : (kind === 'localaway' ? 'LocalAwayOracle' : 'BTCDOracle')
  const o = await ethers.getContractAt(name, oracle)
  const latest = await (o as any).latestAnswer() as bigint
  const ts = await (o as any).latestTimestamp() as bigint
  const target = (process.env.UPDATER || '').trim() || addr
  const isUpdater = await (o as any).isUpdater(target)
  console.log('Signer:', addr)
  console.log('Target addr:', target)
  console.log('Is updater?', isUpdater)
  console.log('Latest:', ethers.formatUnits(latest, 8), '@', new Date(Number(ts)*1000).toISOString())
}

main().catch((e)=>{ console.error(e); process.exit(1) })
