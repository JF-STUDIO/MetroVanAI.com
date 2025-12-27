-- Workflow providers and versions
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_admin = true
  );
$$;

create table if not exists public.workflow_providers (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null unique,
  base_url text not null,
  create_path text not null,
  status_path text not null,
  status_mode text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workflows (
  id uuid primary key default extensions.uuid_generate_v4(),
  slug text not null unique,
  display_name text not null,
  provider_id uuid not null references public.workflow_providers(id),
  credit_per_unit integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.workflow_versions (
  id uuid primary key default extensions.uuid_generate_v4(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  version integer not null,
  workflow_remote_id text not null,
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  runtime_config jsonb not null default '{}'::jsonb,
  notes text,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workflow_id, version)
);

create unique index if not exists workflow_versions_published_unique
  on public.workflow_versions (workflow_id)
  where is_published = true;

-- Extend jobs for new pipeline
alter table public.jobs
  add column if not exists workflow_id uuid references public.workflows(id),
  add column if not exists workflow_version_id uuid references public.workflow_versions(id),
  add column if not exists estimated_units integer not null default 0,
  add column if not exists reserved_units integer not null default 0,
  add column if not exists settled_units integer not null default 0,
  add column if not exists progress integer not null default 0;

create table if not exists public.job_files (
  id uuid primary key default extensions.uuid_generate_v4(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  group_id uuid,
  r2_bucket text not null,
  r2_key text not null,
  filename text,
  exif_time timestamptz,
  size bigint,
  camera_make text,
  camera_model text,
  created_at timestamptz not null default now()
);

create index if not exists job_files_job_id_idx on public.job_files(job_id);
create unique index if not exists job_files_job_key_unique on public.job_files(job_id, r2_key);

create table if not exists public.job_groups (
  id uuid primary key default extensions.uuid_generate_v4(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  group_index integer not null,
  raw_count integer not null default 0,
  hdr_bucket text,
  hdr_key text,
  output_bucket text,
  output_key text,
  status text not null default 'queued',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  unique (job_id, group_index)
);

create index if not exists job_groups_job_id_idx on public.job_groups(job_id);

create table if not exists public.credit_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  available_credits integer not null default 0,
  reserved_credits integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  delta integer not null,
  job_id uuid references public.jobs(id) on delete set null,
  stripe_event_id text,
  idempotency_key text not null unique,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists credit_ledger_user_id_idx on public.credit_ledger(user_id);
create unique index if not exists credit_ledger_job_type_unique
  on public.credit_ledger(user_id, job_id, type)
  where job_id is not null;

-- Ensure credit balance exists for existing profiles
insert into public.credit_balances (user_id, available_credits, reserved_credits)
select id, coalesce(points, 0), 0
from public.profiles
on conflict (user_id) do nothing;

create or replace function public.touch_credit_balance()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists credit_balances_updated_at on public.credit_balances;
create trigger credit_balances_updated_at
before update on public.credit_balances
for each row execute procedure public.touch_credit_balance();

create or replace function public.handle_profile_credit_balance()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.credit_balances (user_id, available_credits, reserved_credits)
  values (new.id, coalesce(new.points, 0), 0)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created_credit on public.profiles;
create trigger on_profile_created_credit
after insert on public.profiles
for each row execute procedure public.handle_profile_credit_balance();

create or replace function public.credit_reserve(
  p_user_id uuid,
  p_job_id uuid,
  p_units integer,
  p_idempotency_key text,
  p_note text default null
)
returns table (available_credits integer, reserved_credits integer)
language plpgsql
as $$
declare
  v_available integer;
  v_reserved integer;
begin
  if p_units is null or p_units <= 0 then
    raise exception 'units must be positive';
  end if;

  insert into public.credit_balances (user_id, available_credits, reserved_credits)
  values (p_user_id, 0, 0)
  on conflict (user_id) do nothing;

  select available_credits, reserved_credits
  into v_available, v_reserved
  from public.credit_balances
  where user_id = p_user_id
  for update;

  if v_available < p_units then
    raise exception 'insufficient credits';
  end if;

  insert into public.credit_ledger (user_id, type, delta, job_id, idempotency_key, note)
  values (p_user_id, 'reserve', -p_units, p_job_id, p_idempotency_key, p_note)
  on conflict do nothing;

  if not found then
    return query select v_available, v_reserved;
    return;
  end if;

  update public.credit_balances
    set available_credits = available_credits - p_units,
        reserved_credits = reserved_credits + p_units
  where user_id = p_user_id
  returning available_credits, reserved_credits into v_available, v_reserved;

  return query select v_available, v_reserved;
end;
$$;

create or replace function public.credit_release(
  p_user_id uuid,
  p_job_id uuid,
  p_units integer,
  p_idempotency_key text,
  p_note text default null
)
returns table (available_credits integer, reserved_credits integer)
language plpgsql
as $$
declare
  v_available integer;
  v_reserved integer;
begin
  if p_units is null or p_units <= 0 then
    raise exception 'units must be positive';
  end if;

  select available_credits, reserved_credits
  into v_available, v_reserved
  from public.credit_balances
  where user_id = p_user_id
  for update;

  if v_reserved < p_units then
    raise exception 'insufficient reserved credits';
  end if;

  insert into public.credit_ledger (user_id, type, delta, job_id, idempotency_key, note)
  values (p_user_id, 'release', p_units, p_job_id, p_idempotency_key, p_note)
  on conflict do nothing;

  if not found then
    return query select v_available, v_reserved;
    return;
  end if;

  update public.credit_balances
    set available_credits = available_credits + p_units,
        reserved_credits = reserved_credits - p_units
  where user_id = p_user_id
  returning available_credits, reserved_credits into v_available, v_reserved;

  return query select v_available, v_reserved;
end;
$$;

create or replace function public.credit_settle(
  p_user_id uuid,
  p_job_id uuid,
  p_units integer,
  p_idempotency_key text,
  p_note text default null
)
returns table (available_credits integer, reserved_credits integer)
language plpgsql
as $$
declare
  v_available integer;
  v_reserved integer;
begin
  if p_units is null or p_units <= 0 then
    raise exception 'units must be positive';
  end if;

  select available_credits, reserved_credits
  into v_available, v_reserved
  from public.credit_balances
  where user_id = p_user_id
  for update;

  if v_reserved < p_units then
    raise exception 'insufficient reserved credits';
  end if;

  insert into public.credit_ledger (user_id, type, delta, job_id, idempotency_key, note)
  values (p_user_id, 'settle', -p_units, p_job_id, p_idempotency_key, p_note)
  on conflict do nothing;

  if not found then
    return query select v_available, v_reserved;
    return;
  end if;

  update public.credit_balances
    set reserved_credits = reserved_credits - p_units
  where user_id = p_user_id
  returning available_credits, reserved_credits into v_available, v_reserved;

  return query select v_available, v_reserved;
end;
$$;

create or replace function public.credit_purchase(
  p_user_id uuid,
  p_units integer,
  p_idempotency_key text,
  p_stripe_event_id text default null,
  p_note text default null
)
returns table (available_credits integer, reserved_credits integer)
language plpgsql
as $$
declare
  v_available integer;
  v_reserved integer;
begin
  if p_units is null or p_units <= 0 then
    raise exception 'units must be positive';
  end if;

  insert into public.credit_balances (user_id, available_credits, reserved_credits)
  values (p_user_id, 0, 0)
  on conflict (user_id) do nothing;

  insert into public.credit_ledger (user_id, type, delta, stripe_event_id, idempotency_key, note)
  values (p_user_id, 'purchase', p_units, p_stripe_event_id, p_idempotency_key, p_note)
  on conflict do nothing;

  if not found then
    select available_credits, reserved_credits
    into v_available, v_reserved
    from public.credit_balances
    where user_id = p_user_id;
    return query select v_available, v_reserved;
    return;
  end if;

  update public.credit_balances
    set available_credits = available_credits + p_units
  where user_id = p_user_id
  returning available_credits, reserved_credits into v_available, v_reserved;

  return query select v_available, v_reserved;
end;
$$;

-- RLS
alter table public.workflow_providers enable row level security;
alter table public.workflows enable row level security;
alter table public.workflow_versions enable row level security;
alter table public.job_files enable row level security;
alter table public.job_groups enable row level security;
alter table public.credit_balances enable row level security;
alter table public.credit_ledger enable row level security;

-- Workflow provider policies
drop policy if exists "Admins manage workflow providers" on public.workflow_providers;
create policy "Admins manage workflow providers"
on public.workflow_providers
as permissive
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Workflows policies
drop policy if exists "Users view active workflows" on public.workflows;
create policy "Users view active workflows"
on public.workflows
for select
to authenticated
using (is_active = true);

drop policy if exists "Admins manage workflows" on public.workflows;
create policy "Admins manage workflows"
on public.workflows
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Workflow versions policies
drop policy if exists "Users view published workflow versions" on public.workflow_versions;
create policy "Users view published workflow versions"
on public.workflow_versions
for select
to authenticated
using (is_published = true);

drop policy if exists "Admins manage workflow versions" on public.workflow_versions;
create policy "Admins manage workflow versions"
on public.workflow_versions
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Job files/groups policies
drop policy if exists "Users view own job files" on public.job_files;
create policy "Users view own job files"
on public.job_files
for select
to authenticated
using (
  exists (
    select 1 from public.jobs
    where jobs.id = job_files.job_id
      and jobs.user_id = auth.uid()
  )
);

drop policy if exists "Users view own job groups" on public.job_groups;
create policy "Users view own job groups"
on public.job_groups
for select
to authenticated
using (
  exists (
    select 1 from public.jobs
    where jobs.id = job_groups.job_id
      and jobs.user_id = auth.uid()
  )
);

-- Credits policies
drop policy if exists "Users view own credit balance" on public.credit_balances;
create policy "Users view own credit balance"
on public.credit_balances
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Admins manage credit balances" on public.credit_balances;
create policy "Admins manage credit balances"
on public.credit_balances
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Users view own credit ledger" on public.credit_ledger;
create policy "Users view own credit ledger"
on public.credit_ledger
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Admins manage credit ledger" on public.credit_ledger;
create policy "Admins manage credit ledger"
on public.credit_ledger
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Seed providers and sync existing tools to workflows
insert into public.workflow_providers (name, base_url, create_path, status_path, status_mode)
values
  ('runninghub_cn', 'https://www.runninghub.cn', '/openapi/v1/workflow/run', '/openapi/v1/workflow/status', 'data_string'),
  ('runninghub_ai', 'https://api.runninghub.ai', '/openapi/v1/workflow/run', '/openapi/v1/workflow/status', 'data_status_field')
on conflict (name) do nothing;

insert into public.workflows (slug, display_name, provider_id, credit_per_unit, is_active)
select pt.workflow_id, pt.name, wp.id, pt.point_cost, coalesce(pt.is_active, true)
from public.photo_tools pt
join public.workflow_providers wp on wp.name = 'runninghub_ai'
on conflict (slug) do nothing;

insert into public.workflow_versions (workflow_id, version, workflow_remote_id, input_schema, output_schema, runtime_config, notes, is_published)
select w.id, 1, w.slug, '{}'::jsonb, '{}'::jsonb,
       '{"timeout": 900, "poll_interval": 5, "max_attempts": 3, "concurrency": 2}'::jsonb,
       'Seeded from photo_tools', true
from public.workflows w
on conflict do nothing;
