import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox, gone, startPage, until, watchUp } from './helpers.ts';

/** The lines of `spool status` under the project's count. */
function standing(s: Sandbox): string[] {
  return s.sp('status').split('\n').filter((line) => /^ {2}(Board|Build is not moving):/.test(line)).map((line) => line.trim());
}

test('with no page up, status says so and that nothing in Build moves without one, asking nothing', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    assert.deepEqual(standing(s), ['Board: not up (spool page -d starts it) · the page builds (Headless)'], 'an empty Build has no reason to give');
    const jump = s.id('task', 'Tighten the jump arc');
    s.sp('build', jump);
    const started = Date.now();
    assert.deepEqual(standing(s), [
      'Board: not up (spool page -d starts it) · the page builds (Headless)',
      'Build is not moving: no page is up to build it. spool page -d --run starts one with agents on.',
    ]);
    assert.ok(Date.now() - started < 1000, 'no page, no request');
    const board = s.json('status').projects[0].board;
    assert.deepEqual(board, { page: null, answering: null, builder: 'headless', agents: null, building: 0, watching: null, landing: null, stuck: 'no page is up to build it. spool page -d --run starts one with agents on.' });
  } finally {
    s.cleanup();
  }
});

test('with a page up, status asks it whether its agents are on, and says when they are off', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  // A stand-in agent that takes its time, so the thread is seen being built.
  const worker = path.join(s.root, 'worker.sh');
  fs.writeFileSync(worker, '#!/bin/sh\ncat > /dev/null\nsleep 30\n');
  fs.chmodSync(worker, 0o755);
  const { child, url, token, stop } = await startPage(s, '--agent', worker);
  try {
    assert.deepEqual(standing(s), [
      `Board: ${url} · the page builds (Headless), agents off`,
      'Build is not moving: the page’s agents are off. spool agents on, or the Agents switch on the page, starts them.',
    ]);
    const res = await fetch(`${url}api/runner`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify({ on: true }) });
    assert.equal(res.status, 200);
    await until('the thread is being built', () => s.json('show', jump).item.state === 'active');
    assert.deepEqual(standing(s), [`Board: ${url} · the page builds (Headless), agents on, 1 building`]);
    assert.deepEqual(
      [s.json('status').projects[0].board.agents, s.json('status').projects[0].board.answering, s.json('status').projects[0].board.stuck],
      [true, true, null],
    );

    // A page that does not answer is said to be up and not answering, not guessed at.
    child.kill('SIGSTOP');
    try {
      assert.deepEqual(standing(s)[0], `Board: ${url}, not answering · the page builds (Headless), 1 building`);
    } finally {
      child.kill('SIGCONT');
    }
  } finally {
    await stop();
    s.cleanup();
  }
});

test('with a chat building, status says whether one is watching, and what Build waits on', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  s.sp('builder', 'chat');
  assert.deepEqual(standing(s), [
    'Board: not up (spool page -d starts it) · a chat builds, but none is watching',
    'Build is not moving: a chat builds here, but none is watching. Say /spool-loop in a Claude Code chat in this project, or spool builder headless.',
  ]);

  const watcher = spawn(process.execPath, [CLI, 'watch', '--interval', '100', '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined },
    stdio: 'ignore',
  });
  try {
    await watchUp(watcher.pid);
    assert.deepEqual(standing(s), ['Board: not up (spool page -d starts it) · a chat builds, and one is watching'], 'a chat is about to take it: nothing to explain');

    // Everything in Build waits on an answer: that is the reason, with the question named.
    const d = s.id('ask', 'A high arc, or a low one?', '--option', 'High', '--option', 'Low', '--for', jump);
    assert.deepEqual(standing(s)[1], `Build is not moving: every thread in it is waiting. The first, ${jump}, waits on your answer to ${d} “A high arc, or a low one?”.`);
    assert.match(s.json('status').projects[0].board.stuck, /^every thread in it is waiting/);
  } finally {
    watcher.kill('SIGTERM');
    await gone(watcher);
    s.cleanup();
  }
});
