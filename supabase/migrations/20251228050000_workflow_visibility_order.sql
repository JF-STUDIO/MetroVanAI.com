alter table public.workflows
  add column if not exists is_hidden boolean not null default false,
  add column if not exists sort_order integer not null default 0;

create index if not exists workflows_sort_order_idx on public.workflows(sort_order);
