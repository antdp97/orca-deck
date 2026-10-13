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
// English versions of user-facing errors, used when the page sends X-Deck-Lang: en.
const EN = {
  'Liên kết không hợp lệ.': 'Invalid link.',
  'Nhập liên kết đầy đủ http:// hoặc https://.': 'Enter a full http:// or https:// link.',
  'Chỉ hỗ trợ liên kết HTTP/HTTPS.': 'Only HTTP/HTTPS links are supported.',
  'Dữ liệu quá lớn.': 'Request too large.',
  'Dữ liệu không hợp lệ.': 'Invalid data.',
  'Thao tác hết thời gian hoặc mất kết nối. Kiểm tra Mac trước khi thử lại.': 'Timed out or disconnected. Check the Mac before trying again.',
  'Orca: Orca không phản hồi.': 'Orca: no response.',
  'Địa chỉ máy chủ không hợp lệ.': 'Invalid host address.',
  'Chỉ thao tác từ trang Orca Deck.': 'Only the Orca Deck page can do this.',
  'Thử lại mã ghép nối sau một phút.': 'Too many attempts. Try the pairing code again in a minute.',
  'Mã ghép nối chưa đúng.': 'Wrong pairing code.',
  'Hook chưa được xác thực.': 'Hook not authenticated.',
  'Hook thiếu thông tin.': 'Hook payload incomplete.',
  'Cần ghép nối thiết bị.': 'Pair this device first.',
  'Không có trang này.': 'Not found.',
  'Quyết định không hợp lệ.': 'Invalid decision.',
  'Yêu cầu đã được xử lý hoặc hết hạn.': 'This request was already handled or has expired.',
  'Project không còn trong Orca.': 'This project is no longer in Orca.',
  'Phiên agent đã thay đổi. Hãy chọn lại.': 'The agent session changed. Choose again.',
  'Nút không hợp lệ.': 'Invalid button.',
  'Thao tác đã hết thời gian hoặc mất kết nối.': 'Timed out or disconnected.',
  'Claude chính phải là một phiên Claude.': 'Main Claude must be a Claude session.',
  'Hãy đặt liên kết cho project này trước.': 'Set a link for this project first.',
  'Project này đang có yêu cầu duyệt. Hãy xử lý yêu cầu trước.': 'This project has a pending approval. Handle it first.',
  'Agent đang chạy; hãy chờ trước khi Continue.': 'The agent is still running; wait before Continue.',
  'Không đọc được màn hình hiện tại. Hãy thao tác trên Mac.': "Can't read the current screen. Use the Mac.",
  'Có hộp duyệt trong terminal. Hãy xử lý trên Mac.': 'There is an approval prompt in the terminal. Handle it on the Mac.',
  'Không có thao tác này.': 'Unknown action.',
  'Gửi chữ hoặc một phím.': 'Send text or one key.',
  'Nội dung không hợp lệ.': 'Invalid text.',
  'Phím không hợp lệ.': 'Invalid key.',
  'Có thể đã gửi. Xem màn hình trước khi gửi lại.': 'It may have been sent. Check the screen before sending again.',
  'Có lỗi khi xử lý. Vui lòng thử lại.': 'Something went wrong. Please try again.'
};

// Approval dialogs from Claude Code and Codex, plus any visible broader-than-once option.
const APPROVAL = /do you want to|would you like to|yes, proceed|allow once|permission required|approve this|don't ask again|for this session|always allow/i;
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
  if (typeof value !== 'string' || value.length > 2000) throw failure(400, 'Liên kết không hợp lệ.');
  let url;
  try { url = new URL(value); } catch { throw failure(400, 'Nhập liên kết đầy đủ http:// hoặc https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure(400, 'Chỉ hỗ trợ liên kết HTTP/HTTPS.');
  return url.href;
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw failure(413, 'Dữ liệu quá lớn.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw failure(400, 'Dữ liệu không hợp lệ.'); }
}
async function runOrca(args, { signal } = {}) {
  const executable = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : path.join(os.homedir(), '.local', 'bin', 'orca'));
  try {
    const { stdout } = await execute(executable, [...args, '--json'], { timeout: 12000, maxBuffer: 2 * 1024 * 1024, signal });
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(result.error?.message || 'Orca không phản hồi.');
    return result.result;
  } catch (err) {
    if (err.name === 'AbortError') throw failure(409, 'Thao tác hết thời gian hoặc mất kết nối. Kiểm tra Mac trước khi thử lại.', 'timeout');
    let message = err.message;
    try { message = JSON.parse(err.stdout).error.message; } catch {}
    throw failure(503, 'Orca: ' + message.slice(0, 300));
  }
}
function createDeck({ config, orca = runOrca, saveConfig = () => {}, requestTimeout = 180000, openUrl = url => execute('/usr/bin/open', [url]) }) {
  const requests = new Map();
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
      check() { if (res.destroyed || controller.signal.aborted) throw failure(409, 'Thao tác đã hết thời gian hoặc mất kết nối.', 'timeout'); }
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
      if (!['localhost', '127.0.0.1', '[::1]', ...localAddresses()].includes(hostname)) throw failure(403, 'Địa chỉ máy chủ không hợp lệ.');
      if (req.headers.origin && req.headers.origin !== 'http://' + host) throw failure(403, 'Chỉ thao tác từ trang Orca Deck.');
      const route = new URL(req.url, 'http://' + host).pathname;
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(route)) {
        const filename = route === '/' ? 'index.html' : route.slice(1);
        const type = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(ROOT, 'public', filename)));
      }
      if (route === '/api/pair' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const entry = attempts.get(ip) || { count: 0, start: Date.now() };
        if (Date.now() - entry.start > 60000) { entry.count = 0; entry.start = Date.now(); }
        if (entry.count >= 5) throw failure(429, 'Thử lại mã ghép nối sau một phút.');
        entry.count++;
        attempts.set(ip, entry);
        const body = await readJson(req);
        if (!equalSecret(body?.pin, config.pin)) throw failure(401, 'Mã ghép nối chưa đúng.');
        attempts.delete(ip);
        return send(res, 200, { token: config.token });
      }
      const credential = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (route === '/api/hook' && req.method === 'POST') {
        if (!isLoopback(req.socket.remoteAddress) || !equalSecret(credential, config.hookToken)) throw failure(401, 'Hook chưa được xác thực.');
        const data = await readJson(req);
        if (!data || typeof data.session_id !== 'string' || typeof data.cwd !== 'string' || typeof data.tool_name !== 'string' || !data.tool_input || typeof data.tool_input !== 'object') throw failure(400, 'Hook thiếu thông tin.');
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
      if (!equalSecret(credential, config.token)) throw failure(401, 'Cần ghép nối thiết bị.');
      if (route === '/api/state' && req.method === 'GET') {
        lastClientSeen = Date.now();
        let agents = [], orcaError = null;
        try {
          const now = Date.now();
          agents = (await terminals()).map(({ preview, ...a }) => ({ ...a, status: agentStatus(preview, a.lastOutputAt, now) }));
        } catch (err) { orcaError = err.message; }
        return send(res, 200, { agents, requests: [...requests.values()].map(r => r.info), links: config.links, main: config.main, orcaError });
      }
      if (req.method !== 'POST') throw failure(404, 'Không có trang này.');
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(400, 'Dữ liệu không hợp lệ.');
      if (route === '/api/decision') {
        if (!['allow', 'deny'].includes(body.decision) || typeof body.id !== 'string') throw failure(400, 'Quyết định không hợp lệ.');
        const request = requests.get(body.id);
        if (!request || Date.now() >= request.info.expiresAt) { request?.finish(null); throw failure(409, 'Yêu cầu đã được xử lý hoặc hết hạn.'); }
        request.finish(body.decision);
        return send(res, 200, { ok: true });
      }
      if (route === '/api/links') {
        const agent = (await terminals(true)).find(t => t.workspace === body.workspace);
        if (!agent) throw failure(409, 'Project không còn trong Orca.');
        config.links[body.workspace] = { pr: urlValue(body.pr), preview: urlValue(body.preview) };
        saveConfig();
        return send(res, 200, { ok: true });
      }
      if (route === '/api/details') {
        const agent = (await terminals()).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
        if (!agent) throw failure(409, 'Phiên agent đã thay đổi. Hãy chọn lại.', 'stale');
        const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen']);
        const { preview, ...shown } = agent;
        return send(res, 200, { agent: shown, screen: output.terminal?.tail || [] });
      }
      if (route === '/api/send') {
        const hasText = typeof body.text === 'string', hasKey = typeof body.key === 'string';
        if (hasText === hasKey) throw failure(400, 'Gửi chữ hoặc một phím.');
        if (hasText && (!body.text || body.text.length > 2000 || CONTROL.test(body.text))) throw failure(400, 'Nội dung không hợp lệ.');
        if (hasKey && body.key !== 'ctrl-c' && !Object.hasOwn(SEND_KEYS, body.key)) throw failure(400, 'Phím không hợp lệ.');
        const { options, check } = guard(res);
        const agent = (await terminals(true, options.signal)).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
        if (!agent) throw failure(409, 'Phiên agent đã thay đổi. Hãy chọn lại.', 'stale');
        check();
        const args = ['terminal', 'send', '--terminal', agent.handle];
        if (body.key === 'ctrl-c') {
          // Interrupting never approves anything, so it skips the prompt checks like the Interrupt key.
          args.push('--interrupt');
        } else {
          if ([...requests.values()].some(r => r.info.workspace === agent.workspace)) throw failure(409, 'Project này đang có yêu cầu duyệt. Hãy xử lý yêu cầu trước.', 'blocked');
          const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options);
          if (output.terminal?.source !== 'screen') throw failure(409, 'Không đọc được màn hình hiện tại. Hãy thao tác trên Mac.', 'no_screen');
          if (APPROVAL.test((output.terminal.tail || []).join('\n'))) throw failure(409, 'Có hộp duyệt trong terminal. Hãy xử lý trên Mac.', 'blocked');
          check();
          const payload = hasText ? body.text : SEND_KEYS[body.key];
          if (payload) args.push('--text', payload);
          if (body.key === 'enter' || (hasText && body.enter === true)) args.push('--enter');
        }
        // shortcut: the screen check and the send are separate Orca calls, so a prompt appearing in between can receive input; needs an atomic Orca guard to close.
        // Once Orca has the call, the input may already be written, so any failure here is "maybe sent", never a plain error.
        try { await orca(args, options); }
        catch { throw failure(409, 'Có thể đã gửi. Xem màn hình trước khi gửi lại.', 'delivery_unknown'); }
        let screen = null;
        try { screen = (await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options)).terminal?.tail || null; } catch {}
        return send(res, 200, { ok: true, screen });
      }
      if (route === '/api/action') {
        if (!['focus', 'continue', 'interrupt', 'pin', 'pr', 'preview'].includes(body.action)) throw failure(400, 'Nút không hợp lệ.');
        const { options, check: checkConnection } = guard(res);
        const agent = (await terminals(true, options.signal)).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
        if (!agent) throw failure(409, 'Phiên agent đã thay đổi. Hãy chọn lại.', 'stale');
        checkConnection();
        if (body.action === 'pin') {
          if (!agent.agent.startsWith('claude')) throw failure(400, 'Claude chính phải là một phiên Claude.');
          config.main = { handle: agent.handle, incarnationId: agent.incarnationId };
          saveConfig();
        } else if (['pr', 'preview'].includes(body.action)) {
          const link = config.links[agent.workspace]?.[body.action];
          if (!link) throw failure(409, 'Hãy đặt liên kết cho project này trước.');
          await openUrl(urlValue(link));
        } else if (body.action === 'focus') {
          await orca(['terminal', 'switch', '--terminal', agent.handle], options);
        } else if (body.action === 'interrupt') {
          await orca(['terminal', 'send', '--terminal', agent.handle, '--interrupt'], options);
        } else {
          if ([...requests.values()].some(r => r.info.workspace === agent.workspace)) throw failure(409, 'Project này đang có yêu cầu duyệt. Hãy xử lý yêu cầu trước.', 'blocked');
          const idle = await orca(['terminal', 'wait', '--terminal', agent.handle, '--for', 'tui-idle', '--timeout-ms', '500'], options);
          if (!idle.wait?.satisfied) throw failure(409, 'Agent đang chạy; hãy chờ trước khi Continue.');
          checkConnection();
          const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options);
          if (output.terminal?.source !== 'screen') throw failure(409, 'Không đọc được màn hình hiện tại. Hãy thao tác trên Mac.', 'no_screen');
          // shortcut: network/Codex approval dialogs remain on Mac until structured approval support is added.
          if (APPROVAL.test((output.terminal.tail || []).join('\n'))) throw failure(409, 'Có hộp duyệt trong terminal. Hãy xử lý trên Mac.', 'blocked');
          checkConnection();
          await orca(['terminal', 'send', '--terminal', agent.handle, '--text', 'continue', '--enter'], options);
        }
        return send(res, 200, { ok: true });
      }
      throw failure(404, 'Không có thao tác này.');
    } catch (err) {
      const error = err.status ? err.message : 'Có lỗi khi xử lý. Vui lòng thử lại.';
      send(res, err.status || 500, { error: req.headers['x-deck-lang'] === 'en' ? EN[error] || error : error, code: err.status ? err.code : undefined });
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
  server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? 'Cổng 8766 đang được dùng. Không mở thêm một bản Orca Deck.' : err.message); process.exit(1); });
  server.listen(config.port, '0.0.0.0', () => {
    console.log('Orca Deck đang chạy — để cửa sổ này mở.');
    console.log('Trên Mac: http://127.0.0.1:' + config.port);
    for (const ip of localAddresses()) console.log('Trên iPad: http://' + ip + ':' + config.port);
    console.log('Mã ghép nối: ' + config.pin);
  });
  const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
module.exports = { createDeck, EN, agentStatus };
