export const config = { runtime: 'edge' }

// Single-call Edge endpoint for live football data using API-Football v3
// Constraints: Only one upstream call per invocation -> GET /fixtures?live=all
// Input (query params):
//   secret: optional, must match process.env.API_SECRET if set
//   leagues: optional CSV of league ids (best-effort filter; API may accept only one per request)
// Behavior:
//   - Fetch all live fixtures (one HTTP call)
//   - Return simplified fixtures with current scores
//   - Compute "goals" as deltas since the previous invocation using in-memory snapshot (no per-fixture events calls)
// Output:
//   { fixtures: [{ id, league: { id, name, country }, home: { id, name, goals }, away: { id, name, goals }, goals: [{ team: 'home'|'away', minute: number|null }] }], ts }
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const guard = (process.env.API_SECRET || '').trim()
    const secret = (searchParams.get('secret') || '').trim()
    if (guard && secret !== guard) return json({ error: 'unauthorized' }, 401)

    const apiKey = (process.env.API_FOOTBALL_KEY || '').trim()
    if (!apiKey) return json({ error: 'missing API_FOOTBALL_KEY' }, 500)

    const leagues = (searchParams.get('leagues') || '').trim()

    // Simple in-memory cache per-region to avoid bursty repeat calls (best-effort; Edge isolates may reset)
    const cacheKey = JSON.stringify({ leagues })
    const now = Date.now()
    const ttlMs = 10_000 // 10s TTL
    const g: any = globalThis as any
    g.__FOOTBALL_CACHE = g.__FOOTBALL_CACHE || new Map<string, { ts:number, body:string }>()
    // Track last seen scores per fixture to synthesize goal deltas between invocations
    g.__FOOTBALL_LAST_SCORES = g.__FOOTBALL_LAST_SCORES || new Map<number, { home:number, away:number }>()
    const cached = g.__FOOTBALL_CACHE.get(cacheKey)
    if (cached && (now - cached.ts) < ttlMs) {
      return new Response(cached.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }

    // Single upstream call: GET /fixtures?live=all
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
    for (const f of fixtures) {
      const fixtureId = f?.fixture?.id
      if (!fixtureId) continue
      const homeId = f?.teams?.home?.id
      const awayId = f?.teams?.away?.id
      const curHome = Number(f?.goals?.home ?? 0) || 0
      const curAway = Number(f?.goals?.away ?? 0) || 0
      // Compute deltas since last snapshot (best-effort; first call yields no deltas)
      const last = g.__FOOTBALL_LAST_SCORES.get(fixtureId)
      const dHome = last ? Math.max(0, curHome - last.home) : 0
      const dAway = last ? Math.max(0, curAway - last.away) : 0
      const goals = [] as Array<{ team: 'home'|'away', minute: number|null }>
      for (let i = 0; i < dHome; i++) goals.push({ team: 'home', minute: null })
      for (let i = 0; i < dAway; i++) goals.push({ team: 'away', minute: null })
      // Update snapshot
      g.__FOOTBALL_LAST_SCORES.set(fixtureId, { home: curHome, away: curAway })
      out.push({
        id: fixtureId,
        league: { id: f?.league?.id, name: f?.league?.name, country: f?.league?.country },
        home: { id: homeId, name: f?.teams?.home?.name, goals: curHome },
        away: { id: awayId, name: f?.teams?.away?.name, goals: curAway },
        goals
      })
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
