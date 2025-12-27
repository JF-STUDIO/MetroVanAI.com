-- Fix ambiguous column references in credit functions

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

  select cb.available_credits, cb.reserved_credits
  into v_available, v_reserved
  from public.credit_balances as cb
  where cb.user_id = p_user_id
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

  update public.credit_balances as cb
    set available_credits = cb.available_credits - p_units,
        reserved_credits = cb.reserved_credits + p_units
  where cb.user_id = p_user_id
  returning cb.available_credits, cb.reserved_credits into v_available, v_reserved;

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

  select cb.available_credits, cb.reserved_credits
  into v_available, v_reserved
  from public.credit_balances as cb
  where cb.user_id = p_user_id
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

  update public.credit_balances as cb
    set available_credits = cb.available_credits + p_units,
        reserved_credits = cb.reserved_credits - p_units
  where cb.user_id = p_user_id
  returning cb.available_credits, cb.reserved_credits into v_available, v_reserved;

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

  select cb.available_credits, cb.reserved_credits
  into v_available, v_reserved
  from public.credit_balances as cb
  where cb.user_id = p_user_id
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

  update public.credit_balances as cb
    set reserved_credits = cb.reserved_credits - p_units
  where cb.user_id = p_user_id
  returning cb.available_credits, cb.reserved_credits into v_available, v_reserved;

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
    select cb.available_credits, cb.reserved_credits
    into v_available, v_reserved
    from public.credit_balances as cb
    where cb.user_id = p_user_id;
    return query select v_available, v_reserved;
    return;
  end if;

  update public.credit_balances as cb
    set available_credits = cb.available_credits + p_units
  where cb.user_id = p_user_id
  returning cb.available_credits, cb.reserved_credits into v_available, v_reserved;

  return query select v_available, v_reserved;
end;
$$;
