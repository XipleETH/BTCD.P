import * as dotenv from 'dotenv'
import { ethers } from 'hardhat'

dotenv.config()

// Simple keeper script:
// - Reads a list of trader addresses from env TRADERS (comma-separated) or from on-chain events (optional later)
// - For each trader, tries closeIfTriggered; then tries liquidation if canLiquidate
// - Ignores failures so the loop continues

const PERPS_ADDR = process.env.PERPS

async function main() {
  if (!PERPS_ADDR) throw new Error('Set PERPS in .env to BTCDPerps address')
  const perps = await ethers.getContractAt('BTCDPerps', PERPS_ADDR)

  const tradersCsv = process.env.TRADERS || ''
  const traders = tradersCsv
    .split(',')
    .map(s => s.trim())
    .filter(s => /^0x[0-9a-fA-F]{40}$/.test(s))

  if (traders.length === 0) {
    console.log('No traders provided via TRADERS env. Nothing to do.')
    return
  }

  console.log('Keepers scanning traders:', traders)

  for (const t of traders) {
    try {
      const [trigger, hitSL, hitTP] = await (perps as any).shouldClose(t)
      if (trigger) {
        try {
          const tx = await (perps as any).closeIfTriggered(t)
          console.log('closeIfTriggered sent', t, 'tx=', tx.hash, 'flags sl/tp=', hitSL, hitTP)
          await tx.wait()
          continue
        } catch (e) {
          console.warn('closeIfTriggered failed for', t, e)
        }
      }
    } catch (e) {
      console.warn('shouldClose view failed for', t, e)
    }

    try {
      const canLiq: boolean = await (perps as any).canLiquidate(t)
      if (canLiq) {
        try {
          const tx = await (perps as any).liquidate(t)
          console.log('liquidate sent', t, 'tx=', tx.hash)
          await tx.wait()
          continue
        } catch (e) {
          console.warn('liquidate failed for', t, e)
        }
      }
    } catch (e) {
      console.warn('canLiquidate view failed for', t, e)
    }
  }

  console.log('Keepers run finished')
}

main().catch((e)=>{ console.error(e); process.exit(1) })
