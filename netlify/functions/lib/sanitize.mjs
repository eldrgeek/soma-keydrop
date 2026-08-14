// Sanitization helpers. Spec §2.1: no secret value at rest, in logs, or in error
// messages — ever, including exception paths. Scar this cites: commitment-scan's
// subprocess.TimeoutExpired leak (_estate/bin/commitment-scan ~L172) — an
// exception's default __str__ can embed the very value it was supposed to protect.
// Every catch block in this function set must go through here, not console.error(e)
// or String(e) directly, when `e` might have touched a secret.

import { createHash } from 'node:crypto';

/** Wrap an unknown error into a message safe to return/log — counts/codes only. */
export function safeErrorMessage(e, fallback) {
  // Never interpolate e.message or String(e) when the call site might have
  // touched a secret value (a fetch body, a thrown validation error, etc).
  // Callers that need detail should construct their own safe message instead
  // of relying on the caught error's text.
  return fallback || 'internal error';
}

/** Fingerprint a key value for the audit trail. Never store/return the value itself. */
export function fingerprint(provider, value) {
  const v = String(value || '');
  const sha256 = createHash('sha256').update(v).digest('hex');
  const prefix = v.length > 8 ? v.slice(0, 8) + '…' : '…';
  const last4 = v.length >= 4 ? v.slice(-4) : '';
  return { provider, prefix, last4, sha256, length: v.length };
}

/** JSON response helper. */
export function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
