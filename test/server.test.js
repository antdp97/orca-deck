'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDeck } = require('../server');

async function fixture(t, extra = {}) {
  const config = { pin: '12345678', token: 'browser-secret', hookToken: 'hook-secret', links: {}, main: null };
  const terminal = { handle: 'term_live', incarnationId: 'inc_live', agentIdentity: 'claude', title: 'Claude', worktreePath: '/tmp/project', connected: true, writable: true };
  const calls = [];
  // Orca controls live agents, so replace only that external boundary.
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'terminal' && args[1] === 'list') return { terminals: [terminal] };
    if (args[1] === 'wait') return { wait: { satisfied: true } };
    if (args[1] === 'read') return { terminal: { source: 'screen', tail: ['Ready for your prompt'] } };
    return { accepted: true };
  };
  const server = createDeck({ config, orca, saveConfig: () => {}, requestTimeout: 70, ...extra });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (path, body, token = config.token, headers = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const hook = () => call('/api/hook', { session_id: 'session_a', cwd: '/tmp/project', tool_name: 'Bash', tool_input: { command: 'touch /tmp/example' } }, config.hookToken);
  async function pending() {
    for (let i = 0; i < 20; i++) {
      const state = await (await call('/api/state')).json();
      if (state.requests.length) return state.requests[0];
      await new Promise(r => setTimeout(r, 2));
    }
    assert.fail('No pending request');
  }
  return { config, calls, terminal, server, call, hook, pending, base };
}

test('protects terminal metadata and rejects cross-site actions even with token', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/state', undefined, 'wrong')).status, 401);
  assert.equal((await f.call('/api/action', { action: 'interrupt' }, f.config.token, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call('/api/hook', {}, f.config.token)).status, 401);
  assert.equal(f.calls.length, 0);
});

test('pairs only with correct PIN and limits repeated guessing', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/pair', { pin: 'wrong' }, '')).status, 401);
  assert.equal((await (await f.call('/api/pair', { pin: '12345678' }, '')).json()).token, 'browser-secret');
  for (let i = 0; i < 5; i++) await f.call('/api/pair', { pin: 'wrong' }, '');
  assert.equal((await f.call('/api/pair', { pin: 'wrong' }, '')).status, 429);
});

test('limits concurrent pairing guesses whose bodies arrive together', async t => {
  const f = await fixture(t);
  const pending = [];
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push(new Promise(resolve => {
      const req = http.request(f.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.write('{"pin":');
      pending.push(req);
    }));
  }
  await new Promise(r => setTimeout(r, 25));
  for (const req of pending) req.end('"wrong"}');
  const results = await Promise.all(statuses);
  assert.equal(results.filter(s => s === 401).length, 5);
  assert.equal(results.filter(s => s === 429).length, 1);
});

test('grants one exact request once and never creates an always-allow rule', async t => {
  const f = await fixture(t, { requestTimeout: 1000 });
  await f.call('/api/state');
  const response = f.hook();
  const request = await f.pending();
  assert.equal(request.sessionId, 'session_a');
  assert.equal(request.input.command, 'touch /tmp/example');
  assert.equal((await f.call('/api/decision', { id: request.id, decision: 'allow' })).status, 200);
  assert.deepEqual(await (await response).json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal((await f.call('/api/decision', { id: request.id, decision: 'allow' })).status, 409);
  assert.equal((await (await f.call('/api/state')).json()).requests.length, 0);
});

test('reject decision reaches only the selected session when requests overlap', async t => {
  const f = await fixture(t, { requestTimeout: 1000 });
  await f.call('/api/state');
  const first = f.hook();
  const a = await f.pending();
  const second = f.call('/api/hook', { session_id: 'session_b', cwd: '/tmp/other', tool_name: 'Write', tool_input: { file_path: '/tmp/a' } }, f.config.hookToken);
  for (let i = 0; i < 30; i++) {
    const state = await (await f.call('/api/state')).json();
    if (state.requests.length === 2) break;
    await new Promise(r => setTimeout(r, 2));
  }
  await f.call('/api/decision', { id: a.id, decision: 'deny' });
  assert.equal((await (await first).json()).hookSpecificOutput.decision.behavior, 'deny');
  const remaining = (await (await f.call('/api/state')).json()).requests;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].sessionId, 'session_b');
  await f.call('/api/decision', { id: remaining[0].id, decision: 'allow' });
  assert.equal((await (await second).json()).hookSpecificOutput.decision.behavior, 'allow');
});

test('expired requests fall back to Claude and cannot be approved later', async t => {
  const f = await fixture(t);
  await f.call('/api/state');
  const response = f.hook();
  const request = await f.pending();
  assert.deepEqual(await (await response).json(), {});
  assert.equal((await f.call('/api/decision', { id: request.id, decision: 'allow' })).status, 409);
});

test('unattended dashboard never holds or auto-approves Claude', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.hook()).json(), {});
});

test('disconnected hook requests disappear and cannot be approved afterwards', async t => {
  const f = await fixture(t, { requestTimeout: 1000 });
  await f.call('/api/state');
  const controller = new AbortController();
  const response = fetch(f.base + '/api/hook', { method: 'POST', signal: controller.signal,
    headers: { Authorization: 'Bearer ' + f.config.hookToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'disconnected', cwd: '/tmp/project', tool_name: 'Bash', tool_input: { command: 'echo test' } })
  }).catch(() => null);
  const request = await f.pending();
  controller.abort();
  await response;
  let requests;
  for (let i = 0; i < 30; i++) {
    requests = (await (await f.call('/api/state')).json()).requests;
    if (!requests.length) break;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.equal(requests.length, 0);
  assert.equal((await f.call('/api/decision', { id: request.id, decision: 'allow' })).status, 409);
});

test('refuses stale terminal incarnation before sending an interrupt', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/action', { action: 'interrupt', handle: 'term_live', incarnationId: 'inc_old' })).status, 409);
  assert.equal(f.calls.some(a => a[1] === 'send'), false);
  assert.equal((await f.call('/api/action', { action: 'interrupt', handle: 'term_live', incarnationId: 'inc_live' })).status, 200);
  assert.deepEqual(f.calls.at(-1).slice(0, 5), ['terminal', 'send', '--terminal', 'term_live', '--interrupt']);
});

test('blocks continue while a permission request is pending', async t => {
  const f = await fixture(t, { requestTimeout: 1000 });
  await f.call('/api/state');
  const response = f.hook();
  const request = await f.pending();
  assert.equal((await f.call('/api/action', { action: 'continue', handle: 'term_live', incarnationId: 'inc_live' })).status, 409);
  assert.equal(f.calls.some(a => a[1] === 'send'), false);
  await f.call('/api/decision', { id: request.id, decision: 'deny' });
  await response;
});

test('Continue uses the current screen, not an old permission prompt in scrollback', async t => {
  const calls = [];
  const f = await fixture(t, { orca: async args => {
    calls.push(args);
    if (args[1] === 'list') return { terminals: [{ handle: 'term_live', incarnationId: 'inc_live', agentIdentity: 'claude', title: 'Claude', worktreePath: '/tmp/project', connected: true, writable: true }] };
    if (args[1] === 'wait') return { wait: { satisfied: true } };
    if (args[1] === 'read') return args.includes('--screen') ? { terminal: { source: 'screen', tail: ['Ready'] } } : { terminal: { source: 'stream', tail: ['Do you want to allow this?', 'Ready'] } };
    return { accepted: true };
  } });
  const response = await f.call('/api/action', { action: 'continue', handle: 'term_live', incarnationId: 'inc_live' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1), ['terminal', 'send', '--terminal', 'term_live', '--text', 'continue', '--enter']);
});

test('Continue refuses when the current screen cannot be rendered', async t => {
  const f = await fixture(t, { orca: async args => {
    if (args[1] === 'list') return { terminals: [{ handle: 'term_live', incarnationId: 'inc_live', agentIdentity: 'claude', title: 'Claude', worktreePath: '/tmp/project', connected: true, writable: true }] };
    if (args[1] === 'wait') return { wait: { satisfied: true } };
    if (args[1] === 'read') return { terminal: { source: 'screen-unavailable', tail: ['Ready'] } };
    assert.fail('Must not send to a terminal without its current screen');
  } });
  assert.equal((await f.call('/api/action', { action: 'continue', handle: 'term_live', incarnationId: 'inc_live' })).status, 409);
});

test('Continue is canceled if the browser disconnects during terminal checks', async t => {
  let releaseRead, enteredRead, sent = false;
  const reading = new Promise(resolve => { enteredRead = resolve; });
  const hold = new Promise(resolve => { releaseRead = resolve; });
  const f = await fixture(t, { orca: async args => {
    if (args[1] === 'list') return { terminals: [{ handle: 'term_live', incarnationId: 'inc_live', agentIdentity: 'claude', title: 'Claude', worktreePath: '/tmp/project', connected: true, writable: true }] };
    if (args[1] === 'wait') return { wait: { satisfied: true } };
    if (args[1] === 'read') { enteredRead(); await hold; return { terminal: { source: 'screen', tail: ['Ready'] } }; }
    if (args[1] === 'send') sent = true;
    return { accepted: true };
  } });
  const controller = new AbortController();
  const response = fetch(f.base + '/api/action', { method: 'POST', signal: controller.signal,
    headers: { Authorization: 'Bearer ' + f.config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'continue', handle: 'term_live', incarnationId: 'inc_live' })
  }).catch(() => null);
  await reading;
  controller.abort();
  await response;
  await new Promise(r => setTimeout(r, 15));
  releaseRead();
  await new Promise(r => setTimeout(r, 15));
  assert.equal(sent, false);
});

test('rejects file URLs and invalid decision payloads', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/links', { workspace: '/tmp/project', pr: 'file:///etc/passwd', preview: '' })).status, 400);
  assert.equal((await f.call('/api/decision', { id: 'x', decision: 'always' })).status, 400);
});

test('details reads the current screen of the exact session only', async t => {
  const f = await fixture(t);
  const ok = await (await f.call('/api/details', { handle: 'term_live', incarnationId: 'inc_live' })).json();
  assert.deepEqual(ok.screen, ['Ready for your prompt']);
  assert.equal(ok.agent.project, 'project');
  assert.deepEqual(f.calls.at(-1), ['terminal', 'read', '--terminal', 'term_live', '--screen']);
  assert.equal((await f.call('/api/details', { handle: 'term_live', incarnationId: 'old' })).status, 409);
  assert.equal((await f.call('/api/details', { handle: 'term_live', incarnationId: 'inc_live' }, 'wrong')).status, 401);
});

test('every server error has an English version, sent when the page asks for it', async t => {
  const source = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  const { EN } = require('../server');
  for (const [, text] of source.matchAll(/failure\(\d+, '([^']+)'[,)]/g)) assert.ok(EN[text], 'missing English for: ' + text);
  const f = await fixture(t);
  assert.equal((await (await f.call('/api/state', undefined, 'wrong', { 'X-Deck-Lang': 'en' })).json()).error, 'Pair this device first.');
  assert.equal((await (await f.call('/api/state', undefined, 'wrong')).json()).error, 'Cần ghép nối thiết bị.');
});

test('agentStatus recognises Claude and Codex approval wording and output age', () => {
  const { agentStatus } = require('../server');
  for (const text of ['Do you want to proceed?', 'Would you like to run the following command?', 'Would you like to grant these permissions?', "2. Yes, and don't ask again", 'Yes, for this session', 'Always allow']) {
    assert.equal(agentStatus(text, 0, 1e9), 'prompt', text);
  }
  assert.equal(agentStatus('Ready', 1e9 - 5000, 1e9), 'working');
  assert.equal(agentStatus('Ready', 1e9 - 5001, 1e9), 'idle');
  assert.equal(agentStatus('', 0, 1e9), 'idle');
});

test('state reports each agent status from its own terminal and hides the preview', async t => {
  const now = Date.now();
  const base = { agentIdentity: 'claude', worktreePath: '/tmp/project', connected: true, writable: true };
  const list = [
    { ...base, handle: 'a', incarnationId: '1', title: 'A', lastOutputAt: now - 60000, preview: 'Would you like to grant these permissions?' },
    { ...base, handle: 'b', incarnationId: '1', title: 'B', lastOutputAt: now - 1000, preview: 'compiling' },
    { ...base, handle: 'c', incarnationId: '1', title: 'C', lastOutputAt: now - 60000, preview: 'done' }
  ];
  const f = await fixture(t, { orca: async args => args[1] === 'list' ? { terminals: list } : { accepted: true } });
  const state = await (await f.call('/api/state')).json();
  assert.deepEqual(state.agents.map(a => a.status), ['prompt', 'working', 'idle']);
  assert.equal(state.agents[1].lastOutputAt, now - 1000);
  assert.equal('preview' in state.agents[0], false);
});

test('a pending Claude request does not mark terminals as waiting', async t => {
  const f = await fixture(t, { requestTimeout: 1000 });
  await f.call('/api/state');
  const response = f.hook();
  const request = await f.pending();
  const state = await (await f.call('/api/state')).json();
  assert.equal(state.agents[0].status, 'idle');
  assert.equal(state.requests.length, 1);
  await f.call('/api/decision', { id: request.id, decision: 'deny' });
  await response;
});

test('refusals carry a stable code', async t => {
  const f = await fixture(t, { requestTimeout: 1000 });
  const stale = await f.call('/api/action', { action: 'interrupt', handle: 'term_live', incarnationId: 'old' });
  assert.equal((await stale.json()).code, 'stale');
  await f.call('/api/state');
  const response = f.hook();
  const request = await f.pending();
  const blocked = await f.call('/api/action', { action: 'continue', handle: 'term_live', incarnationId: 'inc_live' });
  assert.equal((await blocked.json()).code, 'blocked');
  await f.call('/api/decision', { id: request.id, decision: 'deny' });
  await response;
  const plain = await f.call('/api/decision', { id: 'x', decision: 'always' });
  assert.equal('code' in (await plain.json()), false);
});
