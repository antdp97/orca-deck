(function () {
  'use strict';
  var QUIET_AFTER = 20000, COOLDOWN = 30000;
  // Pure: compares the last memory with a new /api/state snapshot.
  function diff(memory, next, now) {
    var out = { agents: {}, requests: {} }, alerts = [];
    next.agents.forEach(function (a) {
      var key = a.handle + '/' + a.incarnationId, old = memory && memory.agents[key];
      var cur = {
        status: a.status,
        workingSince: a.status !== 'working' ? 0 : old && old.status === 'working' ? old.workingSince : now,
        lastAlertAt: old ? old.lastAlertAt : 0
      };
      var type = '';
      if (old && a.status === 'prompt' && old.status !== 'prompt') type = 'needs';
      else if (old && old.status === 'working' && a.status === 'idle' && now - old.workingSince >= QUIET_AFTER) type = 'quiet';
      if (type && (!cur.lastAlertAt || now - cur.lastAlertAt >= COOLDOWN)) { alerts.push({ type: type, id: key }); cur.lastAlertAt = now; }
      out.agents[key] = cur;
    });
    next.requests.forEach(function (r) {
      out.requests[r.id] = true;
      if (memory && !memory.requests[r.id]) alerts.push({ type: 'needs', id: r.id });
    });
    return { memory: out, alerts: alerts };
  }
  function badge(state) {
    return state.requests.length + state.agents.filter(function (a) { return a.status === 'prompt'; }).length;
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { diff: diff, badge: badge }; return; }

  var D = window.Deck, $ = function (id) { return document.getElementById(id); };
  var memory = null, ctx = null, flashTimer = 0, sound = true;
  try { sound = localStorage.getItem('orcaDeckSound') !== 'off'; } catch (e) {}
  // iOS only plays Web Audio after a user gesture, so unlock on the first tap.
  function unlock() {
    if (ctx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ctx = new Ctx();
    var source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, 22050); source.connect(ctx.destination); source.start(0);
    if (ctx.resume) ctx.resume();
  }
  function tone(freq, start, length) {
    var o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + start;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    o.connect(g); g.connect(ctx.destination);
    o.start(at); o.stop(at + length + 0.05);
  }
  function chime(type) {
    if (!sound || !ctx) return;
    if (type === 'needs') { tone(880, 0, 0.15); tone(1175, 0.18, 0.25); } else tone(660, 0, 0.3);
  }
  function flash(type) {
    var body = document.body;
    body.classList.remove('flash-needs', 'flash-quiet');
    void body.offsetWidth; // restart the animation
    body.classList.add('flash-' + type);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { body.classList.remove('flash-' + type); }, 1000);
  }
  function bell() {
    var b = $('soundButton');
    b.setAttribute('aria-pressed', sound ? 'true' : 'false');
    b.getElementsByTagName('use')[0].setAttributeNS('http://www.w3.org/1999/xlink', 'href', sound ? '#i-bell' : '#i-bell-off');
  }
  D.onState(function (state, err) {
    // Hidden or offline: keep no memory, so the next visible snapshot is a fresh baseline (an in-flight poll can land while hidden).
    if (err || !state || document.hidden) { memory = null; if (err || !state) document.title = 'Orca Deck'; return; }
    var out = diff(memory, state, Date.now()), n = badge(state);
    memory = out.memory;
    document.title = n ? '(' + n + ') Orca Deck' : 'Orca Deck';
    if (!out.alerts.length) return;
    var type = out.alerts.some(function (a) { return a.type === 'needs'; }) ? 'needs' : 'quiet';
    flash(type); chime(type);
    if (type === 'needs' && navigator.vibrate) navigator.vibrate(200);
  });
  // Coming back after being hidden starts a fresh baseline instead of a burst of stale alerts.
  document.addEventListener('visibilitychange', function () { if (document.hidden) memory = null; });
  document.addEventListener('touchend', unlock);
  document.addEventListener('click', unlock);
  $('soundButton').onclick = function () {
    sound = !sound;
    try { localStorage.setItem('orcaDeckSound', sound ? 'on' : 'off'); } catch (e) {}
    bell(); if (sound) { unlock(); chime('quiet'); }
  };
  bell();
}());
