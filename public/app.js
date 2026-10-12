(function () {
  'use strict';
  var token = '', state = null, selected = null, selectedRequest = '', requestChosen = false, busy = false, polling = false, timer = 0;
  var KEYS = ['approve', 'reject', 'continue', 'interrupt', 'mainClaude', 'choose', 'pr', 'preview'], layout, editing = false, picked = '';
  var $ = function (id) { return document.getElementById(id); };
  try { token = localStorage.getItem('orcaDeckToken') || ''; } catch (e) {}
  function message(text) { clearTimeout(timer); $('message').textContent = text || ''; if (text) timer = setTimeout(function () { $('message').textContent = ''; }, 4000); }
  function connected(on) { $('dot').className = on ? 'on' : ''; $('dot').setAttribute('aria-label', on ? 'Đã kết nối Mac' : 'Mất kết nối'); }
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
    $('bar').hidden = editing; $('editBar').hidden = !editing;
    var at = layout.order.indexOf(picked);
    $('moveLeft').disabled = !picked || at === 0; $('moveRight').disabled = !picked || at === KEYS.length - 1; $('toggleKey').disabled = !picked;
    try { localStorage.setItem('orcaDeckLayout', JSON.stringify(layout)); } catch (e) {}
    buttonStates();
  }
  function move(step) { var at = layout.order.indexOf(picked); layout.order.splice(at, 1); layout.order.splice(at + step, 0, picked); applyLayout(); }
  function api(route, data, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(data === null ? 'GET' : 'POST', '/api/' + route, true);
    xhr.timeout = 15000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function () {
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (e) { return callback(new Error('Phản hồi không hợp lệ.')); }
      if (xhr.status === 401 && route !== 'pair') { token = ''; try { localStorage.removeItem('orcaDeckToken'); } catch (e) {} showPair(); }
      callback(xhr.status >= 200 && xhr.status < 300 ? null : new Error(result.error || 'Không thực hiện được.'), result);
    };
    xhr.onerror = xhr.ontimeout = function () { callback(new Error('Không kết nối được Mac. Kiểm tra Wi‑Fi và cửa sổ Orca Deck.')); };
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
    $('approve').disabled = $('reject').disabled = busy || !r;
    for (var i = 0; i < ids.length; i++) $(ids[i]).disabled = busy || !a;
    $('choose').disabled = $('mainClaude').disabled = $('agentButton').disabled = busy;
    $('linksButton').disabled = busy || !a;
  }
  function render() {
    var a = agent(), r;
    if (selected && !a) { selected = null; message('Agent đã đổi phiên. Chọn lại.'); }
    $('agentTitle').textContent = a ? a.title : 'Chọn agent';
    $('project').textContent = a ? a.project + ' · ' + a.agent : '';
    var select = $('requestSelect');
    while (select.firstChild) select.removeChild(select.firstChild);
    var empty = document.createElement('option');
    empty.value = ''; empty.textContent = 'Chọn yêu cầu'; select.appendChild(empty);
    if (!requestChosen && state.requests.length === 1) { selectedRequest = state.requests[0].id; requestChosen = true; }
    if (selectedRequest && !request()) selectedRequest = '';
    for (var i = 0; i < state.requests.length; i++) {
      var q = state.requests[i], option = document.createElement('option');
      option.value = q.id; option.textContent = q.project + ' · ' + q.tool + ' · phiên ' + q.sessionId.slice(0, 8); select.appendChild(option);
    }
    select.value = selectedRequest;
    $('request').hidden = !state.requests.length;
    select.hidden = state.requests.length < 2;
    $('requestCount').textContent = state.requests.length;
    r = request();
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
      if (err) { connected(false); state = null; buttonStates(); message(err.message); return; }
      connected(true); state = result;
      if (state.orcaError) message(state.orcaError);
      render();
    });
  }
  function action(name, target, after) {
    if (busy || !target) return;
    busy = true; buttonStates(); message('Đang thực hiện…');
    api('action', { action: name, handle: target.handle, incarnationId: target.incarnationId }, function (err) {
      busy = false; message(err ? err.message : name === 'continue' ? 'Đã gửi Continue.' : name === 'pin' ? 'Đã ghim Claude chính.' : 'Xong.');
      if (!err && after) after();
      buttonStates(); poll();
    });
  }
  function decide(value) {
    var r = request(); if (!r || busy) return;
    busy = true; buttonStates();
    api('decision', { id: r.id, decision: value }, function (err) {
      busy = false; selectedRequest = ''; requestChosen = true;
      message(err ? err.message : value === 'allow' ? 'Đã duyệt một lần.' : 'Đã từ chối.');
      buttonStates(); poll();
    });
  }
  function chooseAgents() {
    if (!state) return;
    var list = $('agentList'); while (list.firstChild) list.removeChild(list.firstChild);
    if (!state.agents.length) { list.className = 'empty'; list.textContent = 'Chưa có Claude/Codex trong Orca.'; } else list.className = '';
    var cur = agent();
    state.agents.forEach(function (a) {
      var row = document.createElement('div'); row.className = 'agent-row';
      var choice = document.createElement('button'); choice.className = 'agent-choice' + (a === cur ? ' current' : '');
      var title = document.createElement('strong'); title.textContent = a.title;
      var sub = document.createElement('small'); sub.textContent = a.project + ' · ' + a.agent;
      choice.appendChild(title); choice.appendChild(sub);
      choice.onclick = function () { selected = a; $('agentModal').hidden = true; render(); action('focus', a); };
      row.appendChild(choice);
      if (a.agent.indexOf('claude') === 0) {
        var isMain = state.main && state.main.handle === a.handle && state.main.incarnationId === a.incarnationId;
        var pin = document.createElement('button'); pin.className = 'icon-button' + (isMain ? ' pinned' : '');
        pin.setAttribute('aria-label', 'Ghim làm Claude chính'); pin.setAttribute('aria-pressed', isMain ? 'true' : 'false');
        pin.innerHTML = '<svg class="icon"><use xlink:href="#i-pin"/></svg>';
        pin.onclick = function () { action('pin', a, function () { selected = a; $('agentModal').hidden = true; }); };
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
      $('pin').value = ''; showPair(); message('Đã kết nối. Ghim Claude chính.'); poll();
    });
  };
  $('requestSelect').onchange = function () { selectedRequest = this.value; requestChosen = true; render(); };
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
      if (!found) { message('Claude chính đã đổi phiên. Ghim lại.'); return chooseAgents(); }
      selected = found; render(); action('focus', found);
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
      busy = false; message(err ? err.message : 'Đã lưu.'); if (!err) $('linksModal').hidden = true; buttonStates(); poll();
    });
  };
  var closes = document.querySelectorAll('.close');
  for (var i = 0; i < closes.length; i++) closes[i].onclick = function () { $('agentModal').hidden = $('linksModal').hidden = true; };
  ['agentModal', 'linksModal'].forEach(function (id) { $(id).onclick = function (event) { if (event.target === this) this.hidden = true; }; });
  $('unpair').onclick = function () { token = ''; state = null; selected = null; try { localStorage.removeItem('orcaDeckToken'); } catch (e) {} showPair(); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  applyLayout(); showPair(); poll(); setInterval(poll, 2000);
}());
