create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_app_settings_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_settings_set_updated_at on public.app_settings;

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute procedure public.set_app_settings_updated_at();

insert into public.app_settings (key, value)
values ('free_trial_points', to_jsonb(10))
on conflict (key) do nothing;

create or replace function public.handle_new_user()
returns trigger as $$
declare
  trial_points integer := 10;
begin
  select coalesce((value)::text::int, 10)
    into trial_points
    from public.app_settings
    where key = 'free_trial_points';

  insert into public.profiles (id, email, points, is_admin)
  values (new.id, new.email, trial_points, false)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;
