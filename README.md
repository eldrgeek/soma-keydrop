# SOMA KeyDrop v0 — authenticated inbound secret handoff

*Built 2026-08-14, Dee (Sonnet 5, CCc), Mike-ratified same day. Spec:
[`SOMA/specs/soma-keydrop-v0.md`](../SOMA/specs/soma-keydrop-v0.md) — read that
first, this README documents the build, not the design rationale.*

**Status: INERT.** Deployed, but `KEYDROP_LIVE=false` — only `--test` asks
bound to `mw@mike-wolf.com` or `claude@mike-wolf.com` are servable; no email
leaves the estate; the delivery adapter only ever touches this site's own
scratch env var, never a real destination. Gate order (spec §5): build inert →
**Locke review (next)** → Mike's nod → live. See `docs/BUILD-2026-08-14.md`
for what's proven vs. mocked and exactly where Locke should look first.

## What this is

Mike's sketch, mechanized: an ask is a token-identified object bound to one
email. The bound person clicks the link, signs in via SOMA Auth, and only
*then* does the site do anything — auth proves identity, not link possession.
A three-step action-button stepper (never a prose recipe, per Mike's 2026-08-13
amendment) walks her through provider login → mint a restricted key → paste it.
The paste is validated for shape, liveness (a real API probe), and power
ceiling (a full secret key is refused, not silently downgraded) before
delivery. The secret value never touches a database row, a log line, or an
error message — only its SHA-256 fingerprint does, after the fact.

## Layout

```
index.html, login.html          — SOMA Auth-gated stepper (static, no build step)
js/soma-auth*.js                — SOMA Auth drop-in (copied from stephanie-hours-dashboard)
vendor/soma-feedback/           — SOMA App Standard §8 feedback chip
netlify/functions/
  ask-state.mjs                 — GET: resolve token → ask + step state (RLS-gated read)
  submit-key.mjs                — POST: attest steps 1–2, verify+deliver step 3
  lib/auth.mjs                  — Supabase bearer-token → {id,email} (WHO is asking)
  lib/supabase.mjs              — asUser() (RLS-enforced) vs asService() (bypass, post-auth only)
  lib/sanitize.mjs               — fingerprint() + safe error/JSON helpers
  lib/providers/stripe.mjs      — shape/liveness/power-ceiling policy + recipe copy
  lib/adapters/netlify-env.mjs  — destination adapter v0 (Netlify env var + redeploy)
  lib/ack.mjs                   — closure-ack integration point (transport NOT wired, see docs)
supabase/schema.sql             — keydrop_asks + keydrop_audit, RLS policies (applied live)
bin/keydrop-ask                 — fleet-allowlisted CLI: create/list/show asks
docs/BUILD-2026-08-14.md        — CSW build report for Locke + Mike
test/                           — E2E harness (admin-link identity tests, curl scripts)
```

## Identity binding — how "auth guarantees it's her" is actually enforced

Two independent layers, on purpose:

1. **App layer**: every function calls `requireUser()` (verifies the bearer JWT
   against Supabase `/auth/v1/user`) before touching anything.
2. **DB layer (RLS)**: `ask-state`/`submit-key` fetch the ask row using the
   *caller's own JWT* + the anon key (`lib/supabase.mjs` `asUser()`), never the
   service key, for the READ that decides authorization. Postgres RLS on
   `keydrop_asks` (`supabase/schema.sql`) restricts SELECT to rows where
   `lower(bound_email) = lower(auth.jwt()->>'email')`. A wrong-identity request
   gets back an **empty array**, not an error — per
   `reference_supabase_js_silent_rls_refusal`, that is treated as "not
   authorized," never as "not found," at every call site.

Only *after* that RLS-gated read confirms ownership does the function switch to
`asService()` (service-role, bypasses RLS) to write state/step/audit — asks have
zero INSERT/UPDATE policy for anon/authenticated, so the DB itself refuses any
write path that didn't go through this sequence.

## Environment (Netlify site env vars)

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | shared SOMA Auth project |
| `SUPABASE_ANON_KEY` | public-safe, RLS-gated reads |
| `SUPABASE_SERVICE_KEY` | dedicated `keydrop_netlify` secret key (Supabase Management API, not the shared legacy `service_role`) — server-only |
| `KEYDROP_LIVE` | `false` in this build. Gates real delivery, real acks, and non-test asks. |
| `KEYDROP_NETLIFY_PAT` | destination-adapter's own Netlify token — see `SOMA/keys/KEYRING.md` for scope/rotation notes |

## Proof (INERT build, 2026-08-14)

Full CSW build report, what's proven vs. mocked, and where Locke should look
first: [`docs/BUILD-2026-08-14.md`](docs/BUILD-2026-08-14.md). Screenshots of
the live authenticated stepper: [`docs/screenshots/`](docs/screenshots/).
Re-runnable tests: `test/e2e.sh` (identity/resume/refusal via curl) and
`test/local-success-path.mjs` (success path, Stripe probe mocked at the
interface — no test Stripe account is accessible in this estate, said
honestly in the build report).

## Running the CLI

```
cd ~/Projects/soma-keydrop
python3 bin/keydrop-ask create --test --provider stripe \
  --bound-email mw@mike-wolf.com --requester claude@mike-wolf.com \
  --site-url https://<the-deployed-site> --dest-site-id <site-id> --dest-env-key STRIPE_RESTRICTED_KEY
python3 bin/keydrop-ask list
python3 bin/keydrop-ask show <token>
```
