# Mobile Control (Agents overview, Reply, Alerts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any phone or tablet on the home Wi‑Fi see every Orca agent's status, read and reply to one agent, and get alerted while the deck is open.

**Architecture:** `server.js` gains agent status in `/api/state`, a guarded `POST /api/send`, `POST /api/snippets`, and stable error codes. The browser app becomes three views (Agents, Agent, Deck) switched by tabs. `app.js` stays the shell and exposes `window.Deck`; three new ES5 files (`alerts.js`, `agents.js`, `agent.js`) plug into it through `Deck.onState`.

**Tech Stack:** Node 18+ (`node:http`, `node:test`), no dependencies. Browser: ES5 + XMLHttpRequest, inline SVG sprite, plain CSS. Target iOS 12 Safari and current phone browsers.

**Spec:** `docs/superpowers/specs/2026-10-13-mobile-control-design.md`

## Global Constraints

- `public/*.js` is ES5 only: `var`, `function`, no arrow functions, template strings, `let`/`const`, `class`, spread, `String.prototype.includes`, `Object.assign`, `Array.from`, or object shorthand. iOS 12 Safari must run it.
- No flex `gap` (iOS 12 lacks it); space with margins.
- CSP stays `default-src 'self'; script-src 'self'; style-src 'self'`: no inline `<script>`, no `style=""` attributes, no `on*=""` attributes in HTML. Setting `el.style`/`el.onclick` from JS is fine.
- No new dependencies. No build step.
- Every new `failure()` message is Vietnamese, single-quoted, contains no `'`, and has an entry in `EN`.
- Inputs and textareas use `font-size:16px` or larger (stops iOS zoom). Touch targets at least 44×44 px.
- Approve stays one-time. Nothing sent by the deck may reach a screen that matches `APPROVAL` (except Ctrl‑C).
- Every terminal action matches `handle` **and** `incarnationId`.
- Every user-visible string goes through `t()` with both `vi` and `en` entries.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01GnLWahVSdUFHm44EyF1deC
  ```
- Run `npm test` before every commit; all tests must pass.

## Review Focus

1. Vietnamese, accented or emoji replies ("Sửa lỗi này nhé 👍") must reach the terminal byte-for-byte unchanged → Task 3 test `send passes Unicode text through unchanged`.
2. Multi-line paste into the reply box must never send a newline (which would submit half a message) → the reply field is `<input type="text">` (browsers strip newlines), and Task 3 test `send rejects bad input before touching Orca` pins the server rejecting `\n`.
3. The snippet editor with blank lines, padded lines, or more than 20 lines must not save junk or fail silently → Task 9 trims and drops blank lines; Task 4 test `snippets reject invalid lists and keep the old one` pins the 21-item refusal; Task 9 step checks the toast.
4. Agents view with pending Claude requests but zero terminals must still list the requests → Task 8 manual step with the mock's terminal list emptied.
5. A request decided on another device while it's showing here must not leave the card blank, and a double tap must not approve the next request unseen → Task 5 manual step with two browser tabs.

---

### Task 1: Probe how Orca delivers special keys

Throwaway check against real Orca. Nothing is committed. Its result decides the key allowlist used in Task 3 and the buttons in Task 9.

**Files:** none.

- [ ] **Step 1: Create a scratch terminal running `cat -v`**

`cat -v` prints control bytes visibly (`^[` for Esc, `^I` for Tab).

```bash
~/.local/bin/orca terminal create --worktree active --title deck-probe --command "cat -v" --json
```

Note the terminal `handle` in the JSON output. Below it is `$H`.

- [ ] **Step 2: Send each key, then Enter, and read the screen**

```bash
O=~/.local/bin/orca
$O terminal send --terminal "$H" --text $'\x1b' --json
$O terminal send --terminal "$H" --text $'\x1b[A' --json
$O terminal send --terminal "$H" --text $'\t' --json
$O terminal send --terminal "$H" --text 'y' --json
$O terminal send --terminal "$H" --enter --json
$O terminal read --terminal "$H" --screen --json
```

Expected: a line containing `^[^[[A^Iy` (echoed input and/or `cat -v` output). Also confirm the `--enter` call without `--text` succeeded (`"ok": true`) and the line was submitted.

- [ ] **Step 3: Close the scratch terminal**

```bash
$O terminal close --terminal "$H" --json
```

- [ ] **Step 4: Record the result**

- All bytes arrived: keep the full allowlist in Task 3 and Task 9 as written.
- Escape bytes were dropped or mangled: in Task 3 remove `esc`, `tab`, `up`, `down`, `left`, `right` from `SEND_KEYS` and from the key-mapping test; in Task 9 remove those buttons. Note the change in the final summary to the user.
- `--enter` without `--text` failed: in Task 3 map `enter` to `--text '' --enter` (change `const args = payload ? ... : ...` to always push `'--text', payload`) and update the expected args in the key-mapping test.

---

### Task 2: Shared approval check, agent status and error codes

**Files:**
- Modify: `server.js` (`failure` at line 45, `terminals()` at 93–109, `/api/state` at 165–170, `/api/details` at 188–193, `/api/action` at 194–231, error handler at 233–236, exports at 268)
- Test: `test/server.test.js`

**Interfaces:**
- Produces:
  - `APPROVAL` regex constant (module scope in `server.js`).
  - `agentStatus(preview: string, lastOutputAt: number, now: number) → 'prompt' | 'working' | 'idle'`, exported.
  - `failure(status, message, code?)`; error JSON is now `{ error, code? }`.
  - `/api/state` agents now carry `lastOutputAt: number` and `status`; they never carry `preview`.
  - Codes: `stale`, `blocked`, `no_screen`, `timeout`.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js`:

```js
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
```

Also change the regex in the existing test `every server error has an English version…` so it still finds messages that now have a third argument:

```js
  for (const [, text] of source.matchAll(/failure\(\d+, '([^']+)'/g)) assert.ok(EN[text], 'missing English for: ' + text);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `agentStatus is not a function`, statuses `undefined`, `code` missing.

- [ ] **Step 3: Implement**

In `server.js`, replace line 45 (`function failure…`) with:

```js
// Approval dialogs from Claude Code and Codex, plus any visible broader-than-once option.
const APPROVAL = /do you want to|would you like to|yes, proceed|allow once|permission required|approve this|don't ask again|for this session|always allow/i;
function failure(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function agentStatus(preview, lastOutputAt, now) {
  if (APPROVAL.test(preview || '')) return 'prompt';
  return now - (lastOutputAt || 0) <= 5000 ? 'working' : 'idle';
}
```

In `terminals()`, extend the mapped object:

```js
        handle: t.handle, incarnationId: t.incarnationId, agent: t.agentIdentity,
        title: t.title || t.agentIdentity, workspace: t.worktreePath, worktreeId: t.worktreeId,
        project: path.basename(t.worktreePath || ''), lastOutputAt: t.lastOutputAt || 0, preview: t.preview || ''
```

In `/api/state`, replace `try { agents = await terminals(); } catch (err) { orcaError = err.message; }` with:

```js
        try {
          const now = Date.now();
          agents = (await terminals()).map(({ preview, ...a }) => ({ ...a, status: agentStatus(preview, a.lastOutputAt, now) }));
        } catch (err) { orcaError = err.message; }
```

In `/api/details`, strip the preview from the returned agent and add the code:

```js
        if (!agent) throw failure(409, 'Phiên agent đã thay đổi. Hãy chọn lại.', 'stale');
        const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen']);
        const { preview, ...shown } = agent;
        return send(res, 200, { agent: shown, screen: output.terminal?.tail || [] });
```

In `/api/action`, add codes:
- `checkConnection`: `throw failure(409, 'Thao tác đã hết thời gian hoặc mất kết nối.', 'timeout');`
- missing agent: `throw failure(409, 'Phiên agent đã thay đổi. Hãy chọn lại.', 'stale');`
- pending request: `throw failure(409, 'Project này đang có yêu cầu duyệt. Hãy xử lý yêu cầu trước.', 'blocked');`
- screen source: `throw failure(409, 'Không đọc được màn hình hiện tại. Hãy thao tác trên Mac.', 'no_screen');`
- replace the inline regex line with:
  ```js
          if (APPROVAL.test((output.terminal.tail || []).join('\n'))) throw failure(409, 'Có hộp duyệt trong terminal. Hãy xử lý trên Mac.', 'blocked');
  ```

In `runOrca`, the abort branch: `throw failure(409, 'Thao tác hết thời gian hoặc mất kết nối. Kiểm tra Mac trước khi thử lại.', 'timeout');`

In the error handler, send the code only for deliberate failures:

```js
      send(res, err.status || 500, { error: req.headers['x-deck-lang'] === 'en' ? EN[error] || error : error, code: err.status ? err.code : undefined });
```

Exports: `module.exports = { createDeck, EN, agentStatus };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests (old and new).

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: agent status, shared approval check and error codes"
```

---

### Task 3: `POST /api/send`

**Files:**
- Modify: `server.js` (new constants near `APPROVAL`; new `guard(res)` helper inside `createDeck`; `/api/action` uses `guard`; new `/api/send` route before `/api/action`; `EN` entries)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `APPROVAL`, `failure(status, message, code)`, `terminals(fresh, signal)`, `requests` (Task 2).
- Produces: `POST /api/send { handle, incarnationId, text?: string, enter?: boolean, key?: 'enter'|'esc'|'tab'|'up'|'down'|'left'|'right'|'y'|'n'|'ctrl-c' }` → `200 { ok: true, screen: string[] | null }` or an error with code `stale | blocked | no_screen | timeout | delivery_unknown` (409) or 400 (bad input).

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js`:

```js
async function sendFixture(t, opts = {}) {
  const calls = [];
  let reads = 0;
  const f = await fixture(t, { requestTimeout: 1000, orca: async args => {
    calls.push(args);
    if (args[1] === 'list') return { terminals: [{ handle: 'term_live', incarnationId: 'inc_live', agentIdentity: 'claude', title: 'Claude', worktreePath: '/tmp/project', connected: true, writable: true }] };
    if (args[1] === 'read') {
      reads++;
      if (reads > 1 && opts.failAfterSend) throw new Error('read failed');
      return { terminal: { source: opts.source || 'screen', tail: opts.tail || ['Ready'] } };
    }
    if (args[1] === 'send' && opts.sendError) throw opts.sendError;
    return { accepted: true };
  } });
  const sendTo = body => f.call('/api/send', { handle: 'term_live', incarnationId: 'inc_live', ...body });
  return { ...f, calls, sendTo, sends: () => calls.filter(a => a[1] === 'send') };
}

test('send types text with Enter into the exact session and returns the new screen', async t => {
  const f = await sendFixture(t);
  const res = await f.sendTo({ text: 'run the tests', enter: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, screen: ['Ready'] });
  assert.deepEqual(f.sends(), [['terminal', 'send', '--terminal', 'term_live', '--text', 'run the tests', '--enter']]);
});

test('send passes Unicode text through unchanged', async t => {
  const f = await sendFixture(t);
  assert.equal((await f.sendTo({ text: 'Sửa lỗi này nhé 👍' })).status, 200);
  assert.deepEqual(f.sends()[0].slice(4), ['--text', 'Sửa lỗi này nhé 👍']);
});

test('send maps allowlisted keys to terminal input', async t => {
  const f = await sendFixture(t);
  const expected = {
    esc: ['--text', '\x1b'], tab: ['--text', '\t'], up: ['--text', '\x1b[A'], down: ['--text', '\x1b[B'],
    right: ['--text', '\x1b[C'], left: ['--text', '\x1b[D'], y: ['--text', 'y'], n: ['--text', 'n'],
    enter: ['--enter'], 'ctrl-c': ['--interrupt']
  };
  for (const [key, args] of Object.entries(expected)) {
    assert.equal((await f.sendTo({ key })).status, 200, key);
    assert.deepEqual(f.sends().at(-1).slice(4), args, key);
  }
});

test('send rejects bad input before touching Orca', async t => {
  const f = await sendFixture(t);
  const bad = [{}, { text: 'a', key: 'esc' }, { text: '' }, { text: 'x'.repeat(2001) }, { text: 'a\nb' }, { text: '\x1b[A' }, { text: 5 }, { key: 'f1' }, { key: 'constructor' }, { key: '__proto__' }];
  for (const body of bad) assert.equal((await f.sendTo(body)).status, 400, JSON.stringify(body));
  assert.equal(f.calls.length, 0);
});

test('send refuses an approval prompt on screen, with no override', async t => {
  const f = await sendFixture(t, { tail: ['Would you like to grant these permissions?', '› 1. Yes, grant for this session', '  2. No'] });
  for (const body of [{ text: 'yes', enter: true }, { key: 'enter' }, { key: 'down' }, { key: 'enter', confirm: true }]) {
    const res = await f.sendTo(body);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'blocked');
  }
  assert.equal(f.sends().length, 0);
});

test('send refuses without a rendered screen', async t => {
  const f = await sendFixture(t, { source: 'screen-unavailable' });
  const res = await f.sendTo({ text: 'hi' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'no_screen');
  assert.equal(f.sends().length, 0);
});

test('send refuses while a Claude request is pending for the workspace', async t => {
  const f = await sendFixture(t);
  await f.call('/api/state');
  const response = f.hook();
  const request = await f.pending();
  const res = await f.sendTo({ text: 'hi' });
  assert.equal((await res.json()).code, 'blocked');
  assert.equal(f.sends().length, 0);
  await f.call('/api/decision', { id: request.id, decision: 'deny' });
  await response;
});

test('Ctrl-C still works with an approval prompt, a pending request and no screen', async t => {
  const f = await sendFixture(t, { source: 'screen-unavailable', tail: ['Do you want to proceed?'] });
  await f.call('/api/state');
  const response = f.hook();
  const request = await f.pending();
  assert.equal((await f.sendTo({ key: 'ctrl-c' })).status, 200);
  assert.deepEqual(f.sends(), [['terminal', 'send', '--terminal', 'term_live', '--interrupt']]);
  await f.call('/api/decision', { id: request.id, decision: 'deny' });
  await response;
});

test('send reports delivery_unknown when the Orca send call fails', async t => {
  const f = await sendFixture(t, { sendError: Object.assign(new Error('Orca: timeout'), { status: 503 }) });
  const res = await f.sendTo({ text: 'hi', enter: true });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'delivery_unknown');
});

test('send counts delivered input as success when the follow-up read fails', async t => {
  const f = await sendFixture(t, { failAfterSend: true });
  assert.deepEqual(await (await f.sendTo({ text: 'hi' })).json(), { ok: true, screen: null });
});

test('send refuses a stale incarnation', async t => {
  const f = await sendFixture(t);
  const res = await f.sendTo({ incarnationId: 'old', text: 'hi' });
  assert.equal((await res.json()).code, 'stale');
  assert.equal(f.sends().length, 0);
});

test('send is cancelled if the browser disconnects before the send step', async t => {
  let releaseRead, enteredRead, sent = false;
  const reading = new Promise(resolve => { enteredRead = resolve; });
  const hold = new Promise(resolve => { releaseRead = resolve; });
  const f = await fixture(t, { orca: async args => {
    if (args[1] === 'list') return { terminals: [{ handle: 'term_live', incarnationId: 'inc_live', agentIdentity: 'claude', title: 'Claude', worktreePath: '/tmp/project', connected: true, writable: true }] };
    if (args[1] === 'read') { enteredRead(); await hold; return { terminal: { source: 'screen', tail: ['Ready'] } }; }
    if (args[1] === 'send') sent = true;
    return { accepted: true };
  } });
  const controller = new AbortController();
  const response = fetch(f.base + '/api/send', { method: 'POST', signal: controller.signal,
    headers: { Authorization: 'Bearer ' + f.config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: 'term_live', incarnationId: 'inc_live', text: 'hi' })
  }).catch(() => null);
  await reading;
  controller.abort();
  await response;
  await new Promise(r => setTimeout(r, 15));
  releaseRead();
  await new Promise(r => setTimeout(r, 15));
  assert.equal(sent, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the new `send …` tests FAIL with 404 (`Không có thao tác này.`).

- [ ] **Step 3: Implement**

Add next to `APPROVAL` in `server.js`:

```js
const CONTROL = /[\u0000-\u001f\u007f]/;
// Terminal bytes for the deck's key row. Ctrl-C is handled separately with --interrupt.
const SEND_KEYS = { enter: '', esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', y: 'y', n: 'n' };
```

Add these `EN` entries:

```js
  'Gửi chữ hoặc một phím.': 'Send text or one key.',
  'Nội dung không hợp lệ.': 'Invalid text.',
  'Phím không hợp lệ.': 'Invalid key.',
  'Có thể đã gửi. Xem màn hình trước khi gửi lại.': 'It may have been sent. Check the screen before sending again.',
```

Inside `createDeck`, after `send()`, add the shared deadline helper:

```js
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
```

In `/api/action`, replace the `controller` / `deadline` / `res.once` / `checkConnection` / `options` lines with:

```js
        const { options, check: checkConnection } = guard(res);
        const agent = (await terminals(true, options.signal)).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
```

Add before `if (route === '/api/action')`:

```js
      if (route === '/api/send') {
        const hasText = typeof body.text === 'string', hasKey = typeof body.key === 'string';
        if (hasText === hasKey) throw failure(400, 'Gửi chữ hoặc một phím.');
        if (hasText && (!body.text || body.text.length > 2000 || CONTROL.test(body.text))) throw failure(400, 'Nội dung không hợp lệ.');
        if (hasKey && body.key !== 'ctrl-c' && !Object.hasOwn(SEND_KEYS, body.key)) throw failure(400, 'Phím không hợp lệ.');
        const { options, check } = guard(res);
        const agent = (await terminals(true, options.signal)).find(t => t.handle === body.handle && t.incarnationId === body.incarnationId);
        if (!agent) throw failure(409, 'Phiên agent đã thay đổi. Hãy chọn lại.', 'stale');
        check();
        const target = ['terminal', 'send', '--terminal', agent.handle];
        if (body.key === 'ctrl-c') {
          // Interrupting never approves anything, so it skips the prompt checks like the Interrupt key.
          await orca([...target, '--interrupt'], options);
        } else {
          if ([...requests.values()].some(r => r.info.workspace === agent.workspace)) throw failure(409, 'Project này đang có yêu cầu duyệt. Hãy xử lý yêu cầu trước.', 'blocked');
          const output = await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options);
          if (output.terminal?.source !== 'screen') throw failure(409, 'Không đọc được màn hình hiện tại. Hãy thao tác trên Mac.', 'no_screen');
          if (APPROVAL.test((output.terminal.tail || []).join('\n'))) throw failure(409, 'Có hộp duyệt trong terminal. Hãy xử lý trên Mac.', 'blocked');
          check();
          const payload = hasText ? body.text : SEND_KEYS[body.key];
          const args = payload ? [...target, '--text', payload] : [...target];
          if (body.key === 'enter' || (hasText && body.enter === true)) args.push('--enter');
          // shortcut: the screen check and the send are separate Orca calls, so a prompt appearing in between can receive input; needs an atomic Orca guard to close.
          try { await orca(args, options); }
          catch { throw failure(409, 'Có thể đã gửi. Xem màn hình trước khi gửi lại.', 'delivery_unknown'); }
        }
        let screen = null;
        try { screen = (await orca(['terminal', 'read', '--terminal', agent.handle, '--screen'], options)).terminal?.tail || null; } catch {}
        return send(res, 200, { ok: true, screen });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests including the existing Continue and Interrupt tests (they now go through `guard`).

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: guarded /api/send for text and keys"
```

---

### Task 4: Snippets

**Files:**
- Modify: `server.js` (`DEFAULT_SNIPPETS` constant, `/api/state` response, new `/api/snippets` route, `EN` entry)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `CONTROL` (Task 3), `saveConfig()`.
- Produces: `/api/state` includes `snippets: string[]`. `POST /api/snippets { list: string[] }` → `200 { ok: true, snippets }` or 400.

- [ ] **Step 1: Write the failing tests**

```js
test('snippets default, save for every device and persist', async t => {
  let saves = 0;
  const f = await fixture(t, { saveConfig: () => { saves++; } });
  assert.deepEqual((await (await f.call('/api/state')).json()).snippets, ['yes', 'continue', 'run the tests']);
  assert.equal((await f.call('/api/snippets', { list: ['ship it', 'Sửa lỗi'] })).status, 200);
  assert.deepEqual((await (await f.call('/api/state')).json()).snippets, ['ship it', 'Sửa lỗi']);
  assert.deepEqual(f.config.snippets, ['ship it', 'Sửa lỗi']);
  assert.equal(saves, 1);
});

test('snippets reject invalid lists and keep the old one', async t => {
  const f = await fixture(t);
  const bad = [undefined, 'yes', Array(21).fill('x'), [''], ['x'.repeat(201)], ['a\nb'], [5]];
  for (const list of bad) assert.equal((await f.call('/api/snippets', { list })).status, 400, JSON.stringify(list));
  assert.equal(f.config.snippets, undefined);
  assert.equal((await f.call('/api/snippets', { list: [] })).status, 200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `snippets` undefined, `/api/snippets` 404.

- [ ] **Step 3: Implement**

Near the other constants:

```js
const DEFAULT_SNIPPETS = ['yes', 'continue', 'run the tests'];
```

`EN` entry:

```js
  'Danh sách mẫu không hợp lệ.': 'Invalid snippet list.',
```

`/api/state` response: add `snippets: config.snippets || DEFAULT_SNIPPETS` to the object.

New route, next to `/api/links`:

```js
      if (route === '/api/snippets') {
        const list = body.list;
        if (!Array.isArray(list) || list.length > 20 || !list.every(s => typeof s === 'string' && s.length >= 1 && s.length <= 200 && !CONTROL.test(s))) throw failure(400, 'Danh sách mẫu không hợp lệ.');
        config.snippets = list;
        saveConfig();
        return send(res, 200, { ok: true, snippets: list });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: shared reply snippets"
```

---

### Task 5: Client core — error codes, `window.Deck`, request-selection fix, remove details modal

**Files:**
- Modify: `public/app.js`, `public/index.html`, `public/style.css`

**Interfaces:**
- Consumes: error JSON `{ error, code }` (Task 2).
- Produces (used by Tasks 6–9):
  ```js
  window.Deck = {
    api: function (route, data, callback) {},   // callback(err, result); err.status (0 if offline), err.code ('' | server code | 'offline')
    t: function (key) {},
    message: function (text) {},
    decide: function (value) {},                 // 'allow' | 'deny'
    action: function (name, agent, after) {},    // existing /api/action wrapper
    poll: function () {},
    getState: function () {},                    // live state or null
    getSelected: function () {},                 // live selected agent or null
    select: function (agent) {},                 // sets selection, re-renders, notifies
    pickRequest: function (id) {},
    onState: function (fn) {}                    // fn(state, err) after every poll and every notify()
  };
  ```
  Card buttons `#cardApprove`, `#cardReject` inside `#cardActions` in `#request`.

- [ ] **Step 1: Error codes in `api()`**

In `public/app.js`, add above `function api`:

```js
  function fail(text, status, code) { var e = new Error(text); e.status = status; e.code = code; return e; }
```

Replace the body of `xhr.onload` and `xhr.onerror`:

```js
    xhr.onload = function () {
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (e) { return callback(fail(t('badResponse'), xhr.status, '')); }
      if (xhr.status === 401 && route !== 'pair') { token = ''; try { localStorage.removeItem('orcaDeckToken'); } catch (e) {} showPair(); }
      callback(xhr.status >= 200 && xhr.status < 300 ? null : fail(result.error || t('failed'), xhr.status, result.code || ''), result);
    };
    xhr.onerror = xhr.ontimeout = function () { callback(fail(t('offline'), 0, 'offline')); };
```

- [ ] **Step 2: Remove the details modal**

`public/index.html`:
- delete the `#detailsButton` line in `header#bar`;
- delete the whole `#detailsModal` line.

`public/app.js`:
- line 3: remove `detailsLoading = false` and `requestChosen = false` from the `var` list; add `shownRequest = '', shownAt = 0`;
- `TEXT.vi` and `TEXT.en`: remove the `details` and `waiting` keys;
- `buttonStates()`: delete `$('detailsButton').disabled = !a;`;
- `poll()`: delete the line `if (!$('detailsModal').hidden) …`;
- delete `loadDetails()` and `showDetails()`;
- delete `$('detailsButton').onclick = showDetails;`;
- in the `.close` loop and the backdrop loop, use `['agentModal', 'linksModal']` only:
  ```js
  var MODALS = ['agentModal', 'linksModal'];
  var closes = document.querySelectorAll('.close');
  for (var i = 0; i < closes.length; i++) closes[i].onclick = function () { MODALS.forEach(function (id) { $(id).hidden = true; }); };
  MODALS.forEach(function (id) { $(id).onclick = function (event) { if (event.target === this) this.hidden = true; }; });
  ```

`public/style.css`: delete the `.meta{…}` and `.tall{…}` rules (only the details modal used them). Keep `.screen`.

- [ ] **Step 3: Request selection fix and 1 s guard**

`public/app.js`, in `render()`, replace

```js
    if (!requestChosen && state.requests.length === 1) { selectedRequest = state.requests[0].id; requestChosen = true; }
    if (selectedRequest && !request()) selectedRequest = '';
```

with

```js
    if (selectedRequest && !request()) selectedRequest = '';
    // A lone request is always shown, including after a decision, expiry, or a decision on another device.
    if (state.requests.length === 1 && !request()) selectedRequest = state.requests[0].id;
```

and after `r = request();` add:

```js
    if ((r ? r.id : '') !== shownRequest) { shownRequest = r ? r.id : ''; shownAt = Date.now(); setTimeout(buttonStates, 1000); }
```

In `decide()`: change the first line to

```js
    var r = request(); if (!r || busy || Date.now() - shownAt < 1000) return;
```

and replace `busy = false; selectedRequest = ''; requestChosen = true;` with `busy = false; selectedRequest = '';`.

`$('requestSelect').onchange`: `function () { selectedRequest = this.value; render(); };`

In `buttonStates()`, replace the approve/reject line with:

```js
    var settling = Date.now() - shownAt < 1000;
    $('approve').disabled = $('reject').disabled = $('cardApprove').disabled = $('cardReject').disabled = busy || !r || settling;
```

- [ ] **Step 4: Card buttons**

`public/index.html`, inside `section#request` after `<pre id="requestInput"></pre>`:

```html
      <div id="cardActions" class="card-actions"><button id="cardApprove" class="approve" aria-label="Approve once" disabled>Approve</button><button id="cardReject" class="reject" disabled>Reject</button></div>
```

`public/app.js`, next to the other handlers:

```js
  $('cardApprove').onclick = function () { decide('allow'); };
  $('cardReject').onclick = function () { decide('deny'); };
```

`public/style.css`:

```css
.card-actions{display:flex;margin-top:10px}
.card-actions button{flex:1;min-height:56px;font-size:18px;font-weight:600}
.card-actions button+button{margin-left:10px}
```

- [ ] **Step 5: `window.Deck` and state listeners**

`public/app.js`, after `function decide`:

```js
  var listeners = [];
  function notify(err) { for (var i = 0; i < listeners.length; i++) listeners[i](state, err || null); }
  window.Deck = {
    api: api, t: t, message: message, decide: decide, action: action, poll: poll,
    getState: function () { return state; },
    getSelected: agent,
    select: function (a) { selected = a; render(); notify(); },
    pickRequest: function (id) { selectedRequest = id; render(); },
    onState: function (fn) { listeners.push(fn); }
  };
```

In `poll()`'s callback, call `notify(err)` right after `message(err.message);` (before `return`) and `notify();` after `render();`.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS (server tests unaffected).

- [ ] **Step 7: Manual check — request selection across two devices (Review Focus 5)**

Start the mock from Task 10 Step 1 (it can be created now). Open `http://127.0.0.1:8799` in two browser tabs, pair both with `12345678`. Send two hook requests (Task 10 Step 1 `curl` twice, in the background with `&`). In tab A choose request 1 and tap Approve. Expected in **both** tabs within 2 s: the card shows request 2 with its tool and input, Approve/Reject are disabled for about 1 s and then enabled. Double-tapping Approve quickly in tab A approves at most one request.

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/index.html public/style.css
git commit -m "feat: Deck API, error codes, card approve buttons; fix stuck request selection"
```

---

### Task 6: View shell — tabs and three views

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: `notify()`, `applyLayout()`, `editing` (Task 5 / existing).
- Produces: `Deck.show(name)`, `Deck.view()` returning `'agents' | 'agent' | 'deck'`. Containers `#agentsView` (with `#agentsList`) and `#agentView` (filled in Tasks 8 and 9). localStorage key `orcaDeckView`.

- [ ] **Step 1: Markup**

`public/index.html` sprite, add:

```html
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></symbol>
```

Inside `#deck`, between `section#request` and `section#keys`:

```html
    <section id="agentsView" class="view" hidden><div id="agentsList" class="list"></div></section>
    <section id="agentView" class="view" hidden></section>
```

After `section#keys`, still inside `#deck`:

```html
    <nav id="tabs" class="tabs" role="tablist">
      <button class="tab" role="tab" data-view="agents"><svg class="icon"><use xlink:href="#i-list"/></svg><span data-t="tabAgents">Tất cả</span></button>
      <button class="tab" role="tab" data-view="agent"><svg class="icon"><use xlink:href="#i-terminal"/></svg><span>Agent</span></button>
      <button class="tab" role="tab" data-view="deck"><svg class="icon"><use xlink:href="#i-grid"/></svg><span>Deck</span></button>
    </nav>
```

- [ ] **Step 2: Strings**

`TEXT.vi`: `tabAgents: 'Tất cả'`. `TEXT.en`: `tabAgents: 'Agents'`.

- [ ] **Step 3: View switching**

`public/app.js`, after the layout setup:

```js
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
```

`applyLayout()`: add `$('tabs').hidden = editing;` after the `$('bar').hidden…` line.

`window.Deck`: add `show: showView, view: function () { return view; }`.

Wire the tabs (next to other handlers):

```js
  var tabButtons = document.querySelectorAll('.tab');
  for (i = 0; i < tabButtons.length; i++) tabButtons[i].onclick = function () { showView(this.getAttribute('data-view')); };
```

(`i` is already declared by the `closes` loop above; keep this after it.)

Start-up line becomes:

```js
  applyLang(); applyLayout(); showPair(); showView(view); poll(); setInterval(poll, 2000);
```

`showView` must be defined before `applyLayout()` runs `$('tabs')`, which it is because both are hoisted function declarations and `#tabs` exists in HTML.

- [ ] **Step 4: CSS**

```css
/* Views and tabs */
.view{flex:1;min-height:0;display:flex;flex-direction:column}
.list{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch}
.tabs{display:flex;flex-shrink:0;margin-top:12px}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px;font-size:13px;min-height:56px}
.tab+.tab{margin-left:8px}
.tab .icon{margin-bottom:2px}
.tab.active{background:#b5e895;border-color:#b5e895;color:#182318;font-weight:600}
@media (min-width:700px){.tabs{order:-1;margin:0 0 12px}.tab{flex-direction:row;min-height:48px;font-size:15px}.tab .icon{margin:0 8px 0 0}}
```

- [ ] **Step 5: Run tests and check in a browser**

Run: `npm test` → PASS.
With the mock running: at 390×844 the tabs sit at the bottom and the app opens on **Tất cả/Agents** (empty list for now); at 1024×768 the tabs sit at the top and it opens on **Deck**. Switching tabs persists across reload. Entering layout edit hides the tabs; switching away from Deck while editing ends edit mode. The approval card shows its own Approve/Reject on Agents and Agent, not on Deck.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/index.html public/style.css
git commit -m "feat: Agents / Agent / Deck tabs"
```

---

### Task 7: Alerts

**Files:**
- Create: `public/alerts.js`
- Create: `test/alerts.test.js`
- Modify: `server.js` (static allowlist), `public/index.html` (sprite, bell button, script tag), `public/app.js` (strings), `public/style.css`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `Deck.onState`, `Deck.t`, agents with `status`, `handle`, `incarnationId`; `requests` with `id`.
- Produces: `diff(memory | null, { agents, requests }, now) → { memory, alerts: [{ type: 'needs' | 'quiet', id }] }`, `badge(state) → number`, exported via `module.exports` in Node.

- [ ] **Step 1: Write the failing tests**

`test/alerts.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diff, badge } = require('../public/alerts.js');

const agent = (status, extra = {}) => ({ handle: 'h', incarnationId: 'i', status, ...extra });
const snap = (agents, requests = []) => ({ agents, requests });

test('first snapshot only builds memory', () => {
  assert.deepEqual(diff(null, snap([agent('prompt')], [{ id: 'r1' }]), 1000).alerts, []);
});

test('a new request and a new approval prompt each alert once', () => {
  const m = diff(null, snap([agent('idle')]), 0).memory;
  let out = diff(m, snap([agent('prompt')], [{ id: 'r1' }]), 1000);
  assert.deepEqual(out.alerts, [{ type: 'needs', id: 'h/i' }, { type: 'needs', id: 'r1' }]);
  out = diff(out.memory, snap([agent('prompt')], [{ id: 'r1' }]), 3000);
  assert.deepEqual(out.alerts, []);
});

test('quiet fires only after at least 20 s of continuous work', () => {
  let m = diff(null, snap([agent('idle')]), 0).memory;
  m = diff(m, snap([agent('working')]), 1000).memory;
  m = diff(m, snap([agent('working')]), 15000).memory;
  assert.deepEqual(diff(m, snap([agent('idle')]), 17000).alerts, []);
  m = diff(null, snap([agent('idle')]), 0).memory;
  m = diff(m, snap([agent('working')]), 1000).memory;
  m = diff(m, snap([agent('working')]), 19000).memory;
  assert.deepEqual(diff(m, snap([agent('idle')]), 21000).alerts, [{ type: 'quiet', id: 'h/i' }]);
});

test('the same agent cannot alert again within 30 s', () => {
  let m = diff(null, snap([agent('idle')]), 0).memory;
  let out = diff(m, snap([agent('prompt')]), 1000);
  assert.equal(out.alerts.length, 1);
  m = diff(out.memory, snap([agent('idle')]), 2000).memory;
  out = diff(m, snap([agent('prompt')]), 10000);
  assert.equal(out.alerts.length, 0);
  m = diff(out.memory, snap([agent('idle')]), 20000).memory;
  assert.equal(diff(m, snap([agent('prompt')]), 31000).alerts.length, 1);
});

test('a new incarnation on the same handle is a different agent', () => {
  const m = diff(null, snap([agent('prompt')]), 0).memory;
  assert.deepEqual(diff(m, snap([agent('prompt', { incarnationId: 'j' })]), 1000).alerts, []);
});

test('badge counts pending requests plus agents showing a prompt', () => {
  assert.equal(badge(snap([agent('prompt'), agent('idle', { handle: 'x' })], [{ id: 'r' }])), 2);
  assert.equal(badge(snap([])), 0);
});
```

The incarnation test expects no alert: the new incarnation has no memory yet, so it is a baseline, like the first snapshot.

Append to `test/server.test.js`:

```js
test('serves the new scripts without pairing', async t => {
  const f = await fixture(t);
  for (const file of ['/alerts.js']) {
    const res = await f.call(file, undefined, '');
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../public/alerts.js'`, and `/alerts.js` returns 401.

- [ ] **Step 3: Implement `public/alerts.js`**

```js
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
    if (err || !state) { memory = null; document.title = 'Orca Deck'; return; }
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
```

- [ ] **Step 4: Serve it, add the bell and styles**

`server.js` static allowlist: `['/', '/app.js', '/style.css', '/alerts.js']`.

`public/index.html` sprite:

```html
  <symbol id="i-bell" viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></symbol>
  <symbol id="i-bell-off" viewBox="0 0 24 24"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></symbol>
```

In `header#bar`, before `#linksButton`:

```html
      <button id="soundButton" class="icon-button" data-ta="sound" aria-label="Âm thanh" aria-pressed="true"><svg class="icon"><use xlink:href="#i-bell"/></svg></button>
```

Script tags at the end of `body`:

```html
<script src="/app.js"></script>
<script src="/alerts.js"></script>
```

Strings: `TEXT.vi.sound = 'Âm thanh'`, `TEXT.en.sound = 'Sound'` (add inside each object literal).

`public/style.css`:

```css
/* Alerts */
.flash-needs main{-webkit-animation:flash-needs 1s ease-out;animation:flash-needs 1s ease-out}
.flash-quiet main{-webkit-animation:flash-quiet 1s ease-out;animation:flash-quiet 1s ease-out}
@-webkit-keyframes flash-needs{from{box-shadow:inset 0 0 0 8px #e8c56a}to{box-shadow:inset 0 0 0 8px rgba(232,197,106,0)}}
@keyframes flash-needs{from{box-shadow:inset 0 0 0 8px #e8c56a}to{box-shadow:inset 0 0 0 8px rgba(232,197,106,0)}}
@-webkit-keyframes flash-quiet{from{box-shadow:inset 0 0 0 8px #b0ec8d}to{box-shadow:inset 0 0 0 8px rgba(176,236,141,0)}}
@keyframes flash-quiet{from{box-shadow:inset 0 0 0 8px #b0ec8d}to{box-shadow:inset 0 0 0 8px rgba(176,236,141,0)}}
@media (prefers-reduced-motion:reduce){
  .flash-needs main,.flash-quiet main{-webkit-animation:none;animation:none}
  .flash-needs main{box-shadow:inset 0 0 0 8px #e8c56a}
  .flash-quiet main{box-shadow:inset 0 0 0 8px #b0ec8d}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (alerts tests and the static-file test).

- [ ] **Step 6: Commit**

```bash
git add public/alerts.js test/alerts.test.js server.js public/index.html public/app.js public/style.css test/server.test.js
git commit -m "feat: in-page alerts with chime, flash, title badge and vibration"
```

---

### Task 8: Agents view

**Files:**
- Create: `public/agents.js`
- Modify: `server.js` (static allowlist), `public/index.html` (sprite, script tag), `public/app.js` (strings, `statusBadge`), `public/style.css`
- Test: `test/server.test.js` (static-file list)

**Interfaces:**
- Consumes: `Deck.onState`, `Deck.view`, `Deck.select`, `Deck.show`, `Deck.pickRequest`, `Deck.t`; agents `{ handle, incarnationId, title, project, agent, status, lastOutputAt }`; requests `{ id, tool, project, sessionId }`.
- Produces: `Deck.statusBadge(status) → HTMLElement` (used again by Task 9).

- [ ] **Step 1: Extend the static-file test**

In `serves the new scripts without pairing`, change the list to `['/alerts.js', '/agents.js']`.

Run: `npm test` → FAIL (`/agents.js` 401).

- [ ] **Step 2: `statusBadge` and strings in `app.js`**

Strings — `TEXT.vi`: `status_prompt: 'Chờ duyệt', status_working: 'Đang chạy', status_idle: 'Đang rảnh', now: 'vừa xong'`; `TEXT.en`: `status_prompt: 'Needs approval', status_working: 'Working', status_idle: 'Idle', now: 'now'`.

Before `window.Deck`:

```js
  var STATUS_ICON = { prompt: 'i-alert', working: 'i-play', idle: 'i-pause' };
  function statusBadge(status) {
    var badge = document.createElement('span');
    badge.className = 'status ' + status;
    badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', t('status_' + status));
    badge.innerHTML = '<svg class="icon"><use xlink:href="#' + STATUS_ICON[status] + '"/></svg>';
    return badge;
  }
```

Add `statusBadge: statusBadge` to `window.Deck`.

Sprite:

```html
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/></symbol>
  <symbol id="i-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></symbol>
```

- [ ] **Step 3: `public/agents.js`**

```js
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
```

- [ ] **Step 4: Serve, load, style**

`server.js` allowlist adds `'/agents.js'`. `index.html` adds `<script src="/agents.js"></script>` after `alerts.js`.

`public/style.css`:

```css
/* Agents list */
.row{display:flex;align-items:center;width:100%;text-align:left;margin-bottom:10px;min-height:64px;padding:10px 14px}
.row-text{flex:1;min-width:0}
.row-text strong,.row-text small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-text small{color:#9aac9e;font-size:13px;margin-top:3px}
.row-side{font-size:13px;color:#9aac9e;margin-left:10px;flex-shrink:0}
.request-row{background:#2a2620;border-color:#7a6a3e}
.status{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;margin-right:12px;flex-shrink:0;background:#2c3434;color:#9aac9e}
.status .icon{width:20px;height:20px}
.status.prompt{background:#e8c56a;color:#2a2210}
.status.working{background:#2f4a2a;color:#b0ec8d}
```

- [ ] **Step 5: Run tests**

Run: `npm test` → PASS.

- [ ] **Step 6: Manual check (Review Focus 4)**

With the mock (Task 10 Step 1) at 390×844: the Agents tab lists the Codex terminal (amber, alert icon, "Needs approval" read by VoiceOver) first, then the working Claude, then the idle one, each with project and age. Tapping a row switches to the Agent tab. Send a hook request: it appears at the top as an amber request row, and tapping it shows it in the card. Then edit the mock so `terms` is `[]`, restart, re-pair, and send a hook: the request row still shows, followed by the "No Claude/Codex terminals" note.

- [ ] **Step 7: Commit**

```bash
git add public/agents.js server.js public/index.html public/app.js public/style.css test/server.test.js
git commit -m "feat: Agents overview with status"
```

---

### Task 9: Agent view — live screen, keys, reply and snippets

**Files:**
- Create: `public/agent.js`
- Modify: `server.js` (static allowlist), `public/index.html` (view markup, snippet modal, sprite, script tag), `public/app.js` (strings, modal list), `public/style.css`
- Test: `test/server.test.js` (static-file list)

**Interfaces:**
- Consumes: `Deck.api` (err `.code`), `Deck.onState`, `Deck.view`, `Deck.show`, `Deck.getSelected`, `Deck.getState`, `Deck.action`, `Deck.poll`, `Deck.message`, `Deck.t`, `Deck.statusBadge`; `POST /api/details`, `POST /api/send`, `POST /api/snippets`.
- Produces: nothing used by later tasks.

- [ ] **Step 1: Extend the static-file test**

List becomes `['/alerts.js', '/agents.js', '/agent.js']`. Run `npm test` → FAIL (`/agent.js` 401).

- [ ] **Step 2: Markup**

Sprite:

```html
  <symbol id="i-pencil" viewBox="0 0 24 24"><path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/></symbol>
```

Replace `<section id="agentView" class="view" hidden></section>` with:

```html
    <section id="agentView" class="view" hidden>
      <p id="agentEmpty" class="empty" data-t="pickAgent">Chọn một agent trong Tất cả.</p>
      <div id="agentBody" class="view" hidden>
        <div class="agent-head">
          <span id="agentBadge"></span><strong id="agentName"></strong>
          <button id="agentFocus" class="icon-button" data-ta="focusMac" aria-label="Mở trên Mac"><svg class="icon"><use xlink:href="#i-monitor"/></svg></button>
          <button id="agentPin" class="icon-button" data-ta="pinAs" aria-label="Ghim làm Claude chính"><svg class="icon"><use xlink:href="#i-pin"/></svg></button>
        </div>
        <pre id="agentScreen" class="screen"></pre>
        <p id="agentNote" class="note" data-t="promptNote" hidden></p>
        <div id="sendKeys" class="send-keys">
          <button type="button" data-key="esc" aria-label="Escape">Esc</button>
          <button type="button" data-key="up" aria-label="Up">↑</button>
          <button type="button" data-key="down" aria-label="Down">↓</button>
          <button type="button" data-key="left" aria-label="Left">←</button>
          <button type="button" data-key="right" aria-label="Right">→</button>
          <button type="button" data-key="tab" aria-label="Tab">Tab</button>
          <button type="button" data-key="y">y</button>
          <button type="button" data-key="n">n</button>
          <button type="button" data-key="enter" aria-label="Enter">⏎</button>
          <button type="button" data-key="ctrl-c" class="danger" aria-label="Ctrl-C">^C</button>
        </div>
        <div id="snippets" class="chips"></div>
        <form id="replyForm" class="reply"><label class="sr-only" for="replyText" data-t="reply">Trả lời</label><input id="replyText" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" maxlength="2000"><button id="replySend" type="submit" class="primary" data-t="send">Gửi</button></form>
      </div>
    </section>
```

If Task 1 showed escape bytes don't arrive, omit the `esc`, `up`, `down`, `left`, `right` and `tab` buttons.

After `#linksModal`:

```html
<div id="snippetModal" class="modal" hidden><section class="modal-card"><div class="modal-heading"><h2 data-t="editSnippets">Sửa mẫu trả lời</h2><button class="icon-button close" data-ta="close" aria-label="Đóng"><svg class="icon"><use xlink:href="#i-x"/></svg></button></div><form id="snippetForm"><label for="snippetText" data-t="snippetsHelp">Mỗi dòng một mẫu (tối đa 20)</label><textarea id="snippetText" rows="8"></textarea><button type="submit" class="primary" data-t="save">Lưu</button></form></section></div>
```

Script tag: `<script src="/agent.js"></script>` after `agents.js`.

- [ ] **Step 3: Strings and modal list in `app.js`**

`TEXT.vi`:

```js
      pickAgent: 'Chọn một agent trong Tất cả.', focusMac: 'Mở trên Mac', promptNote: 'Có hộp duyệt trên màn hình. Dùng thẻ duyệt hoặc Mac.',
      reply: 'Trả lời', send: 'Gửi', sent: 'Đã gửi.', maybeSent: 'Có thể đã gửi. Xem màn hình trước khi gửi lại.',
      editSnippets: 'Sửa mẫu trả lời', snippetsHelp: 'Mỗi dòng một mẫu (tối đa 20)'
```

`TEXT.en`:

```js
      pickAgent: 'Pick an agent in Agents.', focusMac: 'Show on Mac', promptNote: 'Approval on screen. Use the card or the Mac.',
      reply: 'Reply', send: 'Send', sent: 'Sent.', maybeSent: 'Might have been sent. Check the screen before resending.',
      editSnippets: 'Edit snippets', snippetsHelp: 'One snippet per line (up to 20)'
```

`MODALS` becomes `['agentModal', 'linksModal', 'snippetModal']`.

- [ ] **Step 4: `public/agent.js`**

```js
(function () {
  'use strict';
  var D = window.Deck, $ = function (id) { return document.getElementById(id); };
  var loading = '', sending = false, waitRefresh = false, shown = '', snippetsDrawn = '';
  function keyOf(a) { return a ? a.handle + '/' + a.incarnationId : ''; }
  function showScreen(lines) {
    var el = $('agentScreen'), atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = lines.join('\n') || '—';
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
  function renderSnippets(state) {
    var list = (state && state.snippets) || [], sig = JSON.stringify(list), box = $('snippets');
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
    var a = D.getSelected(), k = keyOf(a), state = D.getState();
    $('agentEmpty').hidden = !!a; $('agentBody').hidden = !a;
    // A different agent: drop its screen and any pending send state.
    if (k !== shown) { shown = k; $('agentScreen').textContent = ''; sending = false; waitRefresh = false; }
    if (!a) return;
    var badge = $('agentBadge'); while (badge.firstChild) badge.removeChild(badge.firstChild);
    badge.appendChild(D.statusBadge(a.status));
    $('agentName').textContent = a.title;
    $('agentPin').hidden = a.agent.indexOf('claude') !== 0;
    var prompt = a.status === 'prompt', off = !state || sending || waitRefresh;
    $('agentNote').hidden = !prompt;
    var keys = $('sendKeys').getElementsByTagName('button');
    for (var i = 0; i < keys.length; i++) keys[i].disabled = off || (prompt && keys[i].getAttribute('data-key') !== 'ctrl-c');
    $('replySend').disabled = off || prompt;
    renderSnippets(state);
  }
  function loadScreen() {
    var a = D.getSelected(), k = keyOf(a);
    if (!a || loading === k) return;
    loading = k;
    D.api('details', { handle: a.handle, incarnationId: a.incarnationId }, function (err, result) {
      if (loading === k) loading = '';
      if (keyOf(D.getSelected()) !== k) return; // answer for an agent that's no longer shown
      if (err) { if (err.code === 'stale') { D.message(err.message); D.show('agents'); } return; }
      showScreen(result.screen);
      if (waitRefresh) { waitRefresh = false; refresh(); }
    });
  }
  function send(body, after) {
    var a = D.getSelected(), k = keyOf(a);
    if (!a || sending) return;
    sending = true; refresh();
    body.handle = a.handle; body.incarnationId = a.incarnationId;
    D.api('send', body, function (err, result) {
      sending = false;
      if (keyOf(D.getSelected()) !== k) return;
      if (!err) {
        if (after) after();
        if (result.screen) showScreen(result.screen);
        if (body.text) D.message(D.t('sent'));
      } else if (err.code === 'stale') { D.message(err.message); D.show('agents'); }
      // The input may already be in the terminal: keep the text, but block resending until the screen refreshes.
      else if (err.code === 'delivery_unknown' || err.code === 'offline') { waitRefresh = true; D.message(D.t('maybeSent')); }
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
```

`server.js` allowlist adds `'/agent.js'`.

- [ ] **Step 5: CSS**

```css
/* Agent view */
.agent-head{display:flex;align-items:center;margin-bottom:10px;flex-shrink:0}
.agent-head strong{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:18px}
.note{flex-shrink:0;margin:8px 0 0;color:#e8c56a;font-size:14px}
.send-keys{display:flex;flex-wrap:wrap;flex-shrink:0;margin-top:10px}
.send-keys button{flex:1 0 48px;margin:0 6px 6px 0;padding:0;font-family:Menlo,monospace;font-size:17px}
.chips{display:flex;overflow-x:auto;-webkit-overflow-scrolling:touch;flex-shrink:0;padding-bottom:4px}
.chip{flex-shrink:0;margin-right:8px;border-radius:24px;padding:8px 16px;min-height:44px;font-size:15px;display:flex;align-items:center}
.chip .icon{width:20px;height:20px}
.reply{display:flex;flex-shrink:0;margin-top:8px}
.reply input{margin:0;flex:1;min-width:0}
.reply button{margin-left:8px}
textarea{font:inherit;font-size:16px;border:1px solid #45504a;background:#121717;color:#eee;border-radius:10px;padding:12px;width:100%;margin:8px 0 16px;-webkit-user-select:text;user-select:text;resize:vertical}
```

- [ ] **Step 6: Run tests**

Run: `npm test` → PASS.

- [ ] **Step 7: Manual check (Review Focus 2 and 3)**

With the mock at 390×844 and 1024×768:
- Pick the working Claude from Agents. The screen shows its lines and refreshes every 2 s. Scroll up: it stays put. Scroll to the bottom: it follows new lines.
- Type "run the tests" and tap Send: the mock screen shows the line with ⏎, the box clears, the toast says Sent. Tap ↑ and Esc: the mock shows them.
- Paste two lines of text into the box: only one line appears in the field.
- Pick the Codex agent (approval prompt): the note shows, every key and Send are disabled except ^C; ^C works.
- Tap the pencil: the editor shows the three defaults. Enter `  ship it  `, a blank line and `deploy`, then Save. The chips become `ship it`, `deploy`. Paste 21 lines and save: the toast shows the snippet-list error and the old chips stay.
- While a screen load is pending (throttle the network in DevTools), switch to another agent quickly: the screen never shows the first agent's lines under the second agent's name.

- [ ] **Step 8: Commit**

```bash
git add public/agent.js server.js public/index.html public/app.js public/style.css test/server.test.js
git commit -m "feat: Agent view with live screen, key row, reply and snippets"
```

---

### Task 10: Mock, manual pass at three sizes, README and screenshots

**Files:**
- Create (not committed): `$SCRATCH/mock.js` (use the session scratchpad directory)
- Modify: `README.md`, `docs/deck.png`
- Create: `docs/agents.png`, `docs/agent.png`
- Delete: `docs/details.png`

- [ ] **Step 1: Mock server**

`$SCRATCH/mock.js`:

```js
// node mock.js /path/to/repo → http://127.0.0.1:8799, PIN 12345678, hook token hook-secret
const { createDeck } = require(process.argv[2] + '/server');
const now = Date.now();
const config = { pin: '12345678', token: 'browser-secret', hookToken: 'hook-secret', links: {}, main: null };
const terms = [
  { handle: 't1', incarnationId: 'i1', agentIdentity: 'claude', title: 'Claude — orchestrator', worktreePath: '/Users/me/orca-deck', connected: true, writable: true, lastOutputAt: now, preview: 'Thinking…' },
  { handle: 't2', incarnationId: 'i2', agentIdentity: 'codex', title: 'Codex — fix tests', worktreePath: '/Users/me/webapp', connected: true, writable: true, lastOutputAt: now - 120000, preview: 'Would you like to run the following command?' },
  { handle: 't3', incarnationId: 'i3', agentIdentity: 'claude', title: 'Claude — docs', worktreePath: '/Users/me/site', connected: true, writable: true, lastOutputAt: now - 600000, preview: 'Done.' }
];
const screens = {
  t1: ['> run the tests', '● Bash(npm test)', '  ⎿  pass 17, fail 1', '✻ Thinking…'],
  t2: ['Would you like to run the following command?', '  $ rm -rf dist', '› 1. Yes, proceed', "  2. Yes, and don't ask again", '  3. No'],
  t3: ['● Updated README.md', '> ']
};
setInterval(() => { terms[0].lastOutputAt = Date.now(); }, 1000); // t1 keeps working
const orca = async a => {
  const h = a[a.indexOf('--terminal') + 1];
  if (a[1] === 'list') return { terminals: terms };
  if (a[1] === 'read') return { terminal: { source: 'screen', tail: screens[h] } };
  if (a[1] === 'send') {
    const i = a.indexOf('--text');
    screens[h] = screens[h].concat('> ' + (i > 0 ? JSON.stringify(a[i + 1]) : '') + (a.includes('--enter') ? ' ⏎' : '') + (a.includes('--interrupt') ? ' ^C' : ''));
    return { accepted: true };
  }
  return { wait: { satisfied: true } };
};
createDeck({ config, orca, requestTimeout: 3600000, openUrl: async () => {} })
  .listen(8799, '127.0.0.1', () => console.log('mock: http://127.0.0.1:8799  PIN 12345678'));
```

Run: `node $SCRATCH/mock.js "$PWD"` (background). Send a Claude request (the page must have polled in the last 12 s):

```bash
curl -s -X POST http://127.0.0.1:8799/api/hook -H 'Authorization: Bearer hook-secret' -H 'Content-Type: application/json' \
  -d '{"session_id":"abc12345","cwd":"/Users/me/site","tool_name":"Bash","tool_input":{"command":"npm publish"}}' &
```

- [ ] **Step 2: Manual pass at 1024×768, 768×1024 and 390×844**

At each size, check:
- tabs position (top ≥ 700 px wide, bottom below);
- no horizontal scroll;
- all buttons ≥ 44 px;
- the card with Approve/Reject shows on Agents and Agent;
- Deck keys and layout editing work as before;
- the language switch updates every new string;
- alerts: a hook request flashes amber, sets the title to `(1) Orca Deck`, and chimes after one earlier tap; muting the bell stops the chime but not the flash;
- with OS "Reduce motion" on (DevTools → Rendering → `prefers-reduced-motion`), the flash is a static border.

Fix anything found, re-run `npm test`, and commit fixes with the task they belong to.

- [ ] **Step 3: Screenshots**

Capture at 1024×768 (Deck), and at 390×844 (Agents, Agent with the working Claude selected), English UI, with one pending request. Save as `docs/deck.png`, `docs/agents.png`, `docs/agent.png` (crop with `ffmpeg -i in.png -vf crop=W:H:0:0 out.png` if the browser window is larger). Delete `docs/details.png`.

- [ ] **Step 4: README**

In `README.md`:
- Intro: "from an iPad, phone or any browser on your home Wi‑Fi"; mention seeing every agent, replying and alerts.
- Screenshot table: `Deck | Agents | Agent` with the three new images.
- Architecture diagram: the UI node becomes `public/ UI<br/>app.js, agents.js, agent.js, alerts.js`; the edge label lists `/api/state, /api/action, /api/send,<br/>/api/decision, /api/details, /api/snippets`.
- Replace the "Session details" paragraph with:
  - **Agents** tab: every Claude/Codex terminal with status (needs approval, working, idle) and pending Claude requests first.
  - **Agent** tab: live screen, key row (Esc, arrows, Tab, y, n, Enter, Ctrl‑C), saved replies (shared by all devices; pencil to edit) and a reply box. Typing is blocked while the screen shows an approval prompt or a Claude request is pending for that project; Ctrl‑C always works.
  - **Alerts** while the deck is open: chime, flash and title count when an agent needs you; a softer chime when a busy agent goes quiet (output stopped — not necessarily finished). Bell icon mutes sound. Tap the page once so iOS allows sound. Vibration on Android only.
- Security, add:
  - "Anyone paired can type into your agents. Pair only your own devices."
  - "The deck answers on every network interface of the Mac, including VPNs. Keep the Mac off routed VPNs while it runs, or block port 8766 there."
  - "The deck checks the screen right before typing, but a prompt that appears in the split second between the check and the keystroke could receive it."
- Limitations: "Codex approvals stay on the Mac" stays; add "No alerts when the deck is closed or the device is locked."

- [ ] **Step 5: Run tests and commit**

Run: `npm test` → PASS.

```bash
git add README.md docs/
git commit -m "docs: README and screenshots for Agents, Agent and alerts"
```

- [ ] **Step 6: Restart the real deck**

Stop the running `node server.js` (background task), start it again from the worktree, and tell the user to reload the page on each device.
