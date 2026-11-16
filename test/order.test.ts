import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { board } from '../src/page.ts';
import { Workspace } from '../src/store.ts';
import { CLI, Sandbox, startPage, until } from './helpers.ts';

/** Three threads in build, which the usual rule takes smallest first: coins, pause, jump. */
function three(): { s: Sandbox; jump: string; coins: string; pause: string } {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 'm');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const pause = s.id('task', 'Pause button under the score', '-s', 's');
  s.sp('build', jump, coins, pause);
  return { s, jump, coins, pause };
}

const buildColumn = (s: Sandbox): string[] => {
  const ws = Workspace.open(s.dir, () => new Date());
  try {
    return board(ws).columns.build.map((c) => c.id);
  } finally {
    ws.close();
  }
};
const nextUp = (s: Sandbox): string => s.json('next').task.id;

test('the order the human sets is the order next hands work out, and the order Build is drawn in', () => {
  const { s, jump, coins, pause } = three();
  try {
    assert.deepEqual(buildColumn(s), [coins, pause, jump], 'the usual rule, before anyone says otherwise');

    const placed = s.json('order', jump, '--first');
    assert.deepEqual(placed.order, [jump, coins, pause]);
    assert.deepEqual(buildColumn(s), [jump, coins, pause]);
    assert.match(s.item(jump), /^place: 1$/m);
    assert.match(s.item(jump), /human: placed first in build/);

    s.sp('order', pause, '--before', coins);
    assert.deepEqual(buildColumn(s), [jump, pause, coins]);

    // next hands them out top first, and each one taken leaves the line.
    for (const want of [jump, pause, coins]) {
      assert.equal(nextUp(s), want);
      s.sp('start', want);
      assert.doesNotMatch(s.item(want), /^place:/m, 'taken, it has left Build');
    }

    // The loop's numbered list agrees with the board.
    const { s: t, jump: j, coins: c, pause: p } = three();
    try {
      t.sp('order', c, '--last');
      t.sp('order', j, '--after', p);
      assert.deepEqual(buildColumn(t), [p, j, c]);
      const rows = t.sp('overview', '--table').split('\n').filter((l) => /^\| \d/.test(l));
      assert.deepEqual(rows.map((l) => l.split('|')[2]!.trim()), ['**Pause button under the score**', '**Tighten the jump arc**', '**Make coins readable at sunset**']);
    } finally {
      t.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test('a place goes ahead of priority; new work without one follows by the usual rule; leaving Build clears it', () => {
  const { s, jump, coins, pause } = three();
  try {
    s.sp('order', jump, '--first');
    const urgent = s.id('task', 'The game crashes on launch', '-s', 'xs', '-p', '0');
    s.sp('build', urgent);
    assert.deepEqual(buildColumn(s), [jump, urgent, coins, pause]);

    // Back to the backlog, its place goes: moved to build again, it is ordered like anything else.
    s.sp('propose', jump);
    assert.doesNotMatch(s.item(jump), /^place:/m);
    s.sp('build', jump);
    assert.deepEqual(buildColumn(s), [urgent, coins, pause, jump]);
  } finally {
    s.cleanup();
  }
});

test('order says what it needs, and only takes work that is in build', () => {
  const { s, jump, coins } = three();
  try {
    const later = s.id('task', 'A daily challenge level');
    assert.match(s.fails('order', jump), /say where it goes/);
    assert.match(s.fails('order', jump, '--first', '--before', coins), /say where it goes/);
    assert.match(s.fails('order', later, '--first'), /not in build[\s\S]*spool build/);
    assert.match(s.fails('order', jump, '--before', later), /not in build/);
    assert.match(s.fails('order', jump, '--before', jump), /next to itself/);
    assert.match(s.sp('help'), /order\s+Say where work in build is in line/);
  } finally {
    s.cleanup();
  }
});

/** A stand-in agent that writes down which thread it was given, then finishes it. */
function agent(s: Sandbox): string {
  const file = path.join(s.root, 'worker.sh');
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncat > /dev/null\necho "$SPOOL_TASK" >> "${path.join(s.root, 'built.txt')}"\n"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m built > /dev/null\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

test("the page's own runner builds Build top first, in the order set on the page", async () => {
  const { s, jump, coins, pause } = three();
  const { url, token, stop } = await startPage(s, '--agent', agent(s));
  const post = (action: string, body: unknown) =>
    fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
  try {
    // What a drop at a place in Build sends: jump to the top, then pause just under it.
    assert.equal((await post('order', { id: jump, before: coins })).status, 200);
    assert.equal((await post('order', { id: pause, after: jump })).status, 200);
    assert.equal((await post('order', { id: jump, before: 'not an id' })).status, 400);
    assert.deepEqual(buildColumn(s), [jump, pause, coins]);

    assert.equal((await post('runner', { on: true })).status, 200);
    const built = path.join(s.root, 'built.txt');
    await until('the last thread is built', () => s.json('show', coins).item.status === 'done');
    assert.deepEqual(fs.readFileSync(built, 'utf8').trim().split('\n'), [jump, pause, coins]);
  } finally {
    await stop();
    s.cleanup();
  }
});
