// POST /.netlify/functions/submit-key?ask=<token>
// Body: { action: 'attest'|'verify', step: 1|2|3, value?: string }
//
// The secret VALUE (when present) lives only in this request's local variables,
// used to probe the provider and hand to the destination adapter, then goes out
// of scope when the function returns. It is never assigned to any variable that
// gets logged, and no catch block below interpolates it. Spec §2.1.

import { requireUser, AuthError } from './lib/auth.mjs';
import { asUser, asService } from './lib/supabase.mjs';
import { json, fingerprint } from './lib/sanitize.mjs';
import { sendAcks } from './lib/ack.mjs';
import * as stripe from './lib/providers/stripe.mjs';
import * as netlifyEnv from './lib/adapters/netlify-env.mjs';

const PROVIDERS = { stripe };
const LIVE = process.env.KEYDROP_LIVE === 'true';
const SELF_SITE_ID = process.env.SITE_ID; // Netlify sets this automatically at runtime.

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

async function audit(askId, event, detail) {
  try {
    await asService().insert('keydrop_audit', { ask_id: askId, event, detail: detail || {} });
  } catch {
    // Audit-write failure must never block or leak into the caller's response.
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  const token = event.queryStringParameters && event.queryStringParameters.ask;
  const { action, step, value } = body;
  if (!token) return json(400, { error: 'Missing ask token' });
  if (!['attest', 'verify'].includes(action)) return json(400, { error: 'Invalid action' });
  if (![1, 2, 3].includes(step)) return json(400, { error: 'Invalid step' });

  try {
    const user = await requireUser(event.headers.authorization || event.headers.Authorization);

    const rows = await asUser(user.token).select(
      'keydrop_asks',
      `token=eq.${encodeURIComponent(token)}&select=*`
    );
    if (!rows || rows.length === 0) {
      return json(403, { error: "This ask isn't available to your signed-in identity, or the link is invalid/expired." });
    }
    let row = rows[0];

    if (row.state === 'open' && new Date(row.ttl_at) < new Date()) {
      await asService().update('keydrop_asks', `id=eq.${row.id}`, { state: 'expired' });
      return json(410, { error: 'This ask expired.', ask: publicAsk({ ...row, state: 'expired' }) });
    }
    if (!row.test_only && !LIVE) {
      return json(403, { error: 'KeyDrop is running in inert mode; only test asks are servable.' });
    }
    if (row.state !== 'open') {
      return json(409, { error: `Ask is ${row.state}, not open.`, ask: publicAsk(row) });
    }

    // ---- Attestation steps (1, 2): advance on her word only — we cannot
    // observe her provider session cross-origin (honest boundary, spec §2.5).
    if (action === 'attest') {
      if (step !== row.step || step === 3) {
        return json(409, { error: `Ask is on step ${row.step}, not ${step}.`, ask: publicAsk(row) });
      }
      const updated = await asService().update('keydrop_asks', `id=eq.${row.id}`, { step: row.step + 1 });
      await audit(row.id, 'attest', { step });
      return json(200, { ask: publicAsk(updated[0]) });
    }

    // ---- Verify step (3): the one step that self-verifies.
    if (step !== 3 || row.step !== 3) {
      return json(409, { error: `Ask is on step ${row.step}, not ready to verify.`, ask: publicAsk(row) });
    }
    if (!value || typeof value !== 'string') {
      return json(400, { error: 'Missing key value.' });
    }

    const providerMod = PROVIDERS[row.provider];
    if (!providerMod) return json(500, { error: 'Unknown provider' });

    const shape = providerMod.checkShape(value);
    if (!shape.ok) {
      const attempt_count = row.attempt_count + 1;
      const auditDetail = { step: 3, result: shape.refused ? 'refused-over-powered' : 'invalid-shape', attempt_count };
      if (shape.overPowered) auditDetail.fingerprint = fingerprint(row.provider, value);
      await asService().update('keydrop_asks', `id=eq.${row.id}`, { attempt_count });
      await audit(row.id, shape.refused ? 'refused' : 'invalid', auditDetail);
      const resp = {
        refused: shape.refused === true,
        message: shape.reason,
        ask: publicAsk({ ...row, attempt_count }),
      };
      if (attempt_count >= 2) resp.alt_path = "Two attempts haven't worked — reply to Dee's email instead of continuing to guess.";
      return json(shape.refused ? 200 : 200, resp);
    }

    const probeResult = await providerMod.probe(value);
    if (!probeResult.ok) {
      const attempt_count = row.attempt_count + 1;
      await asService().update('keydrop_asks', `id=eq.${row.id}`, { attempt_count });
      await audit(row.id, 'invalid', { step: 3, result: 'liveness-failed', attempt_count, fingerprint: fingerprint(row.provider, value) });
      const resp = { refused: false, message: probeResult.reason, ask: publicAsk({ ...row, attempt_count }) };
      if (attempt_count >= 2) resp.alt_path = "Two attempts haven't worked — reply to Dee's email instead of continuing to guess.";
      return json(200, resp);
    }

    // ---- Success: shape ok + real liveness proof + power ceiling already
    // enforced (only rk_ ever reaches here). Deliver, then close — but
    // closure must be DURABLE before the ask is marked completed (Locke F2).
    // The old order marked `completed` before the ack attempt and swallowed
    // any ack failure into a logged-but-invisible audit line — a live handoff
    // could silently consume the ask with nobody notified. Fixed order:
    // deliver -> record delivery -> attempt ack (not swallowed; a throw
    // propagates to the outer catch, which returns a real error to the
    // caller and leaves the ask `open`/step 3, retriable) -> only THEN mark
    // `completed`. Delivery re-attempting on retry is idempotent (same
    // key/destination, per Locke F8 note B) so this is safe to retry.
    const fp = fingerprint(row.provider, value);
    const destination = { ...(row.destination || {}), __value: value };
    const adapterResult = await netlifyEnv.deliver({
      destination,
      fingerprint: fp,
      isLive: LIVE,
      selfSiteId: SELF_SITE_ID,
    });
    delete destination.__value; // out of scope for anything logged below

    await audit(row.id, 'delivered', {
      fingerprint: fp,
      account_id: probeResult.accountId || null,
      adapter: { ok: adapterResult.ok, mode: adapterResult.mode, reason: adapterResult.reason || null },
    });

    // No .catch() swallow here on purpose (Locke F2). If this throws (e.g.
    // KEYDROP_LIVE=true before the ack transport is wired), the outer catch
    // returns a real error to the caller and the ask stays open — never a
    // silent success.
    const ackResult = await sendAcks({ isLive: LIVE, ask: row, fingerprint: fp });
    await audit(row.id, 'ack', ackResult);

    const updatedRows = await asService().update('keydrop_asks', `id=eq.${row.id}`, {
      state: 'completed',
      completed_at: new Date().toISOString(),
      fingerprint: fp,
    });
    await audit(row.id, 'completed', { fingerprint: fp });

    return json(200, {
      message: 'Verified and delivered.',
      ask: publicAsk(updatedRows[0]),
      adapter: { ok: adapterResult.ok, mode: adapterResult.mode },
      ack: ackResult,
    });
  } catch (e) {
    if (e instanceof AuthError) return json(e.status, { error: e.message });
    return json(500, { error: 'internal error' });
  }
};
