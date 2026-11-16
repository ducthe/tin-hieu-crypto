import { runPipeline, fetchCandles } from './supabase/functions/_shared/market.js';
import { analyze, CONFIG } from './supabase/functions/_shared/engine.js';

const cfg = window.APP_CONFIG || {};
const SB = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY ? { url: cfg.SUPABASE_URL.replace(/\/$/, ''), key: cfg.SUPABASE_ANON_KEY } : null;

const state = { data: null, filter: 'ALL', sort: 'rank', mode: SB ? 'supabase' : 'live', loading: false, trades: [] };
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ format

function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '—';
  const d = p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 8;
  return p.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}
const fmtPct = (x, d = 2) => (x == null || !isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const fmtR = (r) => (r == null || !isFinite(r) ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
const fmtTime = (t) => new Date(t).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const fmtBig = (x) => (x >= 1e12 ? `${(x / 1e12).toFixed(2)}T` : x >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : `${(x / 1e6).toFixed(0)}M`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { LONG: 'LONG', SHORT: 'SHORT', NEUTRAL: 'ĐỨNG NGOÀI' };

function sparkline(arr) {
  if (!arr || arr.length < 2) return '';
  const w = 96, h = 30, min = Math.min(...arr), max = Math.max(...arr), span = max - min || 1;
  const pts = arr.map((v, i) => `${((i / (arr.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const color = arr[arr.length - 1] >= arr[0] ? 'var(--long)' : 'var(--short)';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

function meter(score) {
  const s = Math.max(-100, Math.min(100, score));
  const color = s >= CONFIG.longThreshold ? 'var(--long)' : s <= CONFIG.shortThreshold ? 'var(--short)' : 'var(--neutral)';
  const left = s >= 0 ? 50 : 50 + s / 2, width = Math.abs(s) / 2;
  return `<div class="meter"><i style="left:${left}%;width:${width}%;background:${color}"></i></div>`;
}

// Backtest stats in the direction of the current signal (or overall when neutral)
function dirStats(r) {
  const b = r.backtest;
  if (!b) return null;
  return r.signal === 'LONG' ? b.long : r.signal === 'SHORT' ? b.short : b.all;
}

function ageText(r) {
  if (r.signal === 'NEUTRAL') return '';
  const h = r.age * 4;
  if (r.age <= 1) return '🆕 vừa xuất hiện';
  return h < 24 ? `${h} giờ trước` : `${(h / 24).toFixed(1)} ngày trước`;
}

// ----------------------------------------------------------------- loading

function setProgress(done, total, text) {
  $('progress').hidden = false;
  $('progress-bar').style.width = `${Math.round((done / total) * 100)}%`;
  $('progress-text').textContent = `${done}/${total} · ${text}`;
}

async function sbGet(path) {
  const r = await fetch(`${SB.url}/rest/v1/${path}`, { headers: { apikey: SB.key, Authorization: `Bearer ${SB.key}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function loadSupabase() {
  const [runs, rows, trades] = await Promise.all([
    sbGet('signal_runs?select=*&order=run_at.desc&limit=1'),
    sbGet('latest_signals?select=payload&order=rank.asc'),
    sbGet('signal_trades?select=*&order=opened_at.desc&limit=300'),
  ]);
  if (!runs.length || !rows.length) throw new Error('Supabase chưa có dữ liệu — hãy gọi Edge Function update-signals lần đầu.');
  state.trades = trades;
  return { generatedAt: runs[0].run_at, fng: runs[0].fng, skipped: runs[0].skipped || [], results: rows.map((x) => x.payload) };
}

async function load(forceLive = false) {
  if (state.loading) return;
  state.loading = true;
  $('refresh').disabled = true;
  try {
    if (SB && !forceLive) {
      $('status').textContent = 'Đang đọc tín hiệu từ Supabase…';
      try {
        state.data = await loadSupabase();
        state.mode = 'supabase';
      } catch (e) {
        console.warn(e);
        $('status').textContent = `${e.message} → chuyển sang tính trực tiếp…`;
        state.data = await runPipeline({ onProgress: setProgress });
        state.mode = 'live';
      }
    } else {
      state.data = await runPipeline({ onProgress: setProgress });
      state.mode = 'live';
    }
    render();
  } catch (e) {
    console.error(e);
    $('status').textContent = `Lỗi tải dữ liệu: ${e.message}`;
  } finally {
    state.loading = false;
    $('refresh').disabled = false;
    setTimeout(() => ($('progress').hidden = true), 400);
  }
}

// ------------------------------------------------------------------ render

function render() {
  const d = state.data;
  if (!d) return;
  const res = d.results;
  $('status').textContent = `Cập nhật ${fmtTime(d.generatedAt)} · ${res.length} coin · nến 4H đã đóng gần nhất ${res[0] ? fmtTime(res[0].lastCandleT + CONFIG.candleMs) : '—'}`;
  $('mode').textContent = state.mode === 'supabase' ? '☁ Supabase' : '⚡ Tính trực tiếp';
  if (d.fng) {
    const f = d.fng;
    $('fng').hidden = false;
    $('fng').innerHTML = `Fear &amp; Greed: <b class="${f.value < 45 ? 'down' : f.value > 55 ? 'up' : ''}">${f.value}</b> ${esc(f.label)}`;
  }
  $('tab-journal').hidden = !SB;

  // Summary
  const n = (s) => res.filter((r) => r.signal === s).length;
  let T = 0, W = 0, R = 0;
  for (const r of res) {
    const b = r.backtest?.all;
    if (!b?.trades) continue;
    T += b.trades; W += b.winRate * b.trades; R += b.totalR;
  }
  const btc = res.find((r) => r.symbol === 'BTC');
  $('summary').innerHTML = `
    <div class="stat long"><div class="k">Tín hiệu LONG</div><div class="v">${n('LONG')}</div><div class="h">${res.filter((r) => r.signal === 'LONG' && r.age <= 1).length} mới xuất hiện</div></div>
    <div class="stat short"><div class="k">Tín hiệu SHORT</div><div class="v">${n('SHORT')}</div><div class="h">${res.filter((r) => r.signal === 'SHORT' && r.age <= 1).length} mới xuất hiện</div></div>
    <div class="stat"><div class="k">Đứng ngoài</div><div class="v">${n('NEUTRAL')}</div><div class="h">Điểm trong khoảng ±${CONFIG.longThreshold}</div></div>
    <div class="stat"><div class="k">BTC</div><div class="v">${btc ? `<span class="${btc.signal === 'LONG' ? 'up' : btc.signal === 'SHORT' ? 'down' : ''}">${btc.score.toFixed(0)}</span>` : '—'}</div><div class="h">${btc ? `${LABEL[btc.signal]} · dẫn dắt thị trường` : ''}</div></div>
    <div class="stat"><div class="k">Backtest tổng (${T} lệnh)</div><div class="v ${W / T >= 0.7 ? 'up' : ''}">${T ? ((W / T) * 100).toFixed(0) + '%' : '—'}</div><div class="h">tỷ lệ có lãi · R TB <b class="${cls(R)}">${T ? fmtR(R / T) : '—'}</b>/lệnh</div></div>`;

  // Filter + sort
  let rows = res.slice();
  if (state.filter === 'WIN70') rows = rows.filter((r) => r.signal !== 'NEUTRAL' && (dirStats(r)?.winRate ?? 0) >= 0.7);
  else if (state.filter !== 'ALL') rows = rows.filter((r) => r.signal === state.filter);
  if (state.sort === 'score') rows.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  if (state.sort === 'fresh') rows.sort((a, b) => (a.signal === 'NEUTRAL') - (b.signal === 'NEUTRAL') || a.age - b.age);

  $('rows').innerHTML = rows.map(rowHtml).join('') || `<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">Không có coin nào khớp bộ lọc.</td></tr>`;
  $('cards').innerHTML = rows.map(cardHtml).join('');
  $('skipped').textContent = d.skipped?.length ? `Bỏ qua (không có dữ liệu nến trên Binance/Bybit/OKX): ${d.skipped.map((s) => s.symbol).join(', ')}` : '';

  if (SB) renderJournal();
}

function planHtml(r) {
  const p = r.plan;
  if (r.signal === 'NEUTRAL') return `<div class="plan"><div class="muted-plan">Chưa đủ điều kiện — chờ điểm vượt ±${CONFIG.longThreshold}</div></div>`;
  const pc = (x) => `<small class="muted">${fmtPct(((x - p.entry) / p.entry) * 100, 1)}</small>`;
  return `<div class="plan">
    <div><span>Entry</span>${fmtPrice(p.entry)}</div>
    <div><span>SL</span><b class="down">${fmtPrice(p.sl)}</b> ${pc(p.sl)}</div>
    <div><span>TP1</span><b class="up">${fmtPrice(p.tp1)}</b> ${pc(p.tp1)}</div>
    <div><span>TP2</span><b class="up">${fmtPrice(p.tp2)}</b> ${pc(p.tp2)}</div></div>`;
}

function btHtml(r) {
  const s = dirStats(r);
  if (!s?.trades) return '<span class="muted">—</span>';
  const label = r.signal === 'NEUTRAL' ? 'mọi lệnh' : `lệnh ${r.signal}`;
  return `<div class="bt"><b class="${s.winRate >= 0.7 ? 'up' : s.winRate < 0.5 ? 'down' : ''}">${(s.winRate * 100).toFixed(0)}%</b> · <b class="${cls(s.avgR)}">${fmtR(s.avgR)}</b><small>${s.trades} ${label}</small></div>`;
}

function fundingHtml(r) {
  if (r.funding == null) return '<span class="muted">—</span>';
  const f = r.funding * 100;
  return `<span class="${f > 0.03 ? 'down' : f < -0.01 ? 'up' : ''}">${f.toFixed(4)}%</span>`;
}

function sigHtml(r) {
  return `<div class="sig"><div><span class="badge ${r.signal}">${LABEL[r.signal]}</span> <b class="mono">${r.score > 0 ? '+' : ''}${r.score.toFixed(0)}</b></div>${meter(r.score)}<div class="meta">${r.signal === 'NEUTRAL' ? 'Điểm yếu, không vào lệnh' : `${r.strength} · ${ageText(r)}`}</div></div>`;
}

function rowHtml(r) {
  return `<tr data-id="${esc(r.id)}">
    <td class="muted">${r.rank}</td>
    <td><div class="coin"><img src="${esc(r.image)}" alt="" loading="lazy"/><div><b>${esc(r.symbol)}</b><small>${esc(r.name)}</small></div></div></td>
    <td class="r">${fmtPrice(r.price)}</td>
    <td class="r ${cls(r.change24h)}">${fmtPct(r.change24h)}</td>
    <td>${sparkline(r.sparkline)}</td>
    <td>${sigHtml(r)}</td>
    <td>${planHtml(r)}</td>
    <td class="r">${btHtml(r)}</td>
    <td class="r">${fundingHtml(r)}</td></tr>`;
}

function cardHtml(r) {
  const p = r.plan;
  return `<div class="card" data-id="${esc(r.id)}">
    <div class="row"><div class="coin"><img src="${esc(r.image)}" alt=""/><div><b>${esc(r.symbol)} <small class="muted">#${r.rank}</small></b><small>${fmtPrice(r.price)} · <span class="${cls(r.change24h)}">${fmtPct(r.change24h)}</span></small></div></div>${sparkline(r.sparkline)}</div>
    <div class="row">${sigHtml(r)}${btHtml(r)}</div>
    ${r.signal === 'NEUTRAL' ? '' : `<div class="row"><div class="plan-grid" style="width:100%">
      <div><span>Entry</span>${fmtPrice(p.entry)}</div><div><span>SL</span><b class="down">${fmtPrice(p.sl)}</b></div>
      <div><span>TP1</span><b class="up">${fmtPrice(p.tp1)}</b></div><div><span>TP2</span><b class="up">${fmtPrice(p.tp2)}</b></div></div></div>`}
  </div>`;
}

// ----------------------------------------------------------------- journal

const STATUS_CLASS = (s, r) => (s === 'OPEN' ? 'open' : r > 0 ? 'win' : r < 0 ? 'loss' : '');

function renderJournal() {
  const tr = state.trades;
  const closed = tr.filter((t) => t.status !== 'OPEN');
  const wins = closed.filter((t) => t.result_r > 0);
  const totalR = closed.reduce((s, t) => s + +t.result_r, 0);
  $('journal-stats').innerHTML = `
    <div class="stat"><div class="k">Lệnh đang mở</div><div class="v">${tr.length - closed.length}</div></div>
    <div class="stat"><div class="k">Lệnh đã đóng</div><div class="v">${closed.length}</div></div>
    <div class="stat"><div class="k">Tỷ lệ có lãi (thực tế)</div><div class="v ${wins.length / closed.length >= 0.7 ? 'up' : ''}">${closed.length ? ((wins.length / closed.length) * 100).toFixed(0) + '%' : '—'}</div></div>
    <div class="stat"><div class="k">Tổng / TB mỗi lệnh</div><div class="v ${cls(totalR)}">${closed.length ? fmtR(totalR) : '—'}</div><div class="h">${closed.length ? fmtR(totalR / closed.length) + ' / lệnh' : ''}</div></div>`;
  $('journal-rows').innerHTML = tr.map((t) => `<tr>
    <td>${fmtTime(t.opened_at)}</td><td><b>${esc(t.symbol)}</b></td><td><span class="badge ${t.dir}">${t.dir}</span></td>
    <td class="r">${fmtPrice(+t.entry)}</td><td class="r">${fmtPrice(+t.sl)}</td><td class="r">${fmtPrice(+t.tp1)}</td><td class="r">${fmtPrice(+t.tp2)}</td>
    <td><span class="status ${STATUS_CLASS(t.status, +t.result_r)}">${t.status === 'OPEN' ? (t.tp1_hit ? 'Đang mở · đã chạm TP1' : 'Đang mở') : esc(t.status)}</span></td>
    <td class="r ${cls(+t.result_r)}">${t.status === 'OPEN' ? '' : fmtR(+t.result_r)}</td></tr>`).join('')
    || `<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">Chưa có lệnh nào. Lệnh được ghi khi một tín hiệu Long/Short mới xuất hiện.</td></tr>`;
}

// ------------------------------------------------------------------ detail

let chart = null;

async function openDetail(id) {
  const r = state.data.results.find((x) => x.id === id);
  if (!r) return;
  const dlg = $('detail');
  $('dlg-title').innerHTML = `<div class="coin"><img src="${esc(r.image)}" alt=""/><div><b>${esc(r.name)} (${esc(r.symbol)}) <span class="badge ${r.signal}">${LABEL[r.signal]} ${r.score > 0 ? '+' : ''}${r.score.toFixed(0)}</span></b><small>#${r.rank} · vốn hóa ${fmtBig(r.marketCap)} · nguồn nến ${esc(r.source)} ${esc(r.ticker)}/USDT · ${r.hasPerp ? 'có hợp đồng Perp trên Binance' : 'không thấy Perp trên Binance'}</small></div></div>`;

  $('parts').innerHTML = r.parts.map((p) => {
    const v = p.value;
    const color = v > 0 ? 'var(--long)' : v < 0 ? 'var(--short)' : 'var(--neutral)';
    return `<div class="part"><div><div class="name">${esc(p.label)} <small class="muted">· trọng số ${p.weight}</small></div><div class="note">${esc(p.note)}</div></div>
      <div class="meter"><i style="left:${v >= 0 ? 50 : 50 + v * 50}%;width:${Math.abs(v) * 50}%;background:${color}"></i></div>
      <div class="val ${cls(v)}">${v > 0 ? '+' : ''}${(v * p.weight).toFixed(1)}</div></div>`;
  }).join('');

  const p = r.plan;
  const risk = Math.abs(p.entry - p.sl) / p.entry;
  $('plan').innerHTML = r.signal === 'NEUTRAL'
    ? `<div class="note-box">Điểm ${r.score.toFixed(0)} nằm trong vùng ±${CONFIG.longThreshold}: tín hiệu chưa rõ ràng, nên đứng ngoài. Biến động trung bình (ATR 4H): ${(p.atrPct * 100).toFixed(2)}%.</div>`
    : `<dl class="kv">
        <dt>Hướng</dt><dd><span class="badge ${r.signal}">${r.signal}</span></dd>
        <dt>Vào lệnh</dt><dd>${fmtPrice(p.entry)}</dd>
        <dt>Stop loss (1R)</dt><dd class="down">${fmtPrice(p.sl)} (${fmtPct(((p.sl - p.entry) / p.entry) * 100)})</dd>
        <dt>TP1 · chốt 50%</dt><dd class="up">${fmtPrice(p.tp1)} (${fmtPct(((p.tp1 - p.entry) / p.entry) * 100)})</dd>
        <dt>TP2 · chốt hết</dt><dd class="up">${fmtPrice(p.tp2)} (${fmtPct(((p.tp2 - p.entry) / p.entry) * 100)})</dd>
        <dt>Giữ tối đa</dt><dd>72 giờ</dd>
        <dt>Rủi ro 1% TK → vị thế</dt><dd>${(1 / risk).toFixed(1)}% tài khoản</dd>
      </dl>
      <div class="note-box">Tín hiệu xuất hiện ${ageText(r)}${r.age > 6 ? ' — đã chạy khá lâu, cân nhắc chờ giá hồi về gần EMA21 rồi mới vào' : ''}. Khi chạm TP1: chốt 50% và dời SL về giá vào lệnh.</div>`;

  const b = r.backtest;
  const st = (s, name) => (s.trades ? `<dt>${name}</dt><dd>${s.trades} lệnh · <b class="${s.winRate >= 0.7 ? 'up' : ''}">${(s.winRate * 100).toFixed(0)}%</b> · <span class="${cls(s.avgR)}">${fmtR(s.avgR)}</span></dd>` : `<dt>${name}</dt><dd>—</dd>`);
  $('bt').innerHTML = `<dl class="kv">${st(b.all, 'Tất cả')}${st(b.long, 'Long')}${st(b.short, 'Short')}
    <dt>Profit factor</dt><dd>${b.all.profitFactor == null ? '—' : isFinite(b.all.profitFactor) ? b.all.profitFactor.toFixed(2) : '∞'}</dd>
    <dt>Giai đoạn</dt><dd>${new Date(b.fromT).toLocaleDateString('vi-VN')} → ${new Date(b.toT).toLocaleDateString('vi-VN')}</dd></dl>`;

  $('trades').innerHTML = `<thead><tr><th>Vào lệnh</th><th>Hướng</th><th class="r">Giá vào</th><th>Kết quả</th><th class="r">R</th><th>Đóng</th></tr></thead><tbody>${
    (r.trades || []).map((t) => `<tr><td>${fmtTime(t.t)}</td><td><span class="badge ${t.dir}">${t.dir}</span></td><td class="r">${fmtPrice(t.entry)}</td><td>${esc(t.outcome)}</td><td class="r ${cls(t.R)}">${fmtR(t.R)}</td><td>${fmtTime(t.exitT)}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">Chưa có lệnh</td></tr>'}</tbody>`;

  dlg.showModal();
  await drawChart(r);
}

async function drawChart(r) {
  const el = $('chart');
  if (chart) { chart.remove(); chart = null; }
  if (!window.LightweightCharts) { el.innerHTML = '<p class="muted" style="padding:16px">Không tải được thư viện biểu đồ.</p>'; return; }
  let series = r.series;
  if (!series) {
    // Supabase rows don't store chart data — rebuild it from fresh candles
    el.innerHTML = '<p class="muted" style="padding:16px">Đang tải biểu đồ…</p>';
    try {
      const d = await fetchCandles(r.ticker || r.symbol, r.id);
      series = analyze(d.candles, { livePrice: d.livePrice, isBtc: r.id === 'bitcoin' }).series;
      r.series = series;
    } catch (e) {
      el.innerHTML = `<p class="muted" style="padding:16px">Không tải được nến: ${esc(e.message)}</p>`;
      return;
    }
    el.innerHTML = '';
  }
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: v('--panel') }, textColor: v('--muted'), fontFamily: 'JetBrains Mono' },
    grid: { vertLines: { color: v('--line') }, horzLines: { color: v('--line') } },
    rightPriceScale: { borderColor: v('--line') },
    timeScale: { borderColor: v('--line'), timeVisible: true },
    localization: { priceFormatter: fmtPrice },
  });
  const cs = chart.addCandlestickSeries({ upColor: v('--long'), downColor: v('--short'), borderVisible: false, wickUpColor: v('--long'), wickDownColor: v('--short') });
  cs.setData(series.candles);
  for (const [k, color] of [['ema21', '#f5a524'], ['ema55', '#4c8dff'], ['ema120', '#b36bff']]) {
    chart.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(series[k]);
  }
  if (r.signal !== 'NEUTRAL') {
    const p = r.plan;
    cs.createPriceLine({ price: p.entry, color: v('--muted'), lineStyle: 2, title: 'Entry' });
    cs.createPriceLine({ price: p.sl, color: v('--short'), lineStyle: 0, title: 'SL' });
    cs.createPriceLine({ price: p.tp1, color: v('--long'), lineStyle: 2, title: 'TP1' });
    cs.createPriceLine({ price: p.tp2, color: v('--long'), lineStyle: 0, title: 'TP2' });
  }
  // Markers for recent backtest entries
  const markers = (r.trades || []).map((t) => ({
    time: Math.floor(t.t / 1000), position: t.dir === 'LONG' ? 'belowBar' : 'aboveBar',
    color: t.dir === 'LONG' ? v('--long') : v('--short'), shape: t.dir === 'LONG' ? 'arrowUp' : 'arrowDown', text: fmtR(t.R),
  })).filter((m) => m.time >= series.candles[0].time).sort((a, b) => a.time - b.time);
  cs.setMarkers(markers);
  chart.timeScale().setVisibleLogicalRange({ from: series.candles.length - 150, to: series.candles.length + 5 });
}

// ------------------------------------------------------------------- events

$('refresh').onclick = () => load(state.mode === 'live');
$('dlg-close').onclick = () => $('detail').close();
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-id]');
  if (row && (row.closest('#rows') || row.closest('#cards'))) openDetail(row.dataset.id);
});
$('filter').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.filter = b.dataset.f;
  [...$('filter').children].forEach((x) => x.classList.toggle('active', x === b));
  render();
};
$('sort').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.sort = b.dataset.s;
  [...$('sort').children].forEach((x) => x.classList.toggle('active', x === b));
  render();
};
$('tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...$('tabs').children].forEach((x) => x.classList.toggle('active', x === b));
  for (const t of ['signals', 'journal', 'method']) $(`view-${t}`).hidden = t !== b.dataset.tab;
};

let timer = null;
const schedule = () => {
  clearInterval(timer);
  try { localStorage.setItem('auto', $('auto').checked ? '1' : '0'); } catch {}
  if ($('auto').checked) timer = setInterval(() => !document.hidden && load(), 15 * 60 * 1000);
};
try { if (localStorage.getItem('auto') === '0') $('auto').checked = false; } catch {}
$('auto').onchange = schedule;
schedule();
load();
