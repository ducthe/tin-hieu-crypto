// Supabase Edge Function: update-signals
// Called hourly by pg_cron. Computes signals for the top 20 coins, stores a snapshot,
// settles open journal trades and opens new ones when a fresh LONG/SHORT appears.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { runPipeline } from '../_shared/market.js';
import { CONFIG } from '../_shared/engine.js';

type Candle = { t: number; h: number; l: number; c: number };
type Trade = {
  id: number; coin_id: string; dir: 'LONG' | 'SHORT'; signal_t: number;
  entry: number; sl: number; tp1: number; tp2: number; tp1_hit: boolean;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });

// Same rules as the backtest in engine.js, replayed on candles after the signal candle.
function settle(tr: Trade, candles: Candle[]) {
  const dir = tr.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(tr.entry - tr.sl);
  const r1 = Math.abs(tr.tp1 - tr.entry) / risk;
  const r2 = Math.abs(tr.tp2 - tr.entry) / risk;
  const fee = ((CONFIG.feePct / 100) * tr.entry) / risk;
  const after = candles.filter((k) => k.t > tr.signal_t).sort((a, b) => a.t - b.t);
  const closeAt = (k: Candle) => new Date(k.t + CONFIG.candleMs).toISOString();
  let tp1Hit = false;
  for (let i = 0; i < after.length && i < CONFIG.holdCandles; i++) {
    const k = after[i];
    if (!tp1Hit) {
      if (dir > 0 ? k.l <= tr.sl : k.h >= tr.sl) return { status: 'SL', result_r: -1 - fee, exit_price: tr.sl, closed_at: closeAt(k), tp1_hit: false };
      if (dir > 0 ? k.h >= tr.tp1 : k.l <= tr.tp1) tp1Hit = true;
    } else {
      if (dir > 0 ? k.l <= tr.entry : k.h >= tr.entry) return { status: 'TP1 → hòa vốn', result_r: 0.5 * r1 - fee, exit_price: tr.entry, closed_at: closeAt(k), tp1_hit: true };
      if (dir > 0 ? k.h >= tr.tp2 : k.l <= tr.tp2) return { status: 'TP2', result_r: 0.5 * r1 + 0.5 * r2 - fee, exit_price: tr.tp2, closed_at: closeAt(k), tp1_hit: true };
    }
  }
  if (after.length >= CONFIG.holdCandles) {
    const k = after[CONFIG.holdCandles - 1];
    const pnlR = (dir * (k.c - tr.entry)) / risk;
    return {
      status: tp1Hit ? 'TP1 → hết giờ' : 'Hết 72h',
      result_r: (tp1Hit ? 0.5 * r1 + 0.5 * pnlR : pnlR) - fee,
      exit_price: k.c, closed_at: closeAt(k), tp1_hit: tp1Hit,
    };
  }
  return { status: 'OPEN', tp1_hit: tp1Hit }; // still running
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') !== secret) return json({ error: 'unauthorized' }, 401);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  try {
    const data = await runPipeline({ keepSeries: false });
    const results = data.results as any[];
    if (!results.length) return json({ error: 'no results', skipped: data.skipped }, 502);

    // 1. Snapshot
    const { data: run, error: runErr } = await sb.from('signal_runs')
      .insert({ fng: data.fng, skipped: data.skipped, coin_count: results.length })
      .select('id').single();
    if (runErr) throw runErr;

    const snaps = results.map(({ recent: _recent, ...r }) => ({
      run_id: run.id, rank: r.rank, coin_id: r.id, symbol: r.symbol, price: r.price,
      signal: r.signal, score: r.score, payload: r,
    }));
    const { error: snapErr } = await sb.from('signal_snapshots').insert(snaps);
    if (snapErr) throw snapErr;

    // 2. Settle open trades
    const { data: open, error: openErr } = await sb.from('signal_trades').select('*').eq('status', 'OPEN');
    if (openErr) throw openErr;
    let settled = 0;
    const stillOpen = new Set<string>();
    for (const tr of (open || []) as Trade[]) {
      const res = results.find((r) => r.id === tr.coin_id);
      if (!res) { stillOpen.add(tr.coin_id); continue; } // coin dropped out of top 20 this run — retry later
      const upd = settle(tr, res.recent);
      if (upd.status === 'OPEN') {
        stillOpen.add(tr.coin_id);
        if (upd.tp1_hit !== tr.tp1_hit) await sb.from('signal_trades').update({ tp1_hit: upd.tp1_hit }).eq('id', tr.id);
      } else {
        const { error } = await sb.from('signal_trades').update(upd).eq('id', tr.id);
        if (error) throw error;
        settled++;
      }
    }

    // 3. Open new trades on fresh signals (signal began on the latest closed candle)
    const fresh = results.filter((r) => r.signal !== 'NEUTRAL' && r.age <= 1 && !stillOpen.has(r.id));
    if (fresh.length) {
      const rows = fresh.map((r) => ({
        coin_id: r.id, symbol: r.symbol, dir: r.signal, signal_t: r.lastCandleT, score: r.score,
        entry: r.plan.entry, sl: r.plan.sl, tp1: r.plan.tp1, tp2: r.plan.tp2,
      }));
      const { error } = await sb.from('signal_trades').upsert(rows, { onConflict: 'coin_id,signal_t', ignoreDuplicates: true });
      if (error) throw error;
    }

    await sb.rpc('prune_old_snapshots');

    return json({
      ok: true, run_id: run.id, coins: results.length, settled, opened_candidates: fresh.length,
      signals: results.map((r) => `${r.symbol}:${r.signal}:${Math.round(r.score)}`),
      skipped: data.skipped,
    });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
