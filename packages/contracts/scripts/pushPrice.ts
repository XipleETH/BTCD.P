import { ethers } from 'hardhat'

async function main() {
  const addr = process.env.ORACLE as string
  const price = process.env.PRICE as string // e.g. "60" or "60.12" not supported; use integer percentage
  if (!addr || !price) throw new Error('Set ORACLE and PRICE env vars')
  const oracle = await ethers.getContractAt('BTCDOracle', addr)
  const p = ethers.parseUnits(price, 8)
  const tx = await oracle.pushPrice(p)
  console.log('tx', tx.hash)
  await tx.wait()
  console.log('pushed', price)
}

main().catch((e)=>{ console.error(e); process.exit(1) })
