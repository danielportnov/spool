/**
 * A run that was cut off carries on when Spool comes back: a page killed outright leaves its
 * thread handed out, and the next page to start picks the agent's session up where it was.
 *
 * The stand-in agent speaks lines recorded from Claude Code (see test/claude.ts).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claude, printed } from './claude.ts';
import { type Page, Sandbox, gone, startPage, until } from './helpers.ts';

const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');
const results = printed('two-turns', (e) => e.type === 'result');
const turns = { first: [init, said[0]!], over: [init, said[1]!, results[1]!] };

/**
 * The first run works until its page dies, and then works on, as Claude does to the end of its
 * turn: it leaves its pid, and would leave `late.txt` if nothing ended it. A run that picks the
 * session up finishes the thread.
 */
const AGENT = [
  'hear',
  'if [ -n "$resumed" ]; then spool done "$SPOOL_TASK" -m "finished after the restart" > /dev/null; say over; while hear; do :; done; exit 0; fi',
  'say first',
  'while hear; do :; done',
  'echo $$ > "$here/left.pid"',
  'sleep 20',
  'echo late > "$here/late.txt"',
].join('\n');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Start a page with agents on, wait for the agent to be at work, and kill the page outright. */
async function cutOff(s: Sandbox, fake: { agent: string; read: (name: string) => string }, started: Page[]): Promise<number> {
  const page = await startPage(s, '--run', '--agent', fake.agent);
  started.push(page);
  await until('the agent is heard working', async () => ((await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>).runner.running[0]?.lines.includes('apple'));
  page.child.kill('SIGKILL');
  await gone(page.child);
  // Its input closed with the page, and it works on.
  return Number(await until('the agent has noticed', () => fake.read('left.pid').trim()));
}

test('a page killed mid-run: the next page carries the thread on in its session, and ends what was left of the agent first', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const fake = claude(s, AGENT, turns);
  const started: Page[] = [];
  try {
    const left = await cutOff(s, fake, started);
    assert.equal(s.json('show', jump).item.state, 'active', 'left marked as handed out');
    assert.equal(alive(left), true, 'and its agent is still there');

    const next = await startPage(s, '--run', '--agent', fake.agent);
    started.push(next);
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    const [first, second] = fake.args();
    const session = / --session-id (\S+)$/.exec(first!)![1]!;
    assert.equal(second, first!.replace('--session-id', '--resume'), 'the same session, picked up');
    assert.match(fake.prompt(2), /it is yours again: t-\w+ Tighten the jump arc\n\nSpool was stopped while you were working, and is back\./);
    const item = s.item(jump);
    assert.match(item, new RegExp(`page: its page had stopped with nobody working it; carried on where it was\n.*page: handed to \`[^\`]*--resume ${session}\``));
    assert.doesNotMatch(item, /back in build/, 'it never left Building');
    assert.equal(s.json('show', jump).item.summary, 'finished after the restart');
    // The agent the dead page had started is gone: it was ended before its session was picked up.
    assert.deepEqual([alive(left), fake.read('late.txt')], [false, '']);
  } finally {
    for (const page of started) await page.stop();
    s.cleanup();
  }
});

test('with agents off when Spool comes back, the thread waits in Build, and is carried on in its session once they are on', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const fake = claude(s, AGENT, turns);
  const started: Page[] = [];
  try {
    const left = await cutOff(s, fake, started);
    const next = await startPage(s, '--agent', fake.agent);
    started.push(next);
    await until('the thread is back in build', () => s.json('show', jump).item.state === 'ready');
    assert.match(s.item(jump), /page: its page had stopped with nobody working it; back in build/);
    assert.equal(alive(left), false, 'nobody is working it, as its log says');

    const on = await fetch(`${next.url}api/runner`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': next.token }, body: '{"on":true}' });
    assert.equal(on.status, 200);
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    assert.equal(fake.args()[1], fake.args()[0]!.replace('--session-id', '--resume'));
    assert.match(fake.prompt(2), /Spool was stopped while you were working, and is back\./);
  } finally {
    for (const page of started) await page.stop();
    s.cleanup();
  }
});
