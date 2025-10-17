import { ethers, network } from 'hardhat'

// Env: RANDOM_ORACLE, INTERVAL_MS(optional), MAX_BPS(optional)
// Changes price every INTERVAL by a random delta in [-MAX_BPS, +MAX_BPS] bps of current price.
// Defaults: INTERVAL_MS=1000, MAX_BPS=10 (0.10%)

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

async function main() {
  const oracleAddr = process.env.RANDOM_ORACLE
  if (!oracleAddr) throw new Error('RANDOM_ORACLE not set')
  const [signer] = await ethers.getSigners()
  const oracle = await ethers.getContractAt('RandomOracle', oracleAddr)
  console.log('Random daemon on', network.name, 'oracle', oracleAddr, 'as', await signer.getAddress())

  const interval = Number(process.env.INTERVAL_MS || '1000')
  const maxBps = Number(process.env.MAX_BPS || '10') // 10 bps = 0.10%
  if (maxBps <= 0 || maxBps > 100) throw new Error('MAX_BPS out of bounds (1..100)')

  while (true) {
    try {
      const latest = await oracle.latestAnswer()
      // Random integer between -maxBps and +maxBps inclusive
      const stepBps = Math.floor(Math.random() * (2 * maxBps + 1)) - maxBps
      // newPrice = latest * (1 + stepBps/10000)
      const latestBig = BigInt(latest)
      const delta = (latestBig * BigInt(stepBps)) / 10000n
      let next = latestBig + delta
      if (next <= 0n) next = 1n
      const tx = await oracle.pushPrice(next)
      await tx.wait()
      // Optional: log sparsely
      console.log(new Date().toISOString(), 'stepBps', stepBps, 'price', next.toString())
    } catch (e) {
      console.error('tick error', e)
    }
    await sleep(interval)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
