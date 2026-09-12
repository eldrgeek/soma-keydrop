// Closure acks (spec §2.7). On completion: email acks from claude@ to the bound
// identity + Mike + the requesting session's thread. Same sender identity as
// SOMA/tools/mail/send_from_claude.py (claude@mike-wolf.com, Gmail SMTP + app
// password), which runs on Mike's Mac. To avoid putting mail credentials on
// Netlify, the function-side live path queues owed acks in keydrop_audit and a
// Mac-side cron/launchd sender delivers them.
//
// What IS proven: the closure call site (submit-key.mjs) calls this on every
// completion path, in both live and dry-run modes, and this module always
// returns a structured result the caller records in the audit trail.

export async function sendAcks({ isLive, ask, fingerprint }) {
  if (!isLive) {
    const result = {
      sent: false,
      mode: 'dry-run',
      would_send_to: [ask.bound_email, 'mw@mike-wolf.com'].filter(Boolean),
      reason: 'KEYDROP_LIVE=false — ack transport not wired for v0 (see docs/BUILD-2026-08-14.md)',
    };
    // Locke F2: "dry-run log lines now" — this must be visible in Netlify
    // function logs, not just recorded in the audit table, so a human
    // scanning logs sees an ack was (correctly) not sent while inert. Never
    // logs the fingerprint's raw provenance beyond what's already
    // audit-safe (provider/prefix/last4/sha256 — never the key value).
    console.log('[keydrop:ack] dry-run — would send to', result.would_send_to.join(', '), 'ask', ask.id);
    return result;
  }
  // Live path: queue the owed ack durably in keydrop_audit via submit-key's
  // existing `audit(row.id, 'ack', ackResult)` call. A Mac-side sender consumes
  // this queue and writes ack_sent / ack_failed follow-ups.
  return {
    sent: false,
    mode: 'queued',
    would_send_to: [ask.bound_email, 'mw@mike-wolf.com'].filter(Boolean),
    reason: 'queued for the Mac ack sender',
  };
}
