#!/usr/bin/env bash
# test/e2e.sh — KeyDrop v0 inert-build E2E proof.
# Mints Supabase sessions via the admin generate_link + verify pattern (no real
# email round-trip needed — see docs/BUILD-2026-08-14.md for why this is a valid
# substitute for clicking an emailed link in an automated test).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

SITE="${SITE_URL:-https://soma-keydrop.netlify.app}"
STAMP=$(date +%s)
WRONG_EMAIL="keydrop-test-wrong-identity+${STAMP}@mike-wolf.com"
BOUND_EMAIL="mw@mike-wolf.com"

session_for() {
  local email="$1"
  local gen hashed loc token
  gen=$(curl -sS -X POST "$SUPABASE_URL/auth/v1/admin/generate_link" \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"magiclink\",\"email\":\"$email\"}")
  hashed=$(echo "$gen" | python3 -c "import json,sys; print(json.load(sys.stdin).get('hashed_token',''))")
  [ -n "$hashed" ] || { echo "generate_link failed for $email: $gen" >&2; return 1; }
  loc=$(curl -sS -o /dev/null -w '%{redirect_url}' \
    "$SUPABASE_URL/auth/v1/verify?type=magiclink&token=$hashed&redirect_to=${SITE}/index.html")
  token=$(python3 -c "
import sys, urllib.parse
frag = sys.argv[1].split('#',1)[1] if '#' in sys.argv[1] else ''
q = urllib.parse.parse_qs(frag)
print(q.get('access_token',[''])[0])
" "$loc")
  [ -n "$token" ] || { echo "no access_token in redirect for $email: $loc" >&2; return 1; }
  echo "$token"
}

echo "== creating throwaway wrong-identity user: $WRONG_EMAIL"
curl -sS -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  --data "{\"email\":\"$WRONG_EMAIL\",\"email_confirm\":true}" > /dev/null

echo "== minting sessions"
WRONG_TOKEN=$(session_for "$WRONG_EMAIL")
BOUND_TOKEN=$(session_for "$BOUND_EMAIL")
echo "wrong-identity token: ${WRONG_TOKEN:0:16}... (len ${#WRONG_TOKEN})"
echo "bound-identity token: ${BOUND_TOKEN:0:16}... (len ${#BOUND_TOKEN})"

echo "== creating test ask bound to $BOUND_EMAIL"
CREATE_OUT=$(python3 bin/keydrop-ask create --test --provider stripe \
  --bound-email "$BOUND_EMAIL" --requester claude@mike-wolf.com \
  --site-url "$SITE" --dest-site-id "${SITE_ID:-cdd3433a-8aaa-41c4-b226-ca2d7e2dfeff}" --dest-env-key STRIPE_RESTRICTED_KEY 2>&1)
echo "$CREATE_OUT"
ASK_TOKEN=$(echo "$CREATE_OUT" | grep -oE '\?ask=[0-9a-f]+' | head -1 | cut -d= -f2)
echo "ask token: $ASK_TOKEN"

echo
echo "=== TEST 1: wrong identity hits ask-state -> expect 403 ==="
curl -sS -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $WRONG_TOKEN" \
  "$SITE/.netlify/functions/ask-state?ask=$ASK_TOKEN"

echo
echo "=== TEST 2: bound identity hits ask-state -> expect 200, step 1 ==="
curl -sS -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $BOUND_TOKEN" \
  "$SITE/.netlify/functions/ask-state?ask=$ASK_TOKEN"

echo
echo "=== TEST 3: resume across reload -- attest step 1, then re-fetch ask-state ==="
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  -H "Authorization: Bearer $BOUND_TOKEN" -H "Content-Type: application/json" \
  --data '{"action":"attest","step":1}' \
  "$SITE/.netlify/functions/submit-key?ask=$ASK_TOKEN"
echo "-- re-fetch (simulates page reload) --"
curl -sS -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $BOUND_TOKEN" \
  "$SITE/.netlify/functions/ask-state?ask=$ASK_TOKEN"

echo
echo "=== TEST 4: attest step 2 ==="
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  -H "Authorization: Bearer $BOUND_TOKEN" -H "Content-Type: application/json" \
  --data '{"action":"attest","step":2}' \
  "$SITE/.netlify/functions/submit-key?ask=$ASK_TOKEN"

echo
echo "=== TEST 5: paste an sk_test_ key -> expect REFUSAL (over-powered) ==="
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  -H "Authorization: Bearer $BOUND_TOKEN" -H "Content-Type: application/json" \
  --data '{"action":"verify","step":3,"value":"sk_test_notarealkeyabcdefghijklmnop"}' \
  "$SITE/.netlify/functions/submit-key?ask=$ASK_TOKEN"

echo
echo "=== TEST 6: paste a garbage rk_test_ key -> expect liveness failure (real Stripe probe) ==="
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  -H "Authorization: Bearer $BOUND_TOKEN" -H "Content-Type: application/json" \
  --data '{"action":"verify","step":3,"value":"rk_test_notarealkeyabcdefghijklmnop"}' \
  "$SITE/.netlify/functions/submit-key?ask=$ASK_TOKEN"

echo
echo "=== after 2 failed attempts: check alt_path present + ask state ==="
python3 bin/keydrop-ask show "$ASK_TOKEN"

echo
echo "== cleanup: deleting throwaway user and test ask =="
# NOTE: this admin endpoint's `filter` param is a substring match, not `eq` —
# it does not accept operator syntax like `email.eq.X`. Substring-match on the
# exact address and pick the exact match (there may be leftover users from
# earlier runs sharing the "keydrop-test-wrong-identity" prefix).
WRONG_ID=$(curl -sS "$SUPABASE_URL/auth/v1/admin/users?filter=$WRONG_EMAIL" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for u in d.get('users', []):
    if u.get('email') == '$WRONG_EMAIL':
        print(u['id']); break
" 2>/dev/null || true)
if [ -n "$WRONG_ID" ]; then
  curl -sS -X DELETE "$SUPABASE_URL/auth/v1/admin/users/$WRONG_ID" \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" -o /dev/null -w 'delete user HTTP %{http_code}\n'
else
  echo "could not resolve wrong-identity user id for cleanup — leaving for manual cleanup: $WRONG_EMAIL"
fi
curl -sS -X DELETE "$SUPABASE_URL/rest/v1/keydrop_asks?token=eq.$ASK_TOKEN" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" -o /dev/null -w 'delete ask HTTP %{http_code}\n'
echo "== done =="
