alter table public.jobs
  add column if not exists input_type text,
  add column if not exists hdr_confidence double precision,
  add column if not exists original_filenames text[],
  add column if not exists output_zip_key text,
  add column if not exists output_file_key text,
  add column if not exists output_file_name text;

alter table public.job_files
  add column if not exists input_kind text,
  add column if not exists exposure_time double precision,
  add column if not exists fnumber double precision,
  add column if not exists iso double precision,
  add column if not exists ev double precision,
  add column if not exists r2_key_thumb text,
  add column if not exists exif_json jsonb;

alter table public.job_groups
  add column if not exists group_type text,
  add column if not exists hdr_confidence double precision,
  add column if not exists output_filename text;
