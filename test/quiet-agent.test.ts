/**
 * An agent that has printed nothing for the limit is marked quiet on the board and tells the
 * human once; past a longer limit, if one is set, it is stopped and its thread put back.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { claude, printed } from './claude.ts';
import { Sandbox, startPage, until } from './helpers.ts';

const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');

test('a quiet agent is marked on the board and notified once, and stopped at the longer limit', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  // Limits in minutes, tiny for the test: quiet after 1.2 s, stopped after 6 s.
  const dir = path.join(s.root, '.home', '.config', 'spool');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ quietMinutes: 0.02, quietStopMinutes: 0.1 }));
  const marker = path.join(s.root, 'notices.txt');
  const fake = claude(s, 'hear\nsay first\nsleep 60', { first: [init, said[0]!] });
  const page = await startPage({ sandbox: s, env: { SPOOL_NOTIFY: `echo "$SPOOL_EVENT $SPOOL_TITLE" >> "${marker}"` } }, '--run', '--agent', fake.agent);
  const running = async () => ((await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>).runner.running[0];
  try {
    await until('the agent is heard', async () => (await running())?.lines.includes('apple'));
    assert.equal((await running()).quiet, null, 'not quiet while it has just spoken');
    await until('it is marked quiet', async () => typeof (await running())?.quiet === 'number');
    await until('the human is told', () => fs.existsSync(marker));
    assert.match(fs.readFileSync(marker, 'utf8'), /^stuck Quiet: Tighten the jump arc/);
    await until('it is stopped and the thread put back', () => s.json('show', jump).item.state !== 'active', { timeout: 20_000 });
    assert.match(s.item(jump), /its agent has printed nothing for/);
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'told once');
  } finally {
    await page.stop();
    s.cleanup();
  }
});
