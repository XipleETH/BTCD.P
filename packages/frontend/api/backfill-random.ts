import { Redis } from '@upstash/redis'

export const config = { runtime: 'edge' }

// POST { secret, chain, oracle, fromBlock, toBlock, lookbackBlocks? }
export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return json({ error: 'method' }, 405)
    const body = await req.json() as any
    const secret = String(body?.secret || '')
    if (!secret || secret !== (process.env.INGEST_SECRET || '')) return json({ error: 'unauthorized' }, 401)
    const chain = String(body?.chain || 'base-sepolia').toLowerCase()
    const oracle = String(body?.oracle || '')
    let fromBlock = body?.fromBlock !== undefined ? Number(body?.fromBlock) : NaN
    let toBlock = body?.toBlock !== undefined ? Number(body?.toBlock) : NaN
    const lookbackBlocks = body?.lookbackBlocks !== undefined ? Number(body?.lookbackBlocks) : NaN

    const rpc = chain === 'base'
      ? ((process.env.BASE_RPC_URL || process.env.BASE_MAINNET_RPC) || '')
      : ((process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC) || '')
    if (!rpc) return json({ error: 'rpc not configured' }, 500)

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

    // Determine block range if using lookback
    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
      if (Number.isFinite(lookbackBlocks) && lookbackBlocks > 0) {
        const bnHex = await rpcCall('eth_blockNumber', []) as string
        const latestBn = Number(bnHex)
        toBlock = latestBn
        fromBlock = Math.max(0, latestBn - Math.floor(lookbackBlocks))
      }
    }
    if (!oracle || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
      return json({ error: 'invalid params' }, 400)
    }

    // Fetch logs for PriceUpdated(int256,uint256)
    const topic0 = '0x' + keccak256('PriceUpdated(int256,uint256)')
    const logs = await rpcCall('eth_getLogs', [{ address: oracle, topics: [topic0], fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + toBlock.toString(16) }]) as Array<any>

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
        // Interpret int256
        const signed = (priceBi & (1n << 255n)) ? (priceBi - (1n << 256n)) : priceBi
        const ts = Number(BigInt(tsHex))
        const dec = Number(signed) / 1e8
        if (!Number.isFinite(ts) || !Number.isFinite(dec) || dec <= 0) continue
        await redis.zadd(ticksKey, { score: Math.floor(ts), member: String(dec) })
        inserted++
      } catch {}
    }

    return json({ ok: true, inserted, chain, oracle, fromBlock, toBlock })
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500)
  }
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

// Simple keccak256 of ASCII string (minimal for Edge) — avoids pulling full ethers
function keccak256(s: string): string {
  // Tiny keccak implementation is overkill; instead, precomputed topic is fine:
  // keccak256("PriceUpdated(int256,uint256)") =
  return '958c3ff76e4abbc5dbbfe67c5e4b61a3dfad24235b0d1e30a348f84692c6d6e9'
}
