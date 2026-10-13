# Orca Deck: control agents from any device at home

Date: 2026-10-13
Status: design approved in chat, awaiting spec review

## Goal

Make Orca Deck usable from any phone or tablet on the home Wi‑Fi (not just the iPad mini), and let it do more than approve: see all agents at a glance, reply to an agent, and get alerted while the deck is open.

Success looks like: from a phone on the couch, I can see which agents are waiting, open one, read its screen, type a reply or press a key, and hear a chime when an agent needs me or finishes.

## Constraints

- Same stack: Node `server.js` with no dependencies; front end in plain ES5 + XHR so it still runs on iOS 12 Safari; no build step.
- Strict CSP stays (`script-src 'self'`, `style-src 'self'`): no inline scripts or styles in HTML.
- Home LAN only, plain HTTP, existing PIN pairing + bearer token. Never exposed to the internet.
- Approve stays one-time. No "always allow".
- Every terminal action targets an exact `handle` + `incarnationId`.

## Scope

In:
1. **Overview** of all agents with live status (waiting / working / idle).
2. **Reply**: free text, saved snippets, and a fixed key row (Enter, Esc, arrows, Tab, y, n, Ctrl‑C).
3. **Alerts** while the deck is open: chime, screen flash, title badge, vibration where supported.
4. Responsive layout for phones, tablets (portrait and landscape).

Out: push notifications when the deck is closed, per-agent mute, remote (non-LAN) access, Codex approvals, arbitrary raw control characters.

## Architecture

One responsive app (approach A) with three views sharing the existing pairing, polling and approval card.

```
Phone / tablet browser                        Mac
┌───────────────────────────────┐   HTTP    ┌──────────────────────────────┐
│ app.js    (shell, Deck view)  │ ───────▶ │ server.js                    │
│ agents.js (Agents view)       │  /api/*   │  /api/state  (+status)       │
│ agent.js  (Agent view)        │           │  /api/details                │
│ alerts.js (diff → chime/flash)│           │  /api/send      (new)        │
└───────────────────────────────┘           │  /api/snippets  (new)        │
                                            │  → orca terminal list/read/send│
                                            └──────────────────────────────┘
```

## Server (`server.js`)

### Status in `/api/state`

`terminals()` already calls `orca terminal list` (3 s cache). Each agent gains:

- `lastOutputAt` (ms epoch, from Orca).
- `status`:
  - `waiting` — a pending hook request exists for that agent's workspace, or the terminal `preview` matches the approval regex.
  - `working` — `now - lastOutputAt <= 5000`.
  - `idle` — otherwise.

The approval regex (`/do you want to|yes, proceed|allow once|permission required|approve this/i`, used today by Continue) moves to one shared constant. No extra Orca calls per poll.

### `POST /api/send`

Body: `{ handle, incarnationId, text?, key?, enter?, confirm? }`

1. Same auth, origin and incarnation checks as `/api/action`.
2. Exactly one of `text` or `key`:
   - `text`: string, 1–2000 chars, no control characters (`/[\u0000-\u001f\u007f]/` rejected). `enter` (boolean) appends Enter.
   - `key`: one of `enter, esc, tab, up, down, left, right, y, n, ctrl-c`, mapped server-side:
     `enter`→ `--enter` with empty text, `esc`→`\x1b`, `tab`→`\t`, `up`→`\x1b[A`, `down`→`\x1b[B`, `right`→`\x1b[C`, `left`→`\x1b[D`, `y`/`n` → literal, `ctrl-c` → `--interrupt`.
3. Read the screen (`orca terminal read --screen`). If it matches the approval regex and `confirm !== true`, return `409 { error, code: 'confirm_needed', lines: [matching lines] }`.
4. Send with `orca terminal send --terminal <handle> --text <payload> [--enter]`, then read the screen again and return `{ ok: true, screen }`.

**Assumption to verify first:** Orca passes raw escape bytes in `--text` through to the PTY unchanged. If it doesn't, the key row ships with Enter, y, n, Ctrl‑C only and the rest are dropped from the allowlist.

### Snippets

- Stored in `.local/runtime.json` under `snippets` (shared across devices).
- `/api/state` returns `snippets`.
- `POST /api/snippets { list }`: array of ≤20 strings, each 1–200 chars, no control characters. Replaces the list.
- Default when unset: `["yes", "continue", "run the tests"]`.

### Errors

Every new `failure()` message gets an entry in the `EN` map; the existing translation test enforces this.

## UI (`public/`)

### Shell and navigation

- Three tabs: **Agents**, **Agent**, **Deck**.
- Width < 700 px: bottom tab bar. Otherwise: tabs in the top bar.
- Last view saved per device in localStorage (`orcaDeckView`). Default: Agents when width < 700 px, Deck otherwise.
- The amber approval card (Approve / Reject, request selector, exact input) is pinned at the top of every view while a hook request is pending.

### Agents view (`agents.js`)

- One row per terminal: status dot + icon (so colour isn't the only signal), agent name, project, relative time ("2m").
- Sorted waiting → working → idle, then most recent output.
- Tap a row → select that agent, open the Agent view.

### Agent view (`agent.js`)

- Header: status, name, ⋯ menu (focus on Mac, pin as Main Claude, PR, Preview).
- Live screen (reuses `/api/details`), fills remaining height, refreshed with the 2 s poll, stays pinned to the bottom unless the user has scrolled up.
- Key row: Esc ↑ ↓ ← → Tab y n Enter, Ctrl‑C styled as danger.
- Snippet chips above the reply box; tapping a chip fills the box (does not send). A pencil chip opens a simple editor (one snippet per line).
- Reply box + Send button.
- On `confirm_needed`: a sheet shows the returned lines with **Send anyway** (resends with `confirm: true`) and **Cancel**.

### Deck view (existing `app.js`)

Unchanged keys, layout editing and language switch. The details button is removed from the top bar (the Agent tab replaces it).

### Shared code

`window.Deck = { api, t, state, select, message }` is exposed by `app.js`; the new files use it. All files stay ES5, no modules.

## Alerts (`public/alerts.js`)

- Pure function `diff(prev, next, now, lastAlert)` → list of `{ type: 'needs' | 'done', handle }`. Exported via `module.exports` when present, so Node tests can import it.
- **needs**: agent became `waiting`, or a new hook request id appeared. Two-note chime, 1 s amber edge flash, `navigator.vibrate(200)` where available.
- **done**: agent went `working → idle` after ≥20 s of continuous working. One soft chime, green flash.
- First poll after load only sets the baseline. Same agent can't alert again within 30 s.
- Title badge `(N) Orca Deck`, N = waiting agents.
- Bell icon toggles sound (localStorage `orcaDeckSound`); flash and badge always on.
- Sound: WebAudio oscillators (`AudioContext || webkitAudioContext`), unlocked on first user tap. No audio files.
- `prefers-reduced-motion`: static border instead of flash.
- Only runs while the page is visible (polling already pauses when hidden).

## Error handling

- Stale incarnation (409): toast, return to Agents.
- Agent gone: removed from Agents; if open, screen greys out, "session ended", sending disabled.
- Send failure: reply text kept, localized toast.
- Offline: dot turns red, Send and keys disabled, alerts paused; polling resumes automatically.

## Security

- No change to pairing, token, origin/host checks or CSP.
- Control bytes only via the named-key allowlist; free text rejects control characters.
- Approval-prompt guard on send (confirm required).
- README gains a warning: anyone paired can type into your agents; trusted home network only.

## Testing

Server (`node:test`, fake Orca, as today):
- status classification (waiting via hook, waiting via preview, working, idle)
- send: key allowlist + mapping, text limits and control-char rejection, `text`/`key` exclusivity
- `confirm_needed` round trip
- stale incarnation refused
- snippets validation and persistence
- every new error has an English version (existing test)

Client:
- `alerts.diff` unit tests in Node (baseline, needs, done threshold, 30 s cooldown).
- Manual pass on the mock server at 1024×768, 768×1024 and 390×844.

Before building the key row: a one-off check against real Orca that Esc and arrows arrive correctly.
