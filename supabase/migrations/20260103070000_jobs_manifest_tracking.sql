-- Track latest manifest/execution for HDR grouping runs
alter table public.jobs
  add column if not exists current_manifest_key text,
  add column if not exists current_manifest_hash text,
  add column if not exists current_execution_name text;

create index if not exists jobs_manifest_hash_idx
  on public.jobs (current_manifest_hash);
