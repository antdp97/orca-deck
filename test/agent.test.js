'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { kinds, fitSize } = require('../public/agent.js');

test('marks your messages, AI replies, tool output and the input box on a Claude screen', () => {
  const lines = ['❯ fix the table', '  on the ipad', '', '⏺ Sure, here it is', '  │ a │ b │', '  ⎿  Read 3 files', '     more', '⏺ Done', 'plain line', '─────', '❯ ', '─────', '  ⏵⏵ auto mode'];
  assert.deepEqual(kinds(lines), ['you', 'you', 'you', 'ai', 'ai', 'tool', 'tool', 'ai', 'plain', 'rule', 'input', 'rule', 'plain']);
});

test('marks Codex messages and replies', () => {
  assert.deepEqual(kinds(['› hi there', '• Working on it', '  still the reply']), ['you', 'ai', 'ai']);
});

test('a line that only looks like a prompt mid-reply stays part of the reply', () => {
  assert.deepEqual(kinds(['⏺ Run this:', '  > npm test']), ['ai', 'ai']);
});

test('fit size scales a wide screen to the width, between 9 and 13 px', () => {
  assert.equal(fitSize(1000, 80), 13);
  assert.equal(fitSize(744, 151), 9); // iPad mini portrait: too narrow, scroll sideways
  assert.equal(fitSize(1000, 151), 11); // iPad mini landscape
  assert.equal(fitSize(300, 400), 9);
  assert.equal(fitSize(500, 0), 13);
});
