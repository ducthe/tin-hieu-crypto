// Market data — plain ES module, works in browsers and Deno (Supabase Edge Functions).
// Sources: CoinGecko (top coins by market cap), Binance → Bybit → OKX (4H candles),
// Binance Futures (funding), alternative.me (Fear & Greed). All public, no API key.

import { analyze, CONFIG } from './engine.js';

const COINGECKO = 'https://api.coingecko.com/api/v3';

// Stablecoins, wrapped/staked tokens, gold & RWA tokens — not useful to trade long/short.
const EXCLUDE = new Set([
  'usdt', 'usdc', 'usds', 'usde', 'dai', 'usd1', 'rlusd', 'usdg', 'pyusd', 'usdy', 'fdusd', 'tusd', 'usdd',
  'usdp', 'gusd', 'frax', 'usdx', 'usd0', 'susde', 'susds', 'buidl', 'usdtb', 'usyc', 'bfusd', 'syrupusdc',
  'xaut', 'paxg', 'figr_heloc', 'wbtc', 'weth', 'steth', 'wsteth', 'weeth', 'wbeth', 'cbbtc', 'reth',
  'meth', 'lbtc', 'solvbtc', 'jitosol', 'bnsol', 'msol', 'ezeth', 'rseth', 'cbeth', 'tbtc', 'clbtc',
]);
const NAME_EXCLUDE = /(wrapped|staked|bridged|restaked|liquid staking|\busd\b|dollar|gold)/i;

// CoinGecko id → exchange tickers to try (when the CoinGecko symbol differs).
const ALIASES = { 'the-open-network': ['TON'] };

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function isTradable(c) {
  if (EXCLUDE.has(c.symbol.toLowerCase())) return false;
  if (NAME_EXCLUDE.test(c.name)) return false;
  // Generic stablecoin heuristic: ~$1 and barely moves over 7 days
  const ch7 = c.price_change_percentage_7d_in_currency;
  if (Math.abs(c.current_price - 1) < 0.03 && (ch7 == null || Math.abs(ch7) < 2)) return false;
  return true;
}

export async function fetchMarkets(poolSize = 60) {
  const url = `${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${poolSize}&page=1&sparkline=true&price_change_percentage=24h,7d`;
  const data = await getJson(url);
  return data.filter(isTradable);
}

// ------------------------------------------------------------------ candles

const now = () => Date.now();

async function binanceCandles(sym, limit) {
  const d = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=4h&limit=${limit}`);
  const all = d.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7], closeT: k[6] }));
  return all;
}

async function bybitCandles(sym, limit) {
  const d = await getJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}USDT&interval=240&limit=${limit}`);
  if (d.retCode !== 0 || !d.result?.list?.length) throw new Error('bybit: no data');
  return d.result.list
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6], closeT: +k[0] + CONFIG.candleMs - 1 }))
    .reverse();
}

async function okxCandles(sym) {
  const map = (k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7], closeT: +k[0] + CONFIG.candleMs - 1 });
  const first = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT&bar=4H&limit=300`);
  if (first.code !== '0' || !first.data?.length) throw new Error('okx: no data');
  let rows = first.data;
  // Up to 3 more pages of history (100 each) so long EMAs can warm up
  for (let p = 0; p < 3; p++) {
    const oldest = rows[rows.length - 1][0];
    try {
      const more = await getJson(`https://www.okx.com/api/v5/market/history-candles?instId=${sym}-USDT&bar=4H&limit=100&after=${oldest}`);
      if (!more.data?.length) break;
      rows = rows.concat(more.data);
    } catch { break; }
  }
  return rows.map(map).reverse();
}

/** Returns { source, candles (closed only), livePrice, ticker } or throws. */
export async function fetchCandles(symbol, id, limit = 1000) {
  const tickers = [symbol.toUpperCase(), ...(ALIASES[id] || [])];
  const sources = [
    ['Binance', (s) => binanceCandles(s, limit)],
    ['Bybit', (s) => bybitCandles(s, limit)],
    ['OKX', (s) => okxCandles(s)],
  ];
  const errors = [];
  for (const ticker of tickers) {
    for (const [name, fn] of sources) {
      try {
        const all = await fn(ticker);
        if (!all || all.length < 80) throw new Error(`${name}: ${all?.length || 0} nến`);
        const livePrice = all[all.length - 1].c;
        const candles = all.filter((k) => k.closeT < now());
        return { source: name, ticker, candles, livePrice };
      } catch (e) {
        errors.push(`${name}/${ticker}: ${e.message}`);
      }
    }
  }
  throw new Error(errors.join(' | '));
}

// ------------------------------------------------------------- extra context

export async function fetchFunding() {
  try {
    const d = await getJson('https://fapi.binance.com/fapi/v1/premiumIndex');
    const m = new Map();
    for (const x of d) if (x.symbol.endsWith('USDT')) m.set(x.symbol.slice(0, -4), +x.lastFundingRate);
    return m;
  } catch {
    return new Map();
  }
}

export async function fetchFearGreed() {
  try {
    const d = await getJson('https://api.alternative.me/fng/?limit=1');
    return { value: +d.data[0].value, label: d.data[0].value_classification };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- pipeline

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/**
 * Full run: top N tradable coins by market cap → candles → signals.
 * @param {{count?: number, onProgress?: (done:number,total:number,label:string)=>void, keepSeries?: boolean}} opts
 */
export async function runPipeline({ count = 20, onProgress = () => {}, keepSeries = true } = {}) {
  onProgress(0, count, 'Đang lấy danh sách vốn hóa từ CoinGecko…');
  const [markets, funding, fng] = await Promise.all([fetchMarkets(60), fetchFunding(), fetchFearGreed()]);

  const btc = markets.find((m) => m.id === 'bitcoin');
  const btcData = btc ? await fetchCandles('BTC', 'bitcoin').catch(() => null) : null;

  const results = [];
  const skipped = [];
  let done = 0;
  // Process in batches until we have `count` coins with data
  let cursor = 0;
  while (cursor < markets.length && results.length < count) {
    const batch = markets.slice(cursor, cursor + (count - results.length));
    cursor += batch.length;
    const rows = await mapLimit(batch, 5, async (m) => {
      try {
        const data = m.id === 'bitcoin' && btcData ? btcData : await fetchCandles(m.symbol, m.id);
        const a = analyze(data.candles, {
          btcCandles: btcData?.candles,
          isBtc: m.id === 'bitcoin',
          funding: funding.get(data.ticker),
          livePrice: data.livePrice,
        });
        if (a.error) throw new Error(a.error);
        onProgress(++done, count, `${m.symbol.toUpperCase()} ✓`);
        if (!keepSeries) delete a.series;
        // Last closed candles — the edge function uses these to settle open trades
        const recent = data.candles.slice(-40).map(({ t, h, l, c }) => ({ t, h, l, c }));
        return {
          id: m.id, symbol: m.symbol.toUpperCase(), name: m.name, image: m.image, rank: m.market_cap_rank,
          marketCap: m.market_cap, volume24h: m.total_volume,
          price: data.livePrice,
          change24h: m.price_change_percentage_24h_in_currency,
          change7d: m.price_change_percentage_7d_in_currency,
          sparkline: (m.sparkline_in_7d?.price || []).filter((_, k) => k % 4 === 0),
          source: data.source, ticker: data.ticker,
          funding: funding.get(data.ticker) ?? null,
          hasPerp: funding.has(data.ticker),
          ...a,
          recent,
        };
      } catch (e) {
        skipped.push({ symbol: m.symbol.toUpperCase(), name: m.name, reason: String(e.message || e).slice(0, 200) });
        return null;
      }
    });
    results.push(...rows.filter(Boolean));
  }

  results.sort((a, b) => a.rank - b.rank);
  return { generatedAt: new Date().toISOString(), fng, results: results.slice(0, count), skipped, config: CONFIG };
}
