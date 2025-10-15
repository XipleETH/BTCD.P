// btcd-local-test.js
// Prueba local: BTC Dominance = MC(bitcoin) / Σ MC(top-N) * 100
// Uso: node btcd-local-test.js --per-page 125 --exclude-stables --pages 1 --tv 56.78

const DEFAULT_UA = 'BTCD-LocalTest/1.0 (+no-commit)';

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next; i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return {
    perPage: Number(args['per-page'] || 125),
    pages: Number(args['pages'] || 1),
    excludeStables: String(args['exclude-stables'] || 'true').toLowerCase() === 'true',
    tv: args['tv'] ? Number(args['tv']) : undefined,
  };
}

const knownStables = new Set([
  'tether','usd-coin','binance-usd','dai','frax','true-usd','usdd','pax-dollar',
  'first-digital-usd','gemini-dollar','liquity-usd','ethena-usde','usdx','usdk','usdn','usdy'
]);

function isProbablyStable(it, excludeStables, extraExcludes) {
  const id = String(it?.id || '').toLowerCase();
  if (extraExcludes.has(id)) return true;
  if (knownStables.has(id)) return true;
  if (!excludeStables) return false;
  const sym = String(it?.symbol || '').toUpperCase();
  const price = Number(it?.current_price);
  if (Number.isFinite(price) && price > 0) {
    if (sym.includes('USD') && price > 0.94 && price < 1.06) return true;
  }
  return false;
}

async function fetchMarkets(page, perPage) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}`;
  const resp = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA }, cache: 'no-store' });
  if (!resp.ok) throw new Error(`CG ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('Empty markets array');
  return data;
}

async function main() {
  const { perPage, pages, excludeStables, tv } = parseArgs();
  const extraExcludes = new Set(String(process.env.EXCLUDE_IDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

  let total = 0;
  let btc = 0;
  for (let p = 1; p <= pages; p++) {
    const arr = await fetchMarkets(p, perPage);
    for (const it of arr) {
      const mc = Number(it?.market_cap);
      if (!Number.isFinite(mc) || mc <= 0) continue;
      const id = String(it?.id || '').toLowerCase();
      if (id === 'bitcoin') btc = mc;
      if (id === 'bitcoin' || !isProbablyStable(it, excludeStables, extraExcludes)) {
        total += mc;
      }
    }
    // Respeta rate limits si pides varias páginas
    if (pages > 1 && p < pages) await new Promise(r => setTimeout(r, 1200));
  }

  if (btc <= 0 || total <= 0) throw new Error('Invalid sums (btc or total = 0)');
  const pct = (btc / total) * 100;
  console.log(`BTC.D = ${pct.toFixed(6)}%  (perPage=${perPage}, pages=${pages}, excludeStables=${excludeStables})`);
  if (typeof tv === 'number' && Number.isFinite(tv)) {
    const diff = pct - tv;
    console.log(`TradingView = ${tv.toFixed(6)}%  Δ = ${diff >= 0 ? '+' : ''}${diff.toFixed(6)}%`);
  }

  // Fallback de referencia (CG /global)
  try {
    const g = await fetch('https://api.coingecko.com/api/v3/global', { headers: { 'User-Agent': DEFAULT_UA }, cache: 'no-store' });
    if (g.ok) {
      const j = await g.json();
      const ref = j?.data?.market_cap_percentage?.btc;
      if (typeof ref === 'number') console.log(`CoinGecko /global ref = ${ref.toFixed(6)}%`);
    }
  } catch {}
}

main().catch(e => { console.error('Error:', e.message || e); process.exit(1); });