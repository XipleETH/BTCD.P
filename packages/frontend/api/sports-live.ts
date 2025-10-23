import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/sports-live?secret=...&chain=base-sepolia
// Returns consolidated live deltas for football, basketball, volleyball, handball in a single response.
// This endpoint DOES NOT push events/ticks; it only updates "last" snapshots and returns items for the daemon to act upon.
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams, origin } = new URL(req.url)
    const guard = (process.env.API_SECRET || '').trim()
    const secret = (searchParams.get('secret') || '').trim()
    if (guard && secret !== guard) return json({ error: 'unauthorized' }, 401)

    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const apiKey = (process.env.API_FOOTBALL_KEY || '').trim()
    if (!apiKey) return json({ error: 'missing API_FOOTBALL_KEY' }, 500)

    const headers: Record<string,string> = { 'x-apisports-key': apiKey, 'accept': 'application/json' }
    const redis = Redis.fromEnv()

  const items: any[] = []
  const summary = { football: 0, basketball: 0, volleyball: 0, handball: 0 }
    const nowSec = Math.floor(Date.now()/1000)

    // helpers for last snapshot
    const getLast = async (sport:string, fixture:number) => {
      const raw = await redis.get<string>(`btcd:last:${sport}:${fixture}`)
      if (!raw) return null
      try { const j = JSON.parse(raw); return { home: Number(j?.home)||0, away: Number(j?.away)||0 } } catch { return null }
    }
    const setLast = async (sport:string, fixture:number, home:number, away:number) => {
      await redis.set(`btcd:last:${sport}:${fixture}`, JSON.stringify({ home: Math.max(0, Math.floor(home||0)), away: Math.max(0, Math.floor(away||0)) }))
    }

    // FOOTBALL (one call via our own Edge endpoint to keep code consistent)
    try {
      const u = new URL(origin + '/api/football-live-goals')
      const guard2 = (process.env.API_SECRET || '').trim()
      if (guard2) u.searchParams.set('secret', guard2)
      const res = await fetch(u.toString(), { cache: 'no-store' })
      if (res.ok) {
        const j: any = await res.json()
  const fixtures = Array.isArray(j?.fixtures) ? j.fixtures : []
  summary.football = fixtures.length
        for (const f of fixtures) {
          const id = Number(f?.id); if (!id) continue
          const curHome = Number(f?.home?.goals ?? 0) || 0
          const curAway = Number(f?.away?.goals ?? 0) || 0
          const prev = (await getLast('football', id)) || { home: curHome, away: curAway }
          const dHome = Math.max(0, curHome - prev.home)
          const dAway = Math.max(0, curAway - prev.away)
          const netPct = (dHome - dAway) * 0.001 // 0.1% per goal diff
          await setLast('football', id, curHome, curAway)
          if (dHome || dAway) {
            items.push({
              ts: nowSec,
              sport: 'football',
              fixtureId: id,
              league: f?.league?.name,
              leagueId: f?.league?.id,
              home: { id: f?.home?.id, name: f?.home?.name },
              away: { id: f?.away?.id, name: f?.away?.name },
              score: { home: curHome, away: curAway },
              delta: { home: dHome, away: dAway },
              deltaPct: netPct,
            })
          }
        }
      }
    } catch {}

    // BASKETBALL (fallback to date-based listing for plans without live=all)
    try {
      const u = new URL('https://v1.basketball.api-sports.io/games')
      const dateStr = new Date().toISOString().slice(0,10)
      u.searchParams.set('date', dateStr)
      u.searchParams.set('timezone', 'UTC')
      const r = await fetch(u.toString(), { headers, cache: 'no-store' })
      if (r.ok) {
        const j:any = await r.json()
  const games = Array.isArray(j?.response) ? j.response : []
  summary.basketball = games.length
        for (const g of games) {
          const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
          const home = g?.scores?.home || {}
          const away = g?.scores?.away || {}
          const totHome = Number(home?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(home?.[k] ?? 0) || 0), 0))) || 0
          const totAway = Number(away?.total ?? (['quarter_1','quarter_2','quarter_3','quarter_4','over_time'].reduce((s,k)=> s + (Number(away?.[k] ?? 0) || 0), 0))) || 0
          const prev = (await getLast('basketball', id)) || { home: totHome, away: totAway }
          const dHome = Math.max(0, totHome - prev.home)
          const dAway = Math.max(0, totAway - prev.away)
          const netPct = (dHome - dAway) * 0.0001 // 0.01%
          await setLast('basketball', id, totHome, totAway)
          if (dHome || dAway) {
            items.push({ ts: nowSec, sport: 'basketball', fixtureId: id, league: g?.league?.name || g?.country?.name, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct })
          }
        }
      }
    } catch {}

    // VOLLEYBALL (date-based) — use period points instead of match set scores
    try {
      const u = new URL('https://v1.volleyball.api-sports.io/games')
      const dateStr = new Date().toISOString().slice(0,10)
      u.searchParams.set('date', dateStr)
      u.searchParams.set('timezone', 'UTC')
      const r = await fetch(u.toString(), { headers, cache: 'no-store' })
      if (r.ok) {
        const j:any = await r.json()
  const games = Array.isArray(j?.response) ? j.response : []
  summary.volleyball = games.length
        for (const g of games) {
          const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
          const periods = g?.scores?.periods || g?.periods || g?.score?.periods || {}
          const sumSide = (side:any) => ['first','second','third','fourth','fifth']
            .reduce((s,k)=> s + (Number(periods?.[k]?.[side] ?? 0) || 0), 0)
          // Count points by summing period points only (ignore set win counts)
          const totHome = sumSide('home')
          const totAway = sumSide('away')
          const prev = (await getLast('volleyball', id)) || { home: totHome, away: totAway }
          const dHome = Math.max(0, totHome - prev.home)
          const dAway = Math.max(0, totAway - prev.away)
          const netPct = (dHome - dAway) * 0.0001 // 0.01%
          await setLast('volleyball', id, totHome, totAway)
          if (dHome || dAway) {
            items.push({ ts: nowSec, sport: 'volleyball', fixtureId: id, league: g?.league?.name || g?.country?.name, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct })
          }
        }
      }
    } catch {}

    // HANDBALL (date-based)
    try {
      const u = new URL('https://v1.handball.api-sports.io/games')
      const dateStr = new Date().toISOString().slice(0,10)
      u.searchParams.set('date', dateStr)
      u.searchParams.set('timezone', 'UTC')
      const r = await fetch(u.toString(), { headers, cache: 'no-store' })
      if (r.ok) {
        const j:any = await r.json()
  const games = Array.isArray(j?.response) ? j.response : []
  summary.handball = games.length
        for (const g of games) {
          const id = Number(g?.id || g?.game?.id || g?.fixture?.id); if (!id) continue
          const totHome = Number(g?.scores?.home ?? 0) || 0
          const totAway = Number(g?.scores?.away ?? 0) || 0
          const prev = (await getLast('handball', id)) || { home: totHome, away: totAway }
          const dHome = Math.max(0, totHome - prev.home)
          const dAway = Math.max(0, totAway - prev.away)
          const netPct = (dHome - dAway) * 0.0001 // 0.01%
          await setLast('handball', id, totHome, totAway)
          if (dHome || dAway) {
            items.push({ ts: nowSec, sport: 'handball', fixtureId: id, league: g?.league?.name || g?.country?.name, home: { name: g?.teams?.home?.name }, away: { name: g?.teams?.away?.name }, score: { home: totHome, away: totAway }, delta: { home: dHome, away: dAway }, deltaPct: netPct })
          }
        }
      }
    } catch {}

  return json({ ts: nowSec, chain, items, summary })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
