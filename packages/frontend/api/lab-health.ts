import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request): Promise<Response> {
  try {
    const hasUrl = Boolean(process.env.UPSTASH_REDIS_REST_URL)
    const hasToken = Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)

    let ok = false
    let err: string | undefined
    try {
      const redis = Redis.fromEnv()
      // Simple round-trip
      await redis.set('btcd:lab:health', '1', { ex: 5 })
      const val = await redis.get<string>('btcd:lab:health')
      ok = val === '1'
    } catch (e: any) {
      ok = false
      err = e?.message || String(e)
    }

    return json({ hasUrl, hasToken, ping: ok ? 'ok' : 'fail', error: ok ? undefined : err })
  } catch (e: any) {
    return json({ ping: 'fail', error: e?.message || String(e) }, 500)
  }
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
