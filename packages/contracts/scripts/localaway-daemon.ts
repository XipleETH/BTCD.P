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
//  API_SPORTS_KEY (optional; fallback to API_FOOTBALL_KEY) for basketball/volleyball/handball

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
  const apiKey = (process.env.API_SPORTS_KEY || process.env.API_FOOTBALL_KEY || '').trim()

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

  // Track last known scores per fixture to detect deltas (per sport)
  const lastFootball = new Map<number, { home:number, away:number, homeName?:string, awayName?:string, leagueName?:string }>()
  const lastBasket = new Map<number, { home:number, away:number, homeName?:string, awayName?:string, leagueName?:string }>()
  const lastVolley  = new Map<number, { home:number, away:number, homeName?:string, awayName?:string, leagueName?:string }>()
  const lastHand    = new Map<number, { home:number, away:number, homeName?:string, awayName?:string, leagueName?:string }>()
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
      // FOOTBALL: single upstream call; apply +/-0.1% per goal per game (one tx per game)
      const fixtures = await fetchLiteFixtures(apiBase, apiSecret)
      let footballActivity = 0
      for (const f of fixtures) {
        const id = Number(f?.id); if (!id) continue
        const curHome = Number(f?.home?.goals ?? 0) || 0
        const curAway = Number(f?.away?.goals ?? 0) || 0
        const prev = lastFootball.get(id) || { home: curHome, away: curAway }
        const dHome = Math.max(0, curHome - prev.home)
        const dAway = Math.max(0, curAway - prev.away)
        if (dHome === 0 && dAway === 0) continue
        footballActivity++
        const netPct = (dHome * 0.001) - (dAway * 0.001) // 0.1% per goal
        // apply multiplicative change
        currentIndex = Math.max(1, currentIndex * (1 + netPct))
        const scaled = toScaled(currentIndex)
        const tx = await oracle.pushPrice(scaled)
        await tx.wait()
        console.log(new Date().toISOString(), `[FOOTBALL] ${f?.league?.name ?? 'League'} ${f?.home?.name} ${curHome}-${curAway} ${f?.away?.name} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
        if (ingestUrl && ingestSecret) {
          try {
            const time = Math.floor(Date.now() / 1000)
            const value = currentIndex
            const meta = {
              type: 'point', sport: 'football', fixtureId: id,
              league: f?.league?.name, leagueId: (f as any)?.league?.id,
              home: { id: f?.home?.id, name: f?.home?.name },
              away: { id: f?.away?.id, name: f?.away?.name },
              score: { home: curHome, away: curAway },
              delta: { home: dHome, away: dAway },
              deltaPct: netPct
            }
            await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
          } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
        }
        lastFootball.set(id, { home: curHome, away: curAway, homeName: f?.home?.name, awayName: f?.away?.name, leagueName: f?.league?.name })
      }

      // SCHEDULED SPORTS every 15 minutes
      const now = new Date(); const minute = now.getUTCMinutes(); // use UTC to be consistent
      const processBasket = [5,20,35,50].includes(minute)
      const processVolley  = [10,25,40,55].includes(minute)
      const processHand    = [0,15,30,45].includes(minute)

      const headers = apiKey ? { 'x-apisports-key': apiKey, 'accept':'application/json' } : undefined

      // BASKETBALL: 0.001% per point (home +, away -), one tx per game
      if (processBasket && apiKey) {
        try {
          const url = new URL('https://v1.basketball.api-sports.io/games')
          url.searchParams.set('live', 'all')
          const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
          const games = Array.isArray(resp.data?.response) ? resp.data.response : []
          for (const g of games) {
            const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
            const leagueName = g?.league?.name || g?.country?.name || 'League'
            const home = g?.scores?.home || {}
            const away = g?.scores?.away || {}
            // prefer total if present, else sum quarters
            const totHome = Number(home?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(home?.[k] ?? 0) || 0), 0))) || 0
            const totAway = Number(away?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(away?.[k] ?? 0) || 0), 0))) || 0
            const prev = lastBasket.get(id) || { home: totHome, away: totAway }
            const dHome = Math.max(0, totHome - prev.home)
            const dAway = Math.max(0, totAway - prev.away)
            if (dHome === 0 && dAway === 0) { lastBasket.set(id, { home: totHome, away: totAway }); continue }
            const netPct = (dHome * 0.00001) - (dAway * 0.00001) // 0.001% = 0.00001 fraction
            currentIndex = Math.max(1, currentIndex * (1 + netPct))
            const scaled = toScaled(currentIndex)
            const tx = await oracle.pushPrice(scaled)
            await tx.wait()
            console.log(new Date().toISOString(), `[BASKET] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
            if (ingestUrl && ingestSecret) {
              try {
                const time = Math.floor(Date.now()/1000)
                const value = currentIndex
                const meta = { type:'point', sport:'basketball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct }
                await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
              } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
            }
            lastBasket.set(id, { home: totHome, away: totAway })
          }
        } catch (e:any) { console.warn('basketball fetch failed', e?.message || e) }
      }

      // VOLLEYBALL: 0.001% per point
      if (processVolley && apiKey) {
        try {
          const url = new URL('https://v1.volleyball.api-sports.io/games')
          url.searchParams.set('live', 'all')
          const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
          const games = Array.isArray(resp.data?.response) ? resp.data.response : []
          for (const g of games) {
            const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
            const leagueName = g?.league?.name || g?.country?.name || 'League'
            const periods = g?.scores?.periods || g?.periods || {}
            const sumSide = (side:any) => ['first','second','third','fourth','fifth'].reduce((s,k)=> s + (Number(periods?.[k]?.[side] ?? 0) || 0), 0)
            const totHome = Number(g?.scores?.home ?? sumSide('home')) || 0
            const totAway = Number(g?.scores?.away ?? sumSide('away')) || 0
            const prev = lastVolley.get(id) || { home: totHome, away: totAway }
            const dHome = Math.max(0, totHome - prev.home)
            const dAway = Math.max(0, totAway - prev.away)
            if (dHome === 0 && dAway === 0) { lastVolley.set(id, { home: totHome, away: totAway }); continue }
            const netPct = (dHome * 0.00001) - (dAway * 0.00001)
            currentIndex = Math.max(1, currentIndex * (1 + netPct))
            const scaled = toScaled(currentIndex)
            const tx = await oracle.pushPrice(scaled)
            await tx.wait()
            console.log(new Date().toISOString(), `[VOLLEY] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
            if (ingestUrl && ingestSecret) {
              try {
                const time = Math.floor(Date.now()/1000)
                const value = currentIndex
                const meta = { type:'point', sport:'volleyball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct }
                await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
              } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
            }
            lastVolley.set(id, { home: totHome, away: totAway })
          }
        } catch (e:any) { console.warn('volleyball fetch failed', e?.message || e) }
      }

      // HANDBALL: 0.01% per point
      if (processHand && apiKey) {
        try {
          const url = new URL('https://v1.handball.api-sports.io/games')
          url.searchParams.set('live', 'all')
          const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
          const games = Array.isArray(resp.data?.response) ? resp.data.response : []
          for (const g of games) {
            const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
            const leagueName = g?.league?.name || g?.country?.name || 'League'
            const totHome = Number(g?.scores?.home ?? 0) || 0
            const totAway = Number(g?.scores?.away ?? 0) || 0
            const prev = lastHand.get(id) || { home: totHome, away: totAway }
            const dHome = Math.max(0, totHome - prev.home)
            const dAway = Math.max(0, totAway - prev.away)
            if (dHome === 0 && dAway === 0) { lastHand.set(id, { home: totHome, away: totAway }); continue }
            const netPct = (dHome * 0.0001) - (dAway * 0.0001) // 0.01%
            currentIndex = Math.max(1, currentIndex * (1 + netPct))
            const scaled = toScaled(currentIndex)
            const tx = await oracle.pushPrice(scaled)
            await tx.wait()
            console.log(new Date().toISOString(), `[HANDBALL] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
            if (ingestUrl && ingestSecret) {
              try {
                const time = Math.floor(Date.now()/1000)
                const value = currentIndex
                const meta = { type:'point', sport:'handball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct }
                await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
              } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
            }
            lastHand.set(id, { home: totHome, away: totAway })
          }
        } catch (e:any) { console.warn('handball fetch failed', e?.message || e) }
      }

      // If no sport activity and configured to push continuity tick
      if (footballActivity === 0 && !processBasket && !processVolley && !processHand) {
        if (pushEveryTick) {
          const scaled = toScaled(currentIndex)
          const tx = await oracle.pushPrice(scaled)
          await tx.wait()
          console.log(new Date().toISOString(), 'no-activity tick pushed', 'index', currentIndex, 'tx', tx.hash)
          if (ingestUrl && ingestSecret) {
            try {
              const time = Math.floor(Date.now() / 1000)
              const value = currentIndex
              const meta = { type: 'tick', note: 'no-activity' }
              await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
            } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
          }
        } else {
          console.log(new Date().toISOString(), 'no new activity — skip on-chain push this interval')
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
