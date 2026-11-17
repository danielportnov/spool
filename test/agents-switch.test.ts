import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox, startPage } from './helpers.ts';

/** The page's record, where src/detach.ts keeps it. */
function recordFile(s: Sandbox): string {
  return path.join(s.root, '.home', '.config', 'spool', 'pages', `${createHash('sha256').update(s.root).digest('hex').slice(0, 16)}.json`);
}

test('spool agents says whether the page’s agents are on, and switches them as the button does', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  assert.equal(s.sp('agents'), 'No Spool page is up for this project. spool page -d --run starts one with agents on.');
  assert.match(s.fails('agents', 'on'), /no Spool page is up for this project\n {2}spool page -d --run starts one with agents on/);
  assert.match(s.sp('agents', 'off'), /^No Spool page is up/, 'stopping what is not running is no failure');
  assert.match(s.fails('agents', 'sideways'), /"sideways" is not on or off/);

  const { url, stop } = await startPage(s);
  const board = async () => (await (await fetch(`${url}api/board`)).json()) as { runner: { on: boolean } };
  try {
    // The token is in the record, which only this user may read.
    assert.equal(fs.statSync(recordFile(s)).mode & 0o777, 0o600);
    assert.match(JSON.parse(fs.readFileSync(recordFile(s), 'utf8')).token, /^[\w-]{20,}$/);

    assert.equal(s.sp('agents'), `The page at ${url} has its agents off.`);
    assert.equal(s.sp('agents', 'on'), 'Agents are on: this page builds what is in Build.', 'in the page’s own words');
    assert.equal((await board()).runner.on, true);
    assert.deepEqual(s.json('agents'), { project: 'skyhop', page: url, builder: 'headless', on: true });
    assert.equal(s.sp('agents', 'off'), 'Agents are off.');
    assert.equal((await board()).runner.on, false);

    // With a chat building, the page starts nothing: on is refused in words, off still goes through.
    s.sp('builder', 'chat');
    assert.match(s.fails('agents', 'on'), /a chat builds skyhop, so the page starts no agents\n {2}Have the page build first: spool builder headless/);
    assert.equal((await board()).runner.on, false);
    assert.equal(s.sp('agents', 'off'), 'Agents are off.');
    assert.match(s.sp('agents'), /A chat builds here \(Chat\)/);
  } finally {
    await stop();
    s.cleanup();
  }
});

test('where the gate is locked, an agent is refused on, but may always switch them off', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--lock');
  const { url, stop } = await startPage(s);
  const board = async () => (await (await fetch(`${url}api/board`)).json()) as { runner: { on: boolean } };
  try {
    assert.match(s.fails('agents', 'on'), /spool agents on is the user's alone in skyhop: its gate is locked/);
    assert.equal((await board()).runner.on, false);
    assert.equal(s.sp('agents', 'off'), 'Agents are off.');
    // The user, at their own terminal, may.
    assert.equal(s.exec(['agents', 'on'], { tty: true }).out, 'Agents are on: this page builds what is in Build.');
    assert.equal((await board()).runner.on, true);
    assert.equal(s.sp('agents', 'off'), 'Agents are off.');
    assert.equal((await board()).runner.on, false);
  } finally {
    await stop();
    s.cleanup();
  }
});
