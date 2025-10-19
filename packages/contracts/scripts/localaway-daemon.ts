import { ethers, network } from 'hardhat'
import axios from 'axios'

// Env:
//  LOCALAWAY_ORACLE (required for on-chain)
//  LOCALAWAY_PRIVATE_KEY (recommended dedicated key)
//  API_BASE (required) -> e.g., https://your-vercel-app.vercel.app/api/football-live-goals
//  API_SECRET (optional; must match Vercel env if configured)
//  LEAGUES (optional CSV of league IDs to limit API-Football calls, e.g., "39,140,135,78")
//  CHAIN (e.g., base-sepolia)
//  INGEST_URL / INGEST_SECRET (optional for chart DB sync)
//  MARKET=localaway (default)
//  INTERVAL_MS (base poll cadence; default 60000 = 1 min)
//  MAX_INTERVAL_MS (optional upper bound for dynamic backoff; default 300000 = 5 min)

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

function toScaled(n: number): bigint {
  return BigInt(Math.round(n * 1e8))
}

type LiteFixture = {
  id: number
  league?: { id?: number, name?: string }
  home?: { id?: number, name?: string, goals?: number|null }
  away?: { id?: number, name?: string, goals?: number|null }
}

async function fetchLiteFixtures(apiBase: string, secret?: string): Promise<LiteFixture[]> {
  const url = new URL(apiBase)
  if (secret) url.searchParams.set('secret', secret)
  // Pass-through optional leagues filter to reduce number of live fixtures processed upstream
  const leaguesCsv = (process.env.LEAGUES || '').trim()
  if (leaguesCsv) url.searchParams.set('leagues', leaguesCsv)
  url.searchParams.set('lite', '1')
  const resp = await axios.get(url.toString(), { timeout: 15000 })
  const fixtures = Array.isArray(resp.data?.fixtures) ? resp.data.fixtures : []
  return fixtures
}

async function main() {
  const oracleAddr = (process.env.LOCALAWAY_ORACLE || '').trim()
  if (!oracleAddr) throw new Error('LOCALAWAY_ORACLE not set')
  const apiBase = (process.env.API_BASE || '').trim()
  if (!apiBase) throw new Error('API_BASE not set (point to /api/football-live-goals)')
  const apiSecret = (process.env.API_SECRET || '').trim()

  // Prefer dedicated signer
  const altPkRaw = (process.env.LOCALAWAY_PRIVATE_KEY || '').trim()
  let signer = (await ethers.getSigners())[0]
  if (altPkRaw) {
    const pk = altPkRaw.startsWith('0x') ? altPkRaw : ('0x' + altPkRaw)
    signer = new (ethers as any).Wallet(pk, ethers.provider)
  }
  const oracle = await ethers.getContractAt('LocalAwayOracle', oracleAddr, signer as any)
  console.log('LocalAway daemon on', network.name, 'oracle', oracleAddr, 'as', await (signer as any).getAddress())

  // 1-minute cadence by default (base), with optional dynamic backoff up to MAX_INTERVAL_MS
  const baseInterval = Number(process.env.INTERVAL_MS || '60000')
  const maxInterval = Number(process.env.MAX_INTERVAL_MS || '300000')
  let currentInterval = baseInterval

  // Optional DB ingest for shared chart
  const ingestUrl = (process.env.INGEST_URL || '').trim()
  const ingestSecret = (process.env.INGEST_SECRET || '').trim()
  const chain = (process.env.CHAIN || (network.name === 'baseSepolia' ? 'base-sepolia' : (network.name === 'base' ? 'base' : network.name))).toLowerCase()
  const market = (process.env.MARKET || 'localaway').toLowerCase()

  // Track last known scores per fixture to detect deltas
  const lastScores = new Map<number, { home: number, away: number, homeName?: string, awayName?: string, leagueName?: string }>()
  // Initialize current index from on-chain value to preserve continuity
  let currentIndex: number
  try {
    const latest = await oracle.latestAnswer()
    const latestNum = Number(ethers.formatUnits(latest, 8))
    // If somehow zero/invalid, fallback to 10000
    currentIndex = Number.isFinite(latestNum) && latestNum > 0 ? Math.floor(latestNum) : 10000
  } catch {
    currentIndex = 10000
  }

  while (true) {
    try {
      // Fetch lite fixtures (scores only) from the Edge API
      const fixtures = await fetchLiteFixtures(apiBase, apiSecret)
      // Compute deltas by comparing current scores vs last tick
      let homeDelta = 0
      let awayDelta = 0
      for (const f of fixtures) {
        const id = Number(f?.id)
        if (!id) continue
        const curHome = Number(f?.home?.goals ?? 0) || 0
        const curAway = Number(f?.away?.goals ?? 0) || 0
        const prev = lastScores.get(id) || { home: curHome, away: curAway }
        const dHome = Math.max(0, curHome - prev.home)
        const dAway = Math.max(0, curAway - prev.away)
        if (dHome > 0 || dAway > 0) {
          console.log(new Date().toISOString(), `[SCORE] ${f?.league?.name ?? 'League'}: ${f?.home?.name ?? 'Home'} ${curHome}-${curAway} ${f?.away?.name ?? 'Away'} (Δ +${dHome}/-${dAway})`)
        }
        homeDelta += dHome
        awayDelta += dAway
        lastScores.set(id, { home: curHome, away: curAway, homeName: f?.home?.name, awayName: f?.away?.name, leagueName: f?.league?.name })
      }

      // If no new goals in this period, sleep and continue without on-chain tx
      if (homeDelta === 0 && awayDelta === 0) {
        console.log(new Date().toISOString(), 'no new goals — sleeping', currentInterval, 'ms')
        await sleep(currentInterval)
        // increase interval with gentle backoff, capped
        currentInterval = Math.min(Math.floor(currentInterval * 1.5), maxInterval)
        continue
      }

      // Update index incrementally: +1 per home goal, -1 per away goal
      currentIndex = currentIndex + homeDelta - awayDelta
      if (currentIndex < 1) currentIndex = 1

      // Optional: could log per-fixture score deltas above; already logged

      // Push new index on-chain
      const scaled = toScaled(currentIndex)
      const tx = await oracle.pushPrice(scaled)
      await tx.wait()
      console.log(new Date().toISOString(), 'index', currentIndex, 'tx', tx.hash, `(Δ +${homeDelta} / -${awayDelta})`)

      // sync to DB for chart
      if (ingestUrl && ingestSecret) {
        try {
          const time = Math.floor(Date.now() / 1000)
          const value = currentIndex
          await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value }, { timeout: 8000 })
        } catch (e: any) {
          console.warn('ingest sync failed', e?.message || e)
        }
      }
      // reset interval back to base after activity
      currentInterval = baseInterval
    } catch (e: any) {
      console.error('tick error', e?.message || e)
    }
    await sleep(currentInterval)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
