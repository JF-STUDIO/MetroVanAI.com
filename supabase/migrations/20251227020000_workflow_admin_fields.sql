alter table public.workflows
  add column if not exists description text,
  add column if not exists preview_original text,
  add column if not exists preview_processed text;

update public.workflows
set description = pt.description,
    preview_original = pt.preview_original,
    preview_processed = pt.preview_processed
from public.photo_tools pt
where public.workflows.slug = pt.workflow_id;

create or replace function public.credit_admin_adjust(
  p_user_id uuid,
  p_delta integer,
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
  if p_delta is null or p_delta = 0 then
    raise exception 'delta must be non-zero';
  end if;

  insert into public.credit_balances (user_id, available_credits, reserved_credits)
  values (p_user_id, 0, 0)
  on conflict (user_id) do nothing;

  select cb.available_credits, cb.reserved_credits
  into v_available, v_reserved
  from public.credit_balances as cb
  where cb.user_id = p_user_id
  for update;

  if p_delta < 0 and (v_available + p_delta) < 0 then
    raise exception 'insufficient credits';
  end if;

  insert into public.credit_ledger (user_id, type, delta, idempotency_key, note)
  values (p_user_id, 'admin_adjust', p_delta, p_idempotency_key, p_note)
  on conflict do nothing;

  if not found then
    return query select v_available, v_reserved;
    return;
  end if;

  update public.credit_balances as cb
    set available_credits = cb.available_credits + p_delta
  where cb.user_id = p_user_id
  returning cb.available_credits, cb.reserved_credits into v_available, v_reserved;

  return query select v_available, v_reserved;
end;
$$;
