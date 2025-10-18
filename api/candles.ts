import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// Query: ?chain=base-sepolia&tf=15m&market=btcd|random
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const tf = (searchParams.get('tf') || '15m').toLowerCase()
    const market = (searchParams.get('market') || 'btcd').toLowerCase()
  const validTf = new Set(['1m','5m','15m','1h','4h','1d','3d','1w'])
    if (!validTf.has(tf)) return json({ error: 'invalid timeframe' }, 400)

    const redis = Redis.fromEnv()
  const ticksKey = `btcd:ticks:${chain}:${market}`
    // Get latest up to N ticks with scores (timestamps)
    const N = 10000
    // Upstash zrange with withScores returns [member, score, member, score, ...]
    const arr = await redis.zrange<[string | number]>(ticksKey, -N, -1, { withScores: true })
    const points: Array<{ time: number; value: number }> = []
    for (let i = 0; i < arr.length; i += 2) {
      const member = arr[i] as string
      const score = Number(arr[i+1])
      const value = typeof member === 'string' ? Number(member) : Number(member)
      if (!Number.isFinite(score) || !Number.isFinite(value)) continue
      points.push({ time: Math.floor(score), value })
    }
    points.sort((a,b)=>a.time-b.time)

    const bucketSec = tf === '1m' ? 60
      : tf === '5m' ? 300
      : tf === '15m' ? 900
      : tf === '1h' ? 3600
      : tf === '4h' ? 14400
      : tf === '1d' ? 86400
      : tf === '3d' ? 259200
      : 604800
    const candles = aggregate(points, bucketSec)
    return json({ chain, market, timeframe: tf, updatedAt: new Date().toISOString(), candles })
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

type Candle = { time: number; open: number; high: number; low: number; close: number }

function aggregate(points: Array<{time:number; value:number}>, bucketSec: number): Candle[] {
  if (!points.length) return []
  const buckets = new Map<number, Candle>()
  for (const p of points) {
    const ts = Math.floor(p.time)
    const bucket = Math.floor(ts / bucketSec) * bucketSec
    const prev = buckets.get(bucket)
    if (!prev) {
      buckets.set(bucket, { time: bucket, open: p.value, high: p.value, low: p.value, close: p.value })
    } else {
      prev.high = Math.max(prev.high, p.value)
      prev.low = Math.min(prev.low, p.value)
      prev.close = p.value
    }
  }
  return Array.from(buckets.entries()).sort((a,b)=>a[0]-b[0]).map(([,c])=>c)
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
