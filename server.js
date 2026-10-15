'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const ROOT = __dirname;
const RUNTIME = path.join(ROOT, '.local', 'runtime.json');
// Vietnamese versions of user-facing errors, used when the page sends X-Deck-Lang: vi.
const VI = {
  'Invalid link.': 'Liên kết không hợp lệ.',
  'Enter a full http:// or https:// link.': 'Nhập liên kết đầy đủ http:// hoặc https://.',
  'Only HTTP/HTTPS links are supported.': 'Chỉ hỗ trợ liên kết HTTP/HTTPS.',
  'Request too large.': 'Dữ liệu quá lớn.',
  'Invalid data.': 'Dữ liệu không hợp lệ.',
  'Timed out or disconnected. Check the Mac before trying again.': 'Thao tác hết thời gian hoặc mất kết nối. Kiểm tra Mac trước khi thử lại.',
  'Orca: no response.': 'Orca: Orca không phản hồi.',
  'Invalid host address.': 'Địa chỉ máy chủ không hợp lệ.',
  'Only the Orca Deck page can do this.': 'Chỉ thao tác từ trang Orca Deck.',
  'Too many attempts. Try the pairing code again in a minute.': 'Thử lại mã ghép nối sau một phút.',
  'Wrong pairing code.': 'Mã ghép nối chưa đúng.',
  'Open the pairing page on the Mac only.': 'Chỉ mở trang ghép nối trên Mac.',
  'Hook not authenticated.': 'Hook chưa được xác thực.',
  'Hook payload incomplete.': 'Hook thiếu thông tin.',
  'Pair this device first.': 'Cần ghép nối thiết bị.',
  'Not found.': 'Không có trang này.',
  'Invalid decision.': 'Quyết định không hợp lệ.',
  'This request was already handled or has expired.': 'Yêu cầu đã được xử lý hoặc hết hạn.',
  'This project is no longer in Orca.': 'Project không còn trong Orca.',
  'The agent session changed. Choose again.': 'Phiên agent đã thay đổi. Hãy chọn lại.',
  'Invalid button.': 'Nút không hợp lệ.',
  'Timed out or disconnected.': 'Thao tác đã hết thời gian hoặc mất kết nối.',
  'Main Claude must be a Claude session.': 'Claude chính phải là một phiên Claude.',
  'Set a link for this project first.': 'Hãy đặt liên kết cho project này trước.',
  'This project has a pending approval. Handle it first.': 'Project này đang có yêu cầu duyệt. Hãy xử lý yêu cầu trước.',
  'The agent is still running; wait before Continue.': 'Agent đang chạy; hãy chờ trước khi Continue.',
  'Cannot read the current screen. Use the Mac.': 'Không đọc được màn hình hiện tại. Hãy thao tác trên Mac.',
  'There is an approval prompt in the terminal. Handle it on the Mac.': 'Có hộp duyệt trong terminal. Hãy xử lý trên Mac.',
  'Unknown action.': 'Không có thao tác này.',
  'Send text or one key.': 'Gửi chữ hoặc một phím.',
  'Invalid snippet list.': 'Danh sách mẫu không hợp lệ.',
  'Invalid text.': 'Nội dung không hợp lệ.',
  'Invalid key.': 'Phím không hợp lệ.',
  'It may have been sent. Check the screen before sending again.': 'Có thể đã gửi. Xem màn hình trước khi gửi lại.',
  'Something went wrong. Please try again.': 'Có lỗi khi xử lý. Vui lòng thử lại.'
};

// Approval dialogs from Claude Code and Codex, plus any visible broader-than-once option.
const APPROVAL = /do you want to|would you like to|yes, proceed|allow once|permission required|approve this|don't ask again|for this session|always allow/i;
const DEFAULT_SNIPPETS = ['yes', 'continue', 'run the tests'];
const CONTROL = /[\u0000-\u001f\u007f]/;
// Terminal bytes for the deck's key row. Ctrl-C is handled separately with --interrupt.
const SEND_KEYS = { enter: '', esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', y: 'y', n: 'n' };
function failure(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function agentStatus(preview, lastOutputAt, now) {
  if (APPROVAL.test(preview || '')) return 'prompt';
  return now - (lastOutputAt || 0) <= 5000 ? 'working' : 'idle';
}
function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isLoopback(ip) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip); }
function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address);
}
function urlValue(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2000) throw failure(400, 'Invalid link.');
  let url;
  try { url = new URL(value); } catch { throw failure(400, 'Enter a full http:// or https:// link.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure(400, 'Only HTTP/HTTPS links are supported.');
  return url.href;
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw failure(413, 'Request too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw failure(400, 'Invalid data.'); }
}
async function runOrca(args, { signal } = {}) {
  const executable = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : path.join(os.homedir(), '.local', 'bin', 'orca'));
  try {
    const { stdout } = await execute(executable, [...args, '--json'], { timeout: 12000, maxBuffer: 2 * 1024 * 1024, signal });
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(result.error?.message || 'no response.');
    return result.result;
  } catch (err) {
    if (err.name === 'AbortError') throw failure(409, 'Timed out or disconnected. Check the Mac before trying again.', 'timeout');
    let message = err.message;
    try { message = JSON.parse(err.stdout).error.message; } catch {}
    throw failure(503, 'Orca: ' + message.slice(0, 300));
  }
}
// CoreImage's built-in QR generator through JXA: argv[0] is the text, prints a base64 PNG (1 px per module).
const QR_SCRIPT = `ObjC.import('CoreImage'); ObjC.import('AppKit');
function run(argv) {
  var f = $.CIFilter.filterWithName('CIQRCodeGenerator');
  f.setValueForKey($.NSString.alloc.initWithUTF8String(argv[0]).dataUsingEncoding($.NSUTF8StringEncoding), 'inputMessage');
  f.setValueForKey($('M'), 'inputCorrectionLevel');
  return $.NSBitmapImageRep.alloc.initWithCIImage(f.outputImage).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0).js;
}`;
async function macQr(text) {
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', QR_SCRIPT, text], { timeout: 5000 });
  return 'data:image/png;base64,' + stdout.trim();
}
function createDeck({ config, orca = runOrca, saveConfig = () => {}, requestTimeout = 180000, openUrl = url => execute('/usr/bin/open', [url]), qrPng = macQr, ticketTtl = 300000 }) {
  const requests = new Map();
  const tickets = new Map(); // one-time pairing tickets from the Mac's /pair page -> expiry time
  const attempts = new Map();
  let lastClientSeen = 0;
  let terminalCache = [], cacheAt = 0, cachePromise;
  async function terminals(fresh = false, signal) {
    if (!fresh && Date.now() - cacheAt < 3000) return terminalCache;
    if (!fresh && cachePromise) return cachePromise;
    const load = async () => {
      const result = await orca(['terminal', 'list'], { signal });
      terminalCache = (result.terminals || []).filter(t => t.connected && t.writable && !t.orphaned && /^(claude|codex)/.test(t.agentIdentity || '')).map(t => ({
        handle: t.handle, incarnationId: t.incarnationId, agent: t.agentIdentity,
        title: t.title || t.agentIdentity, workspace: t.worktreePath, worktreeId: t.worktreeId,
        project: path.basename(t.worktreePath || ''), lastOutputAt: t.lastOutputAt || 0, preview: t.preview || ''
      }));
      cacheAt = Date.now();
      return terminalCache;
    };
    if (fresh) return load();
    cachePromise = load().finally(() => { cachePromise = null; });
    return cachePromise;
  }
  function send(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  // One 13 s deadline per terminal action, cancelled if the browser disconnects.
  function guard(res) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 13000);
    res.once('close', () => { clearTimeout(deadline); controller.abort(); });
    return {
      options: { signal: controller.signal },
      check() { if (res.destroyed || controller.signal.aborted) throw failure(409, 'Timed out or disconnected.', 'timeout'); }
    };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      const hostname = new URL('http://' + host).hostname;
      if (!['localhost', '127.0.0.1', '[::1]', ...localAddresses()].includes(hostname)) throw failure(403, 'Invalid host address.');
      if (req.headers.origin && req.headers.origin !== 'http://' + host) throw failure(403, 'Only the Orca Deck page can do this.');
      const route = new URL(req.url, 'http://' + host).pathname;
      if ((route === '/pair' || route === '/api/pair-info') && !isLoopback(req.socket.remoteAddress)) throw failure(403, 'Open the pairing page on the Mac only.');
      if (route === '/api/pair-info' && req.method === 'GET') {
        for (const [key, expiry] of tickets) if (expiry < Date.now()) tickets.delete(key);
        if (tickets.size >= 20) tickets.delete(tickets.keys().next().value);
        const ticket = crypto.randomBytes(16).toString('hex');
        tickets.set(ticket, Date.now() + ticketTtl);
        const port = req.socket.localPort;
        const links = await Promise.all(localAddresses().map(async ip => {
          const url = 'http://' + ip + ':' + port + '/#t=' + ticket;
          let qr = null;
          try { qr = await qrPng(url); } catch {}
          return { url, qr };
        }));
        return send(res, 200, { pin: config.pin, links, expiresIn: ticketTtl });
      }
      if (req.method === 'GET' && ['/', '/pair', '/pair.js', '/app.js', '/style.css', '/alerts.js', '/agents.js', '/agent.js', '/icon-180.png', '/icon-167.png', '/icon-152.png', '/favicon.png'].includes(route)) {
        const filename = route === '/' ? 'index.html' : route === '/pair' ? 'pair.html' : route.slice(1);
        const type = filename.endsWith('.png') ? 'image/png' : (filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html') + '; charset=utf-8';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(ROOT, 'public', filename)));
      }
      if (route === '/api/pair' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const entry = attempts.get(ip) || { count: 0, start: Date.now() };
        if (Date.now() - entry.start > 60000) { entry.count = 0; entry.start = Date.now(); }
        if (entry.count >= 5) throw failure(429, 'Too many attempts. Try the pairing code again in a minute.');
        entry.count++;
        attempts.set(ip, entry);
        const body = await readJson(req);
        const ticket = typeof body?.ticket === 'string' && tickets.get(body.ticket);
        if (ticket) tickets.delete(body.ticket);
        if (!(ticket && ticket > Date.now()) && !equalSecret(body?.pin, config.pin)) throw failure(401, 'Wrong pairing code.');
        attempts.delete(ip);
        return send(res, 200, { token: config.token });
      }
      const credential = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (route === '/api/hook' && req.method === 'POST') {
        if (!isLoopback(req.socket.remoteAddress) || !equalSecret(credential, config.hookToken)) throw failure(401, 'Hook not authenticated.');
        const data = await readJson(req);
        if (!data || typeof data.session_id !== 'string' || typeof data.cwd !== 'string' || typeof data.tool_name !== 'string' || !data.tool_input || typeof data.tool_input !== 'object') throw failure(400, 'Hook payload incomplete.');
        if (Date.now() - lastClientSeen > 12000) return send(res, 200, {});
        if (requests.size >= 50) return send(res, 200, {});
        const id = crypto.randomUUID();
        const info = { id, sessionId: data.session_id, workspace: data.cwd, project: path.basename(data.cwd), tool: data.tool_name, input: data.tool_input, expiresAt: Date.now() + requestTimeout };
        const finish = decision => {
          if (!requests.has(id)) return;
          clearTimeout(timer);
          requests.delete(id);
          send(res, 200, decision ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision } } } : {});
        };
        const timer = setTimeout(() => finish(null), requestTimeout);
        requests.set(id, { info, finish });
        res.on('close', () => { clearTimeout(timer); requests.delete(id); });
        return;
      }
      if (!equalSecret(credential, config.token)) throw failure(401, 'Pair this device first.');
      if (route === '/api/state' && req.method === 'GET') {
        lastClientSeen = Date.now();
        let agents = [], orcaError = null;
        try {
          const now = Date.now();
          agents = (await terminals()).map(({ preview, ...a }) => ({ ...a, status: agentStatus(preview, a.lastOutputAt, now) }));
        } catch (err) { orcaError = err.message; }
        return send(res, 200, { agents, requests: [...requests.values()].map(r => r.info), links: config.links, main: config.main, snippets: config.snippets || DEFAULT_SNIPPETS, orcaError });
      }
      if (req.method !== 'POST') throw failure(404, 'Not found.');
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(400, 'Invalid data.');
      if (route === '/api/decision') {
        if (!['allow', 'deny'].includes(body.decision) || typeof body.id !== 'string') throw failure(400, 'Invalid decision.');
        const request = requests.get(body.id);
        if (!request || Date.now() >= request.info.expiresAt) { request?.finish(null); throw failure(409, 'This request was already handled or has expired.'); }
        request.finish(body.decision);
        return send(res, 200, { ok: true });
      }
      if (route === '/api/links') {
        const agent = (await terminals(true)).find(t => t.workspace === body.workspace);
        if (!agent) throw failure(409, 'This project is no longer in Orca.');
        config.links[body.workspace] = { pr: urlValue(body.pr), preview: urlValue(body.preview) };
        saveConfig();
        return send(res, 200, { ok: true });
      }
      if (route === '/api/snippets') {
        const list = body.list;
        if (!Array.isArray(list) || list.length > 20 || !list.every(s => typeof s === 'string' && s.length >= 1 && s.length <= 200 && !CONTROL.test(s))) throw failure(400, 'Invalid snippet list.');
        config.snippets = list;
        saveConfig();
        return send(res, 200, { ok: true, snippets: list });
      }
      if (route === '/api/details') {
        const agent = (await terminals()).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
        if (!agent) throw failure(409, 'The agent session changed. Choose again.', 'stale');
        const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen']);
        if (output.terminal?.source !== 'screen') throw failure(409, 'Cannot read the current screen. Use the Mac.', 'no_screen');
        // Orca's read doesn't say which session it read, so confirm the handle still belongs to the same one afterwards.
        if (!(await terminals(true)).some(t => t.handle === agent.handle && t.incarnationId === agent.incarnationId)) throw failure(409, 'The agent session changed. Choose again.', 'stale');
        const { preview, ...shown } = agent;
        return send(res, 200, { agent: shown, screen: output.terminal?.tail || [] });
      }
      if (route === '/api/send') {
        const hasText = typeof body.text === 'string', hasKey = typeof body.key === 'string';
        if (hasText === hasKey) throw failure(400, 'Send text or one key.');
        if (hasText && (!body.text || body.text.length > 2000 || CONTROL.test(body.text))) throw failure(400, 'Invalid text.');
        if (hasKey && body.key !== 'ctrl-c' && !Object.hasOwn(SEND_KEYS, body.key)) throw failure(400, 'Invalid key.');
        const { options, check } = guard(res);
        const agent = (await terminals(true, options.signal)).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
        if (!agent) throw failure(409, 'The agent session changed. Choose again.', 'stale');
        check();
        const args = ['terminal', 'send', '--terminal', agent.handle];
        if (body.key === 'ctrl-c') {
          // Interrupting never approves anything, so it skips the prompt checks like the Interrupt key.
          args.push('--interrupt');
        } else {
          if ([...requests.values()].some(r => r.info.workspace === agent.workspace)) throw failure(409, 'This project has a pending approval. Handle it first.', 'blocked');
          const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options);
          if (output.terminal?.source !== 'screen') throw failure(409, 'Cannot read the current screen. Use the Mac.', 'no_screen');
          if (APPROVAL.test((output.terminal.tail || []).join('\n'))) throw failure(409, 'There is an approval prompt in the terminal. Handle it on the Mac.', 'blocked');
          check();
          const payload = hasText ? body.text : SEND_KEYS[body.key];
          if (payload) args.push('--text', payload);
          if (body.key === 'enter' || (hasText && body.enter === true)) args.push('--enter');
        }
        // shortcut: the screen check and the send are separate Orca calls, so a prompt appearing in between can receive input; needs an atomic Orca guard to close.
        // Once Orca has the call, the input may already be written, so any failure here is "maybe sent", never a plain error.
        try { await orca(args, options); }
        catch { throw failure(409, 'It may have been sent. Check the screen before sending again.', 'delivery_unknown'); }
        let screen = null;
        try { screen = (await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options)).terminal?.tail || null; } catch {}
        return send(res, 200, { ok: true, screen });
      }
      if (route === '/api/action') {
        if (!['focus', 'continue', 'interrupt', 'pin', 'pr', 'preview'].includes(body.action)) throw failure(400, 'Invalid button.');
        const { options, check: checkConnection } = guard(res);
        const agent = (await terminals(true, options.signal)).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
        if (!agent) throw failure(409, 'The agent session changed. Choose again.', 'stale');
        checkConnection();
        if (body.action === 'pin') {
          if (!agent.agent.startsWith('claude')) throw failure(400, 'Main Claude must be a Claude session.');
          config.main = { handle: agent.handle, incarnationId: agent.incarnationId };
          saveConfig();
        } else if (['pr', 'preview'].includes(body.action)) {
          const link = config.links[agent.workspace]?.[body.action];
          if (!link) throw failure(409, 'Set a link for this project first.');
          await openUrl(urlValue(link));
        } else if (body.action === 'focus') {
          await orca(['terminal', 'switch', '--terminal', agent.handle], options);
        } else if (body.action === 'interrupt') {
          await orca(['terminal', 'send', '--terminal', agent.handle, '--interrupt'], options);
        } else {
          if ([...requests.values()].some(r => r.info.workspace === agent.workspace)) throw failure(409, 'This project has a pending approval. Handle it first.', 'blocked');
          const idle = await orca(['terminal', 'wait', '--terminal', agent.handle, '--for', 'tui-idle', '--timeout-ms', '500'], options);
          if (!idle.wait?.satisfied) throw failure(409, 'The agent is still running; wait before Continue.');
          checkConnection();
          const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options);
          if (output.terminal?.source !== 'screen') throw failure(409, 'Cannot read the current screen. Use the Mac.', 'no_screen');
          // shortcut: network/Codex approval dialogs remain on Mac until structured approval support is added.
          if (APPROVAL.test((output.terminal.tail || []).join('\n'))) throw failure(409, 'There is an approval prompt in the terminal. Handle it on the Mac.', 'blocked');
          checkConnection();
          await orca(['terminal', 'send', '--terminal', agent.handle, '--text', 'continue', '--enter'], options);
        }
        return send(res, 200, { ok: true });
      }
      throw failure(404, 'Unknown action.');
    } catch (err) {
      const error = err.status ? err.message : 'Something went wrong. Please try again.';
      send(res, err.status || 500, { error: req.headers['x-deck-lang'] === 'vi' ? VI[error] || error : error, code: err.status ? err.code : undefined });
    }
  });
  server.requestTimeout = 10000;
  server.on('close', () => { for (const r of requests.values()) r.finish(null); });
  return server;
}
function loadRuntime() {
  fs.mkdirSync(path.dirname(RUNTIME), { recursive: true, mode: 0o700 });
  if (fs.existsSync(RUNTIME)) return JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
  const config = { pin: String(crypto.randomInt(10000000, 100000000)), token: crypto.randomBytes(32).toString('hex'), hookToken: crypto.randomBytes(32).toString('hex'), port: 8766, links: {}, main: null };
  fs.writeFileSync(RUNTIME, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}
if (require.main === module) {
  const config = loadRuntime();
  const saveConfig = () => {
    const temp = RUNTIME + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temp, RUNTIME);
  };
  const server = createDeck({ config, saveConfig });
  server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? 'Port 8766 is already in use. Only run one copy of Orca Deck.' : err.message); process.exit(1); });
  server.listen(config.port, '0.0.0.0', () => {
    console.log('Orca Deck is running. Keep this window open.');
    console.log('On this Mac: http://127.0.0.1:' + config.port);
    for (const ip of localAddresses()) console.log('On iPad/phone: http://' + ip + ':' + config.port);
    console.log('Pairing code: ' + config.pin);
    console.log('Pair with a QR code: http://127.0.0.1:' + config.port + '/pair');
  });
  const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
module.exports = { createDeck, VI, agentStatus };
