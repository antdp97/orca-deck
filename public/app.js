(function () {
  'use strict';
  var token = '', state = null, selected = null, selectedRequest = '', shownRequest = '', shownAt = 0, busy = false, polling = false, timer = 0;
  var KEYS = ['approve', 'reject', 'continue', 'interrupt', 'mainClaude', 'choose', 'pr', 'preview'], layout, editing = false, picked = '';
  var $ = function (id) { return document.getElementById(id); };
  var TEXT = {
    vi: {
      pinLabel: 'Mã ghép nối', connect: 'Kết nối', chooseAgent: 'Chọn agent', links: 'Đặt liên kết',
      editLayout: 'Sửa bố cục', moveLeft: 'Chuyển trước', moveRight: 'Chuyển sau', toggleKey: 'Ẩn / hiện nút', reset: 'Bố cục mặc định',
      unpair: 'Ngắt ghép nối', done: 'Xong', chooseRequest: 'Chọn yêu cầu', deck: 'Bảng điều khiển', mainClaude: 'Claude chính',
      openPr: 'Mở PR', openPreview: 'Mở preview', close: 'Đóng', linksTitle: 'Liên kết', save: 'Lưu', language: 'Ngôn ngữ',
      connected: 'Đã kết nối Mac', disconnected: 'Mất kết nối', badResponse: 'Phản hồi không hợp lệ.', failed: 'Không thực hiện được.',
      offline: 'Không kết nối được Mac. Kiểm tra Wi‑Fi và cửa sổ Orca Deck.', agentChanged: 'Agent đã đổi phiên. Chọn lại.', session: 'phiên',
      working: 'Đang thực hiện…', sentContinue: 'Đã gửi Continue.', pinned: 'Đã ghim Claude chính.', doneMsg: 'Xong.',
      approved: 'Đã duyệt một lần.', rejected: 'Đã từ chối.', noAgents: 'Chưa có Claude/Codex trong Orca.', pinAs: 'Ghim làm Claude chính',
      tabAgents: 'Tất cả', approveOnce: 'Duyệt một lần', rejectOne: 'Từ chối', paired: 'Đã kết nối. Ghim Claude chính.', mainChanged: 'Claude chính đã đổi phiên. Ghim lại.', saved: 'Đã lưu.'
    },
    en: {
      pinLabel: 'Pairing code', connect: 'Connect', chooseAgent: 'Choose agent', links: 'Set links',
      editLayout: 'Edit layout', moveLeft: 'Move earlier', moveRight: 'Move later', toggleKey: 'Hide / show key', reset: 'Default layout',
      unpair: 'Unpair', done: 'Done', chooseRequest: 'Choose request', deck: 'Control deck', mainClaude: 'Main Claude',
      openPr: 'Open PR', openPreview: 'Open preview', close: 'Close', linksTitle: 'Links', save: 'Save', language: 'Language',
      connected: 'Connected to Mac', disconnected: 'Disconnected', badResponse: 'Invalid response.', failed: "Couldn't do that.",
      offline: "Can't reach the Mac. Check Wi‑Fi and the Orca Deck window.", agentChanged: 'The agent session changed. Choose again.', session: 'session',
      working: 'Working…', sentContinue: 'Sent Continue.', pinned: 'Main Claude pinned.', doneMsg: 'Done.',
      approved: 'Approved once.', rejected: 'Rejected.', noAgents: 'No Claude/Codex terminals in Orca.', pinAs: 'Pin as main Claude',
      tabAgents: 'Agents', approveOnce: 'Approve once', rejectOne: 'Reject', paired: 'Connected. Pin your main Claude.', mainChanged: 'Main Claude changed session. Pin it again.', saved: 'Saved.'
    }
  };
  var lang = '';
  try { lang = localStorage.getItem('orcaDeckLang') || ''; } catch (e) {}
  if (!TEXT[lang]) lang = /^vi/i.test(navigator.language || '') ? 'vi' : 'en';
  function t(key) { return TEXT[lang][key]; }
  function applyLang() {
    var i, nodes = document.querySelectorAll('[data-t]');
    for (i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-t'));
    nodes = document.querySelectorAll('[data-ta]');
    for (i = 0; i < nodes.length; i++) nodes[i].setAttribute('aria-label', t(nodes[i].getAttribute('data-ta')));
    nodes = document.querySelectorAll('.lang-code');
    for (i = 0; i < nodes.length; i++) nodes[i].textContent = lang.toUpperCase();
    document.documentElement.lang = lang;
    if (!agent()) $('agentTitle').textContent = t('chooseAgent');
  }
  try { token = localStorage.getItem('orcaDeckToken') || ''; } catch (e) {}
  function message(text) { clearTimeout(timer); $('message').textContent = text || ''; if (text) timer = setTimeout(function () { $('message').textContent = ''; }, 4000); }
  function connected(on) { $('dot').className = on ? 'on' : ''; $('dot').setAttribute('aria-label', t(on ? 'connected' : 'disconnected')); }
  function defaultLayout() { return { order: KEYS.slice(), hidden: {} }; }
  try { layout = JSON.parse(localStorage.getItem('orcaDeckLayout')); } catch (e) {}
  if (!layout || !layout.order || !layout.hidden) layout = defaultLayout();
  // Drop unknown ids and append new keys so saved layouts survive future key changes.
  layout.order = layout.order.filter(function (id) { return KEYS.indexOf(id) >= 0; });
  KEYS.forEach(function (id) { if (layout.order.indexOf(id) < 0) layout.order.push(id); });
  function applyLayout() {
    var box = $('keys');
    layout.order.forEach(function (id) {
      var key = $(id); box.appendChild(key);
      key.classList.toggle('off', !!layout.hidden[id]); key.classList.toggle('picked', editing && id === picked);
    });
    box.classList.toggle('editing', editing);
    $('bar').hidden = editing; $('editBar').hidden = !editing; $('tabs').hidden = editing;
    var at = layout.order.indexOf(picked);
    $('moveLeft').disabled = !picked || at === 0; $('moveRight').disabled = !picked || at === KEYS.length - 1; $('toggleKey').disabled = !picked;
    try { localStorage.setItem('orcaDeckLayout', JSON.stringify(layout)); } catch (e) {}
    buttonStates();
  }
  var VIEWS = ['agents', 'agent', 'deck'], view = '';
  try { view = localStorage.getItem('orcaDeckView') || ''; } catch (e) {}
  if (VIEWS.indexOf(view) < 0) view = window.innerWidth < 700 ? 'agents' : 'deck';
  function showView(name) {
    view = name;
    if (editing) { editing = false; picked = ''; applyLayout(); }
    $('agentsView').hidden = name !== 'agents'; $('agentView').hidden = name !== 'agent'; $('keys').hidden = name !== 'deck';
    $('editButton').hidden = name !== 'deck';
    $('cardActions').hidden = name === 'deck';
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-view') === name;
      tabs[i].classList.toggle('active', on); tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    try { localStorage.setItem('orcaDeckView', name); } catch (e) {}
    notify();
  }
  function move(step) { var at = layout.order.indexOf(picked); layout.order.splice(at, 1); layout.order.splice(at + step, 0, picked); applyLayout(); }
  function fail(text, status, code) { var e = new Error(text); e.status = status; e.code = code; return e; }
  function api(route, data, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(data === null ? 'GET' : 'POST', '/api/' + route, true);
    xhr.timeout = 15000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-Deck-Lang', lang);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function () {
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (e) { return callback(fail(t('badResponse'), xhr.status, '')); }
      if (xhr.status === 401 && route !== 'pair') { token = ''; try { localStorage.removeItem('orcaDeckToken'); } catch (e) {} showPair(); }
      callback(xhr.status >= 200 && xhr.status < 300 ? null : fail(result.error || t('failed'), xhr.status, result.code || ''), result);
    };
    xhr.onerror = xhr.ontimeout = function () { callback(fail(t('offline'), 0, 'offline')); };
    xhr.send(data === null ? null : JSON.stringify(data));
  }
  function showPair() { $('pair').hidden = !!token; $('deck').hidden = !token; if (!token) { connected(false); editing = false; applyLayout(); } }
  function agent() {
    if (!state || !selected) return null;
    for (var i = 0; i < state.agents.length; i++) if (state.agents[i].handle === selected.handle && state.agents[i].incarnationId === selected.incarnationId) return state.agents[i];
    return null;
  }
  function request() {
    if (!state) return null;
    for (var i = 0; i < state.requests.length; i++) if (state.requests[i].id === selectedRequest) return state.requests[i];
    return null;
  }
  function buttonStates() {
    var a = agent(), r = request(), ids = ['continue', 'interrupt', 'pr', 'preview'];
    if (editing) { KEYS.forEach(function (id) { $(id).disabled = false; }); return; }
    var settling = Date.now() - shownAt < 1000;
    $('approve').disabled = $('reject').disabled = $('cardApprove').disabled = $('cardReject').disabled = busy || !r || settling;
    for (var i = 0; i < ids.length; i++) $(ids[i]).disabled = busy || !a;
    $('choose').disabled = $('mainClaude').disabled = $('agentButton').disabled = busy;
    $('linksButton').disabled = busy || !a;
  }
  function render() {
    var a = agent(), r;
    if (selected && !a) { selected = null; message(t('agentChanged')); }
    $('agentTitle').textContent = a ? a.title : t('chooseAgent');
    $('project').textContent = a ? a.project + ' · ' + a.agent : '';
    var select = $('requestSelect');
    while (select.firstChild) select.removeChild(select.firstChild);
    var empty = document.createElement('option');
    empty.value = ''; empty.textContent = t('chooseRequest'); select.appendChild(empty);
    if (selectedRequest && !request()) selectedRequest = '';
    // A lone request is always shown, including after a decision, expiry, or a decision on another device.
    if (state.requests.length === 1 && !request()) selectedRequest = state.requests[0].id;
    for (var i = 0; i < state.requests.length; i++) {
      var q = state.requests[i], option = document.createElement('option');
      option.value = q.id; option.textContent = q.project + ' · ' + q.tool + ' · ' + t('session') + ' ' + q.sessionId.slice(0, 8); select.appendChild(option);
    }
    select.value = selectedRequest;
    $('request').hidden = !state.requests.length;
    select.hidden = state.requests.length < 2;
    $('requestCount').textContent = state.requests.length;
    r = request();
    if ((r ? r.id : '') !== shownRequest) { shownRequest = r ? r.id : ''; shownAt = Date.now(); setTimeout(buttonStates, 1000); }
    $('requestTool').textContent = r ? r.tool : '';
    $('requestMeta').textContent = r ? r.project + ' · ' + r.sessionId.slice(0, 8) : '';
    $('requestInput').hidden = !r;
    $('requestInput').textContent = r ? JSON.stringify(r.input, null, 2) : '';
    buttonStates();
  }
  function poll() {
    if (!token || polling || busy || document.hidden) return;
    polling = true;
    api('state', null, function (err, result) {
      polling = false;
      if (err) { connected(false); state = null; buttonStates(); message(err.message); notify(err); return; }
      connected(true); state = result;
      if (state.orcaError) message(state.orcaError);
      render();
      notify();
    });
  }
  function action(name, target, after) {
    if (busy || !target) return;
    busy = true; buttonStates(); message(t('working'));
    api('action', { action: name, handle: target.handle, incarnationId: target.incarnationId }, function (err) {
      busy = false; message(err ? err.message : t(name === 'continue' ? 'sentContinue' : name === 'pin' ? 'pinned' : 'doneMsg'));
      if (!err && after) after();
      buttonStates(); poll();
    });
  }
  function decide(value) {
    var r = request(); if (!r || busy || Date.now() - shownAt < 1000) return;
    busy = true; buttonStates();
    api('decision', { id: r.id, decision: value }, function (err) {
      busy = false; selectedRequest = '';
      message(err ? err.message : t(value === 'allow' ? 'approved' : 'rejected'));
      buttonStates(); poll();
    });
  }
  var listeners = [];
  function notify(err) { for (var i = 0; i < listeners.length; i++) listeners[i](state, err || null); }
  // Every selection change goes through here so the Agent view never shows one agent while targeting another.
  function setSelected(a) { selected = a; render(); notify(); }
  window.Deck = {
    api: api, t: t, message: message, decide: decide, action: action, poll: poll,
    getState: function () { return state; },
    getSelected: agent,
    select: setSelected,
    pickRequest: function (id) { selectedRequest = id; render(); },
    onState: function (fn) { listeners.push(fn); },
    show: showView, view: function () { return view; }
  };
  function chooseAgents() {
    if (!state) return;
    var list = $('agentList'); while (list.firstChild) list.removeChild(list.firstChild);
    if (!state.agents.length) { list.className = 'empty'; list.textContent = t('noAgents'); } else list.className = '';
    var cur = agent();
    state.agents.forEach(function (a) {
      var row = document.createElement('div'); row.className = 'agent-row';
      var choice = document.createElement('button'); choice.className = 'agent-choice' + (a === cur ? ' current' : '');
      var title = document.createElement('strong'); title.textContent = a.title;
      var sub = document.createElement('small'); sub.textContent = a.project + ' · ' + a.agent;
      choice.appendChild(title); choice.appendChild(sub);
      choice.onclick = function () { $('agentModal').hidden = true; setSelected(a); action('focus', a); };
      row.appendChild(choice);
      if (a.agent.indexOf('claude') === 0) {
        var isMain = state.main && state.main.handle === a.handle && state.main.incarnationId === a.incarnationId;
        var pin = document.createElement('button'); pin.className = 'icon-button' + (isMain ? ' pinned' : '');
        pin.setAttribute('aria-label', t('pinAs')); pin.setAttribute('aria-pressed', isMain ? 'true' : 'false');
        pin.innerHTML = '<svg class="icon"><use xlink:href="#i-pin"/></svg>';
        pin.onclick = function () { action('pin', a, function () { $('agentModal').hidden = true; setSelected(a); }); };
        row.appendChild(pin);
      }
      list.appendChild(row);
    });
    $('agentModal').hidden = false;
  }
  function editLinks() {
    var a = agent(); if (!a) return;
    var links = state.links[a.workspace] || {};
    $('prUrl').value = links.pr || ''; $('previewUrl').value = links.preview || ''; $('linksModal').hidden = false;
  }
  $('pairForm').onsubmit = function (event) {
    event.preventDefault();
    api('pair', { pin: $('pin').value.trim() }, function (err, result) {
      if (err) return message(err.message);
      token = result.token; try { localStorage.setItem('orcaDeckToken', token); } catch (e) {}
      $('pin').value = ''; showPair(); message(t('paired')); poll();
    });
  };
  $('requestSelect').onchange = function () { selectedRequest = this.value; render(); };
  $('cardApprove').onclick = function () { decide('allow'); };
  $('cardReject').onclick = function () { decide('deny'); };
  var handlers = {
    approve: function () { decide('allow'); },
    reject: function () { decide('deny'); },
    continue: function () { action('continue', agent()); },
    interrupt: function () { action('interrupt', agent()); },
    choose: chooseAgents,
    mainClaude: function () {
      if (!state || !state.main) return chooseAgents();
      var found = null;
      state.agents.forEach(function (a) { if (a.handle === state.main.handle && a.incarnationId === state.main.incarnationId) found = a; });
      if (!found) { message(t('mainChanged')); return chooseAgents(); }
      setSelected(found); action('focus', found);
    }
  };
  ['pr', 'preview'].forEach(function (name) { handlers[name] = function () { var a = agent(); if (!a) return; if (!(state.links[a.workspace] || {})[name]) return editLinks(); action(name, a); }; });
  KEYS.forEach(function (id) { $(id).onclick = function () { if (editing) { picked = id; applyLayout(); } else handlers[id](); }; });
  $('agentButton').onclick = chooseAgents;
  $('linksButton').onclick = editLinks;
  $('editButton').onclick = function () { editing = true; picked = ''; applyLayout(); };
  $('editDone').onclick = function () { editing = false; picked = ''; applyLayout(); if (state) render(); };
  $('moveLeft').onclick = function () { move(-1); };
  $('moveRight').onclick = function () { move(1); };
  $('toggleKey').onclick = function () { layout.hidden[picked] = !layout.hidden[picked]; applyLayout(); };
  $('resetLayout').onclick = function () { layout = defaultLayout(); picked = ''; applyLayout(); };
  $('linksForm').onsubmit = function (event) {
    event.preventDefault(); var a = agent(); if (!a || busy) return;
    busy = true; buttonStates();
    api('links', { workspace: a.workspace, pr: $('prUrl').value.trim(), preview: $('previewUrl').value.trim() }, function (err) {
      busy = false; message(err ? err.message : t('saved')); if (!err) $('linksModal').hidden = true; buttonStates(); poll();
    });
  };
  var MODALS = ['agentModal', 'linksModal'];
  var closes = document.querySelectorAll('.close');
  for (var i = 0; i < closes.length; i++) closes[i].onclick = function () { MODALS.forEach(function (id) { $(id).hidden = true; }); };
  MODALS.forEach(function (id) { $(id).onclick = function (event) { if (event.target === this) this.hidden = true; }; });
  $('unpair').onclick = function () { token = ''; state = null; selected = null; try { localStorage.removeItem('orcaDeckToken'); } catch (e) {} showPair(); };
  var tabButtons = document.querySelectorAll('.tab');
  for (i = 0; i < tabButtons.length; i++) tabButtons[i].onclick = function () { showView(this.getAttribute('data-view')); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  var langButtons = document.querySelectorAll('.lang-button');
  for (i = 0; i < langButtons.length; i++) langButtons[i].onclick = function () {
    lang = lang === 'vi' ? 'en' : 'vi';
    try { localStorage.setItem('orcaDeckLang', lang); } catch (e) {}
    applyLang(); if (state) render(); connected(!!state);
  };
  applyLang(); applyLayout(); showPair(); showView(view); poll(); setInterval(poll, 2000);
}());
