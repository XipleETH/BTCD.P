import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request): Promise<Response> {
  try {
    const hasUrl = Boolean(process.env.UPSTASH_REDIS_REST_URL)
    const hasToken = Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)

    let ok = false
    let err: string | undefined
    let details: any = {}
    try {
      const redis = Redis.fromEnv()
      // Basic ping
      try { details.ping = await (redis as any).ping?.() } catch {}
      // Simple round-trip with random key
      const key = `btcd:lab:health:${Math.random().toString(36).slice(2,8)}`
      details.set = await redis.set(key, '1', { ex: 15 })
      details.get = await redis.get<string>(key)
      try { details.del = await redis.del(key) } catch {}
      ok = details.get === '1'
    } catch (e: any) {
      ok = false
      err = e?.message || String(e)
    }

    return json({ hasUrl, hasToken, ping: ok ? 'ok' : 'fail', error: ok ? undefined : err, details })
  } catch (e: any) {
    return json({ ping: 'fail', error: e?.message || String(e) }, 500)
  }
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
