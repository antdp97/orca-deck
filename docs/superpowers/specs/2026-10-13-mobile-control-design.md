# Orca Deck: control agents from any device at home

Date: 2026-10-13
Status: design approved in chat; revised after Codex review; awaiting spec review

## Goal

Make Orca Deck usable from any phone or tablet on the home Wi‑Fi (not just the iPad mini), and let it do more than approve: see all agents at a glance, reply to an agent, and get alerted while the deck is open.

Success looks like: from a phone on the couch, I can see which agents need me, open one, read its screen, type a reply or press a key, and hear a chime when an agent needs me or goes quiet.

## Constraints

- Same stack: Node `server.js` with no dependencies; front end in plain ES5 + XHR so it still runs on iOS 12 Safari; no build step.
- Strict CSP stays (`script-src 'self'`, `style-src 'self'`): no inline scripts or styles in HTML.
- Plain HTTP, existing PIN pairing + bearer token. Intended for the home LAN only (see Security for what is and isn't enforced).
- Approve stays one-time. Nothing the deck sends may be able to pick an "always allow" option.
- Every terminal action targets an exact `handle` + `incarnationId`.

## Scope

In:
1. **Overview** of all agents with live status (prompt / working / idle) and pending Claude requests.
2. **Reply**: free text, saved snippets, and a fixed key row (Enter, Esc, arrows, Tab, y, n, Ctrl‑C).
3. **Alerts** while the deck is open: chime, screen flash, title badge, vibration where supported.
4. Responsive layout for phones and tablets (portrait and landscape).

Out: push notifications when the deck is closed, per-agent mute, remote (non-LAN) access, Codex approvals from the deck, typing into a terminal that shows an approval prompt, arbitrary raw control characters, reliable "task finished" detection.

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

The static allowlist in `server.js` (`['/', '/app.js', '/style.css']`) gains `/agents.js`, `/agent.js` and `/alerts.js`. They are served without auth like the existing files.

## Server (`server.js`)

### Status in `/api/state`

`terminals()` already calls `orca terminal list` (3 s cache). Each agent gains:

- `lastOutputAt` (ms epoch, from Orca).
- `status`, from that terminal's own data only:
  - `prompt` — the terminal `preview` matches the approval regex.
  - `working` — `now - lastOutputAt <= 5000`.
  - `idle` — otherwise.

Pending Claude hook requests are **not** mapped onto terminals. A request knows its workspace and session ID but not its terminal, and one workspace can run several Claude sessions, so guessing would mark the wrong terminals. Requests stay as their own list in `/api/state` (as today) and are shown and alerted on by request ID.

The approval regex (`/do you want to|yes, proceed|allow once|permission required|approve this/i`, used today by Continue) moves to one shared constant. No extra Orca calls per poll.

### `POST /api/send`

Body: `{ handle, incarnationId, text?, key?, enter? }`

Follows the same request shape as `/api/action`: a shared `AbortController` with a 13 s overall deadline, aborted if the client disconnects, and `checkConnection()` before every step that changes the terminal. The client XHR timeout (15 s) stays longer than the server deadline, so the server gives up before the phone does.

1. Same auth, origin and incarnation checks as `/api/action` (fresh `terminals(true, signal)` lookup).
2. Exactly one of `text` or `key`:
   - `text`: string, 1–2000 chars, no control characters (`/[\u0000-\u001f\u007f]/` rejected). `enter` (boolean) appends Enter.
   - `key`: one of `enter, esc, tab, up, down, left, right, y, n, ctrl-c`, mapped server-side:
     `enter` → `--enter` with empty text, `esc` → `\x1b`, `tab` → `\t`, `up` → `\x1b[A`, `down` → `\x1b[B`, `right` → `\x1b[C`, `left` → `\x1b[D`, `y`/`n` → literal, `ctrl-c` → `--interrupt`.
3. Refuse (409) if a Claude hook request is pending for the agent's workspace (same rule as Continue).
4. Read the screen (`orca terminal read --screen`). Refuse (409) unless `terminal.source === 'screen'`. Refuse (409) if the screen matches the approval regex. There is no override: approvals are handled by the Approve/Reject card (Claude) or on the Mac (Codex and other dialogs). `ctrl-c` is the one exception and is always allowed, because interrupting never approves anything.
5. `checkConnection()`, then send with `orca terminal send --terminal <handle> --text <payload> [--enter]` (or `--interrupt`).
6. Once the send has succeeded, the input counts as delivered. Read the screen again and return `{ ok: true, screen }`. If that follow-up read fails, still return `{ ok: true, screen: null }` so the client never resends delivered input.

**Assumption to verify first:** Orca passes raw escape bytes in `--text` through to the PTY unchanged. If it doesn't, the key row ships with Enter, y, n and Ctrl‑C only, and the other keys are dropped from the allowlist.

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
- **Approval card on every view:** the amber card (tool, project, request selector, exact input) is pinned at the top of every view while a hook request is pending. It gets its own Approve and Reject buttons, shown only in the Agents and Agent views. In the Deck view those buttons are hidden and the existing Approve/Reject keys in the editable grid are used, so layout editing is unchanged. Both sets call the same `decide()`.

### Agents view (`agents.js`)

- Pending Claude requests listed first (tool + project), each opening the approval card.
- Then one row per terminal: status dot + icon (so colour isn't the only signal), agent name, project, relative time ("2m").
- Terminals sorted prompt → working → idle, then most recent output.
- Tap a row → select that agent, open the Agent view.

### Agent view (`agent.js`)

- Header: status, name, ⋯ menu (focus on Mac, pin as Main Claude, PR, Preview).
- Live screen fetched from `/api/details`. It fills the remaining height, refreshes with the 2 s poll, and stays pinned to the bottom unless the user has scrolled up. Every response is checked against the `handle` + `incarnationId` it was requested for; a response for any other agent is dropped. Changing the selection clears the screen and any send in progress.
- Key row: Esc ↑ ↓ ← → Tab y n Enter, with Ctrl‑C styled as danger.
- Snippet chips above the reply box; tapping a chip fills the box (does not send). A pencil chip opens a simple editor (one snippet per line).
- Reply box + Send button. Send and keys are disabled while a request is in flight, while offline, and while the agent's status is `prompt` (with a note: "Approval on screen — use the card or the Mac").
- On success the box is cleared, including when `screen` is `null`. On failure the text stays in the box.

### Deck view (existing `app.js`)

Unchanged keys, layout editing and language switch. The details modal and `detailsButton` are removed, including their wiring in `applyLang`/`render` and the click handler, because the Agent view replaces them.

### Shared code

`app.js` exposes:

```js
window.Deck = {
  api: api,                  // existing XHR helper
  t: t,                      // existing translation lookup
  getState: function () { return state; },     // live, not a snapshot
  getSelected: function () { return selected; },
  select: function (agent) { /* new: sets selected, saves, re-renders */ },
  decide: decide,            // existing approve/reject
  message: message           // existing toast
};
```

`select()` is new: it moves the existing "tap an agent row" logic out of `chooseAgents()`. All files stay ES5, with no modules.

## Alerts (`public/alerts.js`)

- `diff(memory, next, now)` → `{ memory, alerts: [{ type, id }] }`, a pure function exported via `module.exports` when present so Node tests can import it.
- `memory` holds what the snapshots don't have: per agent (keyed by `handle + incarnationId`) the last status, `workingSince` and `lastAlertAt`; plus the set of request IDs already seen.
- **needs**: a new hook request ID appears (id = request ID), or an agent's status becomes `prompt` (id = agent key). Two-note chime, 1 s amber edge flash, `navigator.vibrate(200)` where available.
- **quiet**: an agent goes `working → idle` after `workingSince` was at least 20 s earlier. One soft chime, green flash. It means "output stopped", not "task finished"; a quiet tool run can trigger it, and that's accepted.
- First poll after load only builds `memory`. The same id can't alert again within 30 s.
- `memory` resets (next poll is a new baseline) after the deck was offline or hidden, so you don't get a burst of stale alerts on return.
- Title badge `(N) Orca Deck`, N = pending requests + agents with status `prompt`.
- Bell icon toggles sound (localStorage `orcaDeckSound`); flash and badge always on.
- Sound: WebAudio oscillators (`AudioContext || webkitAudioContext`), unlocked on first user tap. No audio files.
- `prefers-reduced-motion`: static border instead of flash.

## Error handling

- Stale incarnation (409): toast, return to Agents.
- Agent gone: removed from Agents; if open, the screen greys out with "session ended" and sending is disabled.
- Send refused (409: pending request, approval on screen, no screen, timeout): localized toast; text kept.
- Send failed before delivery: text kept, localized toast.
- Delivered but follow-up read failed: treated as success (box cleared); the next poll refreshes the screen.
- Offline: dot turns red, Send and keys disabled, alerts paused and memory reset; polling resumes automatically.

## Security

- No change to pairing, token, origin/host checks or CSP.
- Control bytes only via the named-key allowlist; free text rejects control characters.
- No typing into a terminal with an approval prompt on screen, or while a Claude request is pending for that workspace; this keeps "approve once, never always allow" true.
- Sending needs a real current screen and runs under a deadline that's cancelled if the client disconnects, so input never arrives late after the phone reported failure.
- **"LAN only" is not enforced by the server.** It listens on all IPv4 interfaces, and host checks accept any local address, including VPN interfaces. The README will say so: anyone paired can type into your agents, so keep the Mac off routed VPNs while the deck runs, or block port 8766 on those interfaces. Binding to a single interface is out of scope.

## Testing

Server (`node:test`, fake Orca, as today):
- status classification (prompt via preview, working, idle); requests not mapped to terminals
- send: key allowlist + mapping, text limits and control-char rejection, `text`/`key` exclusivity
- send refused when: approval regex on screen (no override), `source !== 'screen'`, hook request pending for the workspace; `ctrl-c` still allowed with an approval prompt on screen
- send returns `{ ok: true, screen: null }` when the follow-up read fails
- send aborted when the client disconnects before the send step (Orca `send` never called)
- stale incarnation refused
- snippets validation and persistence
- new script files served without auth
- every new error has an English version (existing test)

Client:
- `alerts.diff` unit tests in Node: baseline, needs (request and prompt), quiet threshold via `workingSince`, 30 s cooldown, reset after offline.
- Manual pass on the mock server at 1024×768, 768×1024 and 390×844, including switching agents while a screen load is in flight.

Before building the key row: a one-off check against real Orca that Esc and arrows arrive correctly.
