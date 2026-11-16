-- Crypto signal tool — schema
-- signal_runs:      one row per Edge Function run
-- signal_snapshots: the 20 coin signals of each run (payload = full JSON from the engine)
-- signal_trades:    forward-test journal: a trade opens when a fresh LONG/SHORT appears,
--                   and is settled (SL / TP1 / TP2 / 72h) on later runs.

create table if not exists public.signal_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  fng jsonb,
  skipped jsonb,
  coin_count int
);
create index if not exists signal_runs_run_at_idx on public.signal_runs (run_at desc);

create table if not exists public.signal_snapshots (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.signal_runs (id) on delete cascade,
  rank int,
  coin_id text not null,
  symbol text not null,
  price double precision,
  signal text not null check (signal in ('LONG', 'SHORT', 'NEUTRAL')),
  score double precision,
  payload jsonb not null
);
create index if not exists signal_snapshots_run_idx on public.signal_snapshots (run_id);
create index if not exists signal_snapshots_coin_idx on public.signal_snapshots (coin_id, id desc);

create table if not exists public.signal_trades (
  id bigint generated always as identity primary key,
  coin_id text not null,
  symbol text not null,
  dir text not null check (dir in ('LONG', 'SHORT')),
  signal_t bigint not null,            -- open time (ms) of the 4H candle that produced the signal
  opened_at timestamptz not null default now(),
  score double precision,
  entry double precision not null,
  sl double precision not null,
  tp1 double precision not null,
  tp2 double precision not null,
  tp1_hit boolean not null default false,
  status text not null default 'OPEN', -- OPEN | SL | TP2 | TP1 → hòa vốn | TP1 → hết giờ | Hết 72h
  result_r double precision,
  exit_price double precision,
  closed_at timestamptz,
  unique (coin_id, signal_t)
);
create index if not exists signal_trades_open_idx on public.signal_trades (status) where status = 'OPEN';
create index if not exists signal_trades_opened_idx on public.signal_trades (opened_at desc);

-- Latest run's signals
create or replace view public.latest_signals with (security_invoker = true) as
select s.*
from public.signal_snapshots s
where s.run_id = (select id from public.signal_runs order by run_at desc limit 1);

-- Row level security: anyone with the anon key may READ; only the service role (Edge Function) writes.
alter table public.signal_runs enable row level security;
alter table public.signal_snapshots enable row level security;
alter table public.signal_trades enable row level security;

drop policy if exists "public read" on public.signal_runs;
drop policy if exists "public read" on public.signal_snapshots;
drop policy if exists "public read" on public.signal_trades;
create policy "public read" on public.signal_runs for select to anon, authenticated using (true);
create policy "public read" on public.signal_snapshots for select to anon, authenticated using (true);
create policy "public read" on public.signal_trades for select to anon, authenticated using (true);

grant select on public.latest_signals to anon, authenticated;

-- Keep storage small: drop snapshots older than 30 days (trades are kept forever)
create or replace function public.prune_old_snapshots() returns void
language sql security definer set search_path = public as $$
  delete from public.signal_runs where run_at < now() - interval '30 days';
$$;
revoke execute on function public.prune_old_snapshots() from public, anon, authenticated;
grant execute on function public.prune_old_snapshots() to service_role;
