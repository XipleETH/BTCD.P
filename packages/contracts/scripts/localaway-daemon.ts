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
//  ALWAYS_POLL_EVERY_MINUTE=true (disable backoff and keep fixed cadence)
//  PUSH_EVERY_TICK=true (push on-chain even if no goals to keep chart continuity)

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
  const alwaysPollEveryMinute = String(process.env.ALWAYS_POLL_EVERY_MINUTE || 'true').toLowerCase() === 'true'
  const pushEveryTick = String(process.env.PUSH_EVERY_TICK || 'true').toLowerCase() === 'true'
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
      let totalHomeDelta = 0
      let totalAwayDelta = 0
      // Process per fixture and push one tx per goal
      for (const f of fixtures) {
        const id = Number(f?.id)
        if (!id) continue
        const curHome = Number(f?.home?.goals ?? 0) || 0
        const curAway = Number(f?.away?.goals ?? 0) || 0
        const prev = lastScores.get(id) || { home: curHome, away: curAway }
        let stepHome = prev.home
        let stepAway = prev.away
        const dHome = Math.max(0, curHome - prev.home)
        const dAway = Math.max(0, curAway - prev.away)
        // Log snapshot
        if (dHome > 0 || dAway > 0) {
          console.log(new Date().toISOString(), `[SCORE] ${f?.league?.name ?? 'League'}: ${f?.home?.name ?? 'Home'} ${curHome}-${curAway} ${f?.away?.name ?? 'Away'} (Δ +${dHome}/-${dAway})`)
        }
        // For each home goal, push a separate tx and ingest meta
        for (let i = 0; i < dHome; i++) {
          stepHome += 1
          totalHomeDelta += 1
          // Update index incrementally: +1
          currentIndex = currentIndex + 1
          const scaled = toScaled(currentIndex)
          const tx = await oracle.pushPrice(scaled)
          await tx.wait()
          console.log(new Date().toISOString(), 'index', currentIndex, 'tx', tx.hash, `(goal +1)`)
          // sync to DB for chart with metadata
          if (ingestUrl && ingestSecret) {
            try {
              const time = Math.floor(Date.now() / 1000)
              const value = currentIndex
              const meta = {
                type: 'goal', side: 'home', fixtureId: id,
                league: f?.league?.name, leagueId: f?.league?.id,
                home: { id: f?.home?.id, name: f?.home?.name },
                away: { id: f?.away?.id, name: f?.away?.name },
                score: { home: stepHome, away: stepAway }
              }
              await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
            } catch (e: any) {
              console.warn('ingest sync failed', e?.message || e)
            }
          }
        }
        // For each away goal, push a separate tx and ingest meta
        for (let i = 0; i < dAway; i++) {
          stepAway += 1
          totalAwayDelta += 1
          // Update index incrementally: -1
          currentIndex = currentIndex - 1
          if (currentIndex < 1) currentIndex = 1
          const scaled = toScaled(currentIndex)
          const tx = await oracle.pushPrice(scaled)
          await tx.wait()
          console.log(new Date().toISOString(), 'index', currentIndex, 'tx', tx.hash, `(goal -1)`)
          if (ingestUrl && ingestSecret) {
            try {
              const time = Math.floor(Date.now() / 1000)
              const value = currentIndex
              const meta = {
                type: 'goal', side: 'away', fixtureId: id,
                league: f?.league?.name, leagueId: f?.league?.id,
                home: { id: f?.home?.id, name: f?.home?.name },
                away: { id: f?.away?.id, name: f?.away?.name },
                score: { home: stepHome, away: stepAway }
              }
              await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
            } catch (e: any) {
              console.warn('ingest sync failed', e?.message || e)
            }
          }
        }
        // Store final observed score
        lastScores.set(id, { home: curHome, away: curAway, homeName: f?.home?.name, awayName: f?.away?.name, leagueName: f?.league?.name })
      }

      // If no new goals in this period
      if (totalHomeDelta === 0 && totalAwayDelta === 0) {
        if (pushEveryTick) {
          // Push same index to keep chart continuity
          const scaled = toScaled(currentIndex)
          const tx = await oracle.pushPrice(scaled)
          await tx.wait()
          console.log(new Date().toISOString(), 'no-goal tick pushed', 'index', currentIndex, 'tx', tx.hash)
          if (ingestUrl && ingestSecret) {
            try {
              const time = Math.floor(Date.now() / 1000)
              const value = currentIndex
              const meta = { type: 'tick', note: 'no-goal' }
              await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
            } catch (e: any) {
              console.warn('ingest sync failed', e?.message || e)
            }
          }
        } else {
          console.log(new Date().toISOString(), 'no new goals — skip on-chain push this interval')
        }
      }

      // All pushes are handled per-goal above; if no goals we optionally pushed a no-goal tick.
      // reset interval back to base after activity
      currentInterval = baseInterval
    } catch (e: any) {
      console.error('tick error', e?.message || e)
    }
    // cadence control
    if (alwaysPollEveryMinute) {
      currentInterval = baseInterval
    } else {
      // if no goals were found last loop and not forcing per-minute, allow backoff
      currentInterval = Math.min(Math.floor(currentInterval * 1.5), maxInterval)
    }
    await sleep(currentInterval)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
