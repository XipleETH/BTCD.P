import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/backfill-by-time?secret=...&chain=base-sepolia&oracle=0x...&from=ISO_OR_EPOCH&to=ISO_OR_EPOCH&rpc=OPTIONAL
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const secret = String(searchParams.get('secret') || '')
    if (!secret || secret !== (process.env.INGEST_SECRET || '')) return json({ ok: false, error: 'unauthorized' })
    const chain = String(searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const oracle = String(searchParams.get('oracle') || '')
    const fromRaw = (searchParams.get('from') || '').trim()
    const toRaw = (searchParams.get('to') || '').trim()
    const rpcOverride = String(searchParams.get('rpc') || '').trim()

    if (!oracle) return json({ ok: false, error: 'missing oracle' })
    const fromTs = parseTimeToSec(fromRaw)
    const toTs = parseTimeToSec(toRaw)
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) return json({ ok: false, error: 'invalid from/to' })
    const tMin = Math.min(fromTs, toTs)
    const tMax = Math.max(fromTs, toTs)

    const rpc = rpcOverride || (chain === 'base'
      ? ((process.env.BASE_RPC_URL || process.env.BASE_MAINNET_RPC || process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC || process.env.VITE_BASE_RPC || process.env.VITE_BASE_MAINNET_RPC) || '')
      : ((process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC || process.env.BASE_SEPOLIA_MAINNET_RPC_URL || process.env.VITE_BASE_SEPOLIA_RPC) || ''))
    if (!rpc) return json({ ok: false, error: 'rpc not configured' })

    const rpcCall = async (method: string, params: any[]) => {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
      if (!res.ok) {
        let msg = 'rpc http ' + res.status
        try { const t = await res.text(); if (t) msg += ' ' + t } catch {}
        throw new Error(msg)
      }
      const j = await res.json()
      if (j.error) throw new Error(j.error?.message || 'rpc error')
      return j.result
    }

    const latestHex = await rpcCall('eth_blockNumber', []) as string
    const latest = Number(latestHex)

    const getTs = async (bn: number) => {
      const hex = '0x' + bn.toString(16)
      const block = await rpcCall('eth_getBlockByNumber', [hex, false])
      if (!block) return NaN
      const tsHex = block?.timestamp as string
      if (typeof tsHex === 'string' && tsHex.startsWith('0x')) {
        return Number(BigInt(tsHex))
      }
      const tsNum = Number(tsHex)
      return Number.isFinite(tsNum) ? tsNum : NaN
    }

    const findBlockByTs = async (target: number) => {
      let lo = 0
      let hi = latest
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        const ts = await getTs(mid)
        if (!Number.isFinite(ts)) return null
        if (ts < target) lo = mid + 1
        else hi = mid
      }
      return lo
    }

    const startBn = await findBlockByTs(tMin)
    const endBn = await findBlockByTs(tMax)
    if (startBn == null || endBn == null) return json({ ok: false, error: 'block search failed' })
    const fromBlock = Math.max(0, startBn - 16)
    const toBlock = Math.min(latest, endBn + 16)

    const inserted = await backfillLogs(rpcCall, chain, oracle, fromBlock, toBlock)
    return json({ ok: true, chain, oracle, fromTs: tMin, toTs: tMax, fromBlock, toBlock, inserted })
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) })
  }
}

async function backfillLogs(rpcCall: (m:string,p:any[])=>Promise<any>, chain: string, oracle: string, fromBlock: number, toBlock: number): Promise<number> {
  const redis = Redis.fromEnv()
  const ticksKey = `btcd:ticks:${chain}:random`
  const topic0 = '0xdb6fb3cf4cc5fb760bcd63b958a53b2396776dff32c063188e864296541e76bd'
  let inserted = 0
  const step = 10_000
  for (let a = fromBlock; a <= toBlock; a += step) {
    const b = Math.min(toBlock, a + step - 1)
    let logs: any[] = []
    try {
      logs = await rpcCall('eth_getLogs', [{ address: oracle, topics: [topic0], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }])
    } catch {
      continue
    }
    for (const l of logs) {
      try {
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
        await redis.zadd(ticksKey, { score: Math.floor(ts), member: String(dec) })
        inserted++
      } catch {}
    }
  }
  return inserted
}

function parseTimeToSec(v: string): number {
  if (!v) return NaN
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n > 3_000_000_000) return Math.floor(n / 1000)
    return Math.floor(n)
  }
  const d = new Date(v)
  const t = Math.floor(d.getTime() / 1000)
  return Number.isFinite(t) ? t : NaN
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
