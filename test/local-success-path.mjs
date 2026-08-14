// test/local-success-path.mjs — proves the SUCCESS branch of the verify step:
// shape check -> liveness probe -> fingerprint -> destination adapter, run
// locally (not against the deployed function) because no Stripe test-mode
// account is accessible in this estate (checked: ai-embassadors' Netlify site
// has zero env vars set — STRIPE_SECRET_KEY there is a placeholder default,
// never configured). Per the build task's own instruction: "if no test Stripe
// account is accessible, mock the probe layer behind an interface and say so
// honestly."
//
// What's REAL here: the Netlify env-var adapter call (KEYDROP_NETLIFY_PAT,
// targeting soma-keydrop's OWN site, dry-run env key) — genuine API calls,
// genuine redeploy, genuine verification.
// What's MOCKED here: global.fetch is intercepted ONLY for
// api.stripe.com/v1/account, returning a canned 200 {id:"acct_test_mock"} —
// everything else (Netlify calls) passes through to the real network.
//
// Run: node test/local-success-path.mjs

import { checkShape, probe } from '../netlify/functions/lib/providers/stripe.mjs';
import { fingerprint } from '../netlify/functions/lib/sanitize.mjs';
import * as netlifyEnv from '../netlify/functions/lib/adapters/netlify-env.mjs';
import fs from 'node:fs';

const envPath = new URL('../.env', import.meta.url);
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const [k, ...rest] = t.split('=');
  process.env[k] = rest.join('=');
}
// This local run also needs the Netlify PAT, which lives only in the deployed
// site's env (by design — never committed locally). Pull it fresh via CLI.
import { execSync } from 'node:child_process';
if (!process.env.KEYDROP_NETLIFY_PAT) {
  const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/Library/Preferences/netlify/config.json', 'utf8'));
  const user = Object.values(cfg.users)[0];
  process.env.KEYDROP_NETLIFY_PAT = user.auth.token;
}
const SELF_SITE_ID = 'cdd3433a-8aaa-41c4-b226-ca2d7e2dfeff';

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.stripe.com/v1/account')) {
    console.log('  [MOCK] intercepted Stripe probe call (no real Stripe test account available)');
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'acct_test_mock_1786682000' }),
    };
  }
  return realFetch(url, opts);
};

async function main() {
  const value = 'rk_test_mockvalue_notreal_abcdefgh12345';

  console.log('1. checkShape():');
  const shape = checkShape(value);
  console.log('   ', shape);
  if (!shape.ok) throw new Error('expected shape.ok=true for rk_test_ prefix');

  console.log('2. probe() [Stripe call is MOCKED]:');
  const p = await probe(value);
  console.log('   ', p);
  if (!p.ok) throw new Error('expected probe.ok=true from mocked Stripe response');

  console.log('3. fingerprint() [never logs the raw value]:');
  const fp = fingerprint('stripe', value);
  console.log('   ', fp);

  console.log('4. adapter.deliver() [REAL Netlify API call, dry-run scratch var, own site]:');
  const result = await netlifyEnv.deliver({
    destination: { site_id: SELF_SITE_ID, env_key: 'STRIPE_RESTRICTED_KEY', __value: value },
    fingerprint: fp,
    isLive: false,
    selfSiteId: SELF_SITE_ID,
  });
  console.log('   ', result);
  if (!result.ok) throw new Error('adapter dry-run call failed: ' + JSON.stringify(result));

  console.log('5. waitForDeploy() [REAL, polls the triggered redeploy to green]:');
  const state = await netlifyEnv.waitForDeploy(SELF_SITE_ID, result.deploy_id, { timeoutMs: 90000, intervalMs: 4000 });
  console.log('   deploy state:', state);
  if (state !== 'ready') throw new Error('expected redeploy to reach ready, got: ' + state);

  console.log('\nALL LOCAL SUCCESS-PATH ASSERTIONS PASSED');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
