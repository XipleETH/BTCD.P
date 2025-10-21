import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET  /api/last?secret=...&sport=football&fixture=123 -> { home, away } | { notFound: true }
// POST /api/last { secret, sport, fixture, home, away } -> { ok: true }
export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url)
    const secret = (req.method === 'GET')
      ? (url.searchParams.get('secret') || '')
      : (await req.clone().json().catch(()=>({})))?.secret || ''
    const expected = (process.env.INGEST_SECRET || '').trim()
    if (!expected || secret !== expected) return json({ error: 'unauthorized' }, 401)

    const redis = Redis.fromEnv()
    if (req.method === 'GET') {
      const sport = (url.searchParams.get('sport') || '').toLowerCase()
      const fixture = Number(url.searchParams.get('fixture') || '')
      if (!sport || !Number.isFinite(fixture) || fixture <= 0) return json({ error: 'bad params' }, 400)
      const key = `btcd:last:${sport}:${fixture}`
      const raw = await redis.get<string>(key)
      if (!raw) return json({ notFound: true })
      try {
        const obj = JSON.parse(raw)
        return json({ home: Number(obj?.home||0), away: Number(obj?.away||0) })
      } catch {
        return json({ notFound: true })
      }
    }
    if (req.method === 'POST') {
      const body: any = await req.json()
      const sport = String(body?.sport || '').toLowerCase()
      const fixture = Number(body?.fixture)
      const home = Number(body?.home)
      const away = Number(body?.away)
      if (!sport || !Number.isFinite(fixture) || fixture <= 0) return json({ error: 'bad params' }, 400)
      const key = `btcd:last:${sport}:${fixture}`
      await redis.set(key, JSON.stringify({ home: Math.max(0, Math.floor(home||0)), away: Math.max(0, Math.floor(away||0)) }))
      // optional TTL could be added; skip for ongoing matches
      return json({ ok: true })
    }
    return json({ error: 'method' }, 405)
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
