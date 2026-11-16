import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { commandFor } from '../src/agent.ts';
import { CLI, spool } from './helpers.ts';

test('a claude command gets the model and effort the thread size suggests', () => {
  const s = spool();
  const tiny = s.id('task', 'Fix a typo', '--size', 'xs');
  const big = s.id('task', 'Rework the store', '--size', 'l');
  const unsized = s.id('task', 'Something');
  const { commands } = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(commands[tiny], 'claude -p --model haiku --effort low');
  assert.equal(commands[big], 'claude -p --model opus --effort xhigh');
  assert.equal(commands[unsized], 'claude -p --model opus --effort high', 'unsized work is treated as medium');
  assert.match(s.sp('loop', '--dry-run', '--agent', 'claude -p'), /\$ claude -p --model haiku --effort low/);
  s.cleanup();
});

test('the human picks a thread’s model and effort, and can hand it back to the size', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  s.sp('edit', t, '--model', 'fable', '--effort', 'max');
  assert.match(s.item(t), /^model: fable$/m);
  assert.equal(s.json('loop', '--dry-run', '--agent', 'claude -p').commands[t], 'claude -p --model fable --effort max');

  s.sp('edit', t, '--effort', 'none');
  assert.equal(s.json('loop', '--dry-run', '--agent', 'claude -p').commands[t], 'claude -p --model fable --effort low');
  s.sp('edit', t, '--model', 'none');
  assert.doesNotMatch(s.item(t), /^model:/m);

  assert.match(s.fails('edit', t, '--model', 'opus; rm -rf ~'), /is not a model name/);
  assert.match(s.fails('edit', t, '--effort', 'huge'), /effort must be one of low, medium, high, xhigh, max/);
  s.cleanup();
});

test('the user’s own table, or none, decides what each size gets', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  s.write('.home/.config/spool/config.json', JSON.stringify({ models: { xs: { model: 'sonnet' } } }));
  assert.equal(s.json('loop', '--dry-run', '--agent', 'claude -p').commands[t], 'claude -p --model sonnet --effort low');
  s.write('.home/.config/spool/config.json', JSON.stringify({ models: false }));
  assert.equal(s.json('loop', '--dry-run', '--agent', 'claude -p').commands[t], 'claude -p');
  s.cleanup();
});

test('only plain words reach the command, and it chooses for itself where it already does', () => {
  assert.equal(commandFor('claude -p --model opus', { model: 'haiku', effort: 'low' }), 'claude -p --model opus --effort low');
  assert.equal(commandFor('/usr/local/bin/claude -p', { model: 'sonnet' }), '/usr/local/bin/claude -p --model sonnet');
  assert.equal(commandFor('my-agent --fast', { model: 'opus', effort: 'high' }), 'my-agent --fast', 'another agent is left alone');
  assert.equal(commandFor('codex exec --model {model}', { model: 'opus' }), 'codex exec --model opus');
  assert.equal(commandFor('codex exec --model {model} --effort={effort}', {}), 'codex exec');
  assert.equal(commandFor('claude -p', { model: '$(touch pwned)', effort: 'high; rm' as never }), 'claude -p');
});

test('the loop runs the thread with its pick put in the command', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 's');
  const file = path.join(s.root, 'worker.sh');
  const seen = path.join(s.root, 'seen.txt');
  fs.writeFileSync(file, `#!/bin/sh\necho "$1 $2" > "${seen}"\n"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m ok > /dev/null\n`);
  fs.chmodSync(file, 0o755);
  assert.match(s.sp('loop', '--agent', `${file} {model} {effort}`), /1 done/);
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), 'sonnet medium');
  assert.match(s.item(t), /loop: handed to `.*worker\.sh sonnet medium`/);
  s.cleanup();
});
