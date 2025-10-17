import { ethers } from 'hardhat'

// Env:
// - ORACLE: address of the oracle contract
// - KIND: 'btcd' | 'random' (default 'btcd')
// - UPDATER: address to grant as updater

async function main() {
  const oracleAddr = (process.env.ORACLE || '').trim()
  const updater = (process.env.UPDATER || '').trim()
  const kind = ((process.env.KIND || 'btcd').trim().toLowerCase()) as 'btcd'|'random'
  if (!oracleAddr || !updater) throw new Error('Set ORACLE and UPDATER env vars')

  const name = kind === 'random' ? 'RandomOracle' : 'BTCDOracle'
  const [signer] = await ethers.getSigners()
  console.log('Granting updater on', name, 'at', oracleAddr, 'to', updater, 'from', await signer.getAddress())
  const oracle = await ethers.getContractAt(name, oracleAddr)
  const tx = await (oracle as any).setUpdater(updater, true)
  console.log('tx', tx.hash)
  await tx.wait()
  console.log('Updater granted')
}

main().catch((e)=>{ console.error(e); process.exit(1) })
