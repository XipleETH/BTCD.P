import { ethers, network } from 'hardhat'
import * as dotenv from 'dotenv'

dotenv.config()

async function main() {
  const [deployer] = await ethers.getSigners()
  const oracleAddr = process.env.RANDOM_ORACLE || process.env.ORACLE
  if (!oracleAddr) throw new Error('Set RANDOM_ORACLE in .env to existing RandomOracle')

  console.log('Deployer', deployer.address)
  console.log('Using Random Oracle', oracleAddr)

  const Perps = await ethers.getContractFactory('RandomPerps')
  const perps = await Perps.deploy(oracleAddr)
  await perps.waitForDeployment()
  const perpsAddr = await perps.getAddress()
  console.log('RandomPerps deployed on', network.name, '->', perpsAddr)
}

main().catch((e)=>{ console.error(e); process.exit(1) })
