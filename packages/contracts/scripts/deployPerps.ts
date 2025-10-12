import { ethers } from 'hardhat'
import * as dotenv from 'dotenv'

dotenv.config()

async function main() {
  const [deployer] = await ethers.getSigners()
  const oracleAddr = process.env.ORACLE
  if (!oracleAddr) throw new Error('Set ORACLE in .env to existing BTCDOracle')

  console.log('Deployer', deployer.address)
  console.log('Using Oracle', oracleAddr)

  const Perps = await ethers.getContractFactory('BTCDPerps')
  const perps = await Perps.deploy(oracleAddr, { maxFeePerGas: ethers.parseUnits('0.2', 'gwei') })
  await perps.waitForDeployment()
  console.log('Perps:', await perps.getAddress())
}

main().catch((e)=>{ console.error(e); process.exit(1) })
