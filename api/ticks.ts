import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/ticks?chain=base-sepolia&market=random&from=2025-10-21T04:00:00Z&to=2025-10-27T07:16:00Z&mode=summary|raw&limit=20000
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const market = (searchParams.get('market') || 'btcd').toLowerCase()
    const mode = (searchParams.get('mode') || 'summary').toLowerCase()
    const limit = Math.max(1, Math.min(200000, Number(searchParams.get('limit') || (market === 'random' ? '200000' : '10000'))))
    const fromRaw = (searchParams.get('from') || '').trim()
    const toRaw = (searchParams.get('to') || '').trim()

    const fromSec = parseTimeToSec(fromRaw)
    const toSec = parseTimeToSec(toRaw)
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) return json({ error: 'invalid from/to' }, 400)
    const min = Math.min(fromSec, toSec)
    const max = Math.max(fromSec, toSec)

    const redis = Redis.fromEnv()
    const ticksKey = `btcd:ticks:${chain}:${market}`
    const arr = await redis.zrange<[string | number]>(ticksKey, min, max, { byScore: true, withScores: true, offset: 0, count: limit })

    const points: Array<{ time: number; value: number }> = []
    for (let i = 0; i < arr.length; i += 2) {
      const member = arr[i] as string
      const score = Number(arr[i+1])
      const value = typeof member === 'string' ? Number(member) : Number(member)
      if (!Number.isFinite(score) || !Number.isFinite(value)) continue
      points.push({ time: Math.floor(score), value })
    }

    if (mode === 'raw') {
      return json({ chain, market, from: min, to: max, count: points.length, points })
    }

    let minV = Number.POSITIVE_INFINITY
    let maxV = Number.NEGATIVE_INFINITY
    let distinct = 0
    const seen = new Set<string>()
    for (const p of points) {
      if (p.value < minV) minV = p.value
      if (p.value > maxV) maxV = p.value
      seen.add(p.value.toFixed(8))
    }
    distinct = seen.size
    const first = points[0] || null
    const last = points.length ? points[points.length - 1] : null

    const sampleHead = points.slice(0, 5)
    const sampleTail = points.slice(-5)

    return json({ chain, market, from: min, to: max, count: points.length, distinct, min: isFinite(minV) ? minV : null, max: isFinite(maxV) ? maxV : null, first, last, sampleHead, sampleTail })
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500)
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
