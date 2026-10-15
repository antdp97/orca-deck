'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

test('installer preserves existing hooks, is idempotent, and removes only its own hook', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-deck-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = path.join(dir, 'settings.json');
  const before = { permissions: { deny: ['Bash(rm *)'] }, hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo existing', timeout: 10 }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
  fs.writeFileSync(settings, JSON.stringify(before));
  const run = mode => spawnSync('/usr/bin/python3', [path.join(ROOT, 'install-hook.py'), '--settings', settings, ...(mode ? ['--uninstall'] : [])], { encoding: 'utf8' });
  const install = run(false);
  assert.equal(install.status, 0, install.stderr);
  const first = JSON.parse(fs.readFileSync(settings));
  assert.deepEqual(first.permissions, before.permissions);
  assert.deepEqual(first.hooks.Stop, before.hooks.Stop);
  assert.deepEqual(first.hooks.PermissionRequest[0], before.hooks.PermissionRequest[0]);
  assert.equal(first.hooks.PermissionRequest.length, 2);
  assert.equal(run(false).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(settings)).hooks.PermissionRequest.length, 2);
  assert.equal(run(true).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), before);
  assert.ok(fs.readdirSync(dir).some(name => name.includes('orca-deck-backup')));
});

test('hook returns no decision when service is unavailable or input is malformed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-deck-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtime, JSON.stringify({ port: 1, hookToken: 'secret' }));
  const result = spawnSync('/usr/bin/python3', [path.join(ROOT, 'hook.py'), '--runtime', runtime], { input: JSON.stringify({ session_id: 'a', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'echo hello' } }), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
  const malformed = spawnSync('/usr/bin/python3', [path.join(ROOT, 'hook.py'), '--runtime', runtime], { input: 'not json', encoding: 'utf8' });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout.trim(), '');
});

test('hook emits only the explicit decision, ignores any injected permission rules', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-deck-hook-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let received;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer hook-secret');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] } } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const runtime = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtime, JSON.stringify({ port: server.address().port, hookToken: 'hook-secret' }));
  const child = spawn('/usr/bin/python3', [path.join(ROOT, 'hook.py'), '--runtime', runtime]);
  let output = ''; child.stdout.on('data', data => { output += data; });
  child.stdin.end(JSON.stringify({ session_id: 'session_a', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'echo hello' } }));
  assert.equal(await new Promise(r => child.on('close', r)), 0);
  assert.equal(received.session_id, 'session_a');
  assert.deepEqual(JSON.parse(output), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});

test('autostart installer writes a LaunchAgent for this folder and removes it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-deck-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...extra) => spawnSync('/usr/bin/python3', [path.join(ROOT, 'install-autostart.py'), '--agents-dir', dir, '--node', process.execPath, '--no-launchctl', ...extra], { encoding: 'utf8' });
  const plist = path.join(dir, 'com.orcadeck.server.plist');
  assert.equal(run().status, 0);
  const agent = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout);
  assert.equal(agent.Label, 'com.orcadeck.server');
  assert.deepEqual(agent.ProgramArguments, [process.execPath, path.join(ROOT, 'server.js')]);
  assert.equal(agent.WorkingDirectory, ROOT);
  assert.equal(agent.RunAtLoad, true);
  assert.equal(agent.KeepAlive, true);
  assert.equal(agent.StandardOutPath, path.join(ROOT, '.local', 'deck.log'));
  assert.ok(agent.EnvironmentVariables.PATH.split(':').includes(path.dirname(process.execPath)));
  assert.equal(run().status, 0, 'installing twice is fine');
  assert.equal(run('--uninstall').status, 0);
  assert.equal(fs.existsSync(plist), false);
  assert.equal(run('--uninstall').status, 0, 'uninstalling twice is fine');
  assert.notEqual(run('--node', path.join(dir, 'missing-node')).status, 0);
});
