import { Redis } from '@upstash/redis'
import { verifyMessage, getAddress } from 'viem'

export const config = { runtime: 'edge' }

// POST /api/lab-vote { id, address, message, signature }
// - Records one vote per address for a given proposal id.
// - Returns updated proposal with votes count.
export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const redis = Redis.fromEnv()

    // Be lenient with content-type; parse body from text to avoid Edge JSON parsing pitfalls
    let body: any = null
    try {
      const txt = await req.text()
      try { body = JSON.parse(txt) } catch { body = null }
      if (!body || typeof body !== 'object') return json({ error: 'invalid json body' }, 400)
    } catch {
      return json({ error: 'invalid body' }, 400)
    }
    const id = (body?.id || '').toString().trim()
    const address = (body?.address || '').toString().trim()
    const message = (body?.message || '').toString()
    const signature = (body?.signature || '').toString()

    if (!id || !/^0x[0-9a-fA-F]{40}$/.test(address)) return json({ error: 'invalid id/address' }, 400)
    // Require valid signature: one signed message per vote
    if (!message || !signature) return json({ error: 'missing signature' }, 401)
    let addrCk: `0x${string}`
    try {
      addrCk = getAddress(address) as `0x${string}`
      const ok = await verifyMessage({ address: addrCk, message, signature })
      if (!ok) return json({ error: 'invalid signature' }, 401)
    } catch {
      return json({ error: 'invalid signature' }, 401)
    }

  const raw = await redis.get<any>(`btcd:lab:proposal:${id}`)
    if (!raw) return json({ error: 'proposal not found' }, 404)

    // Ensure one vote per address
  const addrLower = String(addrCk).toLowerCase()
  const added = await redis.sadd(`btcd:lab:proposal:${id}:voters`, addrLower)
    let newVotes: number | null = null
    if (Number(added) === 1) {
      // First time this voter for this proposal: increment durable counter
      try {
        const v = await redis.incr(`btcd:lab:proposal:${id}:votes`)
        newVotes = Number(v)
      } catch {}
      // Best-effort: also reflect votes in stored proposal object
      try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : (typeof raw === 'object' ? raw : {})
        const votes = newVotes !== null ? newVotes : (Number(p?.votes || 0) + 1)
        const updated = { ...p, votes }
        await redis.set(`btcd:lab:proposal:${id}`, JSON.stringify(updated))
      } catch {}
    }

    const raw2 = await redis.get<any>(`btcd:lab:proposal:${id}`)
    let p2: any = null
    try { p2 = typeof raw2 === 'string' ? JSON.parse(raw2) : (typeof raw2 === 'object' ? raw2 : null) } catch { p2 = null }
    // Overlay durable counter if available
    try {
      const vNow = await redis.get<number>(`btcd:lab:proposal:${id}:votes`)
      if (p2 && typeof vNow === 'number') p2.votes = vNow
    } catch {}
    return json({ ok: true, proposal: p2, hasVoted: true })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
