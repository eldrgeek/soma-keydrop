// KeyDrop login app logic (login.html). Extracted from an inline <script>
// block as part of Locke's F3 fix — see js/app.js header for the rationale
// (CSP script-src 'self' with no unsafe-inline). Behavior unchanged.
(function () {
  var q = new URLSearchParams(location.search);
  var ask = q.get('ask');
  var baseDir = location.href.replace(/login\.html.*$/, '');
  // Preserve the ask token through the auth round trip. Never land back on login.html.
  var appUrl = baseDir + 'index.html' + (ask ? ('?ask=' + encodeURIComponent(ask)) : '');

  var methods = SomaAuth.getMethods();
  var el = function (id) { return document.getElementById(id); };
  var msg = el('msg'), emailInput = el('email'), primaryBtn = el('primary-btn');

  function showMsg(text, kind) { msg.textContent = text; msg.className = 'msg ' + (kind || 'ok'); }

  if (methods.oauth && methods.oauth.length) {
    methods.oauth.forEach(function (provider) {
      var meta = SomaAuth.providerMeta(provider);
      var b = document.createElement('button');
      b.className = 'google';
      b.textContent = 'Continue with ' + meta.label;
      b.addEventListener('click', function () {
        SomaAuth.signInWithOAuth(provider, { redirectTo: appUrl }).then(function (r) {
          if (r && r.error) showMsg(r.error.message, 'err');
        });
      });
      el('oauth-slot').appendChild(b);
    });
  } else {
    el('divider').style.display = 'none';
  }

  primaryBtn.addEventListener('click', function () {
    var email = emailInput.value.trim();
    if (!email) { showMsg('Enter your email.', 'err'); return; }
    primaryBtn.disabled = true;
    SomaAuth.signInWithOtp(email, { emailRedirectTo: appUrl }).then(function (r) {
      primaryBtn.disabled = false;
      if (r && r.error) { showMsg(r.error.message, 'err'); return; }
      showMsg('Check your email for a sign-in link.', 'ok');
    });
  });
  emailInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') primaryBtn.click(); });

  SomaAuth.onAuthStateChange(function (event, session) {
    if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && session && session.user) {
      location.replace(appUrl);
    }
  });
  SomaAuth.init(window.SOMA_AUTH_CONFIG.url, window.SOMA_AUTH_CONFIG.anonKey);
})();
