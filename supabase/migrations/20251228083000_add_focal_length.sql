alter table public.job_files
  add column if not exists focal_length double precision;
