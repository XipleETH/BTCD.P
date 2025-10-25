import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// Admin endpoint to force-reset Perps' Lab proposals
// GET /api/lab-reset?secret=...&archive=true&advance=true
// Auth: uses INGEST_SECRET (same as `clear` endpoint)
// Query:
//  - archive=true|false (default true): store current top proposal as last winner
//  - advance=true|false (default false): advance cycle index by +1 (or set to 0 if unset)
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const secret = (searchParams.get('secret') || '').trim()
    const expected = (process.env.INGEST_SECRET || '').trim()
    if (!expected || secret !== expected) return json({ error: 'unauthorized' }, 401)

    const doArchive = (String(searchParams.get('archive') || 'true').toLowerCase() === 'true')
    const doAdvance = (String(searchParams.get('advance') || 'false').toLowerCase() === 'true')

    const redis = Redis.fromEnv()
    const idxKey = 'btcd:lab:cycleIndex'

    // Load proposals
    const ids = await redis.lrange<string>('btcd:lab:proposals', 0, 499)
    const items: any[] = []
    if (Array.isArray(ids)) {
      for (const id of ids) {
        const raw = await redis.get<any>(`btcd:lab:proposal:${id}`)
        if (!raw) continue
        try {
          const obj = typeof raw === 'string' ? JSON.parse(raw) : (typeof raw === 'object' ? raw : null)
          if (obj) items.push(obj)
        } catch {}
      }
    }
    // Overlay durable vote counters
    await Promise.all(items.map(async (p) => {
      try {
        const v = await redis.get<number>(`btcd:lab:proposal:${p.id}:votes`)
        if (typeof v === 'number') p.votes = v
      } catch {}
    }))
    // Sort by votes desc; tie-breaker ts desc
    items.sort((a,b) => {
      const va = Number(a?.votes || 0)
      const vb = Number(b?.votes || 0)
      if (vb !== va) return vb - va
      return Number(b?.ts || 0) - Number(a?.ts || 0)
    })

    // Optionally archive current top as last winner (store full proposal details)
    let archived: any = null
    if (doArchive) {
      const top = items[0] || null
      const nowMs = Date.now()
      let storedIndex: number | null = null
      try {
        const rawIdx = await redis.get<number>(idxKey)
        storedIndex = (typeof rawIdx === 'number') ? rawIdx : null
      } catch {}
      const winner = top ? {
        id: top.id,
        ts: Number(top.ts||0),
        name: top.name,
        description: top.description,
        upDesc: top.upDesc,
        downDesc: top.downDesc,
        apiUrl: top.apiUrl,
        apiCost: top.apiCost,
        formula: top.formula,
        author: top.author,
        votes: Number(top.votes||0)
      } : null
      archived = { cycle: storedIndex, decidedAt: nowMs, winner }
      try { await redis.set('btcd:lab:lastWinner', JSON.stringify(archived)) } catch {}
    }

    // Delete proposals and related keys
    let deleted = 0
    if (Array.isArray(ids) && ids.length) {
      await Promise.all(ids.flatMap((id) => [
        redis.del(`btcd:lab:proposal:${id}`),
        redis.del(`btcd:lab:proposal:${id}:votes`),
        redis.del(`btcd:lab:proposal:${id}:voters`),
      ]))
      deleted = ids.length
    }
    try { await redis.del('btcd:lab:proposals') } catch {}

    // Optionally advance cycle index by +1
    let newIndex: number | null = null
    if (doAdvance) {
      try {
        const rawIdx = await redis.get<number>(idxKey)
        const current = (typeof rawIdx === 'number') ? rawIdx : -1
        newIndex = current + 1
        await redis.set(idxKey, newIndex)
      } catch {}
    }

    return json({ ok: true, archived, removedCount: deleted, advancedCycleTo: newIndex })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
