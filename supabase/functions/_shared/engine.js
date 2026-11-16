// Signal engine — plain ES module, used by both the browser (index.html) and
// the Supabase Edge Function (Deno). No dependencies.
//
// Timeframe: 4H candles. Holding horizon: 2–3 days (= 12–18 candles).
// Long EMAs on 4H stand in for the daily trend (EMA120 4H ≈ EMA20 1D, EMA300 4H ≈ EMA50 1D).

export const CONFIG = {
  interval: '4h',
  candleMs: 4 * 60 * 60 * 1000,
  holdCandles: 18, // 72h time stop
  longThreshold: 40,
  shortThreshold: -40,
  strongThreshold: 60,
  // Tuned for a high win rate (~70%+ in backtest): wide stop, quick partial profit.
  // Note: win rate rises but average R per trade barely changes — see README.
  slAtr: 3, // stop loss = 3 × ATR(14, 4H) = 1R
  tp1Atr: 0.8, // TP1 ≈ 0.27R: close 50%, move SL to entry
  tp2Atr: 3, // TP2 = 1R: close the rest
  feePct: 0.08, // round-trip taker fee, % of notional
  weights: { htf: 25, trend: 20, macd: 15, rsi: 15, dmi: 10, volume: 5, rs: 10, funding: 5 },
};

// ---------------------------------------------------------------- indicators

// Exponential-style smoothing that skips leading nulls and seeds with an SMA.
function smooth(values, period, alpha) {
  const out = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < period) return out;
  let sum = 0;
  for (let i = start; i < start + period; i++) sum += values[i];
  let prev = sum / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = prev + alpha * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}
export const ema = (v, p) => smooth(v, p, 2 / (p + 1));
const rma = (v, p) => smooth(v, p, 1 / p); // Wilder

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const gains = [null], losses = [null];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = rma(gains, period), al = rma(losses, period);
  return ag.map((g, i) => (g == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
}

export function atr(h, l, c, period = 14) {
  const tr = [null];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  return { tr, atr: rma(tr, period) };
}

export function adx(h, l, c, period = 14) {
  const pdm = [null], mdm = [null];
  for (let i = 1; i < c.length; i++) {
    const up = h[i] - h[i - 1], down = l[i - 1] - l[i];
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
  }
  const { tr } = atr(h, l, c, period);
  const str = rma(tr, period), spdm = rma(pdm, period), smdm = rma(mdm, period);
  const pdi = str.map((t, i) => (t ? (100 * spdm[i]) / t : null));
  const mdi = str.map((t, i) => (t ? (100 * smdm[i]) / t : null));
  const dx = pdi.map((p, i) => {
    if (p == null || mdi[i] == null) return null;
    const s = p + mdi[i];
    return s === 0 ? 0 : (100 * Math.abs(p - mdi[i])) / s;
  });
  return { adx: rma(dx, period), pdi, mdi };
}

export function computeIndicators(candles) {
  const c = candles.map((k) => k.c), h = candles.map((k) => k.h), l = candles.map((k) => k.l);
  const v = candles.map((k) => k.v || 0);
  const ema12 = ema(c, 12), ema26 = ema(c, 26);
  const macd = ema12.map((x, i) => (x == null || ema26[i] == null ? null : x - ema26[i]));
  const macdSignal = ema(macd, 9);
  const macdHist = macd.map((x, i) => (x == null || macdSignal[i] == null ? null : x - macdSignal[i]));
  const { adx: adxV, pdi, mdi } = adx(h, l, c, 14);
  return {
    c, h, l, v,
    t: candles.map((k) => k.t),
    ema21: ema(c, 21), ema55: ema(c, 55), ema120: ema(c, 120), ema300: ema(c, 300),
    rsi: rsi(c, 14), macdHist, atr: atr(h, l, c, 14).atr,
    adx: adxV, pdi, mdi, volSma: sma(v, 20),
  };
}

// ------------------------------------------------------------------- scoring

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

/**
 * Score one candle. Returns null while indicators are still warming up.
 * ctx.btcClose: Map<time, close> for relative strength; ctx.funding: rate per 8h (live only).
 */
export function scoreAt(ind, i, ctx = {}) {
  const W = CONFIG.weights;
  const { c } = ind;
  if (i < 3 || ind.ema55[i] == null || ind.macdHist[i - 1] == null || ind.rsi[i] == null || ind.atr[i] == null || ind.adx[i] == null) {
    return null;
  }
  const parts = [];

  // 1. Higher-timeframe trend (≈ daily EMA20 / EMA50)
  if (ind.ema120[i] != null) {
    const e120 = ind.ema120[i], e300 = ind.ema300[i];
    let val, note;
    if (e300 != null) {
      if (c[i] > e120 && e120 > e300) { val = 1; note = 'Giá > EMA120 > EMA300 (xu hướng ngày tăng)'; }
      else if (c[i] < e120 && e120 < e300) { val = -1; note = 'Giá < EMA120 < EMA300 (xu hướng ngày giảm)'; }
      else { val = c[i] > e120 ? 0.3 : -0.3; note = `Giá ${c[i] > e120 ? 'trên' : 'dưới'} EMA120 nhưng EMA chưa đồng thuận`; }
    } else {
      val = c[i] > e120 ? 0.6 : -0.6;
      note = `Giá ${c[i] > e120 ? 'trên' : 'dưới'} EMA120 (thiếu dữ liệu EMA300)`;
    }
    parts.push({ key: 'htf', label: 'Xu hướng khung ngày', value: val, weight: W.htf, note });
  }

  // 2. Medium-term trend: EMA21 vs EMA55 + slope of EMA21
  {
    const up = ind.ema21[i] > ind.ema55[i];
    const slope = (ind.ema21[i] - ind.ema21[i - 3]) / ind.ema21[i - 3];
    let val;
    if (up && slope > 0) val = 1;
    else if (!up && slope < 0) val = -1;
    else val = up ? 0.3 : -0.3;
    parts.push({ key: 'trend', label: 'Xu hướng 4H (EMA21/55)', value: val, weight: W.trend,
      note: `EMA21 ${up ? '>' : '<'} EMA55, độ dốc EMA21 ${pct(slope)} / 12h` });
  }

  // 3. MACD histogram momentum
  {
    const hNow = ind.macdHist[i], hPrev = ind.macdHist[i - 1];
    let val, note;
    if (hNow > 0) { val = hNow > hPrev ? 1 : 0.3; note = hNow > hPrev ? 'Histogram dương và tăng' : 'Histogram dương nhưng yếu dần'; }
    else { val = hNow < hPrev ? -1 : -0.3; note = hNow < hPrev ? 'Histogram âm và giảm' : 'Histogram âm nhưng thu hẹp'; }
    parts.push({ key: 'macd', label: 'Động lượng MACD', value: val, weight: W.macd, note });
  }

  // 4. RSI regime (penalise extremes — pullback risk inside a 2–3 day hold)
  {
    const r = ind.rsi[i];
    let val;
    if (r > 78) val = -0.5;
    else if (r > 68) val = 0.3;
    else if (r >= 50) val = 1;
    else if (r >= 32) val = -1;
    else if (r >= 22) val = -0.3;
    else val = 0.5;
    const zone = r > 70 ? 'quá mua' : r < 30 ? 'quá bán' : r >= 50 ? 'vùng tăng' : 'vùng giảm';
    parts.push({ key: 'rsi', label: 'RSI(14)', value: val, weight: W.rsi, note: `RSI ${r.toFixed(1)} — ${zone}` });
  }

  // 5. Trend strength / direction (ADX + DMI)
  {
    const a = ind.adx[i], dir = Math.sign(ind.pdi[i] - ind.mdi[i]);
    const val = a >= 20 ? dir * clamp((a - 15) / 15, 0, 1) : 0;
    parts.push({ key: 'dmi', label: 'Sức mạnh xu hướng (ADX)', value: val, weight: W.dmi,
      note: `ADX ${a.toFixed(1)} ${a < 20 ? '— thị trường đi ngang' : dir > 0 ? '— DI+ áp đảo' : '— DI− áp đảo'}` });
  }

  // 6. Volume confirmation
  if (ind.volSma[i] > 0) {
    const avg3 = (ind.v[i] + ind.v[i - 1] + ind.v[i - 2]) / 3;
    const ratio = avg3 / ind.volSma[i];
    const dir = Math.sign(c[i] - c[i - 3]);
    const val = ratio > 1.2 ? dir * clamp((ratio - 1) / 0.8, 0, 1) : 0;
    parts.push({ key: 'volume', label: 'Khối lượng', value: val, weight: W.volume,
      note: `KL 3 nến gần nhất = ${ratio.toFixed(2)}× trung bình 20 nến` });
  }

  // 7. Relative strength vs BTC over 3 days
  if (ctx.btcClose && i >= 18 && !ctx.isBtc) {
    const b0 = ctx.btcClose.get(ind.t[i - 18]), b1 = ctx.btcClose.get(ind.t[i]);
    if (b0 && b1) {
      const diff = (c[i] / c[i - 18] - 1) - (b1 / b0 - 1);
      parts.push({ key: 'rs', label: 'Sức mạnh so với BTC (3 ngày)', value: clamp(diff / 0.05), weight: W.rs,
        note: `Chênh lệch hiệu suất ${pct(diff)} so với BTC` });
    }
  }

  // 8. Funding rate (live only — contrarian on crowded positioning)
  if (ctx.funding != null) {
    const f = ctx.funding;
    let val = 0;
    if (f > 0.0003) val = -clamp((f - 0.0003) / 0.0005, 0.3, 1);
    else if (f < -0.0001) val = clamp((-f - 0.0001) / 0.0003, 0.3, 1);
    parts.push({ key: 'funding', label: 'Funding rate', value: val, weight: W.funding,
      note: `${(f * 100).toFixed(4)}% / 8h ${val < 0 ? '— phe Long đông, rủi ro squeeze' : val > 0 ? '— phe Short đông, rủi ro squeeze' : '— trung tính'}` });
  }

  const wSum = parts.reduce((s, p) => s + p.weight, 0);
  let score = (parts.reduce((s, p) => s + p.value * p.weight, 0) / wSum) * 100;
  if (ind.adx[i] < 15) score *= 0.75; // choppy market dampener
  return { score, parts };
}

export function classify(score) {
  if (score == null) return 'NEUTRAL';
  if (score >= CONFIG.longThreshold) return 'LONG';
  if (score <= CONFIG.shortThreshold) return 'SHORT';
  return 'NEUTRAL';
}

// ------------------------------------------------------------------ backtest


function simulate(ind, i, dir) {
  const { c, h, l } = ind;
  const n = c.length;
  const entry = c[i];
  const risk = CONFIG.slAtr * ind.atr[i];
  const sl = entry - dir * risk;
  const tp1 = entry + dir * CONFIG.tp1Atr * ind.atr[i];
  const tp2 = entry + dir * CONFIG.tp2Atr * ind.atr[i];
  const r1 = CONFIG.tp1Atr / CONFIG.slAtr, r2 = CONFIG.tp2Atr / CONFIG.slAtr;
  const fee = ((CONFIG.feePct / 100) * entry) / risk;
  const last = i + CONFIG.holdCandles;
  if (last > n - 1) return null; // not enough future candles — trade still open
  let tp1Hit = false;
  const done = (j, R, outcome) => ({ entryIdx: i, exitIdx: j, t: ind.t[i], exitT: ind.t[j], dir: dir > 0 ? 'LONG' : 'SHORT', entry, R: R - fee, outcome });
  for (let j = i + 1; j <= last; j++) {
    const lo = l[j], hi = h[j];
    if (!tp1Hit) {
      // Same-candle SL & TP → assume SL first (conservative)
      if (dir > 0 ? lo <= sl : hi >= sl) return done(j, -1, 'SL');
      if (dir > 0 ? hi >= tp1 : lo <= tp1) tp1Hit = true;
    } else {
      if (dir > 0 ? lo <= entry : hi >= entry) return done(j, 0.5 * r1, 'TP1 → hòa vốn');
      if (dir > 0 ? hi >= tp2 : lo <= tp2) return done(j, 0.5 * r1 + 0.5 * r2, 'TP2');
    }
  }
  const pnlR = (dir * (c[last] - entry)) / risk;
  return done(last, tp1Hit ? 0.5 * r1 + 0.5 * pnlR : pnlR, tp1Hit ? 'TP1 → hết giờ' : 'Hết 72h');
}

export function summarize(trades) {
  const stat = (arr) => {
    const wins = arr.filter((t) => t.R > 0);
    const pos = wins.reduce((s, t) => s + t.R, 0);
    const neg = -arr.filter((t) => t.R <= 0).reduce((s, t) => s + t.R, 0);
    const total = arr.reduce((s, t) => s + t.R, 0);
    return {
      trades: arr.length,
      winRate: arr.length ? wins.length / arr.length : null,
      avgR: arr.length ? total / arr.length : null,
      totalR: total,
      profitFactor: neg > 0 ? pos / neg : arr.length ? Infinity : null,
    };
  };
  return { all: stat(trades), long: stat(trades.filter((t) => t.dir === 'LONG')), short: stat(trades.filter((t) => t.dir === 'SHORT')) };
}

// ------------------------------------------------------------------- analyze

/**
 * @param candles closed 4H candles [{t,o,h,l,c,v}] oldest → newest
 * @param opts { btcCandles?, funding?, livePrice?, isBtc? }
 */
export function analyze(candles, opts = {}) {
  if (!candles || candles.length < 80) return { error: 'Không đủ dữ liệu nến' };
  const ind = computeIndicators(candles);
  const n = candles.length;
  const btcClose = opts.btcCandles ? new Map(opts.btcCandles.map((k) => [k.t, k.c])) : null;
  const baseCtx = { btcClose, isBtc: opts.isBtc };

  // Historical scores (no funding — not available historically)
  const scores = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const s = scoreAt(ind, i, baseCtx);
    scores[i] = s ? s.score : null;
  }

  // Backtest: enter on a fresh signal (class changes into LONG/SHORT), one position at a time.
  const trades = [];
  // Start once the HTF EMAs are warm so backtest scores match live scores.
  let first = ind.ema300.findIndex((v) => v != null);
  if (first < 0 || n - first < 60) first = ind.ema120.findIndex((v) => v != null);
  if (first < 0) first = scores.findIndex((s) => s != null);
  first = Math.max(first, scores.findIndex((s) => s != null));
  for (let i = Math.max(first, 1); i < n - 1; i++) {
    const cls = classify(scores[i]);
    if (cls === 'NEUTRAL' || scores[i - 1] == null || cls === classify(scores[i - 1])) continue;
    const tr = simulate(ind, i, cls === 'LONG' ? 1 : -1);
    if (!tr) break;
    trades.push(tr);
    i = tr.exitIdx; // loop ++ moves past exit
  }

  // Current signal (last closed candle, with funding)
  const last = n - 1;
  const cur = scoreAt(ind, last, { ...baseCtx, funding: opts.funding });
  if (!cur) return { error: 'Chỉ báo chưa đủ dữ liệu' };
  const signal = classify(cur.score);

  let age = 0;
  for (let j = last; j >= 0 && classify(scores[j]) === signal; j--) age++;

  const price = opts.livePrice ?? ind.c[last];
  const a = ind.atr[last];
  const dir = signal === 'SHORT' ? -1 : 1;
  const plan = {
    entry: price,
    sl: price - dir * CONFIG.slAtr * a,
    tp1: price + dir * CONFIG.tp1Atr * a,
    tp2: price + dir * CONFIG.tp2Atr * a,
    atr: a,
    atrPct: a / price,
    riskPct: (CONFIG.slAtr * a) / price,
  };

  const strength = Math.abs(cur.score) >= CONFIG.strongThreshold ? 'Mạnh' : signal === 'NEUTRAL' ? '—' : 'Trung bình';

  // Chart series (last 300 candles)
  const from = Math.max(0, n - 300);
  const sec = (t) => Math.floor(t / 1000);
  const line = (arr) => arr.slice(from).map((v, k) => (v == null ? null : { time: sec(ind.t[from + k]), value: v })).filter(Boolean);
  const series = {
    candles: candles.slice(from).map((k) => ({ time: sec(k.t), open: k.o, high: k.h, low: k.l, close: k.c })),
    ema21: line(ind.ema21), ema55: line(ind.ema55), ema120: line(ind.ema120),
    score: line(scores),
  };

  return {
    signal,
    score: cur.score,
    strength,
    age, // number of 4H candles the current class has persisted
    parts: cur.parts,
    plan,
    rsi: ind.rsi[last],
    adx: ind.adx[last],
    lastCandleT: ind.t[last],
    backtest: { ...summarize(trades), fromT: ind.t[first], toT: ind.t[last], candles: n - first },
    trades: trades.slice(-15).reverse().map(({ entryIdx, exitIdx, ...t }) => t),
    series,
  };
}
