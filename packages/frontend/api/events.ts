import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/events?chain=base-sepolia&market=localaway&limit=20&leagues=39,140
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const market = (searchParams.get('market') || 'btcd').toLowerCase()
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') || '20')))
    const leagues = (searchParams.get('leagues') || '').trim()
    const redis = Redis.fromEnv()
    const eventsKey = `btcd:events:${chain}:${market}`
    const arr = await redis.lrange<string>(eventsKey, 0, limit - 1)
    const out = [] as any[]
    for (const raw of arr) {
      try { out.push(JSON.parse(raw)) } catch {}
    }
    if (out.length > 0) {
      return json({ events: out })
    }

    // If market=random, fallback to ZSET ticks to build a simple recent numbers feed
    if (market === 'random') {
      try {
        const ticksKey = `btcd:ticks:${chain}:${market}`
        // Get last N by rank, with scores (timestamps)
        // Prefer newest first; if not supported, we'll sort after
        let pairs: any[] = []
        try {
          // Upstash supports zrange with rev/withScores
          // @ts-ignore - library typing may vary
          pairs = await (redis as any).zrange(ticksKey, -limit, -1, { withScores: true })
        } catch {
          try {
            // Alternative: fetch head and trim
            // @ts-ignore
            pairs = await (redis as any).zrange(ticksKey, 0, limit - 1, { withScores: true, rev: true })
          } catch {}
        }
        const events = Array.isArray(pairs)
          ? pairs.map((p:any)=>{
              const member = Array.isArray(p) ? p[0] : p?.member
              const score = Array.isArray(p) ? p[1] : p?.score
              const val = Number(member)
              const ts = Number(score)
              return { time: Math.floor(ts), value: val, meta: { type: 'random' } }
            }).filter((e:any)=> Number.isFinite(e?.time) && Number.isFinite(e?.value))
          : []
        // Sort newest first and cap limit
        events.sort((a:any,b:any)=> b.time - a.time)
        const recent = events.slice(0, limit)
        if (recent.length) {
          // Mirror to events list (newest-first at head)
          try {
            for (let i = recent.length - 1; i >= 0; i--) {
              await redis.lpush(eventsKey, JSON.stringify(recent[i]))
            }
            await redis.ltrim(eventsKey, 0, 499)
          } catch {}
        }
        return json({ events: recent })
      } catch {}
      return json({ events: [] })
    }

    // Fallback: if no cached events for localaway, try querying our Edge live-goals endpoint in full mode (may use multiple API calls)
    // Only do this when market=localaway; otherwise return empty
    if (market !== 'localaway') return json({ events: [] })

    try {
      const origin = new URL(req.url).origin
      const url = new URL(origin + '/api/football-live-goals')
      if (leagues) url.searchParams.set('leagues', leagues)
      // full mode (omit lite), include secret if configured in env
      const guard = (process.env.API_SECRET || '').trim()
      if (guard) url.searchParams.set('secret', guard)
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (res.ok) {
        const j: any = await res.json()
        const fixtures = Array.isArray(j?.fixtures) ? j.fixtures : []
        // Build recent goal events across fixtures (most recent first by minute if present)
        const flat: any[] = []
        for (const f of fixtures) {
          const goals = Array.isArray(f?.goals) ? f.goals : []
          for (const g of goals) {
            const side = g?.team === 'home' ? 'home' : (g?.team === 'away' ? 'away' : 'unknown')
            const payload = {
              time: Math.floor(Date.now()/1000),
              value: null,
              meta: {
                type: 'goal',
                side,
                delta: side === 'home' ? +1 : (side === 'away' ? -1 : 0),
                fixtureId: f?.id,
                league: f?.league?.name,
                leagueId: f?.league?.id,
                home: { id: f?.home?.id, name: f?.home?.name },
                away: { id: f?.away?.id, name: f?.away?.name },
                score: { home: f?.home?.goals ?? null, away: f?.away?.goals ?? null },
                minute: g?.minute ?? null,
                player: g?.player ?? null,
                assist: g?.assist ?? null,
              }
            }
            flat.push(payload)
          }
        }
        // Sort by minute desc if present, and cap limit
        flat.sort((a,b)=> (b?.meta?.minute ?? 0) - (a?.meta?.minute ?? 0))
        const recent = flat.slice(0, limit)
        // Mirror to Redis for subsequent fast loads
        if (recent.length) {
          try {
            // Push newest-first so head is most recent (consistent with ingest path)
            for (let i = recent.length - 1; i >= 0; i--) {
              const ev = recent[i]
              await redis.lpush(eventsKey, JSON.stringify(ev))
            }
            await redis.ltrim(eventsKey, 0, Math.max(0, 500 - 1))
          } catch {}
        }
        return json({ events: recent })
      }
    } catch {}

    return json({ events: [] })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
