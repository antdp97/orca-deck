(function () {
  'use strict';
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/pair-info');
  xhr.onload = function () {
    var box = document.getElementById('codes'), info;
    try { info = JSON.parse(xhr.responseText); } catch (e) { info = null; }
    if (xhr.status !== 200 || !info) { box.textContent = (info && info.error) || 'Could not load the pairing code.'; return; }
    document.getElementById('pairPin').textContent = info.pin;
    if (!info.links.length) box.textContent = 'No Wi‑Fi address found on this Mac.';
    info.links.forEach(function (link) {
      var card = document.createElement('figure');
      card.className = 'qr-card';
      if (link.qr) { var img = document.createElement('img'); img.src = link.qr; img.alt = 'QR code for ' + link.url.split('#')[0]; card.appendChild(img); }
      var caption = document.createElement('figcaption');
      caption.textContent = link.url.split('#')[0];
      card.appendChild(caption);
      box.appendChild(card);
    });
    // Tickets last info.expiresIn ms: reload a little before that so the code on screen always works.
    setTimeout(function () { location.reload(); }, Math.max(info.expiresIn - 20000, 10000));
  };
  xhr.send();
}());
