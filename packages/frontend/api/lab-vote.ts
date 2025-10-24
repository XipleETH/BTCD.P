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

    const ct = (req.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('application/json')) return json({ error: 'invalid content-type' }, 400)
    const body = await req.json() as any
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

  const raw = await redis.get<string>(`btcd:lab:proposal:${id}`)
    if (!raw) return json({ error: 'proposal not found' }, 404)

    // Ensure one vote per address
  const addrLower = String(addrCk).toLowerCase()
  const added = await redis.sadd(`btcd:lab:proposal:${id}:voters`, addrLower)
    if (Number(added) === 1) {
      // first time this address votes -> increment votes
      const p = JSON.parse(raw)
      const votes = Number(p?.votes || 0) + 1
      const updated = { ...p, votes }
      // If this write fails (e.g., read-only token), surface an error instead of silently succeeding
      const ok = await redis.set(`btcd:lab:proposal:${id}`, JSON.stringify(updated)).then(()=>true).catch(()=>false)
      if (!ok) return json({ error: 'failed to update votes (write denied?)' }, 500)
    }

    const raw2 = await redis.get<string>(`btcd:lab:proposal:${id}`)
    try {
      const p2 = raw2 ? JSON.parse(raw2) : null
      return json({ ok: true, proposal: p2, hasVoted: true })
    } catch {
      return json({ ok: true, hasVoted: true })
    }
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
