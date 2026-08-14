// Stripe recipe/policy v0 (spec §3, Stripe row + §2.3). Expects a RESTRICTED key
// (rk_live_… / rk_test_…). A full secret key (sk_…) is refused, never accepted —
// accepting an over-powerful key silently would make KeyDrop a liability launderer.

export const label = 'Stripe';

export function recipe() {
  return {
    provider_label: 'Stripe',
    login_url: 'https://dashboard.stripe.com/login',
    mint_url: 'https://dashboard.stripe.com/apikeys/create',
    suggested_name: 'soma-keydrop-restricted',
    scopes: [
      'Charges — Write',
      'Checkout Sessions — Write',
      'Customers — Write',
      'Webhook endpoints — Read',
    ],
  };
}

/** Shape check. Returns { ok, refused, reason } — never includes the value. */
export function checkShape(value) {
  const v = String(value || '');
  if (/^sk_(live|test)_/.test(v)) {
    return {
      ok: false,
      refused: true,
      reason:
        'That looks like a full Secret key (sk_…), not a Restricted key. KeyDrop only ' +
        'accepts Restricted keys (rk_live_… / rk_test_…) — least power, on purpose. ' +
        'Go back to step 2, create a Restricted key with the listed scopes, and paste that ' +
        'instead. Because a full key passed through this page, we flagged it in the audit ' +
        'trail with advice to roll it — Stripe dashboard → API keys → roll this key.',
      overPowered: true,
    };
  }
  if (/^rk_(live|test)_/.test(v)) {
    return { ok: true, mode: v.startsWith('rk_test_') ? 'test' : 'live' };
  }
  return {
    ok: false,
    refused: false,
    reason:
      "That doesn't look like a Stripe key (expected it to start with rk_live_ or rk_test_). " +
      'Double-check you copied the whole value and try again.',
  };
}

/** Real liveness probe: GET /v1/account with the key as the bearer. */
export async function probe(value) {
  let resp;
  try {
    resp = await fetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${value}` },
    });
  } catch {
    return { ok: false, reason: 'Could not reach Stripe to verify the key (network error). Try again.' };
  }
  if (resp.status === 401) {
    return { ok: false, reason: 'Stripe rejected that key as invalid or revoked.' };
  }
  if (!resp.ok) {
    return { ok: false, reason: `Stripe returned an unexpected error (${resp.status}) while verifying the key.` };
  }
  let account;
  try {
    account = await resp.json();
  } catch {
    return { ok: false, reason: 'Stripe returned an unreadable response while verifying the key.' };
  }
  return { ok: true, accountId: account && account.id };
}
