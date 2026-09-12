import assert from 'node:assert/strict';
import { sendAcks } from '../netlify/functions/lib/ack.mjs';

export async function run() {
  const ask = { id: 'ask-1', bound_email: 'bound@example.com' };

  const dryRun = await sendAcks({ isLive: false, ask, fingerprint: { last4: '1234' } });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.sent, false);
  assert.equal(
    dryRun.reason,
    'KEYDROP_LIVE=false — ack transport not wired for v0 (see docs/BUILD-2026-08-14.md)'
  );

  const live = await sendAcks({ isLive: true, ask, fingerprint: { last4: '1234' } });
  assert.deepEqual(live, {
    sent: false,
    mode: 'queued',
    would_send_to: ['bound@example.com', 'mw@mike-wolf.com'],
    reason: 'queued for the Mac ack sender',
  });
}
