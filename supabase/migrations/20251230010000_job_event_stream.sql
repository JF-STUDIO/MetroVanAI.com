alter table public.jobs
  add column if not exists total_files integer not null default 0,
  add column if not exists total_groups integer not null default 0,
  add column if not exists done_groups integer not null default 0,
  add column if not exists failed_groups integer not null default 0,
  add column if not exists notify_email text,
  add column if not exists notify_sent_at timestamptz;

alter table public.job_groups
  add column if not exists runninghub_task_id text,
  add column if not exists result_bucket text,
  add column if not exists result_key text,
  add column if not exists preview_bucket text,
  add column if not exists preview_key text,
  add column if not exists error_message text;

alter table public.job_events
  add column if not exists event_id bigserial;

create index if not exists job_events_job_id_event_id_idx
  on public.job_events(job_id, event_id);

create index if not exists job_groups_job_id_status_idx
  on public.job_groups(job_id, status);

create index if not exists job_groups_runninghub_task_idx
  on public.job_groups(runninghub_task_id);
