# LOCKE REVIEW — SOMA KeyDrop v0 (inert build)

*Locke (security), 2026-08-14. Audit-only; no code modified. Gate position:
inert → **THIS REVIEW** → Mike's nod → live. Reviews the tree at commit
`15707ce`, live Netlify site `cdd3433a-8aaa-41c4-b226-ca2d7e2dfeff`
(`soma-keydrop.netlify.app`, `KEYDROP_LIVE=false` confirmed live), shared SOMA
Auth project `omfwcodoimjmbrhssvfl`.*

## Threat model (stated, per stance)

- **The data:** a live Stripe *restricted* key (`rk_live_…`) in transit — high
  value, not catastrophic (restricted scope by design; the whole point of §2.3c
  is to keep `sk_live_` out). Plus, at rest: ask metadata + fingerprints, and
  two service credentials (`SUPABASE_SERVICE_KEY`, `KEYDROP_NETLIFY_PAT`).
- **Trust boundaries:** (1) untrusted browser → Netlify function; (2) Netlify
  function → shared Supabase project (RLS); (3) Netlify function → Netlify
  account API (the crown-jewel PAT); (4) the third-party CDN scripts loaded into
  the same page as the paste field.
- **The adversary:** realistically — someone who has compromised Stephanie's
  email inbox (the link *and* the magic-link auth both land there), a
  supply-chain compromise of a floating CDN script, or a leak of the function
  env. Not modeled: a Supabase/Netlify platform compromise, a nation-state, or
  Mike's laptop being owned (that's game-over estate-wide, out of scope here).

Bottom line up front: **HOLD** — the design is sound and the inert posture is
real, but three items must close before a live secret transits this for
Stephanie. None are architectural; all are small controls.

---

## Findings

### F1 — Netlify PAT is full-account; live delivery writes to any of ~50 sites — MUST-FIX-BEFORE-LIVE
**What:** `KEYDROP_NETLIFY_PAT` (KEYRING crown jewel) is Mike's cached full-account
Netlify CLI token (`~/Library/Preferences/netlify/config.json`, account
`eldrgeek`). `netlify/functions/lib/adapters/netlify-env.mjs` uses it to write env
vars + trigger redeploys.
**Why it matters:** trust boundary (3). Netlify PATs cannot be resource-scoped
via API — confirmed, the builder is right. When `KEYDROP_LIVE=true`, a bug or a
poisoned `destination.site_id`/`env_key` in an ask row (asks are service-role
writes, but a confused/compromised fleet identity creates them) lets this
function write an attacker-chosen value to an attacker-chosen env var on *any*
site in the account, then redeploy it. Blast radius = every SOMA production site.
While inert this is contained (adapter targets `selfSiteId` only — verified
lines 18-19), so it is not a finding *today*, but it gates live.
**Smallest control:** Mike mints a fresh, single-purpose PAT in the Netlify UI
named `keydrop-adapter` and swaps it into `KEYDROP_NETLIFY_PAT` (separate
revocability — the KEYRING already documents this exact step). Additionally,
before live, pin the adapter to an allowlist of permitted destination site_ids
in function code so a bad ask row cannot aim it anywhere. This is a Mike-gated
key-mint + a small code guard.
**Productivity-cost:** minor friction. **Time-to-fix:** ~15 min (mint+swap) +
~20 min (allowlist guard). Hand the swap to Mike; the guard is a code task for the builder.

### F2 — Closure acks are unwired AND the "fail loud" is swallowed → silent-death ask — MUST-FIX-BEFORE-LIVE
**What:** `lib/ack.mjs` throws when `isLive:true` (transport not implemented).
But the call site `submit-key.mjs:153` wraps it: `await sendAcks(...).catch(() =>
({sent:false, error:'ack transport error (sanitized)'}))`. The throw is caught
and downgraded to an audit line. Delivery (`:134`) and `state=completed`
(`:142`) both happen *before* the ack attempt.
**Why it matters:** the BUILD doc claims flipping `KEYDROP_LIVE=true` unwired
"fails loudly instead of silently no-op'ing." It does not — it fails **soft**:
the key is delivered, the ask is consumed, and nobody is notified. Stephanie
gets no confirmation, Mike gets no cc, the Pulse card never resolves. That is
exactly the "ask that dies silently" the spec §2.7 names as the recurring cost
this system exists to end. This is a functional gap that is also the security
audit-of-record gap (no notification that a live secret moved).
**Smallest control:** wire the ack transport (nodemailer + a dedicated
`CLAUDE_GMAIL_APP_PASSWORD` Netlify env var) before live; OR, if v0 ships with
manual closure, remove the `.catch()` swallow so an unwired live send throws to
the outer handler and the caller sees a 500 (better: don't mark `completed`
until acks succeed, so a failed ack leaves a retriable state rather than a
consumed-but-silent ask). Either way the current swallow must go.
**Productivity-cost:** real cost (wiring SMTP) or minor (remove swallow +
reorder). **Time-to-fix:** ~1-2 hrs to wire acks; ~20 min for the fail-hard
fallback. Recommend wiring — a first live handoff with no confirmation to
Stephanie is a bad first impression and an unaudited money-key move.

### F3 — No CSP + floating CDN dependency on a page holding a live secret — SHOULD-FIX-BEFORE-LIVE (high)
**What:** `index.html` loads `@supabase/supabase-js@2` from jsdelivr as a
**floating** major-version (`@2`, resolves to latest 2.x), with no
Subresource-Integrity hash, and the site ships **no Content-Security-Policy**
(no `_headers` file, nothing in `netlify.toml`). The same page holds the pasted
`rk_live_` key in a DOM password field.
**Why it matters:** this is the lethal-trifecta shape — a live secret in the DOM
+ an unconstrained egress path + third-party code on the page. A jsdelivr
compromise, or a hijack of any future 2.x publish, yields script that can read
`document.getElementById('key-value').value` and POST it anywhere. Nothing in
the page constrains where a rogue script may connect. The vendored
`soma-feedback.js` is *one `querySelector` strip* (`[type="password"]`,
verified line 633-636) away from also capturing the key into its VPS-bound
`pageText` payload — that strip is correct today, but it is the only thing
standing between the paste field and an off-estate POST.
**Smallest control:** (a) pin supabase-js to an exact version with an `integrity`
SRI hash; (b) add a CSP via `_headers` with a tight `connect-src 'self'
https://omfwcodoimjmbrhssvfl.supabase.co` (the Stripe probe is server-side, so
the browser never needs to reach Stripe or anywhere else) plus `script-src`
limited to self + the pinned CDN. That single `connect-src` line neuters the
exfil vector even if a script goes rogue. Also add `Referrer-Policy: no-referrer`
while you're in the headers file (defends the `?ask=` token against referrer leak
on the step-1/2 new-tab clicks; grants-nothing token so low, but free here).
**Productivity-cost:** minor friction (pin bumps need a hash update on upgrade).
**Time-to-fix:** ~30-45 min. This is the finding I'd least want to skip — it is
the difference between "one supply-chain event = leaked key" and "not."

### F4 — asUser()/asService() separation is correct — ACCEPTABLE
**What/why:** Verified the builder's #2 concern. In both `ask-state.mjs` and
`submit-key.mjs` the only *read* of an ask is via `asUser(token)` (caller's own
JWT), and RLS `lower(bound_email)=lower(auth.jwt()->>'email')` filters it. Zero
rows → 403, and the code treats empty-array as unauthorized (the documented
supabase-js RLS-silent-refusal scar is handled). Every `asService()` call
(expiry, step advance, completion, audit) is keyed by `row.id` obtained *after*
that ownership-proving read. No `asService()` read path bypasses RLS to fetch an
ask. `requireUser` validates the JWT server-side against `/auth/v1/user` rather
than trusting client claims, and PostgREST re-validates the same token —
defense in depth. This is the strongest part of the build.
**Control:** none needed. Keep it.

### F5 — Stolen ask token without a SOMA Auth session yields nothing — ACCEPTABLE
**What/why:** Token alone hits `requireUser` → 401 before any DB access. RLS
then binds to email. A forwarded/intercepted link is inert without the bound
identity's live session. This is Mike's "auth guarantees it is Stephanie" made
mechanical, and it holds. The token is `secrets.token_hex(32)` (256-bit),
non-enumerable.
**Control:** none needed.

### F6 — Compromised session for a DIFFERENT user in the shared project — ACCEPTABLE-WITH-NOTE
**What/why:** SOMA Auth is one shared user pool across ~50 sites. Any valid JWT
can reach the functions, but RLS returns zero rows for any email != the ask's
`bound_email`, and `keydrop_audit` has zero policies (invisible to
anon/authenticated — confirmed in schema and the build's live `rowsecurity`
check). So a random Legends/Playmaker member's session sees nothing of
Stephanie's ask. The only session that works is one whose JWT email equals
`bound_email` — i.e. someone who controls Stephanie's email (signup is enabled
but `mailer_autoconfirm=false`, so an attacker cannot self-register her address
without her inbox).
**Note:** the security therefore reduces to "controls Stephanie's email inbox" —
which is *also* where the ask link and the magic link are delivered. KeyDrop is
no weaker than email here, but it is no stronger either: inbox compromise = game
over, same as plain email would be. Acceptable, and worth stating plainly to
Mike rather than implying auth defeats an inbox takeover.

### F7 — uri_allow_list append was append-only and correctly scoped — ACCEPTABLE (verified live)
**What/why:** Verified the builder's allow-list change against the live GoTrue
config and the `allow-list-snapshot-20260810T121306Z.txt`. Current: 1915/2048
bytes, 50 entries. The KeyDrop additions are exactly
`https://soma-keydrop.netlify.app/**` and `https://*--soma-keydrop.netlify.app/**`
— its own origin, no wildcard reaching other sites. No estate entry was removed
by the KeyDrop change (the diff vs snapshot shows the agi26 fleet + a
playmaker-design-gallery added and the stale `*--` preview globs pruned — all
consistent with the documented 08-10 compaction workflow, not a KeyDrop
regression). No overbroad glob introduced.
**Note (not KeyDrop's bug, flagged for the estate):** the shared allow-list is at
1915/2048 — 133 bytes of headroom. The `soma-auth-allow.py` tool auto-adds a
`*--<site>.netlify.app/**` deploy-preview glob for every site; a
KeyDrop *deploy preview* would thus also be a valid post-auth redirect target
for a session. Preview builds of a secret-handoff app are a place I'd rather not
have live auth land — recommend NOT relying on preview auth for KeyDrop and, when
the budget next gets tight, dropping KeyDrop's `*--` preview entry specifically.
Hand allow-list byte-budget operation to Ward.

### F8 — Exception paths do not leak the secret — ACCEPTABLE (with two minor notes)
**What/why:** Traced every catch that could touch the value. `auth.mjs` never
interpolates the token (explicitly noted, verified). `stripe.probe` returns only
generic reasons; the value goes to Stripe as a Bearer over TLS, never logged.
`submit-key.mjs` outer catch returns hardcoded `'internal error'`, no `e`. The
value lives only in `value`/`destination.__value`, `delete`d after delivery, and
never assigned to anything logged or audited. The commitment-scan `__str__`
covert-channel scar is respected.
**Note A:** `netlify-env.mjs:46` returns `detail: body.slice(0,200)` (the Netlify
API error body) on env-write failure. The caller (`submit-key.mjs`) does NOT
surface or audit `detail` (it reads only `ok/mode/reason`), so it dies in the
adapter — safe today. But it's a live grenade: any future caller that logs the
full adapter result would leak whatever Netlify echoes on a failed write of a
secret value. Recommend dropping `detail` or reducing it to a status code.
**Note B:** if `asService().update` to `completed` (`:142`) throws *after*
delivery (`:134`), the key is delivered but the ask stays `open` — a retry
re-delivers (idempotent, same key/destination, low harm) and no leak occurs. Tie
this off with F2's "don't complete until closure is durable" fix.
**Productivity-cost:** zero (Note A is a one-line trim).

### F9 — KEYDROP_LIVE gates every dangerous path, with one split-brain caveat — ACCEPTABLE-WITH-NOTE
**What/why:** Checked every path. `ask-state`/`submit-key` refuse non-`test_only`
asks while `!LIVE` (403). `keydrop-ask` CLI refuses non-test ask *creation* while
inert and forces `--test` binds to fleet addresses only. The adapter targets the
self-site scratch var while `!isLive`. `sendAcks` no-ops while `!isLive`. The gate
is consistent — it is not just the happy path.
**Note (split-brain):** the CLI reads `KEYDROP_LIVE` from the local `.env`; the
functions read it from Netlify site env. These are two sources of truth. The
dangerous direction is flipping the Netlify env `KEYDROP_LIVE=true` (functions go
live) while acks/PAT aren't ready — which is precisely F1+F2. Recommend a single
documented flip checklist ("live = F1 done + F2 done + Netlify env flip"), owned
as a runbook. The dry-run adapter also leaves `KEYDROP_ADAPTER_PROBE_<ts>` env
vars accreting on the KeyDrop site and triggers a real redeploy per probe — pure
hygiene, clean them up; hand to Ward.

### F10 — No application-level rate limiting; KeyDrop as a Stripe key-validation oracle — ACCEPTABLE-WITH-NOTE
**What/why:** `submit-key` verify has no hard stop — `attempt_count` increments
and offers the alt-path at ≥2 but never blocks further attempts. With a valid
bound session and an open ask, a caller can submit arbitrary candidate values and
learn valid-vs-invalid from Stripe's real probe response — i.e. use KeyDrop as an
oracle to test stolen Stripe keys. This requires already holding Stephanie's
session AND an open ask (narrow), and Stripe rate-limits its own API. There is
also no per-IP/function rate limit on the endpoints generally.
**Smallest control:** cap verify attempts per ask (e.g. hard-stop at 5, then force
the alt-path and freeze the ask pending requester re-issue). For v0 single-user
this is low; note it and add the cap when BYOK generalizes. Edge/platform rate
limiting → Ward.
**Productivity-cost:** zero for the note; minor to add the cap.

### F11 — SUPABASE_SERVICE_KEY blast radius is the whole shared project — ACCEPTABLE-WITH-NOTE (estate residual)
**What/why:** The KEYRING frames the dedicated `keydrop_netlify` secret key as
narrow because it is separately *revocable*. Correct on revocability — but a
Supabase secret/service key still carries service-role authority = full read/write
across the *entire shared project* (every SOMA app's tables + all user PII),
bypassing RLS. Revocation isolation ≠ authority isolation; the KEYRING language
risks conflating them (the same distinction it gets right for the Netlify PAT).
This key sits in the local `.env` (gitignored, verified never in git history —
good; repo is public) and in Netlify env. If either leaks, the blast radius is
all of SOMA Auth, not just KeyDrop.
**Note:** this is the estate-wide posture (every SOMA app holds a service key
against the shared project), so it is accepted residual risk, not a KeyDrop
regression. Recording it, not relitigating it. Two cheap asks: (1) confirm this
key is a scoped/limited key if Supabase's new key system supports table scoping
for this project — if it does, scope it to `keydrop_*`; if it doesn't, say so in
the KEYRING and correct the "narrow" wording to "separately revocable." (2) put
it on the KEY-REFRESH-LEDGER rotation cadence. Rotation cadence + scoping check →
Ward/Dee.

---

## What we are NOT defending against (stated on purpose)

- **Stephanie's email/inbox compromise.** The link and the auth both arrive
  there; owning the inbox defeats KeyDrop exactly as it would defeat plain email
  (F6). Out of scope, and not solvable in-app.
- **Mike's laptop / Netlify account / Supabase project platform compromise.**
  Any of these is estate-wide game-over; KeyDrop inherits, doesn't amplify.
- **Generic phishing of Stephanie by a lookalike site.** Mitigated by the ask
  always originating from claude@ with Mike cc'd and a known SOMA domain, but the
  residual is phishing-education, not code (spec §3 already concedes this).
- **Stephanie herself pasting a wrong/over-powered key.** Handled as a *feature*
  (§2.3c refusal), not a threat.

---

## Verdict summary

| # | Finding | Verdict |
|---|---|---|
| F1 | Full-account Netlify PAT; live delivery can write any site | **MUST-FIX-BEFORE-LIVE** |
| F2 | Acks unwired + fail-loud swallowed → silent-death live handoff | **MUST-FIX-BEFORE-LIVE** |
| F3 | No CSP + floating unpinned CDN on a page holding a live secret | **SHOULD-FIX-BEFORE-LIVE (high)** |
| F4 | asUser/asService separation airtight | ACCEPTABLE |
| F5 | Stolen token w/o session = nothing | ACCEPTABLE |
| F6 | Different-user session sees nothing (reduces to inbox control) | ACCEPTABLE-WITH-NOTE |
| F7 | uri_allow_list append was append-only + own-origin scoped | ACCEPTABLE (verified live) |
| F8 | Exception paths do not leak the secret | ACCEPTABLE (2 minor trims) |
| F9 | KEYDROP_LIVE gates all dangerous paths; env split-brain caveat | ACCEPTABLE-WITH-NOTE |
| F10 | No app rate-limit; key-validation oracle | ACCEPTABLE-WITH-NOTE |
| F11 | Service key = whole-shared-project authority | ACCEPTABLE-WITH-NOTE (estate residual) |

## Recommendation: **HOLD** for live, pending F1, F2, F3.

The design is right and the inert build is honestly inert — I could not find a
path where a live secret moves or an outward send fires while `KEYDROP_LIVE=false`.
The identity model (F4/F5) is the strong core and needs nothing. But taking it
live for Stephanie's real `rk_live_` key requires closing three small controls:
mint the dedicated PAT + add a destination allowlist (F1), wire acks or make
closure fail hard so the handoff can't die silently (F2), and add a CSP
`connect-src` + pin/SRI the CDN so a supply-chain event can't exfiltrate the
paste field (F3). All three are hours, not days. Flip to SHIP once they land.
