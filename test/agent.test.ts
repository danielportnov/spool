import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { commandFor, pickFor, stepUp } from '../src/agent.ts';
import type { Item } from '../src/model.ts';
import { CLI, type Sandbox, spool } from './helpers.ts';

test('a claude command gets the smallest model the thread’s size can be built with, and nothing chooses first', () => {
  const s = spool();
  const tiny = s.id('task', 'Fix a typo', '--size', 'xs');
  const small = s.id('task', 'Tidy the score screen', '--size', 's');
  const unsized = s.id('task', 'Something');
  const big = s.id('task', 'Rework the store', '--size', 'l');
  const huge = s.id('task', 'A level editor', '--size', 'xl');
  const { commands, stepped } = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(commands[tiny], 'claude -p --model haiku --effort medium');
  assert.equal(commands[small], 'claude -p --model sonnet --effort medium');
  assert.equal(commands[unsized], 'claude -p --model opus --effort medium', 'unsized work is treated as medium');
  assert.equal(commands[big], 'claude -p --model opus --effort high');
  assert.equal(commands[huge], 'claude -p --model opus --effort xhigh');
  assert.deepEqual(stepped, [], 'nothing has run yet, so nothing steps up');
  assert.doesNotMatch(s.sp('loop', '--dry-run', '--agent', 'claude -p'), /fable|chooses/i);
  s.cleanup();
});

test('the human picks a thread’s model and effort, and can hand it back', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  s.sp('edit', t, '--model', 'fable', '--effort', 'max');
  assert.match(s.item(t), /^model: fable$/m);
  const picked = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(picked.commands[t], 'claude -p --model fable --effort max');

  assert.match(s.sp('edit', t, '--effort', 'none'), /effort left to its size/);
  const half = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(half.commands[t], 'claude -p --model fable --effort medium');
  s.sp('edit', t, '--model', 'none');
  assert.doesNotMatch(s.item(t), /^model:/m);

  assert.match(s.fails('edit', t, '--model', 'opus; rm -rf ~'), /is not a model name/);
  assert.match(s.fails('edit', t, '--effort', 'huge'), /effort must be one of low, medium, high, xhigh, max/);
  s.cleanup();
});

test('the user’s own table, or none, decides what each size falls back to', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  s.write('.home/.config/spool/config.json', JSON.stringify({ models: { xs: { model: 'sonnet', effort: 'low' } } }));
  const own = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(own.commands[t], 'claude -p --model sonnet --effort low');
  s.write('.home/.config/spool/config.json', JSON.stringify({ models: false }));
  const none = s.json('loop', '--dry-run', '--agent', 'claude -p');
  assert.equal(none.commands[t], 'claude -p');
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


/** A pick, as its model and effort. */
const pick = (p: { model?: string; effort?: string } | undefined): (string | undefined)[] => [p?.model, p?.effort];

/** A thread as far as picking its model goes: its size, the human's pick, and a log. */
function thread(size: string | undefined, log: string[], chosen: { model?: string; effort?: string } = {}): Item {
  const lines = log.map((what, i) => `- 2026-01-01 00:${String(i).padStart(2, '0')}Z page: ${what}`);
  return { size, ...chosen, body: `Do it.\n\n## Log\n${lines.join('\n')}` } as unknown as Item;
}

test('a thread whose last run did not work goes one model up from the one that ran it, and only then', () => {
  const handed = (model: string, effort = 'medium') => `handed to \`claude -p --model ${model} --effort ${effort} --verbose\``;
  const up = (log: string[], size = 'xs') => stepUp(thread(size, log), undefined);
  // Undone: reverted, or taken back from done; or left unfinished, whether its check failed or not.
  assert.deepEqual(up([handed('haiku'), 'done: it works', 'reverted 2 commit(s): moved back to build on the page']), {
    model: 'sonnet',
    effort: 'medium',
    from: 'haiku',
    reason: 'its last run was undone',
    top: false,
  });
  assert.equal(up([handed('haiku'), 'done: it works', 'moved back to proposed', 'moved to build'])?.model, 'sonnet');
  assert.equal(up([handed('sonnet'), 'agent exited 1 without finishing; back in build'])?.reason, 'its last run ended without finishing');
  assert.equal(up([handed('sonnet'), 'agent exited 1 without finishing; back in build'])?.model, 'opus');
  // It thinks at least as hard as it did; Fable is given high at least; and a thread Fable could not do stays on Fable.
  assert.deepEqual(pick(up([handed('opus', 'xhigh'), 'agent exited 1 without finishing'], 's')), ['fable', 'xhigh']);
  assert.deepEqual(pick(up([handed('opus', 'low'), 'agent exited 1 without finishing'], 's')), ['fable', 'high']);
  assert.deepEqual(pick(up([handed('fable', 'high'), 'done: ok', 'reverted 1 commit(s)'])), ['fable', 'high']);
  assert.equal(up([handed('fable', 'high'), 'done: ok', 'reverted 1 commit(s)'])?.top, true);
  // A full model id is on the ladder by its name.
  assert.equal(up([handed('claude-sonnet-5-5'), 'agent exited 1 without finishing'])?.model, 'opus');
  // A chat's claim says what its subagent was started on, and that is where the step is from.
  assert.equal(up(['started', 'builder model: sonnet · medium, by its size', 'done: ok', 'reverted 1 commit(s)'])?.model, 'opus');
  // A run whose command named no model: the step is up from what its size gives.
  assert.equal(up(['handed to `./agent.sh`', 'agent exited 1 without finishing'], 's')?.model, 'opus');

  // None where it worked, or the human stopped or aborted it, or it asked them something, or nothing has run.
  assert.equal(up([handed('haiku'), 'done: it works']), undefined);
  assert.equal(up([handed('haiku'), 'stopped from the page; back in build']), undefined);
  assert.equal(up([handed('haiku'), 'aborted while page was building it; moved back to proposed', 'moved to build']), undefined);
  assert.equal(up([handed('haiku'), 'waiting on d-1234: which way?']), undefined);
  assert.equal(up(['moved to build']), undefined);
  // Only what happened since the last run counts: a run after the undoing one that worked is the one that stands.
  assert.equal(up([handed('haiku'), 'done: ok', 'reverted 1 commit(s)', handed('sonnet'), 'done: ok']), undefined);
  // The user turning the table off turns the step off too.
  assert.equal(stepUp(thread('xs', [handed('haiku'), 'agent exited 1 without finishing']), false), undefined);
});

test('the human’s pick wins over a step up, and a run carried on in its session does not step', () => {
  const log = ['handed to `claude -p --model haiku --effort medium`', 'agent exited 1 without finishing; back in build'];
  const stepped = pickFor(thread('xs', log), undefined);
  assert.deepEqual([stepped.model, stepped.effort, stepped.why], ['sonnet', 'medium', 'stepped up from haiku: its last run ended without finishing']);
  const theirs = pickFor(thread('xs', log, { model: 'opus' }), undefined);
  assert.deepEqual([theirs.model, theirs.effort, theirs.stepped, theirs.why], ['opus', 'medium', undefined, 'as the thread says']);
  // Their effort alone still lets the model step up.
  assert.deepEqual(pick(pickFor(thread('xs', log, { effort: 'high' }), undefined)), ['sonnet', 'high']);
  const carried = pickFor(thread('xs', log), undefined, { model: 'haiku', effort: 'medium' });
  assert.deepEqual([carried.model, carried.stepped, carried.why], ['haiku', undefined, 'as it ran']);
  assert.equal(pickFor(thread('xs', []), undefined).why, 'by its size');
});

test('a thread undone and moved back to build is built one model up from its last run, and its log says so', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  const dir = path.join(s.root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const worked = path.join(dir, 'worked.txt');
  const give = path.join(dir, 'give-up');
  const file = path.join(dir, 'claude');
  // A stand-in `claude`: it notes its flags, then finishes the thread, or leaves it where it is told to give up.
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "$@" >> "${worked}"\n[ -e "${give}" ] && exit 1\n"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m ok > /dev/null\n`,
  );
  fs.chmodSync(file, 0o755);
  const agent = `${file} -p`;
  const runs = (): string[] => fs.readFileSync(worked, 'utf8').trim().split('\n');

  assert.match(s.sp('loop', '--agent', agent), /1 done/);
  assert.equal(runs().at(-1), '-p --model haiku --effort medium');
  assert.doesNotMatch(s.item(t), /stepped up/);

  // Undone, and back in build: Sonnet builds it next, and the log says why.
  s.sp('revert', t, '-m', 'the typo is still there');
  s.sp('build', t);
  assert.deepEqual(s.json('loop', '--dry-run', '--agent', agent).stepped, [t]);
  assert.match(s.sp('loop', '--dry-run', '--agent', agent), /stepped up from haiku to sonnet · medium: its last run was undone/);
  assert.match(s.sp('loop', '--agent', agent), /1 done/);
  assert.equal(runs().at(-1), '-p --model sonnet --effort medium');
  assert.match(s.item(t), /loop: stepped up from haiku to sonnet · medium: its last run was undone\n.*loop: handed to `.*claude -p --model sonnet --effort medium`/);

  // Undone again, and this time its agent gives up: Opus, then Fable, then Fable again.
  s.sp('revert', t);
  s.sp('build', t);
  fs.writeFileSync(give, '');
  assert.match(s.sp('loop', '--agent', agent), /unfinished/);
  assert.equal(runs().at(-1), '-p --model opus --effort medium');
  fs.rmSync(give);
  s.sp('edit', t, '--tag', 'again');
  assert.match(s.sp('loop', '--agent', agent), /1 done/);
  assert.equal(runs().at(-1), '-p --model fable --effort high');
  assert.match(s.item(t), /loop: stepped up from opus to fable · high: its last run ended without finishing/);

  // The human's pick wins over the step.
  s.sp('revert', t);
  s.sp('build', t);
  s.sp('edit', t, '--model', 'haiku');
  assert.match(s.sp('loop', '--agent', agent), /1 done/);
  assert.equal(runs().at(-1), '-p --model haiku --effort medium');
  s.cleanup();
});

test('a chat’s claim names the model its subagent is started on, one up where the last run was undone', () => {
  const s = spool();
  const t = s.id('task', 'Fix a typo', '--size', 'xs');
  const first = s.sp('start', t, '--as', 'Claude Opus 5.5');
  assert.match(first, /MODEL — haiku · medium, by its size\. Start the subagent that builds it on that model, at that effort\./);
  assert.match(s.item(t), /Claude Opus 5\.5: builder model: haiku · medium, by its size/);
  s.sp('done', t, '-m', 'fixed', '--as', 'Claude Opus 5.5');
  s.sp('revert', t, '-m', 'still there');
  s.sp('build', t);

  const next = s.json('next', '--claim', '--as', 'Claude Opus 5.5');
  assert.equal(next.task.id, t);
  assert.deepEqual(next.model, { model: 'sonnet', effort: 'medium', why: 'stepped up from haiku: its last run was undone' });
  assert.match(s.item(t), /builder model: sonnet · medium, stepped up from haiku: its last run was undone/);
  const small = s.id('task', 'Tidy the score screen', '--size', 's');
  assert.match(s.sp('next'), /MODEL — sonnet · medium, by its size/);
  assert.doesNotMatch(s.item(small), /builder model/, 'only a claim says it on the thread');
  s.cleanup();
});
