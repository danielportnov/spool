/**
 * `spool open`: a thread's Claude session, lent to the terminal and given back.
 *
 * The stand-in `claude` (test/claude.ts) is the page's agent when it runs with `-p`, and Claude
 * Code at the user's terminal when it runs without: then it notes the session it was opened in,
 * and does what the test says the user did there.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claude, printed } from './claude.ts';
import { type Page, Sandbox, startPage, until } from './helpers.ts';

const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');
const results = printed('two-turns', (e) => e.type === 'result');
const turns = { first: [init, said[0]!], over: [init, said[1]!, results[1]!] };

/**
 * Opened at the terminal (no -p): note the session and the folder, and finish the thread if the
 * test said the user did. As the page's agent: the first run works until it is stopped; a run
 * that picks the session up finishes the thread.
 */
const AGENT = [
  'case " $* " in *" -p "*) ;; *)',
  '  echo "$sid ${resumed:-new} $(pwd)" >> "$here/opened.txt"',
  '  if [ -f "$here/finish-at-terminal" ]; then spool done "$SPOOL_TASK" -m "finished at the terminal" > /dev/null; fi',
  '  exit 0;;',
  'esac',
  'hear',
  'if [ -n "$resumed" ]; then spool done "$SPOOL_TASK" -m "finished after the hand-back" > /dev/null; say over; while hear; do :; done; exit 0; fi',
  'say first',
  'while hear; do :; done',
].join('\n');

const env = (s: Sandbox, agent: string): Record<string, string> => ({ SPOOL_AGENT: agent, PATH: process.env.PATH ?? '' });

test('open a thread being built, quit, hand it back: the page carries it on in the same session, and it finishes', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const fake = claude(s, AGENT, turns);
  let page: Page | undefined;
  try {
    page = await startPage(s, '--run', '--agent', fake.agent);
    const at = page.url;
    await until('the agent is heard working', async () => ((await (await fetch(`${at}api/board`)).json()) as Record<string, any>).runner.running[0]?.lines.includes('apple'));
    const session = / --session-id (\S+)$/.exec(fake.args()[0]!)![1]!;

    const opened = s.exec(['open', jump], { env: env(s, fake.agent), stdin: 'h\n' });
    assert.equal(opened.code, 0, opened.err);
    // The page's agent let go first, and the terminal was Claude Code, in that session, where it ran.
    assert.equal(fake.read('opened.txt').trim(), `${session} yes ${s.root}`);
    assert.match(opened.out, /is not done\. Hand it back to the agent to finish \(h\), or leave it stopped \(s\)\?/);
    assert.match(opened.out, /Handed back: Tighten the jump arc\. The page’s agent carries it on in this same session/);
    const item = s.item(jump);
    assert.match(item, /page: stopped from the page; back in build\n.*human: opened in Claude Code, in session \S+\n.*human: handed back from Claude Code; back in build/);

    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    const last = fake.args().at(-1)!;
    assert.match(last, new RegExp(`^-p .*--resume ${session}$`), 'the page picked the same session up again');
    assert.match(fake.prompt(fake.args().length), /opened this session in Claude Code and worked in it with you, and has now handed the thread back to you to finish/);
    assert.equal(s.json('show', jump).item.summary, 'finished after the hand-back');
  } finally {
    await page?.stop();
    s.cleanup();
  }
});

test('done in Claude Code is done; left stopped, the page does not take it; a thread nobody started opens in a new session with its brief', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const coins = s.id('task', 'Outline the coins');
  const fake = claude(s, AGENT, turns);
  try {
    assert.match(s.fails('open', coins), /is in the backlog/);
    s.sp('build', coins);

    const stopped = s.exec(['open', coins, '--then', 'stop'], { env: env(s, fake.agent) });
    assert.equal(stopped.code, 0, stopped.err);
    const [sid, how] = fake.read('opened.txt').trim().split(' ');
    assert.equal(how, 'new', 'a new session, as nobody had one');
    assert.match(fake.args()[0]!, new RegExp(`^--session-id ${sid} You are working one task from a Spool queue, with the user at the keyboard`));
    assert.match(fake.read('args.txt'), /YOUR TASK\n\n.*Outline the coins/);
    assert.match(stopped.out, /Left stopped in Build/);
    assert.equal(s.json('show', coins).item.state, 'ready');
    assert.match(s.item(coins), /human: stopped in Claude Code; back in build/);

    // Opened again, it goes back into that session, and finishing there finishes the thread.
    s.write('claude-bin/finish-at-terminal', '');
    const done = s.exec(['open', coins], { env: env(s, fake.agent) });
    assert.equal(done.code, 0, done.err);
    assert.equal(fake.read('opened.txt').trim().split('\n')[1]!.split(' ').slice(0, 2).join(' '), `${sid} yes`);
    assert.match(done.out, /Done: Outline the coins\. It was finished in Claude Code\./);
    assert.equal(s.json('show', coins).item.status, 'done');
    assert.match(s.fails('open', coins), /is done/);
  } finally {
    s.cleanup();
  }
});

test('a thread another agent is building is not taken from it', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const coins = s.id('task', 'Outline the coins');
  s.sp('build', coins);
  s.sp('start', coins, '--as', 'Codex');
  assert.match(s.fails('open', coins), /is being built by Codex/);
  s.cleanup();
});
