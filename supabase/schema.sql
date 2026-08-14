-- KeyDrop v0 schema. Metadata + fingerprint ONLY — never a secret value (spec §2.1).
create extension if not exists pgcrypto;

create table if not exists public.keydrop_asks (
  id             uuid primary key default gen_random_uuid(),
  token          text unique not null,                -- opaque, in the emailed link
  requester      text not null,                        -- fleet identity that created the ask
  bound_email    text not null,                         -- identity that must sign in (spec §2.4)
  provider       text not null default 'stripe',
  policy         jsonb not null default '{}'::jsonb,    -- shape/liveness/power-ceiling policy
  destination    jsonb not null default '{}'::jsonb,    -- adapter config (netlify_env v0)
  recipe         jsonb not null default '{}'::jsonb,    -- stepper copy: login_url, mint_url, scopes[], label
  state          text not null default 'open'
                   check (state in ('open','completed','refused','expired')),
  step           int  not null default 1 check (step in (1,2,3)),
  attempt_count  int  not null default 0,
  test_only      boolean not null default false,
  created_by_session text,
  pulse_card_key text,
  ttl_at         timestamptz not null default (now() + interval '72 hours'),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  fingerprint    jsonb                                   -- {provider,prefix,last4,sha256} ONLY, never raw
);

create index if not exists keydrop_asks_bound_email_idx on public.keydrop_asks (lower(bound_email));
create index if not exists keydrop_asks_token_idx on public.keydrop_asks (token);

-- Append-only audit trail. Detail must NEVER contain a secret value — fingerprint/counts only.
create table if not exists public.keydrop_audit (
  id         bigint generated always as identity primary key,
  ask_id     uuid not null references public.keydrop_asks(id) on delete cascade,
  ts         timestamptz not null default now(),
  event      text not null,
  detail     jsonb not null default '{}'::jsonb
);

create index if not exists keydrop_audit_ask_id_idx on public.keydrop_audit (ask_id);

alter table public.keydrop_asks enable row level security;
alter table public.keydrop_audit enable row level security;

-- Identity-bound read: a signed-in SOMA Auth user may see ONLY asks bound to their own
-- email (spec §2.4 — "session email must equal the ask's bound identity"). No insert/update
-- policy for anon/authenticated: asks are created and mutated only via the service-role key
-- (fleet CLI + Netlify functions, after the function has independently verified identity).
drop policy if exists "bound identity can read own ask" on public.keydrop_asks;
create policy "bound identity can read own ask"
  on public.keydrop_asks
  for select
  to authenticated
  using (lower(bound_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- No policies at all on keydrop_audit for anon/authenticated — RLS enabled with zero
-- policies means the table is invisible to everyone except service_role (which bypasses
-- RLS entirely). Audit is function-only, by construction.
