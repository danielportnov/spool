import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as http from 'node:http';
import { test } from 'node:test';
import { CLI, Sandbox } from './helpers.ts';

/** Start the real server for a project and wait for the address it prints. */
function startPage(s: Sandbox, ...args: string[]): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '-C', s.root, ...args], {
    env: { ...process.env, HOME: `${s.root}/.home` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the page did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const found = /Spool page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolve({ child, url: found[1]! });
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  });
}

test('the page shows the spool as a board, and what is done on it is saved to the spool', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const question = s.json('review').questions[0].id;

  const { child, url } = await startPage(s, '--port', String(41000 + (process.pid % 2000)));
  try {
    // The page carries the token its own buttons need; nothing else on the machine is told it.
    const html = await (await fetch(url)).text();
    assert.match(html, /<title>Spool<\/title>/);
    const token = /const TOKEN = '([\w-]{20,})';/.exec(html)![1]!;
    const board = async () => (await (await fetch(`${url}api/board`)).json()) as Record<string, any>;
    const post = (action: string, body: unknown, headers: Record<string, string> = { 'x-spool-token': token }) =>
      fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Four columns, each thread in the one that says where it stands, numbered as the loop numbers them.
    let b = await board();
    assert.deepEqual([b.project, b.gate], ['skyhop', true]);
    assert.deepEqual(Object.keys(b.columns), ['proposed', 'build', 'building', 'done']);
    assert.deepEqual(b.columns.proposed.map((c: any) => [c.n, c.id, c.title, c.difficulty, c.priority]), [[2, jump, 'Tighten the jump arc', 'Small', 'High']]);
    assert.deepEqual(b.columns.build.map((c: any) => [c.n, c.id]), [[1, coins]]);
    assert.deepEqual(b.columns.build[0].question, { id: question, title: 'Outline the coins, or turn them teal?', options: ['Outline', 'Teal'], recommend: 1 });

    // Pressing play is the human moving it to build, and it is on the record as theirs.
    assert.equal((await post('move', { id: jump, to: 'build' })).status, 200);
    assert.equal(s.json('show', jump).item.state, 'ready');
    assert.match(s.item(jump), /human: moved to build/);
    assert.equal((await post('move', { id: jump, to: 'proposed' })).status, 200);
    assert.equal(s.json('show', jump).item.state, 'proposed');

    // A note lands on the thread in their words; an idea with no thread waits in the inbox to be filed.
    assert.equal((await post('note', { id: coins, text: 'two pixels, not one -- and "bold"' })).status, 200);
    assert.match(s.item(coins), /> two pixels, not one -- and "bold"\n> — \[\[n-/);
    assert.equal((await post('note', { text: 'add a mute button to settings' })).status, 200);
    assert.match(s.sp('inbox'), /add a mute button to settings/);

    // An answer unblocks the thread it was holding.
    assert.equal((await post('answer', { id: question, choice: '2' })).status, 200);
    assert.equal(s.json('show', question).item.choice, 'Teal');
    b = await board();
    assert.equal(b.columns.build[0].question, null);
    assert.equal(b.also.inbox, 1);

    // It refuses what it should: no token, a name that is not this machine, a move it does not offer.
    assert.equal((await post('move', { id: jump, to: 'build' }, {})).status, 403);
    assert.equal(s.json('show', jump).item.state, 'proposed', 'nothing moved without the token');
    // fetch will not send another Host, so this one goes out by hand, the way a rebound name would arrive.
    const asOtherSite = await new Promise<number>((resolve, reject) => {
      http.get(`${url}api/board`, { headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject);
    });
    assert.equal(asOtherSite, 403);
    const refused = await post('move', { id: jump, to: 'done' });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { text: string }).text, /moved to build, or back to proposed/);
    assert.equal((await post('note', { id: coins, text: '   ' })).status, 400);
    assert.equal((await fetch(`${url}nope`)).status, 404);
  } finally {
    child.kill();
    s.cleanup();
  }
});

test('the page says so where there is no spool', () => {
  const s = new Sandbox();
  assert.match(s.fails('page', '--no-open'), /no \.spool|spool init/i);
  s.cleanup();
});
