import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/events?chain=base-sepolia&market=localaway&limit=20
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const market = (searchParams.get('market') || 'btcd').toLowerCase()
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') || '20')))
    const redis = Redis.fromEnv()
    const eventsKey = `btcd:events:${chain}:${market}`
    const arr = await redis.lrange<string>(eventsKey, 0, limit - 1)
    const out = [] as any[]
    for (const raw of arr) {
      try { out.push(JSON.parse(raw)) } catch {}
    }
    return json({ events: out })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
