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
  const eventsMax = Math.max(1, Number(process.env.EVENTS_MAX || '5000'))
    const arr = await redis.lrange<string>(eventsKey, 0, limit - 1)
    const out = [] as any[]
    for (const raw of arr) {
      try {
        const obj = JSON.parse(raw)
        // Ensure emoji exists if sport tagged
        const sport = String(obj?.meta?.sport || '')
        const em = emojiForSport(sport)
        if (em && !obj?.meta?.emoji) obj.meta.emoji = em
        out.push(obj)
      } catch {}
    }
    // If we have fresh events, also snapshot to a sticky key so we can
    // serve "last known" when the list is temporarily empty (never show empty UI)
    const stickyKey = `btcd:events:sticky:${chain}:${market}`
    if (out.length > 0) {
      try { await redis.set(stickyKey, JSON.stringify(out)) } catch {}
      return json({ events: out })
    }
    // Sticky fallback: return last non-empty snapshot if available
    try {
      const snap = await redis.get<string>(stickyKey)
      if (snap) {
        const arr = JSON.parse(snap)
        if (Array.isArray(arr) && arr.length) return json({ events: arr })
      }
    } catch {}

    // If market=random, fallback to ZSET ticks to build a simple recent numbers feed
    if (market === 'random') {
      try {
        const ticksKey = `btcd:ticks:${chain}:${market}`
        // Read like /api/candles does: Upstash returns flat array [member, score, member, score, ...]
        // Grab a wider window then cap to "limit" newest
        const windowN = Math.max(limit * 5, limit)
        const arr = await redis.zrange<[string | number]>(ticksKey, -windowN, -1, { withScores: true })
        const points: Array<{ time: number; value: number }> = []
        for (let i = 0; i < arr.length; i += 2) {
          const member = arr[i] as string
          const score = Number(arr[i+1])
          const value = typeof member === 'string' ? Number(member) : Number(member)
          if (!Number.isFinite(score) || !Number.isFinite(value)) continue
          points.push({ time: Math.floor(score), value })
        }
        // Newest first and cap
        points.sort((a,b)=> b.time - a.time)
        const recent = points.slice(0, limit).map(p => ({ time: p.time, value: p.value, meta: { type: 'random' } }))
        if (recent.length) {
          // Mirror to events list (newest-first at head)
          try {
            for (let i = recent.length - 1; i >= 0; i--) {
              await redis.lpush(eventsKey, JSON.stringify(recent[i]))
            }
            await redis.ltrim(eventsKey, 0, eventsMax - 1)
            // Update sticky snapshot as well
            try { await redis.set(stickyKey, JSON.stringify(recent)) } catch {}
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
              // Expect 32 bytes price + 32 bytes timestamp = 64 bytes (128 hex chars) after 0x
              const s = data.startsWith('0x') ? data.slice(2) : data
              if (s.length < 64 * 2) continue
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
                await redis.ltrim(eventsKey, 0, eventsMax - 1)
                // Update sticky snapshot as well
                try { await redis.set(stickyKey, JSON.stringify(limited)) } catch {}
              } catch {}
              return json({ events: limited })
            }
          }
        }
        return json({ events: [] })
      } catch {}
      return json({ events: [] })
    }

    // LocalAway fallback: if nothing in Redis and sticky failed, optionally query an upstream sports-live API
    if (market === 'localaway') {
      try {
        // Prefer same-origin by default so we can include API secret automatically; allow override via env
        const defaultBase = new URL('/api/sports-live', req.url).toString()
        const base = (process.env.API_BASE || process.env.SPORTS_LIVE_BASE || defaultBase).trim()
        if (base && base.startsWith('http')) {
          const u = new URL(base)
          u.searchParams.set('chain', chain)
          u.searchParams.set('market', 'localaway')
          u.searchParams.set('limit', String(limit))
          if (leagues) u.searchParams.set('leagues', leagues)
          // Pass secret if upstream is guarded
          const upstreamSecret = (process.env.API_SECRET || process.env.SPORTS_LIVE_SECRET || '').trim()
          if (upstreamSecret) u.searchParams.set('secret', upstreamSecret)
          const res = await fetch(u.toString(), { cache: 'no-store' })
          if (res.ok) {
            const j = await res.json()
            // Accept multiple shapes: direct array, {events:[]}, or {items:[]}
            const raw = Array.isArray(j)
              ? j
              : (Array.isArray(j?.events)
                  ? j.events
                  : (Array.isArray(j?.items) ? j.items : []))
            const sanitized: any[] = []
            for (const ev of raw) {
              try {
                const time = Math.floor(Number(ev?.time || ev?.timestamp || ev?.ts || 0))
                if (!Number.isFinite(time) || time <= 0) continue
                const meta = (typeof ev?.meta === 'object' && ev?.meta) ? ev.meta : {}
                const sport = String(meta?.sport || ev?.sport || 'football')
                const em = emojiForSport(sport)
                if (em && !meta.emoji) (meta as any).emoji = em
                // normalize structure; include common fields when coming from sports-live {items}
                const value = Number(ev?.value ?? ev?.deltaPct ?? 0)
                const type = String(meta?.type || ev?.type || (ev?.delta || ev?.deltaPct ? 'delta' : ''))
                const league = (meta as any)?.league || ev?.league || ev?.leagueName
                const home = (meta as any)?.home || ev?.home
                const away = (meta as any)?.away || ev?.away
                const score = (meta as any)?.score || ev?.score
                const delta = (meta as any)?.delta || ev?.delta
                const deltaPct = (meta as any)?.deltaPct ?? ev?.deltaPct
                sanitized.push({
                  time,
                  value,
                  meta: {
                    ...meta,
                    sport,
                    type,
                    league,
                    home,
                    away,
                    score,
                    delta,
                    deltaPct,
                  },
                })
              } catch {}
            }
            if (sanitized.length) {
              // Mirror newest-first to Redis list and update sticky snapshot
              try {
                for (let i = sanitized.length - 1; i >= 0; i--) {
                  await redis.lpush(eventsKey, JSON.stringify(sanitized[i]))
                }
                await redis.ltrim(eventsKey, 0, eventsMax - 1)
                try { await redis.set(stickyKey, JSON.stringify(sanitized)) } catch {}
              } catch {}
              return json({ events: sanitized })
            }
          }
        }
      } catch {}
    }

    // Default: if nothing found, return empty array (UI will keep showing sticky/last-known).
    return json({ events: [] })
  } catch (e:any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body:any, status=200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

function emojiForSport(sport: string): string | undefined {
  const m: Record<string, string> = {
    football: '⚽️', soccer: '⚽️',
    basketball: '🏀',
    volleyball: '🏐',
    handball: '🤾',
    random: '🎲'
  }
  const key = sport.toLowerCase()
  return m[key]
}
