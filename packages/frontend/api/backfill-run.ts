import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// GET /api/backfill-run?secret=...&chain=base&oracle=0x...&lookback=50000
//    or with explicit &from=123&to=456
export default async function handler(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const secret = String(searchParams.get('secret') || '')
    if (!secret || secret !== (process.env.INGEST_SECRET || '')) return json({ ok: false, error: 'unauthorized' })
    const chain = String(searchParams.get('chain') || 'base-sepolia').toLowerCase()
    const oracle = String(searchParams.get('oracle') || '')
    let fromBlock = searchParams.has('from') ? Number(searchParams.get('from')) : NaN
    let toBlock = searchParams.has('to') ? Number(searchParams.get('to')) : NaN
    const lookback = searchParams.has('lookback') ? Number(searchParams.get('lookback')) : NaN

    const rpcOverride = String(searchParams.get('rpc') || '').trim()
    const rpc = rpcOverride || (chain === 'base'
      ? ((process.env.BASE_RPC_URL || process.env.BASE_MAINNET_RPC || process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC || process.env.VITE_BASE_RPC || process.env.VITE_BASE_MAINNET_RPC) || '')
      : ((process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC || process.env.BASE_SEPOLIA_MAINNET_RPC_URL || process.env.VITE_BASE_SEPOLIA_RPC) || ''))
    if (!rpc) return json({ ok: false, error: 'rpc not configured' })

    const rpcCall = async (method: string, params: any[]) => {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
      if (Number.isFinite(lookback) && lookback > 0) {
        const bnHex = await rpcCall('eth_blockNumber', []) as string
        const latestBn = Number(bnHex)
        toBlock = latestBn
        fromBlock = Math.max(0, latestBn - Math.floor(lookback))
      }
    }
    if (!oracle || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
      return json({ ok: false, error: 'invalid params', oracle, fromBlock, toBlock })
    }

  // keccak256("PriceUpdated(int256,uint256)")
  const topic0 = '0xdb6fb3cf4cc5fb760bcd63b958a53b2396776dff32c063188e864296541e76bd'
  let logs: any[] = []
    try {
      logs = await rpcCall('eth_getLogs', [{ address: oracle, topics: [topic0], fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + toBlock.toString(16) }]) as Array<any>
    } catch (e: any) {
      return json({ ok: false, error: e?.message || String(e), oracle, fromBlock, toBlock })
    }

    const redis = Redis.fromEnv()
    const ticksKey = `btcd:ticks:${chain}:random`
    let inserted = 0
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
    return json({ ok: true, inserted, oracle, chain, fromBlock, toBlock })
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) })
  }
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
