(function () {
  'use strict';
  var D = window.Deck, $ = function (id) { return document.getElementById(id); };
  var ORDER = { prompt: 0, working: 1, idle: 2 }, drawn = '';
  function ago(ms) {
    var s = Math.round((Date.now() - ms) / 1000);
    return s < 60 ? D.t('now') : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h';
  }
  function row(cls, badge, title, sub, side, onclick) {
    var b = document.createElement('button'), text = document.createElement('span'), strong = document.createElement('strong'), small = document.createElement('small');
    b.type = 'button'; b.className = 'row' + (cls ? ' ' + cls : ''); text.className = 'row-text';
    strong.textContent = title; small.textContent = sub;
    text.appendChild(strong); text.appendChild(small);
    b.appendChild(badge); b.appendChild(text);
    if (side) { var s = document.createElement('span'); s.className = 'row-side'; s.textContent = side; b.appendChild(s); }
    b.onclick = onclick;
    return b;
  }
  function render(state) {
    var list = $('agentsList');
    var agents = state ? state.agents.slice().sort(function (a, b) { return ORDER[a.status] - ORDER[b.status] || b.lastOutputAt - a.lastOutputAt; }) : [];
    var requests = state ? state.requests : [];
    // Rebuild only when something visible changed, so a row isn't replaced under a finger mid-tap.
    var sig = JSON.stringify([requests.map(function (r) { return r.id; }), agents.map(function (a) { return [a.handle, a.incarnationId, a.title, a.status, a.lastOutputAt ? ago(a.lastOutputAt) : '']; }), D.t('now')]);
    if (sig === drawn) return;
    drawn = sig;
    while (list.firstChild) list.removeChild(list.firstChild);
    requests.forEach(function (r) {
      list.appendChild(row('request-row', D.statusBadge('prompt'), r.tool, r.project + ' · ' + r.sessionId.slice(0, 8), '', function () { D.pickRequest(r.id); }));
    });
    agents.forEach(function (a) {
      list.appendChild(row('', D.statusBadge(a.status), a.title, a.project + ' · ' + a.agent, a.lastOutputAt ? ago(a.lastOutputAt) : '', function () { D.select(a); D.show('agent'); }));
    });
    if (state && !agents.length) { var p = document.createElement('p'); p.className = 'empty'; p.textContent = D.t('noAgents'); list.appendChild(p); }
  }
  D.onState(function (state) { if (D.view() === 'agents') render(state); });
}());
