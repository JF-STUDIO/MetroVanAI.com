create index if not exists job_events_job_id_idx on public.job_events (job_id, event_id);
create index if not exists job_groups_job_id_status_idx on public.job_groups (job_id, status);
create index if not exists job_files_job_id_idx on public.job_files (job_id);

