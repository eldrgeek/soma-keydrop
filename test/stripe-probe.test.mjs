// Stripe liveness probe: a least-privilege restricted key cannot read /v1/account,
// so Stripe answers 403 permission_error. That must count as a genuine key
// (2026-09-13: Mike's rk_live_ key with Checkout Sessions / Customers / Prices
// only was refused as "unexpected error (403)"). 401 stays a rejection.
import assert from 'node:assert/strict';
import { probe } from '../netlify/functions/lib/providers/stripe.mjs';

function withStripeResponse(status, body, fn) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://api.stripe.com/v1/account');
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return fn().finally(() => { global.fetch = realFetch; });
}

export async function run() {
  await withStripeResponse(200, { id: 'acct_123' }, async () => {
    assert.deepEqual(await probe('rk_test_x'), { ok: true, accountId: 'acct_123' });
  });

  await withStripeResponse(403, { error: { type: 'permission_error', message: 'The provided key does not have the required permissions for this endpoint.' } }, async () => {
    assert.deepEqual(await probe('rk_live_x'), { ok: true, accountId: null });
  });

  // The body Stripe actually sends a least-privilege restricted key on /v1/account
  // (the first fix missed this shape and refused Mike's key again, audit row 31).
  await withStripeResponse(403, { error: { type: 'invalid_request_error', message: "The provided key 'rk_live_*********************abcd' does not have the required permissions for this endpoint on account 'acct_1AbCdEf'. Having the 'rak_accounts_kyc_basic_read' permission would allow this request to continue." } }, async () => {
    assert.deepEqual(await probe('rk_live_x'), { ok: true, accountId: 'acct_1AbCdEf' });
  });

  await withStripeResponse(403, { error: { type: 'invalid_request_error' } }, async () => {
    const r = await probe('rk_live_x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /unexpected error \(403\)/);
  });

  await withStripeResponse(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } }, async () => {
    const r = await probe('rk_live_x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /invalid or revoked/);
  });

  await withStripeResponse(500, { error: { type: 'api_error' } }, async () => {
    assert.equal((await probe('rk_live_x')).ok, false);
  });
}
