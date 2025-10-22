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

async function simulateCall(to: string, data: string): Promise<void> {
  // Low-level static call to detect reverts before sending a tx
  await ethers.provider.call({ to, data })
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
  if (!apiBase) throw new Error('API_BASE not set (point to /api/football-live-goals or /api/sports-live)')
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
  const signerAddr = await (signer as any).getAddress()
  console.log('LocalAway daemon on', network.name, 'oracle', oracleAddr, 'as', signerAddr)
  try {
    const ok = await (oracle as any).isUpdater(signerAddr)
    console.log('isUpdater?', ok)
  } catch {}

  // 1-minute cadence by default (base), with optional dynamic backoff up to MAX_INTERVAL_MS
  const baseInterval = Number(process.env.INTERVAL_MS || '60000')
  const maxInterval = Number(process.env.MAX_INTERVAL_MS || '300000')
  const alwaysPollEveryMinute = String(process.env.ALWAYS_POLL_EVERY_MINUTE || 'true').toLowerCase() === 'true'
  const pushEveryTick = String(process.env.PUSH_EVERY_TICK || 'true').toLowerCase() === 'true'
  const stagger15m = String(process.env.STAGGER_15M || 'true').toLowerCase() === 'true'
  // Optional fallback to legacy football processing when aggregator returns empty for several cycles
  const fallbackLegacy = String(process.env.AGGREGATOR_FALLBACK_LEGACY || 'true').toLowerCase() === 'true'
  const fallbackEmptyCycles = Math.max(1, Number(process.env.AGGREGATOR_FALLBACK_EMPTY_CYCLES || '3'))
  let emptyCycles = 0
  let currentInterval = baseInterval

  // Optional DB ingest for shared chart
  const ingestUrl = (process.env.INGEST_URL || '').trim()
  const ingestSecret = (process.env.INGEST_SECRET || '').trim()
  const chain = (process.env.CHAIN || (network.name === 'baseSepolia' ? 'base-sepolia' : (network.name === 'base' ? 'base' : network.name))).toLowerCase()
  const market = (process.env.MARKET || 'localaway').toLowerCase()
  // Optional shared snapshot API (root /api/last guarded by INGEST_SECRET)
  const lastApi = (process.env.LAST_URL || (ingestUrl ? ingestUrl.replace('/ingest', '/last') : '')).trim()

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

  // helpers for preflight push
  const preflightAndPush = async (nextIndex: number, label: string): Promise<{ ok: boolean, hash?: string, err?: any }> => {
    const scaled = toScaled(nextIndex)
    try {
      const data = (oracle as any).interface.encodeFunctionData('pushPrice', [scaled])
      await simulateCall(oracleAddr, data)
    } catch (e:any) {
      console.warn('preflight push failed ('+label+') — skipping send', e?.message || e)
      return { ok: false, err: e }
    }
    try {
      const tx = await oracle.pushPrice(scaled)
      await tx.wait()
      return { ok: true, hash: tx.hash }
    } catch (e:any) {
      console.warn('send push failed ('+label+')', e?.message || e)
      return { ok: false, err: e }
    }
  }

  // derive specific endpoints for football when API_BASE points to aggregator
  const footballUrl = (() => {
    const override = (process.env.FOOTBALL_URL || '').trim()
    if (override) return override
    if (apiBase.includes('/api/sports-live')) return apiBase.replace('/api/sports-live','/api/football-live-goals')
    return apiBase
  })()

  // slot scheduler state
  let lastSlot = -1
  // per-sport cooldown to guarantee max 1 call per 15 minutes even if loop conditions misfire
  const FIFTEEN_SEC = 900
  const nextAllowed: Record<'football'|'handball'|'volleyball'|'basketball', number> = {
    football: 0,
    handball: 0,
    volleyball: 0,
    basketball: 0,
  }
  const canRun = (sport: keyof typeof nextAllowed, nowSec: number) => nowSec >= (nextAllowed[sport] || 0)
  const markRun = (sport: keyof typeof nextAllowed, nowSec: number) => { nextAllowed[sport] = nowSec + FIFTEEN_SEC }

  while (true) {
    try {
      let footballActivity = 0
      let anyActivity = false
      const aggregatorMode = apiBase.includes('/api/sports-live')
      // Staggered mode first, then aggregator, else legacy
      if (stagger15m) {
          const nowSec = Math.floor(Date.now() / 1000)
          const slot = Math.floor((nowSec % 900) / 225) // 0..3
          if (slot !== lastSlot) {
            lastSlot = slot
            console.log(new Date().toISOString(), `[STAGGER] slot=${slot} (0=football,1=handball,2=volleyball,3=basketball)`)            
            // order: 0=football, 1=handball, 2=volleyball, 3=basketball
            if (slot === 0) {
              // FOOTBALL (internal endpoint)
              try {
                if (!canRun('football', nowSec)) { console.log(new Date().toISOString(), '[STAGGER] football cooldown active — skip'); }
                else {
                  markRun('football', nowSec)
                const fixtures = await fetchLiteFixtures(footballUrl, apiSecret)
                for (const f of fixtures) {
                  const id = Number(f?.id); if (!id) continue
                  const curHome = Number(f?.home?.goals ?? 0) || 0
                  const curAway = Number(f?.away?.goals ?? 0) || 0
                  let prev = lastFootball.get(id)
                  if (!prev && lastApi && ingestSecret) {
                    try {
                      const u = new URL(lastApi)
                      u.searchParams.set('secret', ingestSecret)
                      u.searchParams.set('sport', 'football')
                      u.searchParams.set('fixture', String(id))
                      const r = await axios.get(u.toString(), { timeout: 8000 })
                      if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                        prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                      }
                    } catch {}
                  }
                  prev = prev || { home: curHome, away: curAway }
                  const dHome = Math.max(0, curHome - prev.home)
                  const dAway = Math.max(0, curAway - prev.away)
                  if (!dHome && !dAway) { lastFootball.set(id, { home: curHome, away: curAway }); continue }
                  anyActivity = true
                  const netPct = (dHome * 0.001) - (dAway * 0.001)
                  currentIndex = Math.max(1, currentIndex * (1 + netPct))
                  const push = await preflightAndPush(currentIndex, 'football')
                  if (push.ok && push.hash) {
                    console.log(new Date().toISOString(), `[FOOTBALL][STAGGER] ${f?.league?.name ?? 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
                  } else {
                    console.log(new Date().toISOString(), `[FOOTBALL][STAGGER][NO-TX] ${f?.league?.name ?? 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
                  }
                  if (ingestUrl && ingestSecret) {
                    try {
                      const time = Math.floor(Date.now()/1000)
                      const value = currentIndex
                      const meta = { type:'point', sport:'football', fixtureId: id, league: f?.league?.name, leagueId: (f as any)?.league?.id, home: { id:f?.home?.id, name:f?.home?.name }, away: { id:f?.away?.id, name:f?.away?.name }, score:{ home: curHome, away: curAway }, delta:{ home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                      await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
                    } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
                  }
                  lastFootball.set(id, { home: curHome, away: curAway })
                  if (lastApi && ingestSecret) { try { await axios.post(lastApi, { secret: ingestSecret, sport: 'football', fixture: id, home: curHome, away: curAway }, { timeout: 8000 }) } catch {} }
                }
                }
              } catch (e:any) { console.warn('football stagger fetch failed', e?.message || e) }
            }
            if (slot === 1 && apiKey) {
              // HANDBALL (date-based)
              try {
                if (!canRun('handball', nowSec)) { console.log(new Date().toISOString(), '[STAGGER] handball cooldown active — skip'); }
                else {
                  markRun('handball', nowSec)
                const headers = { 'x-apisports-key': apiKey, 'accept': 'application/json' }
                const url = new URL('https://v1.handball.api-sports.io/games')
                const dateStr = new Date().toISOString().slice(0,10)
                url.searchParams.set('date', dateStr)
                url.searchParams.set('timezone', 'UTC')
                const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
                const games = Array.isArray(resp.data?.response) ? resp.data.response : []
                for (const g of games) {
                  const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
                  const totHome = Number(g?.scores?.home ?? 0) || 0
                  const totAway = Number(g?.scores?.away ?? 0) || 0
                  let prev = lastHand.get(id)
                  if (!prev && lastApi && ingestSecret) {
                    try {
                      const u = new URL(lastApi)
                      u.searchParams.set('secret', ingestSecret)
                      u.searchParams.set('sport', 'handball')
                      u.searchParams.set('fixture', String(id))
                      const r = await axios.get(u.toString(), { timeout: 8000 })
                      if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                        prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                      }
                    } catch {}
                  }
                  prev = prev || { home: totHome, away: totAway }
                  const dHome = Math.max(0, totHome - prev.home)
                  const dAway = Math.max(0, totAway - prev.away)
                  if (!dHome && !dAway) { lastHand.set(id, { home: totHome, away: totAway }); continue }
                  anyActivity = true
                  const netPct = (dHome * 0.0001) - (dAway * 0.0001)
                  currentIndex = Math.max(1, currentIndex * (1 + netPct))
                  const push = await preflightAndPush(currentIndex, 'handball')
                  if (push.ok && push.hash) {
                    console.log(new Date().toISOString(), `[HANDBALL][STAGGER] ${g?.league?.name || g?.country?.name || 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
                  } else {
                    console.log(new Date().toISOString(), `[HANDBALL][STAGGER][NO-TX] ${g?.league?.name || g?.country?.name || 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
                  }
                  if (ingestUrl && ingestSecret) {
                    try {
                      const time = Math.floor(Date.now()/1000)
                      const value = currentIndex
                      const meta = { type:'point', sport:'handball', league: g?.league?.name || g?.country?.name || 'League', home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta:{ home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                      await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
                    } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
                  }
                  lastHand.set(id, { home: totHome, away: totAway })
                  if (lastApi && ingestSecret) { try { await axios.post(lastApi, { secret: ingestSecret, sport: 'handball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {} }
                }
                }
              } catch (e:any) { console.warn('handball stagger fetch failed', e?.message || e) }
            }
            if (slot === 2 && apiKey) {
              // VOLLEYBALL (date-based)
              try {
                if (!canRun('volleyball', nowSec)) { console.log(new Date().toISOString(), '[STAGGER] volleyball cooldown active — skip'); }
                else {
                  markRun('volleyball', nowSec)
                const headers = { 'x-apisports-key': apiKey, 'accept': 'application/json' }
                const url = new URL('https://v1.volleyball.api-sports.io/games')
                const dateStr = new Date().toISOString().slice(0,10)
                url.searchParams.set('date', dateStr)
                url.searchParams.set('timezone', 'UTC')
                const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
                const games = Array.isArray(resp.data?.response) ? resp.data.response : []
                for (const g of games) {
                  const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
                  const periods = g?.scores?.periods || g?.periods || {}
                  const sumSide = (side:any) => ['first','second','third','fourth','fifth'].reduce((s,k)=> s + (Number(periods?.[k]?.[side] ?? 0) || 0), 0)
                  const totHome = Number(g?.scores?.home ?? sumSide('home')) || 0
                  const totAway = Number(g?.scores?.away ?? sumSide('away')) || 0
                  let prev = lastVolley.get(id)
                  if (!prev && lastApi && ingestSecret) {
                    try {
                      const u = new URL(lastApi)
                      u.searchParams.set('secret', ingestSecret)
                      u.searchParams.set('sport', 'volleyball')
                      u.searchParams.set('fixture', String(id))
                      const r = await axios.get(u.toString(), { timeout: 8000 })
                      if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                        prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                      }
                    } catch {}
                  }
                  prev = prev || { home: totHome, away: totAway }
                  const dHome = Math.max(0, totHome - prev.home)
                  const dAway = Math.max(0, totAway - prev.away)
                  if (!dHome && !dAway) { lastVolley.set(id, { home: totHome, away: totAway }); continue }
                  anyActivity = true
                  const netPct = (dHome * 0.00001) - (dAway * 0.00001)
                  currentIndex = Math.max(1, currentIndex * (1 + netPct))
                  const push = await preflightAndPush(currentIndex, 'volleyball')
                  if (push.ok && push.hash) {
                    console.log(new Date().toISOString(), `[VOLLEY][STAGGER] ${g?.league?.name || g?.country?.name || 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
                  } else {
                    console.log(new Date().toISOString(), `[VOLLEY][STAGGER][NO-TX] ${g?.league?.name || g?.country?.name || 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
                  }
                  if (ingestUrl && ingestSecret) {
                    try {
                      const time = Math.floor(Date.now()/1000)
                      const value = currentIndex
                      const meta = { type:'point', sport:'volleyball', league: g?.league?.name || g?.country?.name || 'League', home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta:{ home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                      await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
                    } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
                  }
                  lastVolley.set(id, { home: totHome, away: totAway })
                  if (lastApi && ingestSecret) { try { await axios.post(lastApi, { secret: ingestSecret, sport: 'volleyball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {} }
                }
                }
              } catch (e:any) { console.warn('volleyball stagger fetch failed', e?.message || e) }
            }
            if (slot === 3 && apiKey) {
              // BASKETBALL (date-based)
              try {
                if (!canRun('basketball', nowSec)) { console.log(new Date().toISOString(), '[STAGGER] basketball cooldown active — skip'); }
                else {
                  markRun('basketball', nowSec)
                const headers = { 'x-apisports-key': apiKey, 'accept': 'application/json' }
                const url = new URL('https://v1.basketball.api-sports.io/games')
                const dateStr = new Date().toISOString().slice(0,10)
                url.searchParams.set('date', dateStr)
                url.searchParams.set('timezone', 'UTC')
                const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
                const games = Array.isArray(resp.data?.response) ? resp.data.response : []
                for (const g of games) {
                  const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
                  const home = g?.scores?.home || {}
                  const away = g?.scores?.away || {}
                  const totHome = Number(home?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(home?.[k] ?? 0) || 0), 0))) || 0
                  const totAway = Number(away?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(away?.[k] ?? 0) || 0), 0))) || 0
                  let prev = lastBasket.get(id)
                  if (!prev && lastApi && ingestSecret) {
                    try {
                      const u = new URL(lastApi)
                      u.searchParams.set('secret', ingestSecret)
                      u.searchParams.set('sport', 'basketball')
                      u.searchParams.set('fixture', String(id))
                      const r = await axios.get(u.toString(), { timeout: 8000 })
                      if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                        prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                      }
                    } catch {}
                  }
                  prev = prev || { home: totHome, away: totAway }
                  const dHome = Math.max(0, totHome - prev.home)
                  const dAway = Math.max(0, totAway - prev.away)
                  if (!dHome && !dAway) { lastBasket.set(id, { home: totHome, away: totAway }); continue }
                  anyActivity = true
                  const netPct = (dHome * 0.00001) - (dAway * 0.00001)
                  currentIndex = Math.max(1, currentIndex * (1 + netPct))
                  const push = await preflightAndPush(currentIndex, 'basketball')
                  if (push.ok && push.hash) {
                    console.log(new Date().toISOString(), `[BASKET][STAGGER] ${g?.league?.name || g?.country?.name || 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
                  } else {
                    console.log(new Date().toISOString(), `[BASKET][STAGGER][NO-TX] ${g?.league?.name || g?.country?.name || 'League'} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
                  }
                  if (ingestUrl && ingestSecret) {
                    try {
                      const time = Math.floor(Date.now()/1000)
                      const value = currentIndex
                      const meta = { type:'point', sport:'basketball', league: g?.league?.name || g?.country?.name || 'League', home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta:{ home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                      await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
                    } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
                  }
                  lastBasket.set(id, { home: totHome, away: totAway })
                  if (lastApi && ingestSecret) { try { await axios.post(lastApi, { secret: ingestSecret, sport: 'basketball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {} }
                }
                }
              } catch (e:any) { console.warn('basketball stagger fetch failed', e?.message || e) }
            }
          } else {
            // same slot — do nothing to respect per-sport 15-minute cadence
          }
      } else if (aggregatorMode) {
        // One consolidated call: /api/sports-live
        try {
          const u = new URL(apiBase)
          if (apiSecret) u.searchParams.set('secret', apiSecret)
          u.searchParams.set('chain', chain)
          const resp = await axios.get(u.toString(), { timeout: 20000 })
          const items = Array.isArray(resp.data?.items) ? resp.data.items : []
          const summary = resp.data?.summary || { football: 0, basketball: 0, volleyball: 0, handball: 0 }
          if (!items.length) {
            emptyCycles++
            console.log(new Date().toISOString(), `aggregator: no deltas. live summary -> football:${summary.football} basket:${summary.basketball} volley:${summary.volleyball} hand:${summary.handball} (emptyCycles=${emptyCycles})`)
          } else {
            emptyCycles = 0
          }
          for (const it of items) {
            const sport = String(it?.sport || '')
            const id = Number(it?.fixtureId || 0); if (!id) continue
            const dHome = Number(it?.delta?.home || 0) || 0
            const dAway = Number(it?.delta?.away || 0) || 0
            const netPct = Number(it?.deltaPct || 0) || 0
            if (!dHome && !dAway) continue
            if (sport === 'football') footballActivity++
            anyActivity = true
            currentIndex = Math.max(1, currentIndex * (1 + netPct))
            const push = await preflightAndPush(currentIndex, sport)
            if (push.ok && push.hash) {
              console.log(new Date().toISOString(), `[${sport.toUpperCase()}] ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
            } else {
              console.log(new Date().toISOString(), `[${sport.toUpperCase()}][NO-TX] ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
            }
            if (ingestUrl && ingestSecret) {
              try {
                const time = Math.floor(Date.now()/1000)
                const value = currentIndex
                const meta = { type:'point', sport, fixtureId: id, league: it?.league, leagueId: it?.leagueId, home: it?.home, away: it?.away, score: it?.score, delta: { home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
              } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
            }
            // update local maps for visibility
            if (sport === 'football') lastFootball.set(id, { home: it?.score?.home||0, away: it?.score?.away||0 })
            if (sport === 'basketball') lastBasket.set(id, { home: it?.score?.home||0, away: it?.score?.away||0 })
            if (sport === 'volleyball') lastVolley.set(id, { home: it?.score?.home||0, away: it?.score?.away||0 })
            if (sport === 'handball') lastHand.set(id, { home: it?.score?.home||0, away: it?.score?.away||0 })
          }
          // Optional: if no items for several cycles, run legacy polls once to verify activity across all sports
          if (fallbackLegacy && emptyCycles >= fallbackEmptyCycles) {
            try {
              console.log(new Date().toISOString(), `aggregator empty ${emptyCycles} cycles — running legacy polls once`)
              // FOOTBALL legacy
              const fixtures = await fetchLiteFixtures(apiBase.replace('/api/sports-live','/api/football-live-goals'), apiSecret)
              console.log(new Date().toISOString(), `legacy football: fixtures=${fixtures.length}`)
              for (const f of fixtures) {
                const id = Number(f?.id); if (!id) continue
                const curHome = Number(f?.home?.goals ?? 0) || 0
                const curAway = Number(f?.away?.goals ?? 0) || 0
                let prev = lastFootball.get(id)
                if (!prev && lastApi && ingestSecret) {
                  try {
                    const u = new URL(lastApi)
                    u.searchParams.set('secret', ingestSecret)
                    u.searchParams.set('sport', 'football')
                    u.searchParams.set('fixture', String(id))
                    const r = await axios.get(u.toString(), { timeout: 8000 })
                    if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                      prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                    }
                  } catch {}
                }
                prev = prev || { home: curHome, away: curAway }
                const dHome = Math.max(0, curHome - prev.home)
                const dAway = Math.max(0, curAway - prev.away)
                console.log(new Date().toISOString(), `[FOOTBALL][LEGACY] ${f?.league?.name ?? 'League'} ${f?.home?.name} ${curHome}-${curAway} ${f?.away?.name} ΔH:${dHome} ΔA:${dAway}`)
                if (dHome || dAway) {
                  const netPct = (dHome * 0.001) - (dAway * 0.001)
                  currentIndex = Math.max(1, currentIndex * (1 + netPct))
                  const scaled = toScaled(currentIndex)
                  try {
                    const data = (oracle as any).interface.encodeFunctionData('pushPrice', [scaled])
                    await simulateCall(oracleAddr, data)
                  } catch (e:any) {
                    console.warn('preflight push failed (legacy football) — skipping send', e?.message || e)
                    continue
                  }
                  const tx = await oracle.pushPrice(scaled)
                  await tx.wait()
                  console.log(new Date().toISOString(), `[FOOTBALL][LEGACY] netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
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
                }
                lastFootball.set(id, { home: curHome, away: curAway })
              }
              // BASKETBALL legacy (date-based)
              if (apiKey) {
                try {
                  const headers = { 'x-apisports-key': apiKey, 'accept': 'application/json' }
                  const url = new URL('https://v1.basketball.api-sports.io/games')
                  const dateStr = new Date().toISOString().slice(0,10)
                  url.searchParams.set('date', dateStr)
                  url.searchParams.set('timezone', 'UTC')
                  const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
                  const games = Array.isArray(resp.data?.response) ? resp.data.response : []
                  console.log(new Date().toISOString(), `legacy basketball: games=${games.length}`)
                  for (const g of games) {
                    const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
                    const leagueName = g?.league?.name || g?.country?.name || 'League'
                    const home = g?.scores?.home || {}
                    const away = g?.scores?.away || {}
                    const totHome = Number(home?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(home?.[k] ?? 0) || 0), 0))) || 0
                    const totAway = Number(away?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(away?.[k] ?? 0) || 0), 0))) || 0
                    let prev = lastBasket.get(id)
                    if (!prev && lastApi && ingestSecret) {
                      try {
                        const u = new URL(lastApi)
                        u.searchParams.set('secret', ingestSecret)
                        u.searchParams.set('sport', 'basketball')
                        u.searchParams.set('fixture', String(id))
                        const r = await axios.get(u.toString(), { timeout: 8000 })
                        if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                          prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                        }
                      } catch {}
                    }
                    prev = prev || { home: totHome, away: totAway }
                    const dHome = Math.max(0, totHome - prev.home)
                    const dAway = Math.max(0, totAway - prev.away)
                    console.log(new Date().toISOString(), `[BASKET][LEGACY] ${leagueName} ΔH:${dHome} ΔA:${dAway}`)
                    if (dHome || dAway) {
                      const netPct = (dHome * 0.00001) - (dAway * 0.00001)
                      currentIndex = Math.max(1, currentIndex * (1 + netPct))
                      const scaled = toScaled(currentIndex)
                      try {
                        const data = (oracle as any).interface.encodeFunctionData('pushPrice', [scaled])
                        await simulateCall(oracleAddr, data)
                      } catch (e:any) {
                        console.warn('preflight push failed (legacy basketball) — skipping send', e?.message || e)
                        continue
                      }
                      const tx = await oracle.pushPrice(scaled)
                      await tx.wait()
                      console.log(new Date().toISOString(), `[BASKET][LEGACY] netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
                      if (ingestUrl && ingestSecret) {
                        try {
                          const time = Math.floor(Date.now()/1000)
                          const value = currentIndex
                          const meta = { type:'point', sport:'basketball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct }
                          await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
                        } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
                      }
                    }
                    lastBasket.set(id, { home: totHome, away: totAway })
                    if (lastApi && ingestSecret) {
                      try { await axios.post(lastApi, { secret: ingestSecret, sport: 'basketball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {}
                    }
                  }
                } catch (e:any) {
                  console.warn('legacy basketball fetch failed', e?.message || e)
                }
              }
              // VOLLEYBALL legacy (date-based)
              if (apiKey) {
                try {
                  const headers = { 'x-apisports-key': apiKey, 'accept': 'application/json' }
                  const url = new URL('https://v1.volleyball.api-sports.io/games')
                  const dateStr = new Date().toISOString().slice(0,10)
                  url.searchParams.set('date', dateStr)
                  url.searchParams.set('timezone', 'UTC')
                  const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
                  const games = Array.isArray(resp.data?.response) ? resp.data.response : []
                  console.log(new Date().toISOString(), `legacy volleyball: games=${games.length}`)
                  for (const g of games) {
                    const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
                    const leagueName = g?.league?.name || g?.country?.name || 'League'
                    const periods = g?.scores?.periods || g?.periods || {}
                    const sumSide = (side:any) => ['first','second','third','fourth','fifth'].reduce((s,k)=> s + (Number(periods?.[k]?.[side] ?? 0) || 0), 0)
                    const totHome = Number(g?.scores?.home ?? sumSide('home')) || 0
                    const totAway = Number(g?.scores?.away ?? sumSide('away')) || 0
                    let prev = lastVolley.get(id)
                    if (!prev && lastApi && ingestSecret) {
                      try {
                        const u = new URL(lastApi)
                        u.searchParams.set('secret', ingestSecret)
                        u.searchParams.set('sport', 'volleyball')
                        u.searchParams.set('fixture', String(id))
                        const r = await axios.get(u.toString(), { timeout: 8000 })
                        if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                          prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                        }
                      } catch {}
                    }
                    prev = prev || { home: totHome, away: totAway }
                    const dHome = Math.max(0, totHome - prev.home)
                    const dAway = Math.max(0, totAway - prev.away)
                    console.log(new Date().toISOString(), `[VOLLEY][LEGACY] ${leagueName} ΔH:${dHome} ΔA:${dAway}`)
                    if (dHome || dAway) {
                      const netPct = (dHome * 0.00001) - (dAway * 0.00001)
                      currentIndex = Math.max(1, currentIndex * (1 + netPct))
                      const scaled = toScaled(currentIndex)
                      try {
                        const data = (oracle as any).interface.encodeFunctionData('pushPrice', [scaled])
                        await simulateCall(oracleAddr, data)
                      } catch (e:any) {
                        console.warn('preflight push failed (legacy volleyball) — skipping send', e?.message || e)
                        continue
                      }
                      const tx = await oracle.pushPrice(scaled)
                      await tx.wait()
                      console.log(new Date().toISOString(), `[VOLLEY][LEGACY] netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
                      if (ingestUrl && ingestSecret) {
                        try {
                          const time = Math.floor(Date.now()/1000)
                          const value = currentIndex
                          const meta = { type:'point', sport:'volleyball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct }
                          await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
                        } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
                      }
                    }
                    lastVolley.set(id, { home: totHome, away: totAway })
                    if (lastApi && ingestSecret) {
                      try { await axios.post(lastApi, { secret: ingestSecret, sport: 'volleyball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {}
                    }
                  }
                } catch (e:any) {
                  console.warn('legacy volleyball fetch failed', e?.message || e)
                }
              }
              // HANDBALL legacy (date-based)
              if (apiKey) {
                try {
                  const headers = { 'x-apisports-key': apiKey, 'accept': 'application/json' }
                  const url = new URL('https://v1.handball.api-sports.io/games')
                  const dateStr = new Date().toISOString().slice(0,10)
                  url.searchParams.set('date', dateStr)
                  url.searchParams.set('timezone', 'UTC')
                  const resp = await axios.get(url.toString(), { headers, timeout: 15000 })
                  const games = Array.isArray(resp.data?.response) ? resp.data.response : []
                  console.log(new Date().toISOString(), `legacy handball: games=${games.length}`)
                  for (const g of games) {
                    const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
                    const leagueName = g?.league?.name || g?.country?.name || 'League'
                    const totHome = Number(g?.scores?.home ?? 0) || 0
                    const totAway = Number(g?.scores?.away ?? 0) || 0
                    let prev = lastHand.get(id)
                    if (!prev && lastApi && ingestSecret) {
                      try {
                        const u = new URL(lastApi)
                        u.searchParams.set('secret', ingestSecret)
                        u.searchParams.set('sport', 'handball')
                        u.searchParams.set('fixture', String(id))
                        const r = await axios.get(u.toString(), { timeout: 8000 })
                        if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                          prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                        }
                      } catch {}
                    }
                    prev = prev || { home: totHome, away: totAway }
                    const dHome = Math.max(0, totHome - prev.home)
                    const dAway = Math.max(0, totAway - prev.away)
                    console.log(new Date().toISOString(), `[HANDBALL][LEGACY] ${leagueName} ΔH:${dHome} ΔA:${dAway}`)
                    if (dHome || dAway) {
                      const netPct = (dHome * 0.0001) - (dAway * 0.0001)
                      currentIndex = Math.max(1, currentIndex * (1 + netPct))
                      const scaled = toScaled(currentIndex)
                      try {
                        const data = (oracle as any).interface.encodeFunctionData('pushPrice', [scaled])
                        await simulateCall(oracleAddr, data)
                      } catch (e:any) {
                        console.warn('preflight push failed (legacy handball) — skipping send', e?.message || e)
                        continue
                      }
                      const tx = await oracle.pushPrice(scaled)
                      await tx.wait()
                      console.log(new Date().toISOString(), `[HANDBALL][LEGACY] netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} tx:${tx.hash}`)
                      if (ingestUrl && ingestSecret) {
                        try {
                          const time = Math.floor(Date.now()/1000)
                          const value = currentIndex
                          const meta = { type:'point', sport:'handball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct }
                          await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
                        } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
                      }
                    }
                    lastHand.set(id, { home: totHome, away: totAway })
                    if (lastApi && ingestSecret) {
                      try { await axios.post(lastApi, { secret: ingestSecret, sport: 'handball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {}
                    }
                  }
                } catch (e:any) {
                  console.warn('legacy handball fetch failed', e?.message || e)
                }
              }
              emptyCycles = 0
            } catch (e:any) {
              console.warn('legacy fallback failed', e?.message || e)
            }
          }
        } catch (e:any) {
          console.warn('aggregator fetch failed', e?.message || e)
        }
      } else {
        // Legacy minute-based scheduling
        // FOOTBALL: single upstream call; apply +/-0.1% per goal per game (one tx per game)
        const fixtures = await fetchLiteFixtures(apiBase, apiSecret)
        for (const f of fixtures) {
          const id = Number(f?.id); if (!id) continue
          const curHome = Number(f?.home?.goals ?? 0) || 0
          const curAway = Number(f?.away?.goals ?? 0) || 0
          // try remote last if memory empty
          let prev = lastFootball.get(id)
          if (!prev && lastApi && ingestSecret) {
            try {
              const u = new URL(lastApi)
              u.searchParams.set('secret', ingestSecret)
              u.searchParams.set('sport', 'football')
              u.searchParams.set('fixture', String(id))
              const r = await axios.get(u.toString(), { timeout: 8000 })
              if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
              }
            } catch {}
          }
          prev = prev || { home: curHome, away: curAway }
          const dHome = Math.max(0, curHome - prev.home)
          const dAway = Math.max(0, curAway - prev.away)
          if (dHome === 0 && dAway === 0) continue
          footballActivity++
          anyActivity = true
          const netPct = (dHome * 0.001) - (dAway * 0.001) // 0.1% per goal
          currentIndex = Math.max(1, currentIndex * (1 + netPct))
          const push = await preflightAndPush(currentIndex, 'football')
          if (push.ok && push.hash) {
            console.log(new Date().toISOString(), `[FOOTBALL] ${f?.league?.name ?? 'League'} ${f?.home?.name} ${curHome}-${curAway} ${f?.away?.name} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
          } else {
            console.log(new Date().toISOString(), `[FOOTBALL][NO-TX] ${f?.league?.name ?? 'League'} ${f?.home?.name} ${curHome}-${curAway} ${f?.away?.name} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
          }
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
                deltaPct: netPct,
                note: push.ok ? undefined : 'push-skipped'
              }
              await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
            } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
          }
          lastFootball.set(id, { home: curHome, away: curAway, homeName: f?.home?.name, awayName: f?.away?.name, leagueName: f?.league?.name })
          if (lastApi && ingestSecret) {
            try {
              await axios.post(lastApi, { secret: ingestSecret, sport: 'football', fixture: id, home: curHome, away: curAway }, { timeout: 8000 })
            } catch {}
          }
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
            // read remote prev if necessary
            let prev = lastBasket.get(id)
            if (!prev && lastApi && ingestSecret) {
              try {
                const u = new URL(lastApi)
                u.searchParams.set('secret', ingestSecret)
                u.searchParams.set('sport', 'basketball')
                u.searchParams.set('fixture', String(id))
                const r = await axios.get(u.toString(), { timeout: 8000 })
                if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                  prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                }
              } catch {}
            }
            prev = prev || { home: totHome, away: totAway }
            const dHome = Math.max(0, totHome - prev.home)
            const dAway = Math.max(0, totAway - prev.away)
            if (dHome === 0 && dAway === 0) { lastBasket.set(id, { home: totHome, away: totAway }); continue }
            const netPct = (dHome * 0.00001) - (dAway * 0.00001) // 0.001% = 0.00001 fraction
            currentIndex = Math.max(1, currentIndex * (1 + netPct))
            const push = await preflightAndPush(currentIndex, 'basketball')
            if (push.ok && push.hash) {
              console.log(new Date().toISOString(), `[BASKET] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
            } else {
              console.log(new Date().toISOString(), `[BASKET][NO-TX] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
            }
            anyActivity = true
            if (ingestUrl && ingestSecret) {
              try {
                const time = Math.floor(Date.now()/1000)
                const value = currentIndex
                const meta = { type:'point', sport:'basketball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
              } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
            }
            lastBasket.set(id, { home: totHome, away: totAway })
            if (lastApi && ingestSecret) {
              try { await axios.post(lastApi, { secret: ingestSecret, sport: 'basketball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {}
            }
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
            let prev = lastVolley.get(id)
            if (!prev && lastApi && ingestSecret) {
              try {
                const u = new URL(lastApi)
                u.searchParams.set('secret', ingestSecret)
                u.searchParams.set('sport', 'volleyball')
                u.searchParams.set('fixture', String(id))
                const r = await axios.get(u.toString(), { timeout: 8000 })
                if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                  prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                }
              } catch {}
            }
            prev = prev || { home: totHome, away: totAway }
            const dHome = Math.max(0, totHome - prev.home)
            const dAway = Math.max(0, totAway - prev.away)
            if (dHome === 0 && dAway === 0) { lastVolley.set(id, { home: totHome, away: totAway }); continue }
            const netPct = (dHome * 0.00001) - (dAway * 0.00001)
            currentIndex = Math.max(1, currentIndex * (1 + netPct))
            const push = await preflightAndPush(currentIndex, 'volleyball')
            if (push.ok && push.hash) {
              console.log(new Date().toISOString(), `[VOLLEY] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
            } else {
              console.log(new Date().toISOString(), `[VOLLEY][NO-TX] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(4)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
            }
            anyActivity = true
            if (ingestUrl && ingestSecret) {
              try {
                const time = Math.floor(Date.now()/1000)
                const value = currentIndex
                const meta = { type:'point', sport:'volleyball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
              } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
            }
            lastVolley.set(id, { home: totHome, away: totAway })
            if (lastApi && ingestSecret) {
              try { await axios.post(lastApi, { secret: ingestSecret, sport: 'volleyball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {}
            }
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
            let prev = lastHand.get(id)
            if (!prev && lastApi && ingestSecret) {
              try {
                const u = new URL(lastApi)
                u.searchParams.set('secret', ingestSecret)
                u.searchParams.set('sport', 'handball')
                u.searchParams.set('fixture', String(id))
                const r = await axios.get(u.toString(), { timeout: 8000 })
                if (r.data && r.data.home !== undefined && r.data.away !== undefined) {
                  prev = { home: Number(r.data.home)||0, away: Number(r.data.away)||0 }
                }
              } catch {}
            }
            prev = prev || { home: totHome, away: totAway }
            const dHome = Math.max(0, totHome - prev.home)
            const dAway = Math.max(0, totAway - prev.away)
            if (dHome === 0 && dAway === 0) { lastHand.set(id, { home: totHome, away: totAway }); continue }
            const netPct = (dHome * 0.0001) - (dAway * 0.0001) // 0.01%
            currentIndex = Math.max(1, currentIndex * (1 + netPct))
            const push = await preflightAndPush(currentIndex, 'handball')
            if (push.ok && push.hash) {
              console.log(new Date().toISOString(), `[HANDBALL] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} tx:${push.hash}`)
            } else {
              console.log(new Date().toISOString(), `[HANDBALL][NO-TX] ${leagueName} ΔH:${dHome} ΔA:${dAway} netPct:${(netPct*100).toFixed(3)}% idx:${currentIndex.toFixed(6)} reason: preflight/send failed`)
            }
            anyActivity = true
            if (ingestUrl && ingestSecret) {
              try {
                const time = Math.floor(Date.now()/1000)
                const value = currentIndex
                const meta = { type:'point', sport:'handball', league: leagueName, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct, note: push.ok ? undefined : 'push-skipped' }
                await axios.post(ingestUrl, { secret: ingestSecret, chain, market, time, value, meta }, { timeout: 8000 })
              } catch (e:any) { console.warn('ingest sync failed', e?.message || e) }
            }
            lastHand.set(id, { home: totHome, away: totAway })
            if (lastApi && ingestSecret) {
              try { await axios.post(lastApi, { secret: ingestSecret, sport: 'handball', fixture: id, home: totHome, away: totAway }, { timeout: 8000 }) } catch {}
            }
          }
        } catch (e:any) { console.warn('handball fetch failed', e?.message || e) }
      }

      }

  // If no sport activity across any sport and configured to push continuity tick
  if (!anyActivity) {
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
