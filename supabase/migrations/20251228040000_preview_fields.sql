alter table public.job_files
  add column if not exists group_order integer,
  add column if not exists preview_bucket text,
  add column if not exists preview_key text,
  add column if not exists preview_ready boolean not null default false;

alter table public.job_groups
  add column if not exists representative_file_id uuid references public.job_files(id) on delete set null;
