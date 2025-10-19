export const config = { runtime: 'edge' }

// Edge endpoint that aggregates live goals from API-Football v3
// Input (query params):
//   secret: optional simple guard (must match process.env.API_SECRET if set)
//   leagues: optional CSV of league ids (defaults to all live)
//   lite: optional flag ("1") to skip per-fixture events and return only scores to minimize API calls
// Output:
//   { fixtures: [{ id, league: { id, name, country }, home: { id, name, goals }, away: { id, name, goals }, goals: [{ at, team: 'home'|'away', player, assist, minute }] }], ts }
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const guard = (process.env.API_SECRET || '').trim()
    const secret = (searchParams.get('secret') || '').trim()
    if (guard && secret !== guard) return json({ error: 'unauthorized' }, 401)

    const apiKey = (process.env.API_FOOTBALL_KEY || '').trim()
    if (!apiKey) return json({ error: 'missing API_FOOTBALL_KEY' }, 500)

    const leagues = (searchParams.get('leagues') || '').trim()
    const lite = (searchParams.get('lite') || '').trim() === '1'

    // Simple in-memory cache per-region to avoid bursty repeat calls (best-effort; Edge isolates may reset)
    const cacheKey = JSON.stringify({ leagues, lite })
    const now = Date.now()
    const ttlMs = 10_000 // 10s TTL
    const g: any = globalThis as any
    g.__FOOTBALL_CACHE = g.__FOOTBALL_CACHE || new Map<string, { ts:number, body:string }>()
    const cached = g.__FOOTBALL_CACHE.get(cacheKey)
    if (cached && (now - cached.ts) < ttlMs) {
      return new Response(cached.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }

    // 1) Get all live fixtures
    // Docs: GET /fixtures?live=all
    const liveUrl = new URL('https://v3.football.api-sports.io/fixtures')
    liveUrl.searchParams.set('live', 'all')
    if (leagues) liveUrl.searchParams.set('league', leagues)

    const baseHeaders: Record<string,string> = {
      'x-apisports-key': apiKey,
      'accept': 'application/json'
    }

    const liveRes = await fetch(liveUrl.toString(), { headers: baseHeaders, cache: 'no-store' })
    if (!liveRes.ok) return json({ error: 'fixtures fetch failed', status: liveRes.status }, 502)
    const liveJson: any = await liveRes.json()
    const fixtures = Array.isArray(liveJson?.response) ? liveJson.response : []

    const out: any[] = []
    if (lite) {
      // Lite mode: no per-fixture events; return only scores/teams
      for (const f of fixtures) {
        const fixtureId = f?.fixture?.id
        if (!fixtureId) continue
        const homeId = f?.teams?.home?.id
        const awayId = f?.teams?.away?.id
        out.push({
          id: fixtureId,
          league: { id: f?.league?.id, name: f?.league?.name, country: f?.league?.country },
          home: { id: homeId, name: f?.teams?.home?.name, goals: f?.goals?.home ?? null },
          away: { id: awayId, name: f?.teams?.away?.name, goals: f?.goals?.away ?? null },
          goals: []
        })
      }
    } else {
      // Full mode: fetch events per fixture to derive goal sides and details
      for (const f of fixtures) {
        const fixtureId = f?.fixture?.id
        if (!fixtureId) continue
        const evUrl = new URL('https://v3.football.api-sports.io/fixtures/events')
        evUrl.searchParams.set('fixture', String(fixtureId))
        const evRes = await fetch(evUrl.toString(), { headers: baseHeaders, cache: 'no-store' })
        if (!evRes.ok) continue
        const evJson: any = await evRes.json()
        const events = Array.isArray(evJson?.response) ? evJson.response : []
        const goals = events.filter((e:any)=> (e?.type === 'Goal')).map((e:any)=>({
          at: e?.time?.elapsed ?? null,
          teamId: e?.team?.id ?? null,
          teamName: e?.team?.name ?? null,
          player: e?.player?.name ?? null,
          assist: e?.assist?.name ?? null,
          minute: e?.time?.elapsed ?? null,
        }))
        const homeId = f?.teams?.home?.id
        const awayId = f?.teams?.away?.id
        const mappedGoals = goals.map((g:any)=> ({
          at: g.at,
          minute: g.minute,
          team: g.teamId === homeId ? 'home' : (g.teamId === awayId ? 'away' : 'unknown'),
          player: g.player,
          assist: g.assist,
        }))
        out.push({
          id: fixtureId,
          league: { id: f?.league?.id, name: f?.league?.name, country: f?.league?.country },
          home: { id: homeId, name: f?.teams?.home?.name, goals: f?.goals?.home ?? null },
          away: { id: awayId, name: f?.teams?.away?.name, goals: f?.goals?.away ?? null },
          goals: mappedGoals,
        })
      }
    }

    const body = JSON.stringify({ ts: Math.floor(Date.now()/1000), fixtures: out })
    // store in cache
    g.__FOOTBALL_CACHE.set(cacheKey, { ts: now, body })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
