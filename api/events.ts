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

    // For random, derive fresh events directly from ticks to avoid stale list snapshots
    if (market === 'random') {
      try {
        const stickyKey = `btcd:events:sticky:${chain}:${market}`
        const ticksKey = `btcd:ticks:${chain}:${market}`
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
        points.sort((a,b)=> b.time - a.time)
        const recent = points.slice(0, limit).map(p => ({ time: p.time, value: p.value, meta: { type: 'random' } }))
        if (recent.length) {
          try {
            // optional: keep list/sticky fresh for other consumers
            for (let i = recent.length - 1; i >= 0; i--) {
              await redis.lpush(eventsKey, JSON.stringify(recent[i]))
            }
            await redis.ltrim(eventsKey, 0, eventsMax - 1)
            try { await redis.set(stickyKey, JSON.stringify(recent)) } catch {}
          } catch {}
          return json({ events: recent })
        }

        // Secondary fallback: on-chain logs if oracle provided
        if (!recent.length && oracle) {
          const rpc = chain === 'base'
            ? (process.env.BASE_RPC_URL || '')
            : (process.env.BASE_SEPOLIA_RPC_URL || '')
          if (rpc) {
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
            const bnHex = await rpcCall('eth_blockNumber', []) as string
            const latestBn = BigInt(bnHex)
            const fromBn = latestBn > 30000n ? (latestBn - 30000n) : 0n
            const logs = await rpcCall('eth_getLogs', [{ address: oracle, fromBlock: '0x' + fromBn.toString(16), toBlock: '0x' + latestBn.toString(16) }]) as Array<any>
            const parsed: any[] = []
            for (const l of logs) {
              const data: string = l?.data || '0x'
              const s = data.startsWith('0x') ? data.slice(2) : data
              if (s.length < 64 * 2) continue
              const priceHex = '0x' + s.slice(0, 64)
              const tsHex = '0x' + s.slice(64, 128)
              const priceBi = BigInt(priceHex)
              const signed = (priceBi & (1n << 255n)) ? (priceBi - (1n << 256n)) : priceBi
              const ts = Number(BigInt(tsHex))
              const dec = Number(signed) / 1e8
              if (!Number.isFinite(ts) || !Number.isFinite(dec) || dec <= 0) continue
              parsed.push({ time: Math.floor(ts), value: dec, meta: { type: 'random' } })
            }
            parsed.sort((a,b)=> b.time - a.time)
            const limited = parsed.slice(0, limit)
            if (limited.length) {
              try {
                for (let i = limited.length - 1; i >= 0; i--) {
                  await redis.lpush(eventsKey, JSON.stringify(limited[i]))
                }
                await redis.ltrim(eventsKey, 0, eventsMax - 1)
                try { await redis.set(stickyKey, JSON.stringify(limited)) } catch {}
              } catch {}
              return json({ events: limited })
            }
          }
        }
      } catch {}
      return json({ events: [] })
    }

  // Fresh events from Redis list (non-random markets)
  const arr = await redis.lrange<string>(eventsKey, 0, limit - 1)
    const out: any[] = []
    for (const raw of arr) {
      try {
        const obj = JSON.parse(raw)
        const sport = String(obj?.meta?.sport || '')
        const em = emojiForSport(sport)
        if (em && !obj?.meta?.emoji) obj.meta.emoji = em
        out.push(obj)
      } catch {}
    }
    // Maintain a sticky snapshot to avoid empty UI during brief gaps
    const stickyKey = `btcd:events:sticky:${chain}:${market}`
    if (out.length > 0) {
      try { await redis.set(stickyKey, JSON.stringify(out)) } catch {}
      return json({ events: out })
    }
    // Sticky fallback
    try {
      const snap = await redis.get<string>(stickyKey)
      if (snap) {
        const arr = JSON.parse(snap)
        if (Array.isArray(arr) && arr.length) return json({ events: arr })
      }
    } catch {}

    // Random market fallback: derive from ticks ZSET or on-chain logs
    if (market === 'random') {
      try {
        const ticksKey = `btcd:ticks:${chain}:${market}`
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
        points.sort((a,b)=> b.time - a.time)
        const recent = points.slice(0, limit).map(p => ({ time: p.time, value: p.value, meta: { type: 'random' } }))
        if (recent.length) {
          try {
            for (let i = recent.length - 1; i >= 0; i--) {
              await redis.lpush(eventsKey, JSON.stringify(recent[i]))
            }
            await redis.ltrim(eventsKey, 0, eventsMax - 1)
            try { await redis.set(stickyKey, JSON.stringify(recent)) } catch {}
          } catch {}
          return json({ events: recent })
        }

        // Secondary: on-chain logs if oracle provided
        if (!recent.length && oracle) {
          const rpc = chain === 'base'
            ? (process.env.BASE_RPC_URL || '')
            : (process.env.BASE_SEPOLIA_RPC_URL || '')
          if (rpc) {
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
            const bnHex = await rpcCall('eth_blockNumber', []) as string
            const latestBn = BigInt(bnHex)
            const fromBn = latestBn > 30000n ? (latestBn - 30000n) : 0n
            const logs = await rpcCall('eth_getLogs', [{ address: oracle, fromBlock: '0x' + fromBn.toString(16), toBlock: '0x' + latestBn.toString(16) }]) as Array<any>
            const parsed: any[] = []
            for (const l of logs) {
              const data: string = l?.data || '0x'
              const s = data.startsWith('0x') ? data.slice(2) : data
              if (s.length < 64 * 2) continue
              const priceHex = '0x' + s.slice(0, 64)
              const tsHex = '0x' + s.slice(64, 128)
              const priceBi = BigInt(priceHex)
              const signed = (priceBi & (1n << 255n)) ? (priceBi - (1n << 256n)) : priceBi
              const ts = Number(BigInt(tsHex))
              const dec = Number(signed) / 1e8
              if (!Number.isFinite(ts) || !Number.isFinite(dec) || dec <= 0) continue
              parsed.push({ time: Math.floor(ts), value: dec, meta: { type: 'random' } })
            }
            parsed.sort((a,b)=> b.time - a.time)
            const limited = parsed.slice(0, limit)
            if (limited.length) {
              try {
                for (let i = limited.length - 1; i >= 0; i--) {
                  await redis.lpush(eventsKey, JSON.stringify(limited[i]))
                }
                await redis.ltrim(eventsKey, 0, eventsMax - 1)
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

    // LocalAway fallback: seed from upstream aggregator when Redis empty
    if (market === 'localaway') {
      const publicBase = (process.env.SPORTS_LIVE_PUBLIC_BASE || 'https://perp-it.xyz/api/sports-live').trim()
      const sameOrigin = new URL('/api/sports-live', req.url).toString()
      const candidates = [publicBase, (process.env.API_BASE || process.env.SPORTS_LIVE_BASE || sameOrigin).trim()]
      for (const base of candidates) {
        try {
          if (!base || !base.startsWith('http')) continue
          const u = new URL(base)
          u.searchParams.set('chain', chain)
          u.searchParams.set('market', 'localaway')
          u.searchParams.set('limit', String(limit))
          if (leagues) u.searchParams.set('leagues', leagues)
          const upstreamSecret = (process.env.API_SECRET || process.env.SPORTS_LIVE_SECRET || '').trim()
          const isSameOrigin = u.origin === new URL(req.url).origin
          if (upstreamSecret && isSameOrigin) u.searchParams.set('secret', upstreamSecret)
          const res = await fetch(u.toString(), { cache: 'no-store' })
          if (!res.ok) continue
          const j = await res.json()
          const raw = Array.isArray(j) ? j : (Array.isArray(j?.events) ? j.events : (Array.isArray(j?.items) ? j.items : []))
          const sanitized: any[] = []
          for (const ev of raw) {
            try {
              const time = Math.floor(Number(ev?.time || ev?.timestamp || ev?.ts || 0))
              if (!Number.isFinite(time) || time <= 0) continue
              const meta = (typeof ev?.meta === 'object' && ev?.meta) ? ev.meta : {}
              const sport = String((meta as any)?.sport || ev?.sport || 'football')
              const em = emojiForSport(sport)
              if (em && !(meta as any).emoji) (meta as any).emoji = em
              const value = Number(ev?.value ?? ev?.deltaPct ?? 0)
              const type = String((meta as any)?.type || ev?.type || (ev?.delta || ev?.deltaPct ? 'delta' : ''))
              const league = (meta as any)?.league || ev?.league || ev?.leagueName
              const home = (meta as any)?.home || ev?.home
              const away = (meta as any)?.away || ev?.away
              const score = (meta as any)?.score || ev?.score
              const delta = (meta as any)?.delta || ev?.delta
              const deltaPct = (meta as any)?.deltaPct ?? ev?.deltaPct
              sanitized.push({ time, value, meta: { ...meta, sport, type, league, home, away, score, delta, deltaPct } })
            } catch {}
          }
          if (sanitized.length) {
            try {
              for (let i = sanitized.length - 1; i >= 0; i--) {
                await redis.lpush(eventsKey, JSON.stringify(sanitized[i]))
              }
              await redis.ltrim(eventsKey, 0, eventsMax - 1)
              try { await redis.set(stickyKey, JSON.stringify(sanitized)) } catch {}
            } catch {}
            return json({ events: sanitized })
          }
        } catch {}
      }
    }

    // Default empty
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
