import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// POST { secret, chain, market, time, value, meta?, mode? }
export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return resp(405, { error: 'method' })
    const body = await req.json() as any
    const secret = String(body?.secret || '')
    if (!secret || secret !== (process.env.INGEST_SECRET || '')) return resp(401, { error: 'unauthorized' })
    const chain = String(body?.chain || 'base-sepolia').toLowerCase()
    const market = String(body?.market || 'btcd').toLowerCase()
    const mode = String(body?.mode || '').toLowerCase()
    const time = Number(body?.time)
    const value = Number(body?.value)
  const meta = body?.meta
    if (!Number.isFinite(time) || !Number.isFinite(value)) return resp(400, { error: 'invalid payload' })

    const redis = Redis.fromEnv()
  const ticksKey = `btcd:ticks:${chain}:${market}`
  const eventsKey = `btcd:events:${chain}:${market}`
  const eventsMax = Math.max(1, Number(process.env.EVENTS_MAX || '5000'))

    // Optional delete mode to clear a series quickly
    if (mode === 'del') {
      await redis.del(ticksKey)
      await redis.del(eventsKey)
      return resp(200, { ok: true, action: 'del', ticksKey, eventsKey })
    }

    // Store time/value for candles as ZSET score=time, member=value (as string)
    await redis.zadd(ticksKey, { score: Math.floor(time), member: String(value) })

    // Optionally store metadata in a capped list
    // Only persist non-tick events so the feed accumulates meaningful updates
    const metaType = String(meta?.type || '').toLowerCase()
    if (meta && typeof meta === 'object' && metaType !== 'tick') {
      try {
        // Normalize sport emoji if present
        const emoji = emojiForSport(String(meta?.sport || ''))
        if (emoji && !meta.emoji) meta.emoji = emoji
        // Ensure a stable id to help clients de-duplicate and merge
        if (!meta.id) {
          const sport = String(meta?.sport || 'na')
          const fix = String(meta?.fixtureId || meta?.leagueId || 'na')
          const dH = Number(meta?.delta?.home || 0) || 0
          const dA = Number(meta?.delta?.away || 0) || 0
          meta.id = `${sport}:${fix}:${Math.floor(time)}:${dH}:${dA}`
        }
        const payload = { time: Math.floor(time), value, meta }
        await redis.lpush(eventsKey, JSON.stringify(payload))
        await redis.ltrim(eventsKey, 0, eventsMax - 1)
      } catch {}
    }

    // Trim ticks to a rolling window per market
    // Random needs a deeper history to preserve older candles
    const keep = market === 'random' ? 200_000 : 10_000
    const len = await redis.zcard(ticksKey)
    if ((len || 0) > keep + Math.floor(keep * 0.1)) {
      await redis.zremrangebyrank(ticksKey, 0, (len! - keep - 1))
    }
    return resp(200, { ok: true })
  } catch (e: any) {
    return resp(500, { error: e?.message || String(e) })
  }
}

function emojiForSport(sport: string): string | undefined {
  const m: Record<string, string> = {
    football: '⚽️', soccer: '⚽️',
    basketball: '🏀',
    volleyball: '🏐',
    handball: '🤾',
    random: '🎲'
  }
  const key = sport.toLowerCase()
  return m[key]
}

function resp(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}