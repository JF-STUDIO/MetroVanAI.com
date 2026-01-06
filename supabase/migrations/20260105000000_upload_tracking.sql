alter table public.job_files
  add column if not exists upload_status text not null default 'pending',
  add column if not exists uploaded_at timestamptz;

alter table public.job_groups
  add column if not exists uploaded_count integer not null default 0,
  add column if not exists manifest_key text,
  add column if not exists execution_name text;

create index if not exists job_files_upload_status_idx on public.job_files (job_id, upload_status);
create index if not exists job_groups_manifest_key_idx on public.job_groups (job_id, manifest_key);
