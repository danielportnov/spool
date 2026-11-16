/**
 * Carry on: a thread a run left unfinished is picked up in the Claude session it was in.
 *
 * The stand-in agent speaks lines recorded from Claude Code (see test/claude.ts).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Runner, leftOff } from '../src/engine.ts';
import { hearLine, inSession, sessionOf } from '../src/stream.ts';
import { claude, engineCtx, printed, recorded } from './claude.ts';
import { CLI, Sandbox, until } from './helpers.ts';

const ID = '3486a718-65b8-4df5-8fcc-2b9cd7a75f45';
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

// What Claude printed in two turns of one session, a turn to each part.
const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');
const results = printed('two-turns', (e) => e.type === 'result');
const turns = { first: [init, said[0]!], second: [init, said[1]!, results[1]!] };
// And what it prints when told to pick up a session it does not have.
const gone = recorded('resume-unknown-id');
const noSession = { 'gone-err': gone.filter((r) => r.dir === '!').map((r) => r.line), gone: gone.filter((r) => r.dir === '<').map((r) => r.line) };

/** The transcripts kept for a thread, oldest first, each as the events in it. */
function transcripts(s: Sandbox, id: string): Record<string, any>[][] {
  const dir = path.join(s.root, '.spool', 'runs', id);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>));
}

test('a claude -p command is put in a session of Spool’s choosing, unless it names one or is another agent', () => {
  assert.equal(inSession('claude -p --model opus', ID), `claude -p --model opus --session-id ${ID}`);
  assert.equal(inSession('/usr/local/bin/claude --print', ID, true), `/usr/local/bin/claude --print --resume ${ID}`);
  for (const own of ['--session-id x', '--resume x', '-r x', '--continue', '-c', '--no-session-persistence']) {
    assert.equal(inSession(`claude -p ${own}`, ID), undefined, `${own} is the command's own say`);
  }
  assert.equal(inSession('./worker.sh -p', ID), undefined, 'another agent: Spool does not know its flags');
  assert.equal(inSession('claude', ID), undefined, 'not print mode');
  assert.equal(inSession('claude -p', 'abc; rm -rf .'), undefined, 'only a session id goes near the shell');
  assert.deepEqual(sessionOf(`claude -p --session-id ${ID} --verbose`), { id: ID, resumed: false });
  assert.deepEqual(sessionOf(`claude -p --resume ${ID}`), { id: ID, resumed: true });
  assert.equal(sessionOf('claude -p --resume latest'), undefined);
  assert.equal(sessionOf(`./worker.sh --resume ${ID}`), undefined);
});

test('Claude saying it has no such session is heard, on stderr and in its last event', () => {
  const [err] = gone.filter((r) => r.dir === '!');
  const [end] = gone.filter((r) => r.dir === '<');
  assert.deepEqual(hearLine(err!.line), { lines: ['No conversation found with session ID: SESSION'], lost: true });
  const heard = hearLine(end!.line);
  assert.deepEqual([heard.lost, heard.lines], [true, ['ended: error_during_execution · 0 turns']]);
  assert.equal(hearLine(results[0]!).lost, undefined);
});

test('a stopped thread is carried on in the session it was in, told only what is new', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const floaty = s.id('capture', 'the jump feels floaty');
  const jump = s.id('task', 'Tighten the jump arc', '--from', floaty);
  // The first run says a line and works on until it is told to stop; one that picks the session up says the next and finishes.
  const fake = claude(s, ['hear', 'if [ -z "$resumed" ]; then say first; hear; exit 1; fi', 'say second', 'spool done "$SPOOL_TASK" -m "finished" > /dev/null'].join('\n'), turns);
  const runner = new Runner(engineCtx(s), undefined, fake.agent, true);
  try {
    runner.wake();
    await until('the agent is heard', () => runner.runs.get(jump)?.lines.includes('apple'));
    const [first] = fake.args();
    const session = new RegExp(`--session-id (${UUID})$`).exec(first!)?.[1];
    assert.ok(session, `the session is Spool's choice: ${first}`);
    assert.match(s.item(jump), new RegExp(`page: handed to \`[^\`]*claude -p --model haiku --effort low --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --session-id ${session}\``));
    assert.equal(leftOff(s.json('show', jump).item), undefined, 'nothing to carry on while it is being built');

    // Stopped, it waits. The human writes on it, and carries on.
    assert.equal(runner.stop(jump), true);
    await until('the agent is gone', () => !runner.runs.size);
    assert.match(s.item(jump), /page: stopped from the page; back in build/);
    s.sp('file', s.id('capture', 'keep gravity at 34'), '--into', jump);
    runner.take(jump);
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');

    // The same session, picked up: the same model, nobody asked to choose it again, and one line for what happened.
    assert.deepEqual(fake.args(), [first, first!.replace('--session-id', '--resume')]);
    assert.equal(fake.read('routed.txt'), 'asked\n');
    assert.match(s.item(jump), new RegExp(`page: handed to \`[^\`]*claude -p --model haiku --effort low --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --resume ${session}\``));
    assert.match(fake.prompt(1), /## Working a thread[\s\S]*YOUR TASK[\s\S]*the jump feels floaty/);
    const again = fake.prompt(2);
    assert.match(again, new RegExp(`earlier in this session, and it is yours again: ${jump} Tighten the jump arc\n\nThe human stopped you, and has now set you going again\\.\n\nSince you were last given the thread, the human has written on it:\n\n> keep gravity at 34\n\nThe human may write to you while you work[^\n]*\n\nCarry on from where you were\\.[^\n]*spool done`));
    assert.doesNotMatch(again, /Working a thread|the jump feels floaty/, 'not the rules and the brief a second time');
    const kept = transcripts(s, jump);
    assert.deepEqual(kept.map((events) => [...new Set(events.filter((e) => e.type !== 'spool').map((e) => e.session_id))]), [[session], [session]], 'two runs, one session');
    assert.equal(JSON.parse(s.read(`.spool/runs/${jump}/session.json`)).session, session);
    await until('the agent has gone', () => !runner.runs.size);
  } finally {
    runner.close();
    s.cleanup();
  }
});

test('a session Claude no longer has is not waited on: the thread starts afresh, and its log says so', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  // The first run gives up. Told to pick its session up, Claude has none; started afresh, it finishes.
  const fake = claude(
    s,
    [
      'hear',
      'if [ "$n" = 1 ]; then say first; exit 1; fi',
      'if [ -n "$resumed" ]; then say gone-err >&2; say gone; exit 1; fi',
      'say second',
      'spool done "$SPOOL_TASK" -m "finished" > /dev/null',
    ].join('\n'),
    { ...turns, ...noSession },
  );
  const runner = new Runner(engineCtx(s), undefined, fake.agent, true);
  try {
    runner.wake();
    await until('the agent has given up', () => runner.recent[0]?.outcome.startsWith('unfinished'));
    const lost = sessionOf(`claude -p ${fake.args()[0]}`)!.id;
    assert.deepEqual(leftOff(s.json('show', jump).item), { session: lost, how: 'unfinished' });

    // It is not tried again until something about it changes: the human's word does that.
    s.sp('file', s.id('capture', 'try the other way'), '--into', jump);
    runner.wake();
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    const [, second, third] = fake.args();
    assert.match(second!, new RegExp(`--resume ${lost}$`));
    const fresh = sessionOf(`claude -p ${third}`)!;
    assert.deepEqual([fresh.resumed, fresh.id === lost], [false, false], 'a new session, not the lost one again');
    assert.match(s.item(jump), new RegExp(`page: session ${lost} could not be picked up again; starting afresh\n.*page: handed to \`[^\`]*--session-id ${fresh.id}\``));
    assert.match(fake.prompt(2), /Your last run ended with the thread neither finished nor waiting on a question\.[\s\S]*> try the other way/);
    assert.match(fake.prompt(3), /## Working a thread[\s\S]*YOUR TASK[\s\S]*try the other way/, 'afresh is the rules and the whole brief');
    assert.match(s.item(jump), new RegExp(`page: session ${fresh.id} · transcript`), 'and the session the thread now has is the new one');
    await until('the agent has gone', () => !runner.runs.size);
  } finally {
    runner.close();
    s.cleanup();
  }
});

test('another agent command cannot pick a Claude session up: it starts afresh, and the log says so', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  const fake = claude(s, ['hear', 'say first', 'exit 1'].join('\n'), turns);
  const first = new Runner(engineCtx(s), undefined, fake.agent, true);
  try {
    first.wake();
    await until('the agent has given up', () => first.recent[0]?.outcome.startsWith('unfinished'));
  } finally {
    first.close();
  }
  const session = leftOff(s.json('show', jump).item)?.session;
  assert.ok(session);

  const worker = path.join(s.root, 'worker.sh');
  fs.writeFileSync(worker, `#!/bin/sh\ncat > "${s.root}/worker-prompt.txt"\n"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m "finished" > /dev/null\n`);
  fs.chmodSync(worker, 0o755);
  const second = new Runner(engineCtx(s), undefined, worker, true);
  try {
    second.wake();
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    assert.match(s.item(jump), new RegExp(`page: session ${session} cannot be picked up by \`[^\`]*worker\\.sh\`; starting afresh\n.*page: handed to \`[^\`]*worker\\.sh\``));
    assert.match(s.read('worker-prompt.txt'), /## Working a thread[\s\S]*YOUR TASK/);
    await until('the agent has gone', () => !second.runs.size);
  } finally {
    second.close();
    s.cleanup();
  }
});

test('a thread moved, undone or taken by someone else since its run is not carried on', () => {
  const log = (...lines: string[]) => ({ status: 'open', body: `words\n\n## Log\n${lines.map((l) => `- 2026-01-01 00:01Z ${l}`).join('\n')}` }) as never;
  const ran = [`page: handed to \`claude -p --session-id ${ID}\``, `page: session ${ID} · transcript x.jsonl · open it with \`claude --resume ${ID}\``];
  assert.deepEqual(leftOff(log(...ran, 'page: stopped from the page; back in build')), { session: ID, how: 'stopped' });
  assert.deepEqual(leftOff(log(...ran, 'human: stopped while claude was building it; back in build')), { session: ID, how: 'stopped' });
  assert.deepEqual(leftOff(log(...ran, 'page: agent exited 1 without finishing; back in build')), { session: ID, how: 'unfinished' });
  assert.deepEqual(leftOff(log(...ran, 'page: the page was stopped; back in build', 'human: edited: title')), { session: ID, how: 'cut off' });
  assert.equal(leftOff(log(...ran, 'page: stopped from the page; back in build', 'human: moved back to proposed', 'human: moved to build')), undefined);
  assert.equal(leftOff(log(...ran, 'page: stopped from the page; back in build', 'claude: started', 'human: stopped while claude was building it; back in build')), undefined);
  assert.equal(leftOff(log('page: handed to `./worker.sh`', 'page: agent exited 1 without finishing; back in build')), undefined, 'no session to pick up');
  // Cut short before its agent said which session it was: the hand-off says which Spool put it in.
  assert.deepEqual(leftOff(log(ran[0]!, 'page: its page had stopped with nobody working it; back in build')), { session: ID, how: 'cut off' });
  assert.equal(leftOff(log(...ran)), undefined, 'still being built');
});
