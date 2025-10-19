import { ethers } from 'hardhat'
import * as dotenv from 'dotenv'

dotenv.config()

async function main() {
  const oracle = (process.env.RANDOM_ORACLE || process.env.ORACLE || '').trim()
  const pkRaw = (process.env.RANDOM_PRIVATE_KEY || '').trim()
  if (!oracle) throw new Error('Set RANDOM_ORACLE env')
  if (!pkRaw) throw new Error('Set RANDOM_PRIVATE_KEY env')
  const pk = pkRaw.startsWith('0x') ? pkRaw : ('0x' + pkRaw)
  const wallet = new (ethers as any).Wallet(pk)
  const updaterAddr = await wallet.getAddress()

  const [owner] = await ethers.getSigners()
  console.log('Granting Random updater:', updaterAddr, 'on', oracle, 'from owner', await owner.getAddress())
  const rand = await ethers.getContractAt('RandomOracle', oracle, owner as any)
  const tx = await (rand as any).setUpdater(updaterAddr, true)
  console.log('tx', tx.hash)
  await tx.wait()
  console.log('Updater granted for', updaterAddr)
}

main().catch((e)=>{ console.error(e); process.exit(1) })
