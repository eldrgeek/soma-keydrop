// Destination adapter v0 (spec §2.6): set the key as a Netlify env var on the
// named site, trigger a redeploy, verify it goes green. This function's own
// Netlify PAT is KeyDrop's crown jewel — see SOMA/keys/KEYRING.md. Never logged.
//
// Gate: when KEYDROP_LIVE !== 'true', this adapter runs in DRY-RUN mode — it
// still exercises the real Netlify API (auth, site lookup) so the mechanism is
// genuinely proven, but it targets ONLY the KeyDrop site's own scratch env var
// (KEYDROP_ADAPTER_PROBE_*), never the ask's real destination site/key. This is
// what makes "hits the adapter in dry-run" (build task §7) an honest claim
// rather than a stub.

const NETLIFY_API = 'https://api.netlify.com/api/v1';

export async function deliver({ destination, fingerprint, isLive, selfSiteId }) {
  const pat = process.env.KEYDROP_NETLIFY_PAT;
  if (!pat) return { ok: false, reason: 'Adapter not configured (no KEYDROP_NETLIFY_PAT)' };

  const siteId = isLive ? destination.site_id : selfSiteId;
  const envKey = isLive ? destination.env_key : `KEYDROP_ADAPTER_PROBE_${Date.now()}`;
  // The actual secret VALUE is passed in only via the caller's in-memory scope
  // (see submit-key.mjs) and never appears in this module's own logs. In
  // dry-run mode we deliberately do NOT write the real value anywhere — we
  // write a harmless marker so the probe is a real API call with zero blast
  // radius, matching the "nothing outward, no real delivery" hard rule.
  const envValue = isLive ? destination.__value : `dry-run-probe-${fingerprint.sha256.slice(0, 12)}`;

  try {
    const getEnv = await fetch(`${NETLIFY_API}/sites/${siteId}/env`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!getEnv.ok) return { ok: false, reason: `Could not reach site env (${getEnv.status})` };

    // Netlify's supported write path: PUT /api/v1/sites/{site_id}/env/{key}
    const put = await fetch(`${NETLIFY_API}/sites/${siteId}/env/${encodeURIComponent(envKey)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: envKey, values: [{ value: envValue, context: 'all' }] }),
    });
    if (!put.ok) {
      const body = await put.text().catch(() => '');
      return { ok: false, reason: `Env write failed (${put.status})`, detail: body.slice(0, 200) };
    }

    const deploy = await fetch(`${NETLIFY_API}/sites/${siteId}/builds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!deploy.ok) return { ok: false, reason: `Redeploy trigger failed (${deploy.status})` };
    const deployInfo = await deploy.json().catch(() => ({}));

    return {
      ok: true,
      mode: isLive ? 'live' : 'dry-run',
      site_id: siteId,
      env_key: envKey,
      deploy_id: deployInfo.deploy_id || null,
    };
  } catch {
    return { ok: false, reason: 'Adapter call failed (network/exception, sanitized)' };
  }
}

/** Poll a deploy until it's ready/error, bounded. Returns final state string. */
export async function waitForDeploy(siteId, deployId, { timeoutMs = 60000, intervalMs = 3000 } = {}) {
  const pat = process.env.KEYDROP_NETLIFY_PAT;
  if (!pat || !deployId) return 'unknown';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys/${deployId}`, {
      headers: { Authorization: `Bearer ${pat}` },
    }).catch(() => null);
    if (r && r.ok) {
      const d = await r.json().catch(() => ({}));
      if (d.state === 'ready' || d.state === 'error') return d.state;
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return 'timeout';
}
