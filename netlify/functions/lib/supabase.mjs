// Minimal Supabase REST helpers — no @supabase/supabase-js dependency (keeps
// functions build-step-free). Two distinct access modes, used deliberately:
//
//   asUser(token)   — forwards the CALLER's own JWT + anon apikey. Postgres RLS
//                      on keydrop_asks (bound_email = jwt email) enforces identity
//                      binding at the DB layer, not just in function code. This is
//                      the read path for ask-state and the pre-check in submit-key.
//                      Per reference_supabase_js_silent_rls_refusal: a wrong-identity
//                      row comes back as an EMPTY ARRAY (200, not 403/404) — always
//                      treat zero rows as "not authorized", never as "not found".
//
//   asService()     — service-role key, bypasses RLS entirely. Used ONLY after
//                      asUser() has already proven the caller owns the ask, for the
//                      state/step/audit writes (which need to touch columns no
//                      authenticated RLS policy grants, by design — asks are never
//                      writable by anon/authenticated per schema.sql).

const URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function client(apikey, authToken) {
  const headers = {
    apikey,
    Authorization: `Bearer ${authToken || apikey}`,
    'Content-Type': 'application/json',
  };
  return {
    async select(table, query) {
      const r = await fetch(`${URL}/rest/v1/${table}?${query}`, { headers });
      if (!r.ok) throw new Error(`select ${table} failed: ${r.status}`);
      return r.json();
    },
    async update(table, query, body, opts) {
      const h = { ...headers, Prefer: (opts && opts.prefer) || 'return=representation' };
      const r = await fetch(`${URL}/rest/v1/${table}?${query}`, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`update ${table} failed: ${r.status}`);
      return r.json();
    },
    async insert(table, body, opts) {
      const h = { ...headers, Prefer: (opts && opts.prefer) || 'return=representation' };
      const r = await fetch(`${URL}/rest/v1/${table}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`insert ${table} failed: ${r.status}`);
      return r.json();
    },
  };
}

export function asUser(token) {
  if (!URL || !ANON_KEY) throw new Error('Server missing Supabase config');
  return client(ANON_KEY, token);
}

export function asService() {
  if (!URL || !SERVICE_KEY) throw new Error('Server missing Supabase service config');
  return client(SERVICE_KEY, SERVICE_KEY);
}
