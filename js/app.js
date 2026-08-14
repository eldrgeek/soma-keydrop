// KeyDrop stepper app logic (index.html). Extracted from an inline <script>
// block into this external file as part of Locke's F3 fix — a CSP with
// `script-src 'self'` (no `unsafe-inline`) cannot execute inline script, and
// dropping `unsafe-inline` is what actually blocks an injected/rogue inline
// script from running at all, on top of the connect-src egress restriction.
// Behavior is unchanged from the inline version — this is a relocation, not
// a rewrite. Loaded in the same DOM position the inline block occupied.
(function () {
  var el = function (id) { return document.getElementById(id); };
  var appEl = el('app');
  var q = new URLSearchParams(location.search);
  var askToken = q.get('ask');
  var session = null;
  var askState = null;

  function baseDir() { return location.href.replace(/index\.html.*$/, '').replace(/\?.*$/, ''); }

  function renderCenter(html) {
    appEl.innerHTML = '<div class="center">' + html + '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    var res = await fetch('/.netlify/functions/' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  }

  function renderStepper() {
    if (!askState) { renderCenter('No ask loaded.'); return; }
    var a = askState;
    var step = a.step;
    var stateBadge = '';
    if (a.state === 'completed') {
      appEl.innerHTML =
        '<div class="eyebrow">SOMA · KeyDrop</div><h1>Done</h1>' +
        '<div class="step done"><div class="step-body">This ask is complete. The key has been delivered ' +
        'and this page is now closed. You can close this tab.<br><br>' +
        '<b>Please clear your clipboard</b> — we cannot do that for you from a web page.</div></div>';
      return;
    }
    if (a.state === 'refused') {
      appEl.innerHTML = '<div class="eyebrow">SOMA · KeyDrop</div><h1>Ask refused</h1>' +
        '<div class="step done"><div class="step-body">This ask was refused. The requester has been notified ' +
        'and can send a new one.</div></div>';
      return;
    }
    if (a.state === 'expired') {
      appEl.innerHTML = '<div class="eyebrow">SOMA · KeyDrop</div><h1>Ask expired</h1>' +
        '<div class="step done"><div class="step-body">This ask expired. The requester has been notified ' +
        'and can send a new one.</div></div>';
      return;
    }

    var html = '<div class="eyebrow">SOMA · KeyDrop</div>' +
      '<h1>' + esc(a.recipe.provider_label || a.provider) + ' key request</h1>' +
      '<p class="sub">Requested by ' + esc(a.requester) + '. Three steps, one button each.</p>' +
      (a.test_only ? '<div class="test-banner show">TEST ASK — inert build. No real key will be requested or stored.</div>' : '');

    // Step 1
    html += '<div class="step ' + (step > 1 ? 'done' : (step === 1 ? 'active' : '')) + '">' +
      '<div class="step-head"><div class="step-num">' + (step > 1 ? '✓' : '1') + '</div>' +
      '<div class="step-title">Log in to ' + esc(a.recipe.provider_label || a.provider) + '</div></div>' +
      '<div class="step-body">Opens in a new tab. This KeyDrop tab stays put — switch back here when you\'re signed in.</div>';
    if (step === 1) {
      html += '<a href="' + esc(a.recipe.login_url) + '" target="_blank" rel="noopener"><button class="primary">Log in to ' + esc(a.recipe.provider_label) + '</button></a>' +
        '<br><button class="secondary" id="attest-1">Done — I\'m logged in</button>';
    }
    html += '</div>';

    // Step 2
    html += '<div class="step ' + (step > 2 ? 'done' : (step === 2 ? 'active' : '')) + '">' +
      '<div class="step-head"><div class="step-num">' + (step > 2 ? '✓' : '2') + '</div>' +
      '<div class="step-title">Create the restricted key</div></div>';
    if (step === 2) {
      html += '<div class="step-body">Opens the key-creation page in a new tab. Match these settings exactly — ' +
        'the checklist is the only prose here on purpose:</div>' +
        '<ul class="scopes">' + (a.recipe.scopes || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
        (a.recipe.suggested_name ? '<div class="step-body">Suggested name: <code>' + esc(a.recipe.suggested_name) + '</code></div>' : '') +
        '<a href="' + esc(a.recipe.mint_url) + '" target="_blank" rel="noopener"><button class="primary">Create the restricted key</button></a>' +
        '<br><button class="secondary" id="attest-2">Done — I created it</button>';
    }
    html += '</div>';

    // Step 3
    html += '<div class="step ' + (step === 3 ? 'active' : '') + '">' +
      '<div class="step-head"><div class="step-num">3</div>' +
      '<div class="step-title">Paste the key here</div></div>';
    if (step === 3) {
      html += '<div class="step-body">Paste the key you just created. It is never shown back to you, never logged, ' +
        'and used exactly once to deliver it — then it is gone from our memory.</div>' +
        '<input type="password" id="key-value" autocomplete="off" placeholder="rk_live_… or rk_test_…" />' +
        '<br><button class="primary" id="submit-key">Verify and send</button>' +
        '<div class="msg" id="step3-msg"></div>';
    }
    html += '</div>';

    html += '<div class="foot">SOMA KeyDrop · the secret never rests anywhere but its destination.</div>';
    appEl.innerHTML = html;

    var a1 = el('attest-1'); if (a1) a1.addEventListener('click', function () { doStep({ action: 'attest', step: 1 }); });
    var a2 = el('attest-2'); if (a2) a2.addEventListener('click', function () { doStep({ action: 'attest', step: 2 }); });
    var sk = el('submit-key');
    if (sk) sk.addEventListener('click', function () {
      var v = el('key-value').value;
      if (!v) { showStep3('Paste a value first.', 'err'); return; }
      sk.disabled = true;
      doStep({ action: 'verify', step: 3, value: v }).then(function () { sk.disabled = false; el('key-value').value = ''; });
    });
  }

  function showStep3(text, kind) {
    var m = el('step3-msg');
    if (!m) return;
    m.textContent = text;
    m.className = 'msg ' + kind;
  }

  async function doStep(body) {
    var r = await api('submit-key?ask=' + encodeURIComponent(askToken), { method: 'POST', body: body });
    if (!r.ok) {
      if (body.step === 3) showStep3((r.data && r.data.error) || 'Request failed.', 'err');
      else renderCenter('Request failed: ' + ((r.data && r.data.error) || r.status));
      return;
    }
    askState = r.data.ask;
    renderStepper();
    // renderStepper() rebuilds the DOM (fresh #step3-msg included), so the
    // message must be set AFTER it, not before — otherwise the re-render
    // wipes it out before it's ever visible.
    if (body.step === 3 && r.data.message) {
      var text = r.data.message + (r.data.alt_path ? ' ' + r.data.alt_path : '');
      showStep3(text, r.data.alt_path ? 'warn' : 'err');
    }
  }

  async function loadAsk() {
    if (!askToken) { renderCenter('No ask token in the URL. This link is incomplete.'); return; }
    var r = await api('ask-state?ask=' + encodeURIComponent(askToken));
    if (!r.ok) {
      renderCenter((r.data && r.data.error) || 'This ask isn\'t available to your signed-in identity, or the link is invalid/expired.');
      return;
    }
    askState = r.data.ask;
    renderStepper();
  }

  SomaAuth.onAuthStateChange(function (event, s) {
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
      if (!s || !s.user) {
        location.replace('login.html' + (askToken ? ('?ask=' + encodeURIComponent(askToken)) : ''));
        return;
      }
      session = s;
      loadAsk();
    } else if (event === 'SIGNED_OUT') {
      location.replace('login.html' + (askToken ? ('?ask=' + encodeURIComponent(askToken)) : ''));
    }
  });
  SomaAuth.init(window.SOMA_AUTH_CONFIG.url, window.SOMA_AUTH_CONFIG.anonKey);
})();
