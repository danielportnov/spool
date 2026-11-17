/**
 * The quick reply: a reply on a thread nobody is building is answered by a small model in seconds,
 * with "Typing…" on the thread while it is written. One on a thread being built goes to its agent,
 * and nothing else answers.
 *
 * The stand-ins here are shell scripts named `claude`: nothing real is started.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { claudeOf, quickArgs, quickModel, quickPrompt, signedAs } from '../src/quick.ts';
import { claude, printed } from './claude.ts';
import { Sandbox, pause, startPage, until } from './helpers.ts';

const ON = { SPOOL_QUICK_REPLY: 'on' };

/** A `claude` that keeps its flags and its prompt, waits a moment, and says `reply`, or fails. */
function quickClaude(s: Sandbox, reply: string, code = 0): { agent: string; args: () => string[]; prompt: () => string } {
  const here = path.join(s.root, 'quick-bin');
  fs.mkdirSync(here, { recursive: true });
  const file = path.join(here, 'claude');
  fs.writeFileSync(file, ['#!/bin/sh', `echo "$*" >> "${here}/args.txt"`, `cat > "${here}/prompt.txt"`, 'sleep 1', `echo "${reply}"`, `exit ${code}`].join('\n'));
  fs.chmodSync(file, 0o755);
  const read = (name: string) => (fs.existsSync(path.join(here, name)) ? fs.readFileSync(path.join(here, name), 'utf8') : '');
  return { agent: `${file} -p`, args: () => read('args.txt').trim().split('\n').filter(Boolean), prompt: () => read('prompt.txt') };
}

async function pageFor(s: Sandbox, agent: string, ...args: string[]) {
  const page = await startPage({ sandbox: s, env: ON }, ...args, '--agent', agent);
  const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
  const post = async (action: string, body: unknown) => {
    const res = await fetch(`${page.url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) });
    return { status: res.status, ...((await res.json()) as { ok: boolean; text: string; answers?: string }) };
  };
  return { page, board, post };
}

test('a one-liner gets Haiku, anything longer Sonnet, run reading only and signed with the model', () => {
  assert.equal(quickModel('ok, ship it'), 'haiku');
  assert.equal(quickModel('Could the jump arc be a little higher, and the landing softer? It feels stiff on the second level.'), 'sonnet');
  assert.equal(quickModel('two\nlines'), 'sonnet');
  assert.deepEqual([signedAs('haiku'), signedAs('sonnet')], ['Claude Haiku', 'Claude Sonnet']);
  assert.equal(claudeOf('claude -p --output-format stream-json'), 'claude');
  assert.equal(claudeOf('/opt/bin/claude --print'), '/opt/bin/claude');
  assert.equal(claudeOf('./worker.sh -p'), undefined, 'only claude, whose flags Spool knows');
  assert.equal(claudeOf('claude'), undefined, 'and only in print mode');
  const args = quickArgs('sonnet');
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'sonnet']);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
  assert.match(args[args.indexOf('--disallowedTools') + 1]!, /Bash.*Edit.*Write/);
});

test('a reply on a thread nobody is building shows Typing…, then a quick answer on the thread', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('log', jump, 'tried a gravity of 40; too floaty');
  const fake = quickClaude(s, 'Noted: a softer landing is added to the thread.');
  const state = s.json('show', jump).item.state;
  const { page, board, post } = await pageFor(s, fake.agent);
  try {
    const sent = await post('note', { id: jump, text: 'make the landing softer' });
    assert.deepEqual([sent.status, sent.answers], [200, 'quick']);
    // At once, and for as long as it is being written.
    const typing = (await board()).runner.typing;
    assert.deepEqual(typing.map((t: { id: string; who: string }) => [t.id, t.who]), [[jump, 'Claude Haiku']]);
    await until('the answer is on the thread', () => /Claude Haiku: Noted: a softer landing is added to the thread\./.test(s.item(jump)), { timeout: 15_000 });
    await until('Typing… ends', async () => (await board()).runner.typing.length === 0);
    // It was given the thread and their words, and run reading only.
    assert.match(fake.prompt(), /Tighten the jump arc[\s\S]*RECENT LOG[\s\S]*too floaty[\s\S]*THEIR MESSAGE\nmake the landing softer/);
    assert.match(fake.prompt(), /Nobody is building this thread/);
    assert.match(fake.args()[0]!, /^-p --model haiku .*--allowedTools Read,Grep,Glob/);
    assert.equal(s.json('show', jump).item.state, state, 'it answers; it never moves the thread');
  } finally {
    await page.stop();
  }
});

test('a quick reply that fails says so on the thread, and Typing… ends', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  const fake = quickClaude(s, 'not logged in', 1);
  const { page, board, post } = await pageFor(s, fake.agent);
  try {
    assert.equal((await post('note', { id: jump, text: 'why is it floaty?' })).answers, 'quick');
    await until('the thread says it did not come', () => /page: no quick reply: not logged in/.test(s.item(jump)), { timeout: 15_000 });
    assert.equal((await board()).runner.typing.length, 0);
  } finally {
    await page.stop();
  }
});

test('switched off, or with an agent that is not claude, nothing answers', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  const fake = quickClaude(s, 'hello');
  fs.mkdirSync(path.join(s.root, '.home', '.config', 'spool'), { recursive: true });
  fs.writeFileSync(path.join(s.root, '.home', '.config', 'spool', 'config.json'), JSON.stringify({ quickReply: false }));
  const { page, post } = await pageFor(s, fake.agent);
  try {
    assert.equal((await post('note', { id: jump, text: 'hello?' })).answers, 'none');
    await pause(300);
    assert.deepEqual(fake.args(), []);
  } finally {
    await page.stop();
  }
});

// One session of Claude's, a turn to each part, as in reply.test.ts.
const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');
const results = printed('two-turns', (e) => e.type === 'result');

test('a reply on a thread being built goes to its agent: Typing… until it is heard, and no quick reply', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const go = path.join(s.root, 'go');
  // It takes its prompt and starts; told something, it says nothing until `go`, then speaks and finishes.
  const fake = claude(s, ['hear', 'say first', 'hear', `while [ ! -f "${go}" ]; do sleep 0.1; done`, 'say over', 'spool done "$SPOOL_TASK" -m "finished" > /dev/null', 'while hear; do :; done'].join('\n'), {
    first: [init, said[0]!],
    over: [said[1]!, results[1]!],
  });
  const { page, board, post } = await pageFor(s, fake.agent, '--run');
  try {
    await until('the agent is heard', async () => (await board()).runner.running[0]?.lines.includes('apple'));
    const sent = await post('note', { id: jump, text: 'keep gravity at 34' });
    assert.deepEqual([sent.status, sent.answers], [200, 'agent']);
    await until('the agent is told', () => fake.heard(1)[1]?.message?.content === 'keep gravity at 34');
    const typing = await until('Typing… shows for its agent', async () => { const t = (await board()).runner.typing; return t.length > 0 && t; });
    assert.deepEqual(typing.map((t: { id: string; who: string }) => [t.id, t.who]), [[jump, '']]);
    fs.writeFileSync(go, '');
    await until('Typing… ends once it is heard', async () => (await board()).runner.typing.length === 0);
    assert.equal(fake.args().length, 1, 'only the agent was started: no quick reply on top of it');
  } finally {
    fs.writeFileSync(go, '');
    await page.stop();
  }
});
