// Auth gate for KeyDrop functions. Verifies the caller is a logged-in SOMA Auth
// (Supabase) user by asking Supabase /auth/v1/user with the bearer token — same
// pattern as FrontRow's netlify/functions/lib/auth.ts and ai-embassadors'
// checkout function, ported to JS/mjs for a build-step-free static site.
//
// This proves WHO is asking. It does NOT decide whether they may see a given
// ask — that is Postgres RLS on keydrop_asks (bound_email = jwt email), enforced
// by fetching the row with the caller's own token, not the service-role key.

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export async function requireUser(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new AuthError('Missing Authorization bearer token');

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new AuthError('Server missing Supabase config', 500);

  let resp;
  try {
    resp = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
  } catch {
    // Never let a raw fetch error (which can embed the token in some
    // environments' error strings) reach a caller or a log.
    throw new AuthError('Auth check failed (network)', 502);
  }
  if (!resp.ok) throw new AuthError('Invalid or expired session');

  let user;
  try {
    user = await resp.json();
  } catch {
    throw new AuthError('Invalid session response', 502);
  }
  if (!user || !user.id || !user.email) throw new AuthError('Invalid session');
  return { id: user.id, email: user.email, token };
}
