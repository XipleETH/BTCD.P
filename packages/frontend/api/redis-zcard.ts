import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/redis-zcard?chain=base-sepolia&market=random&from=ISO&to=ISO
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const market = (searchParams.get('market') || 'btcd').toLowerCase()
    const fromRaw = (searchParams.get('from') || '').trim()
    const toRaw = (searchParams.get('to') || '').trim()
    const fromSec = parseTimeToSec(fromRaw)
    const toSec = parseTimeToSec(toRaw)
    const min = Number.isFinite(fromSec) ? Math.min(fromSec, toSec) : undefined
    const max = Number.isFinite(toSec) ? Math.max(fromSec, toSec) : undefined

    const redis = Redis.fromEnv()
    const ticksKey = `btcd:ticks:${chain}:${market}`
    const total = await redis.zcard(ticksKey)

    let rangeCount: number | undefined = undefined
    if (min !== undefined && max !== undefined) {
      const arr = await redis.zrange(ticksKey, min, max, { byScore: true, withScores: false, offset: 0, count: 1 })
      rangeCount = Array.isArray(arr) ? (arr.length > 0 ? -1 : 0) : 0
    }
    return json({ ok: true, key: ticksKey, total, hasAnyInRange: rangeCount })
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500)
  }
}

function parseTimeToSec(v: string): number {
  if (!v) return NaN
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n > 3_000_000_000) return Math.floor(n / 1000)
    return Math.floor(n)
  }
  const d = new Date(v)
  const t = Math.floor(d.getTime() / 1000)
  return Number.isFinite(t) ? t : NaN
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
