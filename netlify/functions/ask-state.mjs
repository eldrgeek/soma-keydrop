// GET /.netlify/functions/ask-state?ask=<token>
// Resolves a token to ask metadata + step state, enforcing identity binding via
// RLS (fetched with the CALLER's own JWT, never the service key — see
// lib/supabase.mjs asUser). Zero rows back = not authorized for THIS identity,
// which is the mechanical form of spec §2.4's "auth guarantees it is Stephanie."

import { requireUser, AuthError } from './lib/auth.mjs';
import { asUser, asService } from './lib/supabase.mjs';
import { json } from './lib/sanitize.mjs';
import * as stripe from './lib/providers/stripe.mjs';

const PROVIDERS = { stripe };
const LIVE = process.env.KEYDROP_LIVE === 'true';

function publicAsk(row) {
  const providerMod = PROVIDERS[row.provider];
  const recipe = { ...(providerMod ? providerMod.recipe() : {}), ...(row.recipe || {}) };
  return {
    token: row.token,
    requester: row.requester,
    provider: row.provider,
    recipe,
    state: row.state,
    step: row.step,
    attempt_count: row.attempt_count,
    test_only: row.test_only,
  };
}

export const handler = async (event) => {
  try {
    const token = event.queryStringParameters && event.queryStringParameters.ask;
    if (!token) return json(400, { error: 'Missing ask token' });

    const user = await requireUser(event.headers.authorization || event.headers.Authorization);

    const rows = await asUser(user.token).select(
      'keydrop_asks',
      `token=eq.${encodeURIComponent(token)}&select=*`
    );
    if (!rows || rows.length === 0) {
      // Empty array from RLS = wrong identity or unknown token. Same message
      // either way — never confirm/deny which, to a caller who isn't the owner.
      return json(403, { error: "This ask isn't available to your signed-in identity, or the link is invalid/expired." });
    }
    let row = rows[0];

    if (row.state === 'open' && new Date(row.ttl_at) < new Date()) {
      await asService().update('keydrop_asks', `id=eq.${row.id}`, { state: 'expired' });
      row = { ...row, state: 'expired' };
    }

    // Inert-build safety: while KEYDROP_LIVE is false, only test asks are servable.
    if (!row.test_only && !LIVE) {
      return json(403, { error: 'KeyDrop is running in inert mode; only test asks are servable.' });
    }

    return json(200, { ask: publicAsk(row) });
  } catch (e) {
    if (e instanceof AuthError) return json(e.status, { error: e.message });
    return json(500, { error: 'internal error' });
  }
};
