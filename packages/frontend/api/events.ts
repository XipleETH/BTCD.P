import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/events?chain=base-sepolia&market=localaway&limit=20&leagues=39,140
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const chain = (searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const market = (searchParams.get('market') || 'btcd').toLowerCase()
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') || '20')))
  const leagues = (searchParams.get('leagues') || '').trim()
  const oracle = (searchParams.get('oracle') || '').trim()
    const redis = Redis.fromEnv()
    const eventsKey = `btcd:events:${chain}:${market}`
    const arr = await redis.lrange<string>(eventsKey, 0, limit - 1)
    const out = [] as any[]
    for (const raw of arr) {
      try { out.push(JSON.parse(raw)) } catch {}
    }
    if (out.length > 0) {
      return json({ events: out })
    }

    // If market=random, fallback to ZSET ticks to build a simple recent numbers feed
    if (market === 'random') {
      try {
        const ticksKey = `btcd:ticks:${chain}:${market}`
        // Get last N by rank, with scores (timestamps)
        // Prefer newest first; if not supported, we'll sort after
        let pairs: any[] = []
        try {
          // Upstash supports zrange with rev/withScores
          // @ts-ignore - library typing may vary
          pairs = await (redis as any).zrange(ticksKey, -limit, -1, { withScores: true })
        } catch {
          try {
            // Alternative: fetch head and trim
            // @ts-ignore
            pairs = await (redis as any).zrange(ticksKey, 0, limit - 1, { withScores: true, rev: true })
          } catch {}
        }
        const events = Array.isArray(pairs)
          ? pairs.map((p:any)=>{
              const member = Array.isArray(p) ? p[0] : p?.member
              const score = Array.isArray(p) ? p[1] : p?.score
              const val = Number(member)
              const ts = Number(score)
              return { time: Math.floor(ts), value: val, meta: { type: 'random' } }
            }).filter((e:any)=> Number.isFinite(e?.time) && Number.isFinite(e?.value))
          : []
        // Sort newest first and cap limit
        events.sort((a:any,b:any)=> b.time - a.time)
        const recent = events.slice(0, limit)
        if (recent.length) {
          // Mirror to events list (newest-first at head)
          try {
            for (let i = recent.length - 1; i >= 0; i--) {
              await redis.lpush(eventsKey, JSON.stringify(recent[i]))
            }
            await redis.ltrim(eventsKey, 0, 499)
          } catch {}
          return json({ events: recent })
        }

        // Secondary fallback: query on-chain logs if oracle and RPC URL available
        if (!recent.length && oracle) {
          // Pick RPC by chain
          const rpc = chain === 'base'
            ? (process.env.BASE_RPC_URL || '')
            : (process.env.BASE_SEPOLIA_RPC_URL || '')
          if (rpc) {
            // Helpers
            const rpcCall = async (method: string, params: any[]) => {
              const res = await fetch(rpc, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
              })
              if (!res.ok) throw new Error('rpc http ' + res.status)
              const j = await res.json()
              if (j.error) throw new Error(j.error?.message || 'rpc error')
              return j.result
            }
            const hexToBigInt = (h: string) => BigInt(h)
            const hexToBigIntSigned = (h: string) => {
              // strip 0x and pad
              const s = h.startsWith('0x') ? h.slice(2) : h
              const bi = BigInt('0x' + s)
              // if sign bit set (bit 255), interpret as negative: bi - 2^256
              const signMask = 1n << 255n
              return (bi & signMask) ? (bi - (1n << 256n)) : bi
            }
            const toNum = (h: string) => Number(BigInt(h))
            const bnHex = await rpcCall('eth_blockNumber', []) as string
            const latestBn = BigInt(bnHex)
            const fromBn = latestBn > 30000n ? (latestBn - 30000n) : 0n
            const logs = await rpcCall('eth_getLogs', [{
              address: oracle,
              fromBlock: '0x' + fromBn.toString(16),
              toBlock: '0x' + latestBn.toString(16),
            }]) as Array<any>
            const parsed: any[] = []
            for (const l of logs) {
              const data: string = l?.data || '0x'
              // Expect 64 bytes price + 64 bytes timestamp = 128 bytes (256 hex chars) after 0x
              const s = data.startsWith('0x') ? data.slice(2) : data
              if (s.length < 128 * 2) continue
              const priceHex = '0x' + s.slice(0, 64)
              const tsHex = '0x' + s.slice(64, 128)
              const price = hexToBigIntSigned(priceHex)
              const ts = toNum(tsHex)
              if (!Number.isFinite(ts)) continue
              const dec = Number(price) / 1e8
              if (!Number.isFinite(dec) || dec <= 0) continue
              parsed.push({ time: Math.floor(ts), value: dec, meta: { type: 'random' } })
            }
            // Newest first
            parsed.sort((a,b)=> b.time - a.time)
            const limited = parsed.slice(0, limit)
            if (limited.length) {
              try {
                for (let i = limited.length - 1; i >= 0; i--) {
                  await redis.lpush(eventsKey, JSON.stringify(limited[i]))
                }
                await redis.ltrim(eventsKey, 0, 499)
              } catch {}
              return json({ events: limited })
            }
          }
        }
        return json({ events: [] })
      } catch {}
      return json({ events: [] })
    }

    // Fallback: if no cached events for localaway, try querying our Edge live-goals endpoint in full mode (may use multiple API calls)
    // Only do this when market=localaway; otherwise return empty
    if (market !== 'localaway') return json({ events: [] })

    try {
      const origin = new URL(req.url).origin
      const url = new URL(origin + '/api/football-live-goals')
      if (leagues) url.searchParams.set('leagues', leagues)
      // full mode (omit lite), include secret if configured in env
      const guard = (process.env.API_SECRET || '').trim()
      if (guard) url.searchParams.set('secret', guard)
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (res.ok) {
        const j: any = await res.json()
        const fixtures = Array.isArray(j?.fixtures) ? j.fixtures : []
        // Build recent goal events across fixtures (most recent first by minute if present)
        const flat: any[] = []
        for (const f of fixtures) {
          const goals = Array.isArray(f?.goals) ? f.goals : []
          for (const g of goals) {
            const side = g?.team === 'home' ? 'home' : (g?.team === 'away' ? 'away' : 'unknown')
            const payload = {
              time: Math.floor(Date.now()/1000),
              value: null,
              meta: {
                type: 'goal',
                side,
                delta: side === 'home' ? +1 : (side === 'away' ? -1 : 0),
                fixtureId: f?.id,
                league: f?.league?.name,
                leagueId: f?.league?.id,
                home: { id: f?.home?.id, name: f?.home?.name },
                away: { id: f?.away?.id, name: f?.away?.name },
                score: { home: f?.home?.goals ?? null, away: f?.away?.goals ?? null },
                minute: g?.minute ?? null,
                player: g?.player ?? null,
                assist: g?.assist ?? null,
              }
            }
            flat.push(payload)
          }
        }
        // Sort by minute desc if present, and cap limit
        flat.sort((a,b)=> (b?.meta?.minute ?? 0) - (a?.meta?.minute ?? 0))
        const recent = flat.slice(0, limit)
        // Mirror to Redis for subsequent fast loads
        if (recent.length) {
          try {
            // Push newest-first so head is most recent (consistent with ingest path)
            for (let i = recent.length - 1; i >= 0; i--) {
              const ev = recent[i]
              await redis.lpush(eventsKey, JSON.stringify(ev))
            }
            await redis.ltrim(eventsKey, 0, Math.max(0, 500 - 1))
          } catch {}
        }
        return json({ events: recent })
      }
    } catch {}

    return json({ events: [] })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
