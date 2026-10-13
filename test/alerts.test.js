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
