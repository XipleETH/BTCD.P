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
    // Per-market keying so datasets don't mix
  const ticksKey = `btcd:ticks:${chain}:${market}`
  const eventsKey = `btcd:events:${chain}:${market}`
      // Optional delete mode to clear a series quickly
      if (mode === 'del') {
        await redis.del(ticksKey)
        await redis.del(eventsKey)
        return resp(200, { ok: true, action: 'del', ticksKey, eventsKey })
      }
    // Store as ZSET score=time, member=value (as string) — this powers candles
    await redis.zadd(ticksKey, { score: Math.floor(time), member: String(value) })
    // Optionally store metadata in a capped list (last 500 events)
    if (meta && typeof meta === 'object') {
      try {
        // add sport emoji if not present
        const emoji = emojiForSport(String(meta?.sport || ''))
        if (emoji && !meta.emoji) meta.emoji = emoji
        // For "no-goal" ticks, persist value=0 in events to represent a neutral delta,
        // while keeping the absolute index in the ticks ZSET above for chart continuity.
        const valueForEvent = (String(meta?.type).toLowerCase() === 'tick' && ['no-goal','no-activity'].includes(String(meta?.note).toLowerCase()))
          ? 0
          : value
        const payload = { time: Math.floor(time), value: valueForEvent, meta }
        await redis.lpush(eventsKey, JSON.stringify(payload))
        await redis.ltrim(eventsKey, 0, 499)
      } catch {}
    }
    // Trim to last 10000
    const len = await redis.zcard(ticksKey)
    if ((len || 0) > 11000) {
      await redis.zremrangebyrank(ticksKey, 0, (len! - 10000 - 1))
    }
    return resp(200, { ok: true })
  } catch (e: any) {
    return resp(500, { error: e?.message || String(e) })
  }
}

function resp(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

function emojiForSport(sport: string): string | undefined {
  const m: Record<string, string> = {
    football: '⚽️', soccer: '⚽️',
    basketball: '🏀',
    volleyball: '🏐',
    handball: '🤾',
    random: '🎲'
  }
  return m[sport.toLowerCase()]
}
