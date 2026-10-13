(function () {
  'use strict';
  var D = window.Deck, $ = function (id) { return document.getElementById(id); };
  // shown: key of the agent on screen (kept when it ends or we go offline).
  // pending[key]: a send to that session is in flight. locks[key]: time its last send may have been delivered;
  // Send stays off for that session until a screen read started after that time comes back.
  var shown = '', shownAgent = null, pending = {}, locks = {}, loading = '', snippetsDrawn = '';
  function keyOf(a) { return a ? a.handle + '/' + a.incarnationId : ''; }
  function showScreen(lines) {
    var el = $('agentScreen'), atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = lines.join('\n') || '—';
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
  function renderSnippets(state) {
    var list = (state && state.snippets) || [], sig = JSON.stringify([list, D.t('editSnippets')]), box = $('snippets');
    if (sig === snippetsDrawn) return;
    snippetsDrawn = sig;
    while (box.firstChild) box.removeChild(box.firstChild);
    list.forEach(function (text) {
      var chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'chip'; chip.textContent = text;
      chip.onclick = function () { $('replyText').value = text; $('replyText').focus(); };
      box.appendChild(chip);
    });
    var edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'chip'; edit.setAttribute('aria-label', D.t('editSnippets'));
    edit.innerHTML = '<svg class="icon"><use xlink:href="#i-pencil"/></svg>';
    edit.onclick = function () { $('snippetText').value = ((D.getState() || {}).snippets || []).join('\n'); $('snippetModal').hidden = false; };
    box.appendChild(edit);
  }
  function refresh() {
    var a = D.getSelected(), state = D.getState(), k = keyOf(a);
    if (k && k !== shown) { shown = k; $('agentScreen').textContent = ''; }
    if (a) shownAgent = a;
    $('agentEmpty').hidden = !!shown; $('agentBody').hidden = !shown;
    if (!shown) return;
    var ended = !a && !!state, prompt = !!a && a.status === 'prompt', locked = !!a && !!locks[k];
    var badge = $('agentBadge'); while (badge.firstChild) badge.removeChild(badge.firstChild);
    badge.appendChild(D.statusBadge(a ? a.status : 'idle'));
    $('agentName').textContent = shownAgent.title;
    $('agentScreen').classList.toggle('ended', ended);
    $('agentNote').textContent = D.t(ended ? 'sessionEnded' : 'promptNote');
    $('agentNote').hidden = !ended && !prompt;
    $('agentPin').hidden = shownAgent.agent.indexOf('claude') !== 0;
    $('agentFocus').disabled = $('agentPin').disabled = $('agentPr').disabled = $('agentPreview').disabled = !a;
    // Offline, ended or busy: nothing can be sent. Ctrl-C stays usable through prompts and "maybe sent".
    var down = !a || !state || !!pending[k], keys = $('sendKeys').getElementsByTagName('button');
    for (var i = 0; i < keys.length; i++) keys[i].disabled = down || ((prompt || locked) && keys[i].getAttribute('data-key') !== 'ctrl-c');
    $('replySend').disabled = down || prompt || locked;
    renderSnippets(state);
  }
  function loadScreen() {
    var a = D.getSelected(), k = keyOf(a), started = Date.now();
    if (!a || loading === k) return;
    loading = k;
    D.api('details', { handle: a.handle, incarnationId: a.incarnationId }, function (err, result) {
      if (loading === k) loading = '';
      if (keyOf(D.getSelected()) !== k) return; // answer for an agent that's no longer shown
      if (err) { if (err.code === 'stale') { D.message(err.message); D.show('agents'); } return; }
      if (keyOf(result.agent) !== k) return;
      showScreen(result.screen);
      if (locks[k] && started > locks[k]) { delete locks[k]; refresh(); }
    });
  }
  function send(body, after) {
    var a = D.getSelected(), k = keyOf(a);
    if (!a || pending[k]) return;
    pending[k] = true; refresh();
    body.handle = a.handle; body.incarnationId = a.incarnationId;
    D.api('send', body, function (err, result) {
      delete pending[k];
      // The input may already be in that terminal: lock it even if the user has moved on.
      if (err && (err.code === 'delivery_unknown' || err.code === 'offline')) locks[k] = Date.now();
      if (keyOf(D.getSelected()) !== k) { refresh(); return; } // user moved on: no toast, keep their box
      if (!err) {
        if (after) after();
        if (result.screen) showScreen(result.screen);
        if (body.text) D.message(D.t('sent'));
      } else if (err.code === 'stale') { D.message(err.message); D.show('agents'); }
      else if (locks[k]) D.message(D.t('maybeSent'));
      else D.message(err.message);
      refresh();
    });
  }
  var keys = $('sendKeys').getElementsByTagName('button');
  for (var i = 0; i < keys.length; i++) keys[i].onclick = function () { send({ key: this.getAttribute('data-key') }); };
  $('replyForm').onsubmit = function (event) {
    event.preventDefault();
    var text = $('replyText').value.trim();
    if (!text || $('replySend').disabled) return;
    send({ text: text, enter: true }, function () { if ($('replyText').value.trim() === text) $('replyText').value = ''; });
  };
  $('agentFocus').onclick = function () { D.action('focus', D.getSelected()); };
  $('agentPin').onclick = function () { D.action('pin', D.getSelected()); };
  $('agentPr').onclick = function () { D.openLink('pr'); };
  $('agentPreview').onclick = function () { D.openLink('preview'); };
  $('snippetForm').onsubmit = function (event) {
    event.preventDefault();
    var list = $('snippetText').value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    D.api('snippets', { list: list }, function (err) {
      D.message(err ? err.message : D.t('saved'));
      if (!err) { $('snippetModal').hidden = true; D.poll(); }
    });
  };
  D.onState(function (state, err) {
    refresh();
    if (!err && state && D.view() === 'agent') loadScreen();
  });
}());
