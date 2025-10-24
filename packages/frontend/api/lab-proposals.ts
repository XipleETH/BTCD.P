import { Redis } from '@upstash/redis'
import { verifyMessage, getAddress } from 'viem'

export const config = { runtime: 'edge' }

// GET  /api/lab-proposals               -> list proposals (newest first)
// POST /api/lab-proposals { ...fields } -> create a proposal
export default async function handler(req: Request): Promise<Response> {
  try {
    const redis = Redis.fromEnv()
    const u = new URL(req.url)
    const debug = u.searchParams.get('debug') === '1'
    const method = req.method || 'GET'

    if (method === 'GET') {
      const ids = await redis.lrange<string>('btcd:lab:proposals', 0, 199)
      const items: any[] = []
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const raw = await redis.get<any>(`btcd:lab:proposal:${id}`)
          if (raw === undefined || raw === null) continue
          if (typeof raw === 'string') {
            try { items.push(JSON.parse(raw)) } catch {}
          } else if (typeof raw === 'object') {
            try { items.push(raw) } catch {}
          } else {
            // fallback: ignore unsupported types (numbers, etc.)
          }
        }
      }
      // newest first
      items.sort((a,b) => Number(b?.ts||0) - Number(a?.ts||0))

      // Optional: mark which proposals this address already voted
      const addrQ = (u.searchParams.get('address') || '').toString().trim()
      const addrLower = /^0x[0-9a-fA-F]{40}$/.test(addrQ) ? addrQ.toLowerCase() : ''
      if (items.length) {
        await Promise.all(items.map(async (p) => {
          // Overlay durable votes counter if present
          try {
            const v = await redis.get<number>(`btcd:lab:proposal:${p.id}:votes`)
            if (typeof v === 'number') p.votes = v
          } catch {}
          // For address-specific vote mark
          if (addrLower) {
            try {
              const isMember: any = await redis.sismember(`btcd:lab:proposal:${p.id}:voters`, addrLower)
              p.hasVoted = Boolean(Number(isMember))
            } catch { p.hasVoted = false }
          }
        }))
      }

      if (debug) {
        let host = ''
        try { const h = new URL(process.env.UPSTASH_REDIS_REST_URL || ''); host = h.host } catch {}
        return json({ proposals: items, debug: { idsCount: Array.isArray(ids)? ids.length : 0, envHasUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL), envHasToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN), upstashHost: host } })
      }
      return json({ proposals: items })
    }

    if (method === 'POST') {
      // Lenient parsing: accept raw text and parse JSON
      let body: any = null
      try {
        const txt = await req.text()
        try { body = JSON.parse(txt) } catch { body = null }
        if (!body || typeof body !== 'object') return json({ error: 'invalid json body' }, 400)
      } catch { return json({ error: 'invalid body' }, 400) }
      const name = (body?.name || '').toString().trim()
      const description = (body?.description || '').toString().trim()
      const upDesc = (body?.upDesc || '').toString().trim()
      const downDesc = (body?.downDesc || '').toString().trim()
      const apiUrl = (body?.apiUrl || '').toString().trim()
      const apiCost = (body?.apiCost || '').toString().trim().toLowerCase()
      const formula = (body?.formula || '').toString().trim()
      const author = (body?.author || '').toString().trim()
      const address = (body?.address || '').toString().trim()
      const message = (body?.message || '').toString()
      const signature = (body?.signature || '').toString()

      if (!name || !description || !upDesc || !downDesc || !formula) {
        return json({ error: 'missing required fields' }, 400)
      }
      // Require a valid wallet signature for submission
      if (!(/^0x[0-9a-fA-F]{40}$/.test(address)) || !message || !signature) {
        return json({ error: 'missing signature' }, 401)
      }
      try {
        const addrCk = getAddress(address)
        const ok = await verifyMessage({ address: addrCk, message, signature })
        if (!ok) return json({ error: 'invalid signature' }, 401)
      } catch {
        return json({ error: 'invalid signature' }, 401)
      }

      const costVal = apiCost === 'paid' ? 'paid' : (apiCost === 'free' ? 'free' : '')

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`
      const ts = Math.floor(Date.now()/1000)
      const rec = {
        id, ts, name, description, upDesc, downDesc,
        apiUrl, apiCost: costVal, formula, author,
        votes: 0
      }
      await redis.set(`btcd:lab:proposal:${id}`, JSON.stringify(rec))
      await redis.lpush('btcd:lab:proposals', id)
      // Initialize durable votes counter
      try { await redis.set(`btcd:lab:proposal:${id}:votes`, 0) } catch {}
      return json({ ok: true, id })
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
