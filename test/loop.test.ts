import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, type Sandbox, spool } from './helpers.ts';

/** A stand-in agent: a shell script that reads its prompt and drives the real CLI. */
function agent(s: Sandbox, name: string, script: string): string {
  const file = path.join(s.root, name);
  const spoolCmd = `"${process.execPath}" "${CLI}"`;
  fs.writeFileSync(file, `#!/bin/sh\nspool() { ${spoolCmd} "$@"; }\ncat > "${path.join(s.root, 'last-prompt.txt')}"\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('the loop hands each ready task to the agent until none are left', () => {
  const s = spool();
  const urgent = s.id('task', 'Urgent', '-p', '0');
  const normal = s.id('task', 'Normal');
  const worker = agent(s, 'worker.sh', 'spool done "$SPOOL_TASK" -m "finished by $SPOOL_ACTOR" > /dev/null');

  const out = s.sp('loop', '--agent', worker);
  assert.match(out, new RegExp(`▶ ${urgent}  Urgent[\\s\\S]*✓ done — finished by agent[\\s\\S]*▶ ${normal}  Normal`));
  assert.match(out, /Loop stopped after 2 run\(s\): 2 done, 0 waiting, 0 unfinished\. 0 still ready\./);
  assert.equal(s.json('review').shipped.length, 2);

  // The agent was given the protocol, the policy and the task — everything it needs, on stdin.
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /unattended/);
  assert.match(prompt, /# Spool · worker protocol[\s\S]*## Working a task/);
  assert.doesNotMatch(prompt, /## Coming back|\/loop /, 'an unattended agent is given one task, not the schedule');
  assert.match(prompt, /## Ask first/);
  assert.match(prompt, new RegExp(`YOUR TASK\\n\\n${normal}  p2  Normal`));
  assert.doesNotMatch(prompt, /\x1b\[/, 'no colour codes');
  assert.match(s.item(normal), /loop: handed to/);
  s.cleanup();
});

test('an agent that asks leaves its task waiting, and the loop moves on', () => {
  const s = spool();
  const hard = s.id('task', 'Needs a decision', '-p', '0');
  const easy = s.id('task', 'Easy');
  const worker = agent(
    s,
    'asker.sh',
    `if grep -q "Needs a decision" "${path.join(s.root, 'last-prompt.txt')}"; then
  spool ask "Which way?" --option Left --option Right --for "$SPOOL_TASK" > /dev/null
else
  spool done "$SPOOL_TASK" -m ok > /dev/null
fi`,
  );
  const marker = path.join(s.root, 'idle.txt');
  const result = s.exec(['loop', '--agent', worker], {
    env: { SPOOL_NOTIFY: `echo "$SPOOL_EVENT" >> "${marker}"` },
  });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /1 done, 1 waiting, 0 unfinished/);
  assert.match(result.out, /1 question\(s\) are waiting on you — spool review/);
  assert.equal(s.json('show', hard).item.state, 'blocked');
  assert.equal(s.json('show', easy).item.state, 'done');
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['ask', 'idle'], 'told when asked, and again when it ran dry');
  s.cleanup();
});

test('an agent that walks away has its task released, once', () => {
  const s = spool();
  const task = s.id('task', 'Too hard');
  const quitter = agent(s, 'quitter.sh', 'exit 3');
  const out = s.sp('loop', '--agent', quitter, '--max', '5');
  assert.match(out, /↺ unfinished — agent exited 3; released/);
  assert.match(out, /Loop stopped after 1 run\(s\): 0 done, 0 waiting, 1 unfinished\. 1 still ready\./, 'not retried in a spin');
  const item = s.json('show', task).item;
  assert.equal(item.state, 'ready');
  assert.equal(item.by, undefined);
  assert.match(item.body, /loop: agent exited 3 without finishing/);
  s.cleanup();
});

test('--once and --dry-run bound what the loop does', () => {
  const s = spool();
  const a = s.id('task', 'A');
  const b = s.id('task', 'B');
  const worker = agent(s, 'worker.sh', 'spool done "$SPOOL_TASK" -m ok > /dev/null');

  const dry = s.sp('loop', '--dry-run', '--agent', worker);
  assert.match(dry, new RegExp(`Would run .* on 2 task\\(s\\)[\\s\\S]*${a}[\\s\\S]*${b}`));
  assert.equal(s.json('show', a).item.state, 'ready', 'a dry run claims nothing');

  assert.match(s.sp('loop', '--once', '--agent', worker), /1 run\(s\): 1 done[\s\S]*1 still ready/);
  assert.match(s.fails('loop', '--max', '0'), /--max must be a whole number above zero/);

  // The agent command comes from the user's own config when no flag is given — never from the repo.
  s.write('.home/.config/spool/config.json', JSON.stringify({ agent: worker }));
  s.write('.spool/config.json', JSON.stringify({ version: 1, name: 'demo', agent: 'exit 9', notify: 'exit 9' }));
  assert.match(s.sp('loop'), /1 run\(s\): 1 done/);
  s.cleanup();
});
