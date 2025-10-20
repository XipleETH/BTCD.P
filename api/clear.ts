import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// Clear/trim ticks for a given chain+market
// GET params:
//   secret: must match INGEST_SECRET
//   chain: e.g. base-sepolia | base (default base-sepolia)
//   market: btcd | random (default btcd)
//   del=true -> delete entire key
//   before=unixSec -> remove scores <= before
//   after=unixSec -> remove scores >= after
//   from=unixSec&to=unixSec -> remove range [from, to]
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const secret = (searchParams.get('secret') || '').trim()
    const expected = (process.env.INGEST_SECRET || '').trim()
    if (!expected || secret !== expected) return json({ error: 'unauthorized' }, 401)

    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const market = (searchParams.get('market') || 'btcd').toLowerCase()
    const del = String(searchParams.get('del') || '').toLowerCase() === 'true'
    const beforeStr = searchParams.get('before')
    const afterStr = searchParams.get('after')
    const fromStr = searchParams.get('from')
    const toStr = searchParams.get('to')

    const redis = Redis.fromEnv()
    const ticksKey = `btcd:ticks:${chain}:${market}`
    const eventsKey = `btcd:events:${chain}:${market}`

    if (del) {
      // Delete both ticks and events to fully reset chart/history for this market
      const [resTicks, resEvents] = await Promise.all([
        redis.del(ticksKey),
        redis.del(eventsKey),
      ])
      return json({ ok: true, action: 'del', ticksKey, eventsKey, results: { ticks: resTicks, events: resEvents } })
    }

    if (fromStr && toStr) {
      const from = Number(fromStr), to = Number(toStr)
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return json({ error: 'invalid from/to' }, 400)
      const removed = await redis.zremrangebyscore(ticksKey, Math.floor(from), Math.floor(to))
      return json({ ok: true, action: 'trimRange', key: ticksKey, from: Math.floor(from), to: Math.floor(to), removed })
    }

    if (beforeStr) {
      const before = Number(beforeStr)
      if (!Number.isFinite(before) || before <= 0) return json({ error: 'invalid before' }, 400)
      const removed = await redis.zremrangebyscore(ticksKey, Number.NEGATIVE_INFINITY, Math.floor(before))
      return json({ ok: true, action: 'trimBefore', key: ticksKey, before: Math.floor(before), removed })
    }

    if (afterStr) {
      const after = Number(afterStr)
      if (!Number.isFinite(after) || after <= 0) return json({ error: 'invalid after' }, 400)
      const removed = await redis.zremrangebyscore(ticksKey, Math.floor(after), Number.POSITIVE_INFINITY)
      return json({ ok: true, action: 'trimAfter', key: ticksKey, after: Math.floor(after), removed })
    }

    return json({ error: 'nothing to do; provide del=true or before/after or from/to' }, 400)
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
