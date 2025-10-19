import { ethers } from 'hardhat'

async function main() {
  const addr = (process.env.RANDOM_ORACLE || '').trim()
  const price = (process.env.PRICE || '').trim() // e.g. "1000"
  if (!addr) throw new Error('Set RANDOM_ORACLE in environment')
  if (!price) throw new Error('Set PRICE in environment, e.g. 1000')
  const [signer] = await ethers.getSigners()
  const abi = [
    "function pushPrice(int256 price)",
    "function isUpdater(address) view returns (bool)"
  ]
  const o = new ethers.Contract(addr, abi, signer as any)
  const p = ethers.parseUnits(price, 8)
  const me = await signer.getAddress()
  const ok: boolean = await o.isUpdater(me)
  if (!ok) throw new Error(`Signer ${me} is not an updater on RandomOracle ${addr}`)
  const fd = await ethers.provider.getFeeData()
  const mp = (fd.maxPriorityFeePerGas ?? fd.gasPrice ?? ethers.parseUnits('10','gwei'))
  const mf = (fd.maxFeePerGas ?? fd.gasPrice ?? ethers.parseUnits('30','gwei'))
  const bump = (x: bigint) => (x * 150n) / 100n
  const tx = await o.pushPrice(p, { maxPriorityFeePerGas: bump(mp), maxFeePerGas: bump(mf) })
  console.log('tx', tx.hash)
  await tx.wait()
  console.log('pushed random price', price)
}

main().catch((e)=>{ console.error(e); process.exit(1) })
