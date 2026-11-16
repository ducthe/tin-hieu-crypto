-- Run ONCE in Supabase Dashboard → SQL Editor, after deploying the Edge Function.
-- Replace the two placeholders first. Schedules update-signals every hour at minute 2
-- (4H candles close at 07:00, 11:00, 15:00, 19:00, 23:00, 03:00 Vietnam time).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
select vault.create_secret('YOUR-CRON-SECRET', 'cron_secret'); -- same value as the CRON_SECRET function secret

select cron.schedule(
  'update-signals-hourly',
  '2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/update-signals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Check:   select * from cron.job_run_details order by start_time desc limit 5;
--          select * from net._http_response order by created desc limit 5;
-- Remove:  select cron.unschedule('update-signals-hourly');
