import test from 'node:test';
import assert from 'node:assert/strict';
import { recentContext, CONTEXT_MESSAGES } from '../src/core/sessions/recent-context.mjs';

const message = (role, text, at) => ({ role, text, at });

test('bounded recent evidence retains the latest substantive user request through a busy assistant turn', () => {
  const messages = [message('user', 'Old request', 1000), message('assistant', 'Old answer', 2000), message('user', 'Current request', 3000),
    ...Array.from({ length: 9 }, (_, i) => message('assistant', `Progress ${i}`, 4000 + i)),
    message('user', '<environment_context>injected context</environment_context>', 5000)];
  const context = recentContext(messages);
  assert.equal(context.messages.length, CONTEXT_MESSAGES);
  assert.deepEqual(context.messages.map(item => item.text), ['Current request', 'Progress 4', 'Progress 5', 'Progress 6', 'Progress 7', 'Progress 8']);
  assert.equal(context.updatedAt, 4008);
  const next = recentContext([...context.messages, message('user', 'New direction', 6000)]);
  assert.equal(next.messages.length, CONTEXT_MESSAGES);
  assert.equal(next.messages.at(-1).text, 'New direction');
  assert.ok(!next.messages.some(item => item.text === 'Current request'), 'a newer user request replaces the retained one');
});

test('assistant-only evidence remains bounded and does not invent a user request', () => {
  const context = recentContext(Array.from({ length: 8 }, (_, i) => message('assistant', `Reply ${i}`, 1000 + i)));
  assert.equal(context.messages.length, CONTEXT_MESSAGES);
  assert.ok(context.messages.every(item => item.role === 'assistant'));
  assert.equal(context.messages[0].text, 'Reply 2');
});
