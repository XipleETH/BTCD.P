import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// POST { secret, chain, time, value }
export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return resp(405, { error: 'method' })
    const body = await req.json() as any
    const secret = String(body?.secret || '')
    if (!secret || secret !== (process.env.INGEST_SECRET || '')) return resp(401, { error: 'unauthorized' })
    const chain = String(body?.chain || 'base-sepolia').toLowerCase()
    const time = Number(body?.time)
    const value = Number(body?.value)
    if (!Number.isFinite(time) || !Number.isFinite(value)) return resp(400, { error: 'invalid payload' })

    const redis = Redis.fromEnv()
    const ticksKey = `btcd:ticks:${chain}`
    // Store as ZSET score=time, member=value (as string)
    await redis.zadd(ticksKey, { score: Math.floor(time), member: String(value) })
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