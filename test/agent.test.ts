import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { commandFor, parseRoute } from '../src/agent.ts';
import { CLI, type Sandbox, spool } from './helpers.ts';

test('a claude command falls back to a pick on the big side of what the thread size suggests', () => {
  const s = spool();
  const tiny = s.id('task', 'Fix a typo', '--size', 'xs');
  const big = s.id('task', 'Rework the store', '--size', 'l');
  const unsized = s.id('task', 'Something');
  const { commands, routed } = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(commands[tiny], 'claude -p --model sonnet --effort medium');
  assert.equal(commands[big], 'claude -p --model fable --effort high');
  assert.equal(commands[unsized], 'claude -p --model opus --effort xhigh', 'unsized work is treated as medium');
  assert.deepEqual([...routed].sort(), [tiny, big, unsized].sort(), 'Fable chooses first for every one');
  assert.match(
    s.sp('loop', '--dry-run', '--agent', 'claude -p'),
    /fable chooses the model and effort first; if it cannot: \$ claude -p --model sonnet --effort medium/,
  );
  s.cleanup();
});

test('the human picks a thread’s model and effort, and can hand it back', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  s.sp('edit', t, '--model', 'fable', '--effort', 'max');
  assert.match(s.item(t), /^model: fable$/m);
  const picked = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(picked.commands[t], 'claude -p --model fable --effort max');
  assert.deepEqual(picked.routed, [], 'nothing is left for Fable to choose');

  s.sp('edit', t, '--effort', 'none');
  const half = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(half.commands[t], 'claude -p --model fable --effort medium');
  assert.deepEqual(half.routed, [t]);
  s.sp('edit', t, '--model', 'none');
  assert.doesNotMatch(s.item(t), /^model:/m);

  assert.match(s.fails('edit', t, '--model', 'opus; rm -rf ~'), /is not a model name/);
  assert.match(s.fails('edit', t, '--effort', 'huge'), /effort must be one of low, medium, high, xhigh, max/);
  s.cleanup();
});

test('the user’s own table, or none, decides what each size falls back to', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  s.write('.home/.config/spool/config.json', JSON.stringify({ models: { xs: { model: 'haiku' } }, router: false }));
  const own = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(own.commands[t], 'claude -p --model haiku --effort medium');
  assert.deepEqual(own.routed, [], 'router: false goes by the table alone');
  s.write('.home/.config/spool/config.json', JSON.stringify({ models: false }));
  const none = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(none.commands[t], 'claude -p');
  assert.deepEqual(none.routed, []);
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

test('Fable’s answer is read from what it prints, and only plain words are kept', () => {
  assert.deepEqual(parseRoute('thinking…\n{"model": "Opus", "effort": "XHIGH", "why": "a big   change"}'), {
    model: 'opus',
    effort: 'xhigh',
    why: 'a big change',
  });
  assert.deepEqual(parseRoute('{"model":"$(rm -rf ~)","effort":"high"}'), { model: undefined, effort: 'high' });
  assert.equal(parseRoute('I would use opus'), undefined);
  assert.equal(parseRoute('{"model": 3}'), undefined);
});

test('the loop runs the thread with its pick put in the command', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 's');
  const file = path.join(s.root, 'worker.sh');
  const seen = path.join(s.root, 'seen.txt');
  fs.writeFileSync(file, `#!/bin/sh\necho "$1 $2" > "${seen}"\n"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m ok > /dev/null\n`);
  fs.chmodSync(file, 0o755);
  assert.match(s.sp('loop', '--agent', `${file} {model} {effort}`), /1 done/);
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), 'opus high');
  assert.match(s.item(t), /loop: handed to `.*worker\.sh opus high`/);
  s.cleanup();
});

/** A stand-in `claude`: asked to route, it prints `answer`; asked to work, it notes its flags and finishes. */
function fakeClaude(s: Sandbox, name: string, answer: string): { agent: string; asked: string; worked: string } {
  const dir = path.join(s.root, name);
  fs.mkdirSync(dir, { recursive: true });
  const asked = path.join(dir, 'asked.txt');
  const worked = path.join(dir, 'worked.txt');
  const file = path.join(dir, 'claude');
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      'if [ -n "$SPOOL_ROUTING" ]; then',
      `  echo "$@" > "${asked}"`,
      `  echo '${answer}'`,
      '  exit 0',
      'fi',
      `echo "$@" > "${worked}"`,
      `"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m ok > /dev/null`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(file, 0o755);
  return { agent: `${file} -p`, asked, worked };
}

test('Fable reads the thread first and its choice runs it, with the reason on the thread', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  const claude = fakeClaude(s, 'bin', '{"model": "opus", "effort": "max", "why": "it touches the store"}');
  assert.match(s.sp('loop', '--agent', claude.agent), /1 done/);
  assert.equal(fs.readFileSync(claude.asked, 'utf8').trim(), '-p --model fable --effort high');
  assert.equal(fs.readFileSync(claude.worked, 'utf8').trim(), '-p --model opus --effort max');
  const item = s.item(t);
  assert.match(item, /loop: fable chose opus · max: it touches the store/);
  assert.match(item, /loop: handed to `.*claude -p --model opus --effort max`/);
  s.cleanup();
});

test('the human’s pick wins over Fable’s, and the size decides when Fable cannot', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  s.sp('edit', t, '--model', 'sonnet');
  const claude = fakeClaude(s, 'bin', '{"model": "opus", "effort": "xhigh"}');
  assert.match(s.sp('loop', '--agent', claude.agent), /1 done/);
  assert.equal(fs.readFileSync(claude.worked, 'utf8').trim(), '-p --model sonnet --effort xhigh');

  const u = s.id('task', 'Another typo', '--size', 'xs');
  const mute = fakeClaude(s, 'mute', 'no idea');
  assert.match(s.sp('loop', '--agent', mute.agent), /1 done/);
  assert.equal(fs.readFileSync(mute.worked, 'utf8').trim(), '-p --model sonnet --effort medium');
  assert.match(s.item(u), /loop: fable could not choose \(no answer it could read\); going by its size/);
  s.cleanup();
});
