// Closure acks (spec §2.7). On completion: email acks from claude@ to the bound
// identity + Mike + the requesting session's thread. Same sender identity as
// SOMA/tools/mail/send_from_claude.py (claude@mike-wolf.com, Gmail SMTP + app
// password) — but that script runs on Mike's Mac; a Netlify function runs off-Mac,
// so live mode needs its own SMTP client (nodemailer + CLAUDE_GMAIL_APP_PASSWORD
// as a Netlify env var). NOT WIRED YET — deliberately: this build is inert
// (KEYDROP_LIVE=false) and the hard rule for this build is "no outward sends,
// nothing to Stephanie, no real ack" (task §Hard rules). Flagged honestly here and
// in docs/BUILD-2026-08-14.md rather than half-wiring a live sender that would
// need a real credential and a real recipient to test.
//
// What IS proven: the closure call site (submit-key.mjs) calls this on every
// completion path, in both live and dry-run modes, and this module always
// returns a structured result the caller records in the audit trail — so the
// integration point is real, only the transport is stubbed pending Locke + Mike.

export async function sendAcks({ isLive, ask, fingerprint }) {
  if (!isLive) {
    return {
      sent: false,
      mode: 'dry-run',
      would_send_to: [ask.bound_email, 'mw@mike-wolf.com'].filter(Boolean),
      reason: 'KEYDROP_LIVE=false — ack transport not wired for v0 (see docs/BUILD-2026-08-14.md)',
    };
  }
  // Live path intentionally not implemented in v0. Throwing here (rather than
  // silently no-op'ing) means a future flip of KEYDROP_LIVE without finishing
  // this function fails loudly instead of pretending to have sent an ack.
  throw new Error('ack transport not implemented — do not set KEYDROP_LIVE=true until this is wired');
}
