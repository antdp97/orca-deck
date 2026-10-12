(function () {
  'use strict';
  var token = '', state = null, selected = null, selectedRequest = '', requestChosen = false, busy = false, polling = false;
  var $ = function (id) { return document.getElementById(id); };
  try { token = localStorage.getItem('orcaDeckToken') || ''; } catch (e) {}
  function message(text) { $('message').textContent = text || ''; }
  function connected(on) { $('dot').className = on ? 'on' : ''; $('connection').textContent = on ? 'Đã kết nối Mac' : 'Mất kết nối'; }
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
  function showPair() { $('pair').hidden = !!token; $('deck').hidden = !token; if (!token) connected(false); }
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
    $('approve').disabled = $('reject').disabled = busy || !r;
    for (var i = 0; i < ids.length; i++) $(ids[i]).disabled = busy || !a;
    $('choose').disabled = $('mainClaude').disabled = busy;
    $('linksButton').disabled = busy || !a;
  }
  function render() {
    var a = agent(), r;
    if (selected && !a) { selected = null; message('Phiên agent đã thay đổi. Hãy chọn lại.'); }
    $('agentTitle').textContent = a ? a.title : 'Chọn agent để bắt đầu';
    $('project').textContent = a ? a.project + ' · ' + a.agent : 'Dùng “Chọn agent”, rồi ghim phiên orchestrator.';
    var select = $('requestSelect');
    while (select.firstChild) select.removeChild(select.firstChild);
    var empty = document.createElement('option');
    empty.value = ''; empty.textContent = state.requests.length ? 'Chọn một yêu cầu để duyệt' : 'Không có yêu cầu đang chờ'; select.appendChild(empty);
    if (!requestChosen && state.requests.length === 1) { selectedRequest = state.requests[0].id; requestChosen = true; }
    if (selectedRequest && !request()) selectedRequest = '';
    for (var i = 0; i < state.requests.length; i++) {
      var q = state.requests[i], option = document.createElement('option');
      option.value = q.id; option.textContent = q.project + ' · ' + q.tool + ' · phiên ' + q.sessionId.slice(0, 8); select.appendChild(option);
    }
    select.value = selectedRequest;
    $('requestCount').textContent = state.requests.length + ' đang chờ';
    r = request();
    $('requestMeta').textContent = r ? 'Claude · ' + r.workspace + ' · phiên ' + r.sessionId.slice(0, 8) : 'Approve / Reject áp dụng đúng yêu cầu hiển thị ở đây.';
    $('requestInput').textContent = r ? JSON.stringify(r.input, null, 2) : 'Khi Claude cần quyền, yêu cầu sẽ xuất hiện tại đây.';
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
      busy = false; message(err ? err.message : name === 'continue' ? 'Đã gửi Continue; kiểm tra phản hồi trên Mac.' : 'Đã thực hiện trên Mac.');
      if (!err && after) after();
      buttonStates(); poll();
    });
  }
  function decide(value) {
    var r = request(); if (!r || busy) return;
    busy = true; buttonStates();
    api('decision', { id: r.id, decision: value }, function (err) {
      busy = false; selectedRequest = ''; requestChosen = true;
      message(err ? err.message : value === 'allow' ? 'Đã duyệt một lần cho đúng yêu cầu.' : 'Đã từ chối yêu cầu.');
      buttonStates(); poll();
    });
  }
  function chooseAgents() {
    if (!state) return;
    var list = $('agentList'); while (list.firstChild) list.removeChild(list.firstChild);
    if (!state.agents.length) list.textContent = 'Chưa tìm thấy Claude/Codex đang chạy trong Orca.';
    state.agents.forEach(function (a) {
      var row = document.createElement('div'); row.className = 'agent-row';
      var choice = document.createElement('button'); choice.className = 'agent-choice';
      var title = document.createElement('strong'); title.textContent = a.title;
      var sub = document.createElement('small'); sub.textContent = a.project + ' · ' + a.agent;
      choice.appendChild(title); choice.appendChild(sub);
      choice.onclick = function () { selected = a; $('agentModal').hidden = true; render(); action('focus', a); };
      row.appendChild(choice);
      if (a.agent.indexOf('claude') === 0) {
        var pin = document.createElement('button'); pin.className = 'pin-button'; pin.textContent = 'Claude chính';
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
      $('pin').value = ''; showPair(); message('Đã ghép nối. Chọn phiên Claude chính của bạn.'); poll();
    });
  };
  $('requestSelect').onchange = function () { selectedRequest = this.value; requestChosen = true; render(); };
  $('approve').onclick = function () { decide('allow'); };
  $('reject').onclick = function () { decide('deny'); };
  $('continue').onclick = function () { action('continue', agent()); };
  $('interrupt').onclick = function () { action('interrupt', agent()); };
  $('choose').onclick = chooseAgents;
  $('mainClaude').onclick = function () {
    if (!state || !state.main) return chooseAgents();
    var found = null;
    state.agents.forEach(function (a) { if (a.handle === state.main.handle && a.incarnationId === state.main.incarnationId) found = a; });
    if (!found) { message('Claude chính đã đổi phiên. Hãy ghim lại.'); return chooseAgents(); }
    selected = found; render(); action('focus', found);
  };
  ['pr', 'preview'].forEach(function (name) { $(name).onclick = function () { var a = agent(); if (!a) return; if (!(state.links[a.workspace] || {})[name]) return editLinks(); action(name, a); }; });
  $('linksButton').onclick = editLinks;
  $('linksForm').onsubmit = function (event) {
    event.preventDefault(); var a = agent(); if (!a || busy) return;
    busy = true; buttonStates();
    api('links', { workspace: a.workspace, pr: $('prUrl').value.trim(), preview: $('previewUrl').value.trim() }, function (err) {
      busy = false; message(err ? err.message : 'Đã lưu liên kết cho ' + a.project + '.'); if (!err) $('linksModal').hidden = true; buttonStates(); poll();
    });
  };
  var closes = document.querySelectorAll('.close');
  for (var i = 0; i < closes.length; i++) closes[i].onclick = function () { $('agentModal').hidden = $('linksModal').hidden = true; };
  $('unpair').onclick = function () { token = ''; state = null; selected = null; try { localStorage.removeItem('orcaDeckToken'); } catch (e) {} showPair(); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  showPair(); poll(); setInterval(poll, 2000);
}());
