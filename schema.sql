-- ===========================================================================
-- Neobank onboarding — the state machine lives HERE, not in the orchestrator.
-- Postgres 14+. The workflow engine only calls functions in this file; it has
-- no INSERT/UPDATE rights on any table, so it cannot write state directly.
-- ===========================================================================

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- States. Note kyc_unknown: a provider timeout is an UNKNOWN, never a reject.
-- Rejecting a customer because our network hiccuped is a compliance incident,
-- not a bug.
-- ---------------------------------------------------------------------------
create type app.application_state as enum (
  'draft',            -- started, incomplete
  'submitted',        -- applicant submitted, awaiting validation
  'screening',        -- sanctions / PEP screening running
  'kyc_pending',      -- sent to KYC provider, awaiting async callback
  'kyc_unknown',      -- provider call indeterminate — reconcile, do not decide
  'kyc_review',       -- human decision required (REFER, or screening hit)
  'approved',         -- KYC passed. Durable fact: never silently reversed.
  'rejected',         -- terminal, with reason
  'expired',          -- applicant abandoned / documents aged out
  'account_opened'    -- terminal success
);

create type app.review_outcome as enum ('approve','reject','request_more_info');

-- ---------------------------------------------------------------------------
-- The application. One row per business intent, not per attempt.
-- ---------------------------------------------------------------------------
create table app.application (
  id                    uuid primary key default gen_random_uuid(),
  -- Business identity. Two submissions for the same person+product are the
  -- same application, no matter how many times the client retries.
  customer_external_ref text        not null,
  product_code          text        not null,
  state                 app.application_state not null default 'draft',
  -- Every transition bumps it; returned to callers so they can tell a
  -- fresh read from a stale one.
  version               bigint      not null default 0,

  -- Idempotency of the INBOUND submit call.
  idempotency_key       text        not null,
  -- Same key + different payload must 409, not silently return the original.
  request_fingerprint   text        not null,

  provider_ref          text,                     -- KYC provider's id
  risk_rating           text,                     -- low | medium | high
  reject_reason         text,
  applicant             jsonb       not null default '{}'::jsonb,

  kyc_attempts          int         not null default 0,
  next_attempt_at       timestamptz,
  submitted_at          timestamptz,
  decided_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint application_idem_uq unique (idempotency_key)
);

-- One live application per customer+product. A second submit finds this one.
create unique index application_business_uq
  on app.application (customer_external_ref, product_code)
  where state not in ('rejected','expired');

create index application_due_idx
  on app.application (next_attempt_at)
  where state = 'kyc_unknown';

create index application_review_idx
  on app.application (updated_at)
  where state = 'kyc_review';

-- ---------------------------------------------------------------------------
-- Allowed transitions are DATA, not code. Adding a state is a migration,
-- not a redeploy of every workflow that touches onboarding.
-- ---------------------------------------------------------------------------
create table app.application_transition_allowed (
  from_state app.application_state not null,
  to_state   app.application_state not null,
  -- who may trigger it: system | reviewer | applicant
  actor      text not null check (actor in ('system','reviewer','applicant')),
  primary key (from_state, to_state, actor)
);

insert into app.application_transition_allowed (from_state, to_state, actor) values
  ('draft',       'submitted',      'applicant'),
  ('draft',       'expired',        'system'),

  ('submitted',   'screening',      'system'),
  ('submitted',   'rejected',       'system'),      -- failed eligibility checks

  ('screening',   'kyc_pending',    'system'),      -- clear; intent recorded BEFORE the provider call
  ('screening',   'kyc_review',     'system'),      -- sanctions / PEP hit, or screening unavailable

  ('kyc_pending', 'approved',       'system'),      -- provider CLEAR
  ('kyc_pending', 'rejected',       'system'),      -- provider DECLINE
  ('kyc_pending', 'kyc_review',     'system'),      -- provider REFER, or provider refused the request
  ('kyc_pending', 'kyc_unknown',    'system'),      -- timeout / 5xx — decide nothing
  ('kyc_pending', 'expired',        'system'),

  ('kyc_unknown', 'approved',       'system'),      -- reconciler found CLEAR
  ('kyc_unknown', 'rejected',       'system'),      -- reconciler found DECLINE
  ('kyc_unknown', 'kyc_review',     'system'),      -- reconciler gave up → human
  ('kyc_unknown', 'kyc_pending',    'system'),      -- never received: resubmit with the SAME key

  ('kyc_review',  'approved',       'reviewer'),    -- maker-checker only
  ('kyc_review',  'rejected',       'reviewer'),
  ('kyc_review',  'kyc_pending',    'reviewer'),    -- more info supplied

  ('approved',    'account_opened', 'system');
  -- NOTE: there is deliberately NO way out of approved except account_opened.
  -- KYC approval is a durable, audited fact; reversing it is a new case with
  -- its own record. That is also what makes a late or replayed provider
  -- callback harmless: a decided application has no transition it can take.

-- ---------------------------------------------------------------------------
-- Append-only audit. Every transition, who caused it, and why.
-- ---------------------------------------------------------------------------
create table app.application_event (
  id              bigserial primary key,
  application_id  uuid        not null references app.application(id),
  from_state      app.application_state,
  to_state        app.application_state not null,
  actor           text        not null,
  actor_ref       text,                       -- reviewer id / workflow exec id
  reason          text,
  -- Makes the transition itself idempotent: the same logical event applied
  -- twice is a no-op, not a second row.
  idempotency_key text        not null,
  payload         jsonb       not null default '{}'::jsonb,
  version_after   bigint      not null,
  created_at      timestamptz not null default now(),
  constraint application_event_idem_uq unique (application_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- Human review queue. In a bank, manual resolution is a financial control:
-- maker-checker, no free-form state edits, immutable trail.
-- ---------------------------------------------------------------------------
create table app.review_task (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid        not null references app.application(id),
  raised_reason   text        not null,     -- e.g. sanctions_hit | provider_REFER | reconcile_exhausted
  maker_id        text,                     -- proposes
  maker_outcome   app.review_outcome,
  maker_note      text,
  checker_id      text,                     -- approves — must differ from maker
  checker_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint review_four_eyes check (checker_id is null or checker_id <> maker_id)
);

create unique index review_task_open_uq
  on app.review_task (application_id)
  where checker_at is null;

-- ---------------------------------------------------------------------------
-- Inbound provider webhooks: at-least-once delivery, arbitrary order.
-- ---------------------------------------------------------------------------
create table app.provider_event (
  event_id     text primary key,            -- dedupe
  provider_ref text        not null,
  event_type   text        not null,
  sequence_no  bigint,                      -- recorded for audit; ordering safety
                                            -- comes from the transition table
  payload      jsonb       not null,
  received_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- SUBMIT. Find-or-create on the idempotency key, in one statement, so two
-- concurrent submits produce one application and both callers get it back.
--
-- outcome:
--   created          new application, state = submitted
--   replay           same key, same payload — existing application returned
--   key_conflict     same key, DIFFERENT payload — caller must answer 409
--   already_open     a live application exists for this customer + product
--                    under a different key — caller must answer 409
-- ---------------------------------------------------------------------------
create or replace function app.submit_application(
  p_customer_external_ref text,
  p_product_code          text,
  p_applicant             jsonb,
  p_idempotency_key       text,
  p_request_fingerprint   text
) returns table (outcome text, application_id uuid, state app.application_state, version bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  begin
    insert into app.application (
      customer_external_ref, product_code, applicant,
      idempotency_key, request_fingerprint, state, submitted_at
    ) values (
      p_customer_external_ref, p_product_code, coalesce(p_applicant, '{}'::jsonb),
      p_idempotency_key, p_request_fingerprint, 'submitted', now()
    )
    on conflict (idempotency_key) do update
      set updated_at = app.application.updated_at       -- no-op write, row returned
    returning app.application.id, app.application.state, app.application.version,
              app.application.request_fingerprint, (xmax = 0) as was_created
    into r;
  exception when unique_violation then
    -- Not the idempotency key: the one-live-application-per-customer index.
    select a.id, a.state, a.version into r
      from app.application a
     where a.customer_external_ref = p_customer_external_ref
       and a.product_code = p_product_code
       and a.state not in ('rejected','expired');
    return query select 'already_open'::text, r.id, r.state, r.version;
    return;
  end;

  if r.was_created then
    insert into app.application_event (application_id, from_state, to_state, actor,
                                       reason, idempotency_key, version_after)
    values (r.id, null, 'submitted', 'applicant', 'submitted', 'submit', r.version);
    return query select 'created'::text, r.id, r.state, r.version;
  elsif r.request_fingerprint <> p_request_fingerprint then
    return query select 'key_conflict'::text, r.id, r.state, r.version;
  else
    return query select 'replay'::text, r.id, r.state, r.version;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- THE transition function. Locks first, checks the table, writes state +
-- audit in ONE transaction, and is idempotent on replay.
--
-- Returns: applied | duplicate | forbidden | not_found — never raises for
-- business cases; an exception would roll back the caller's own bookkeeping.
--
-- Side effects that must never be forgotten by a workflow branch live here:
--   * entering kyc_unknown schedules the reconciler
--   * entering kyc_review opens exactly one review task
-- ---------------------------------------------------------------------------
create or replace function app.transition_application(
  p_application_id  uuid,
  p_expected_from   app.application_state,   -- null = don't care
  p_to              app.application_state,
  p_actor           text,
  p_actor_ref       text,
  p_reason          text,
  p_idempotency_key text,
  p_payload         jsonb default '{}'::jsonb
) returns table (result text, state app.application_state, version bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current app.application_state;
  v_version bigint;
  v_allowed boolean;
begin
  -- 1. Replay check BEFORE locking: the cheapest path is the repeated one.
  select ae.version_after into v_version
    from app.application_event ae
   where ae.application_id = p_application_id
     and ae.idempotency_key = p_idempotency_key;

  if found then
    select a.state into v_current
      from app.application a where a.id = p_application_id;
    return query select 'duplicate'::text, v_current, v_version;
    return;
  end if;

  -- 2. Lock the row. Everything after this is serialised per application.
  select a.state, a.version into v_current, v_version
    from app.application a
   where a.id = p_application_id
   for update;

  if not found then
    return query select 'not_found'::text, null::app.application_state, null::bigint;
    return;
  end if;

  -- 3. Optional optimistic guard.
  if p_expected_from is not null and v_current <> p_expected_from then
    return query select 'forbidden'::text, v_current, v_version;
    return;
  end if;

  -- 4. Is this transition legal at all?
  select exists (
    select 1 from app.application_transition_allowed t
     where t.from_state = v_current
       and t.to_state   = p_to
       and t.actor      = p_actor
  ) into v_allowed;

  if not v_allowed then
    return query select 'forbidden'::text, v_current, v_version;
    return;
  end if;

  -- 5. Apply. State + audit together or not at all.
  update app.application a
     set state           = p_to,
         version         = a.version + 1,
         updated_at      = now(),
         reject_reason   = case when p_to = 'rejected' then p_reason else a.reject_reason end,
         decided_at      = case when p_to in ('approved','rejected')
                                then now() else a.decided_at end,
         next_attempt_at = case when p_to = 'kyc_unknown'
                                then now() + interval '1 minute' else null end
   where a.id = p_application_id
   returning a.version into v_version;

  insert into app.application_event (
    application_id, from_state, to_state, actor, actor_ref,
    reason, idempotency_key, payload, version_after
  ) values (
    p_application_id, v_current, p_to, p_actor, p_actor_ref,
    p_reason, p_idempotency_key, coalesce(p_payload, '{}'::jsonb), v_version
  );

  if p_to = 'kyc_review' then
    insert into app.review_task (application_id, raised_reason)
    values (p_application_id, coalesce(nullif(p_reason, ''), 'unspecified'))
    on conflict do nothing;                    -- one open task per application
  end if;

  return query select 'applied'::text, p_to, v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- Provider bookkeeping. Neither changes state.
-- ---------------------------------------------------------------------------
create or replace function app.record_provider_ref(p_application_id uuid, p_provider_ref text)
returns table (state app.application_state, version bigint)
language sql
security definer
set search_path = ''
as $$
  update app.application a
     set provider_ref = coalesce(p_provider_ref, a.provider_ref), updated_at = now()
   where a.id = p_application_id
  returning a.state, a.version;
$$;

-- At-least-once delivery: the same event WILL arrive twice.
-- Returns is_new = false for a duplicate, atomically.
create or replace function app.record_provider_event(
  p_event_id text, p_provider_ref text, p_event_type text,
  p_sequence_no bigint, p_payload jsonb
) returns table (is_new boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.provider_event (event_id, provider_ref, event_type, sequence_no, payload)
  values (p_event_id, p_provider_ref, p_event_type, p_sequence_no, p_payload)
  on conflict (event_id) do nothing;
  return query select found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Callback SLA. A provider that never calls back must not leave an
-- application in kyc_pending forever: past the SLA it becomes kyc_unknown,
-- and the reconciler asks the provider directly. Always returns one row so
-- the calling workflow carries on.
-- ---------------------------------------------------------------------------
create or replace function app.flag_overdue_pending(p_sla interval default interval '6 hours')
returns table (flagged int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select a.id, a.version from app.application a
     where a.state = 'kyc_pending' and a.updated_at < now() - p_sla
     order by a.updated_at
     limit 100
     for update skip locked
  loop
    perform app.transition_application(r.id, 'kyc_pending', 'kyc_unknown', 'system', null,
                                       'callback_sla_breached', 'sla:' || r.id || ':' || r.version);
    n := n + 1;
  end loop;
  return query select n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciler claim. SKIP LOCKED so N workers never resolve the same row.
-- ---------------------------------------------------------------------------
create or replace function app.claim_unknown_applications(p_limit int default 25)
returns setof app.application
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    select id from app.application
     where state = 'kyc_unknown'
       and next_attempt_at <= now()
       and kyc_attempts < 8
     order by next_attempt_at
     limit p_limit
     for update skip locked
  )
  update app.application a
     set kyc_attempts    = a.kyc_attempts + 1,
         -- exponential back-off WITH jitter — otherwise every stuck
         -- application stampedes the provider the second it recovers
         next_attempt_at = now()
                         + (interval '1 minute' * power(2, a.kyc_attempts))
                         + (random() * interval '30 seconds'),
         updated_at      = now()
    from claimed c
   where a.id = c.id
  returning a.*;
$$;

-- ---------------------------------------------------------------------------
-- Least privilege: the orchestrator gets the functions, not the tables.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

revoke all on schema app from public;
revoke all on all functions in schema app from public;
grant usage on schema app to service_role;
grant execute on function app.submit_application(text, text, jsonb, text, text) to service_role;
grant execute on function app.transition_application(
  uuid, app.application_state, app.application_state, text, text, text, text, jsonb
) to service_role;
grant execute on function app.record_provider_ref(uuid, text) to service_role;
grant execute on function app.record_provider_event(text, text, text, bigint, jsonb) to service_role;
grant execute on function app.claim_unknown_applications(int) to service_role;
grant execute on function app.flag_overdue_pending(interval) to service_role;
