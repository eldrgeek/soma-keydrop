// SOMA Auth config for KeyDrop v0. Publishable/anon key — safe in client-side code
// (RLS-gated; grants nothing beyond what Postgres RLS on keydrop_asks allows, and
// keydrop_audit has zero policies so it is invisible to anon/authenticated entirely).
// NEVER put the secret/service_role key here. Shared SOMA Auth project.
window.SOMA_AUTH_CONFIG = {
  url: 'https://omfwcodoimjmbrhssvfl.supabase.co',
  anonKey: 'sb_publishable_vi2qDWjozUJ5mi9dwirkLA_rj6UaqLf',

  methods: {
    magicLink: true,      // passwordless email link (default SOMA method) — this is
                           // the identity proof: KeyDrop trusts auth, not link possession.
    emailOtp:  false,
    password:  false,
    phone:     false,
    oauth:     ['google']
  }
};
