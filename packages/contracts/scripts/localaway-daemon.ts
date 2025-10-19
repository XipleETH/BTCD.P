import { ethers, network } from 'hardhat'
import axios from 'axios'

// Env:
//  LOCALAWAY_ORACLE (required for on-chain)
//  LOCALAWAY_PRIVATE_KEY (recommended dedicated key)
//  API_BASE (required) -> e.g., https://your-vercel-app.vercel.app/api/football-live-goals
//  API_SECRET (optional; must match Vercel env if configured)
//  CHAIN (e.g., base-sepolia)
//  INGEST_URL / INGEST_SECRET (optional for chart DB sync)
//  MARKET=localaway (default)
//  INTERVAL_MS (poll cadence; default 60000 = 1 min)

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

function toScaled(n: number): bigint {
  return BigInt(Math.round(n * 1e8))
}

type GoalEvent = {
  key: string
  fixtureId: number
  leagueName?: string
  homeName?: string
  awayName?: string
  team: 'home' | 'away' | 'unknown'
  minute: number | null
  player?: string | null
}

async function fetchAllGoals(apiBase: string, secret?: string): Promise<GoalEvent[]> {
  const url = new URL(apiBase)
  if (secret) url.searchParams.set('secret', secret)
  const resp = await axios.get(url.toString(), { timeout: 15000 })
  const fixtures = Array.isArray(resp.data?.fixtures) ? resp.data.fixtures : []
  const out: GoalEvent[] = []
  for (const f of fixtures) {
    const fixtureId = Number(f?.id)
    const leagueName = f?.league?.name as string | undefined
    const homeName = f?.home?.name as string | undefined
    const awayName = f?.away?.name as string | undefined
    const goals = Array.isArray(f?.goals) ? f.goals : []
    for (const g of goals) {
      const team = g?.team === 'home' ? 'home' : (g?.team === 'away' ? 'away' as const : 'unknown')
      const minute = (typeof g?.minute === 'number') ? g.minute : null
      const player = (g?.player ?? null) as (string | null)
      // API-Football events in our Edge map may not have unique IDs, so we compose a stable key
      const key = `${fixtureId}|${minute ?? 'na'}|${team}|${player ?? 'unk'}`
      out.push({ key, fixtureId, leagueName, homeName, awayName, team, minute, player })
    }
  }
  return out
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

  // 1-minute cadence by default
  const interval = Number(process.env.INTERVAL_MS || '60000')

  // Optional DB ingest for shared chart
  const ingestUrl = (process.env.INGEST_URL || '').trim()
  const ingestSecret = (process.env.INGEST_SECRET || '').trim()
  const chain = (process.env.CHAIN || (network.name === 'baseSepolia' ? 'base-sepolia' : (network.name === 'base' ? 'base' : network.name))).toLowerCase()
  const market = (process.env.MARKET || 'localaway').toLowerCase()

  // Track seen goal events to count only new ones each tick
  const seen = new Set<string>()
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
      // Fetch all goals from the Edge API
      const goals = await fetchAllGoals(apiBase, apiSecret)
      // Count only new goals since last tick
      let homeDelta = 0
      let awayDelta = 0
      const newEvents: GoalEvent[] = []
      for (const g of goals) {
        if (seen.has(g.key)) continue
        seen.add(g.key)
        if (g.team === 'home') homeDelta += 1
        else if (g.team === 'away') awayDelta += 1
        newEvents.push(g)
      }

      // If no new goals in this period, sleep and continue without on-chain tx
      if (homeDelta === 0 && awayDelta === 0) {
        console.log(new Date().toISOString(), 'no new goals in this interval')
        await sleep(interval)
        continue
      }

      // Update index incrementally: +1 per home goal, -1 per away goal
      currentIndex = currentIndex + homeDelta - awayDelta
      if (currentIndex < 1) currentIndex = 1

      // Log details of new goals
      for (const ev of newEvents) {
        const who = ev.team.toUpperCase()
        const vs = `${ev.homeName ?? 'Home'} vs ${ev.awayName ?? 'Away'}`
        const lg = ev.leagueName ?? 'Unknown League'
        const mm = ev.minute != null ? `min ${ev.minute}` : 'min ?'
        const pl = ev.player ? ` by ${ev.player}` : ''
        console.log(`${new Date().toISOString()} [GOAL] ${lg}: ${vs} — ${who} ${mm}${pl}`)
      }

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
    } catch (e: any) {
      console.error('tick error', e?.message || e)
    }
    await sleep(interval)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
