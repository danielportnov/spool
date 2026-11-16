/**
 * A reply on a thread being built reaches its agent: a `claude -p` session is started with its
 * input open, and what the human writes on the thread is said to it.
 *
 * The stand-in agent speaks lines recorded from Claude Code (see test/claude.ts).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Runner } from '../src/engine.ts';
import { heardRun } from '../src/heard.ts';
import { interruptLine, listening, listens, userLine } from '../src/stream.ts';
import { claude, engineCtx, printed, recorded } from './claude.ts';
import { CLI, Sandbox, pause, startPage, until } from './helpers.ts';

// One session of Claude's, a turn to each part: `first` is the start of one, `over` its end.
const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');
const results = printed('two-turns', (e) => e.type === 'result');
const turns = { first: [init, said[0]!], over: [said[1]!, results[1]!] };
// What it prints when it is told to stop while a tool runs.
const stopped = recorded('interrupt-running-tool');
const interrupted = stopped.filter((r) => r.dir === '<').slice(stopped.filter((r) => r.dir === '<').findIndex((r) => r.event?.type === 'control_response')).map((r) => r.line);
// What was written to the real one, for the shape of what Spool writes.
const sentTo = (name: string, pick: (e: Record<string, any>) => boolean) => recorded(name).find((r) => r.dir === '>' && r.event && pick(r.event))!.event!;
const DONE = 'spool done "$SPOOL_TASK" -m "finished" > /dev/null';
/** Like the real one, the stand-in goes when its input is closed, and not before. */
const UNTIL_CLOSED = 'while hear; do :; done';

function transcript(s: Sandbox, id: string): Record<string, any>[] {
  const dir = path.join(s.root, '.spool', 'runs', id);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>));
}

test('a claude -p command is run with its input open, and the lines Spool writes are the ones Claude takes', () => {
  assert.equal(listening('claude -p --output-format stream-json --verbose'), 'claude -p --output-format stream-json --verbose --input-format stream-json');
  assert.equal(listening('claude -p --output-format json'), 'claude -p --output-format json', 'no stream to read, so nothing to say');
  assert.equal(listening('claude -p --output-format stream-json --input-format text'), 'claude -p --output-format stream-json --input-format text', 'an input the user chose is kept');
  assert.equal(listening('./worker.sh -p --output-format stream-json'), './worker.sh -p --output-format stream-json');
  assert.equal(listening('claude -p "$(cat {prompt_file})" --output-format stream-json'), 'claude -p "$(cat {prompt_file})" --output-format stream-json', 'it has its prompt already');
  assert.deepEqual([listens('claude -p --output-format stream-json --input-format stream-json'), listens('claude -p --output-format stream-json'), listens('./worker.sh --input-format stream-json --output-format stream-json')], [true, false, false]);
  // The same lines the recordings were made with.
  const message = sentTo('mid-turn-and-interrupt', (e) => e.type === 'user');
  assert.deepEqual(JSON.parse(userLine(message.message.content)), message);
  const interrupt = sentTo('mid-turn-and-interrupt', (e) => e.type === 'control_request');
  assert.deepEqual(JSON.parse(interruptLine(interrupt.request_id)), interrupt);
});

test('what the human writes on a thread being built is said to its agent, once, and the log says so', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  const go = path.join(s.root, 'go');
  // It takes its prompt, starts work, and is told something while it works. Then it finishes, and goes when its input closes.
  const fake = claude(s, ['hear', 'say first', 'hear', `while [ ! -f "${go}" ]; do sleep 0.1; done`, DONE, 'say over', UNTIL_CLOSED].join('\n'), turns);
  const runner = new Runner(engineCtx(s), undefined, fake.agent, true);
  try {
    runner.wake();
    await until('the agent is heard', () => runner.runs.get(jump)?.lines.includes('apple'));
    assert.deepEqual(runner.live().map((run) => [run.id, run.listens]), [[jump, true]]);
    // It is told what is true: the human can reach it.
    assert.match(fake.prompt(1), /^You are working one task from a Spool queue\. The human may write to you while you\nwork: what they say arrives as a message, so read it and adjust\.[\s\S]*spool ask[\s\S]*## Working a thread[\s\S]*YOUR TASK[\s\S]*Tighten the jump arc/);
    assert.doesNotMatch(fake.prompt(1), /unattended|Nobody is reading/);

    const note = s.id('capture', 'keep gravity at 34');
    s.sp('file', note, '--into', jump);
    await until('the agent is told', () => fake.heard(1).length === 2);
    assert.deepEqual(fake.heard(1)[1], { type: 'user', message: { role: 'user', content: 'keep gravity at 34' } });
    await until('the log says so', () => /page: passed on to the agent: "keep gravity at 34"/.test(s.item(jump)));
    assert.ok(runner.runs.get(jump)!.lines.includes('you: keep gravity at 34'), 'and it shows among what the agent says');
    assert.deepEqual(JSON.parse(s.read(`.spool/runs/${jump}/session.json`)).told, [note]);

    // Looked at every second, and said once.
    await pause(2300);
    assert.equal(fake.heard(1).length, 2);
    assert.equal(s.item(jump).match(/passed on to the agent/g)?.length, 1);

    // It finishes. Its turn over and nothing left to do, its input is closed, and it goes as an agent always did.
    const shown = runner.runs.get(jump)!.lines;
    fs.writeFileSync(go, '');
    await until('the agent has gone', () => !runner.runs.size);
    assert.deepEqual(runner.recent.map((r) => r.outcome), ['done']);
    assert.deepEqual(transcript(s, jump).filter((e) => e.type === 'spool'), [{ type: 'spool', event: 'said', text: 'keep gravity at 34' }]);
    // What was said to it is in its transcript among what it said, so the run reads back line for line as it was shown.
    assert.deepEqual(heardRun(path.join(s.root, '.spool'), jump).lines, shown);
    assert.equal(shown.indexOf('you: keep gravity at 34'), shown.indexOf('apple') + 1);
  } finally {
    runner.close();
    s.cleanup();
  }
});

test('Stop asks the agent to stop before it ends it, and ends one that does not listen', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  // The first run stops when told to, as Claude does. Picked up again, it hears nothing it is told.
  const fake = claude(
    s,
    ['hear', 'say first', 'if [ -n "$resumed" ]; then sleep 30; fi', 'hear', 'case "$heard" in *\'"subtype":"interrupt"\'*) say interrupted;; esac', UNTIL_CLOSED, 'exit 1'].join('\n'),
    { ...turns, interrupted },
  );
  const runner = new Runner(engineCtx(s), undefined, fake.agent, true);
  try {
    runner.wake();
    await until('the agent is heard', () => runner.runs.get(jump)?.lines.includes('apple'));
    const asked = Date.now();
    assert.equal(runner.stop(jump), true);
    await until('the agent has gone', () => !runner.runs.size);
    assert.ok(Date.now() - asked < 2500, 'it went by itself, before anything ended it');
    assert.deepEqual(fake.heard(1)[1], { type: 'control_request', request_id: 'spool-1', request: { subtype: 'interrupt' } });
    assert.match(s.item(jump), /page: stopped from the page; back in build/);
    const kept = transcript(s, jump);
    assert.deepEqual(kept.filter((e) => e.type === 'spool'), [{ type: 'spool', event: 'interrupt' }]);
    assert.equal(kept.findLast((e) => e.type === 'result')!.subtype, 'error_during_execution', 'its session knows it was stopped');

    // One that does not listen is ended all the same, a moment later.
    runner.take(jump);
    await until('it is picked up again', () => runner.runs.get(jump)?.lines.includes('apple'));
    assert.equal(runner.stop(jump), true);
    await until('the agent has gone', () => !runner.runs.size);
    assert.deepEqual(runner.recent.map((r) => r.outcome), ['stopped', 'stopped']);
  } finally {
    runner.close();
    s.cleanup();
  }
});

test('a session that ends its turn unfinished is ended as before, unless the human has just written; then it is kept for their next word, for a while', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  // Every message it is given is a turn, and none finishes the thread until it is told to.
  const fake = claude(s, ['finish() { case "$heard" in *"finish now"*) ' + DONE + ';; esac; }', 'hear', 'finish', 'say first', 'say over', 'while hear; do finish; say over; done'].join('\n'), turns);
  const runner = new Runner(engineCtx(s), undefined, fake.agent, true);
  const unfinished = (n: number) => until(`run ${n} is over, unfinished`, () => !runner.runs.size && runner.recent.length === n && runner.recent[0]!.outcome.startsWith('unfinished: the agent exited 0'));
  try {
    // Nobody has said anything: its turn over, it is not waited on.
    runner.wake();
    await unfinished(1);
    assert.equal(fake.heard(1).length, 1);

    // The human writes. Picked up with their words, it ends its turn unfinished again, and this time is kept for what they say next.
    s.sp('file', s.id('capture', 'what about the small platform?'), '--into', jump);
    runner.wake();
    await until('it is picked up, and its turn is over', () => runner.runs.get(jump)?.session?.waiting);
    assert.match(fake.prompt(2), /> what about the small platform\?/);
    await pause(1500);
    assert.deepEqual(runner.live().map((run) => [run.id, run.listens]), [[jump, true]], 'still there, a tick later');

    // Not for ever: once those minutes are up it is ended, and the thread waits as one its agent walked away from.
    runner.replyWindow = 1;
    await unfinished(2);
    runner.replyWindow = 60_000;

    // Their next word picks it up again, and this time it is said while the session waits.
    s.sp('file', s.id('capture', 'move the platform instead'), '--into', jump);
    runner.wake();
    await until('it is picked up, and its turn is over', () => runner.runs.get(jump)?.session?.waiting);
    s.sp('file', s.id('capture', 'finish now'), '--into', jump);
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    await until('the agent has gone', () => !runner.runs.size);
    assert.deepEqual(fake.heard(3).map((m) => m.message.content).slice(1), ['finish now']);
    assert.equal(fake.args().length, 3);
  } finally {
    runner.close();
    s.cleanup();
  }
});

test('an agent that is not claude is only watched, as before: nothing is said to it', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  const go = path.join(s.root, 'go');
  const worker = path.join(s.root, 'worker.sh');
  // It reads its prompt to the end, which only comes if its input is closed behind it.
  fs.writeFileSync(worker, `#!/bin/sh\ncat > "${s.root}/prompt.txt"\necho "working"\nwhile [ ! -f "${go}" ]; do sleep 0.1; done\n"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m "finished" > /dev/null\n`);
  fs.chmodSync(worker, 0o755);
  const runner = new Runner(engineCtx(s), undefined, worker, true);
  try {
    runner.wake();
    await until('the agent is heard', () => runner.runs.get(jump)?.lines.includes('working'));
    assert.match(s.read('prompt.txt'), /unattended\. Nobody is reading your\nreplies/);
    assert.deepEqual(runner.live().map((run) => run.listens), [false]);
    s.sp('file', s.id('capture', 'keep gravity at 34'), '--into', jump);
    assert.equal(runner.interrupt(jump), false);
    await pause(1500);
    assert.doesNotMatch(s.item(jump), /passed on|told by the human/);
    fs.writeFileSync(go, '');
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    await until('the agent has gone', () => !runner.runs.size);
  } finally {
    runner.close();
    s.cleanup();
  }
});

test('from the page: a reply posted on a building thread reaches its agent, and it can be told to stop and listen', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const idle = s.id('task', 'Make coins readable at sunset');
  s.sp('build', jump);
  // Told to stop, it does, and waits; told to finish, it finishes.
  const fake = claude(
    s,
    ['hear', 'say first', 'while hear; do', '  case "$heard" in *\'"subtype":"interrupt"\'*) say interrupted;; *"finish now"*) ' + DONE + '; say over;; esac', 'done'].join('\n'),
    { ...turns, interrupted },
  );
  const page = await startPage(s, '--run', '--agent', fake.agent);
  const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
  const post = async (action: string, body: unknown) => {
    const res = await fetch(`${page.url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) });
    return { status: res.status, ...((await res.json()) as { ok: boolean; text: string }) };
  };
  try {
    const live = await until('the agent is heard', async () => { const b = await board(); return b.runner.running[0]?.lines.includes('apple') && b; });
    assert.deepEqual([live.runner.running[0].id, live.runner.running[0].listens], [jump, true], 'the board says it can be spoken to');

    // The reply box: the note is kept on the thread first, and the page's runner says it to the agent.
    assert.equal((await post('note', { id: jump, text: 'keep gravity at 34' })).status, 200);
    await until('the agent is told', () => fake.heard(1)[1]?.message?.content === 'keep gravity at 34');
    await until('its lines show it', async () => (await board()).runner.running[0]?.lines.includes('you: keep gravity at 34'));

    // Told to stop what it is doing: it is not ended, and it waits for the next word.
    assert.deepEqual(await post('interrupt', { id: jump }), { status: 200, ok: true, text: 'Told to stop what it is doing. It waits for your reply.' });
    await until('the agent is told to stop', () => fake.heard(1)[2]?.request?.subtype === 'interrupt');
    await until('its turn is over', async () => (await board()).runner.running[0]?.lines.some((line: string) => line.startsWith('ended: error_during_execution')));
    await pause(1300);
    assert.deepEqual([(await board()).runner.running.length, s.json('show', jump).item.state], [1, 'active'], 'still its thread, a tick later');
    assert.match(s.item(jump), /page: told by the human to stop what it was doing; it waits for their word/);
    assert.equal((await post('interrupt', { id: idle })).status, 400, 'nothing is building that one');

    assert.equal((await post('note', { id: jump, text: 'finish now' })).status, 200);
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    await until('the agent has gone', async () => !(await board()).runner.running.length);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
