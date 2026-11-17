/**
 * Two chats claiming at once: the claim reads, checks and writes under the project's lock, so of
 * two processes only one gets the thread, and the other is told who has it.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox } from './helpers.ts';

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

/** Start a spool command as a process of its own, as another chat's shell would. */
function launch(s: Sandbox, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: s.dir, env: { ...process.env, HOME: path.join(s.root, '.home'), NO_COLOR: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function project(): { s: Sandbox; t: string } {
  const s = new Sandbox();
  s.sp('init', '--name', 'race', '--gate');
  s.sp('builder', 'chat');
  const t = s.id('task', 'One thread');
  s.sp('build', t);
  return { s, t };
}

const started = (item: string): number => (item.match(/: started/g) ?? []).length;

// Under different names (a Claude and a Codex chat), and under one (two chats of the same agent).
const PAIRS = [['Claude Opus 5.5', 'Codex GPT-6'], ['Claude Opus 5.5', 'Claude Opus 5.5']];

test('two processes running spool start on one thread at once: exactly one gets it, the other is told who has it', async () => {
  for (const names of PAIRS) {
    for (let round = 0; round < 3; round++) {
      const { s, t } = project();
      try {
        const ran = await Promise.all(names.map((n) => launch(s, ['start', t, '--as', n])));
        const won = ran.filter((r) => r.code === 0);
        const lost = ran.filter((r) => r.code !== 0);
        assert.equal(won.length, 1, `${names.join(' + ')}: ${JSON.stringify(ran)}`);
        assert.equal(lost.length, 1);
        assert.match(lost[0]!.err, new RegExp(`${t} is being worked by ${names[ran.indexOf(won[0]!)]}, claimed`));
        assert.equal(started(s.item(t)), 1, 'one start on the thread');
      } finally {
        s.cleanup();
      }
    }
  }
});

test('two processes running spool next --claim at once: exactly one gets the thread, the other is handed nothing', async () => {
  for (const names of PAIRS) {
    for (let round = 0; round < 3; round++) {
      const { s, t } = project();
      try {
        const ran = await Promise.all(names.map((n) => launch(s, ['next', '--claim', '--json', '--as', n])));
        const tasks = ran.map((r) => JSON.parse(r.out).task);
        assert.equal(tasks.filter((x) => x?.id === t).length, 1, `${names.join(' + ')}: ${JSON.stringify(ran)}`);
        assert.equal(tasks.filter((x) => x === null).length, 1);
        assert.equal(started(s.item(t)), 1);
      } finally {
        s.cleanup();
      }
    }
  }
});

test('a start and a next --claim at once under one name: one gets the thread', async () => {
  const { s, t } = project();
  try {
    const ran = await Promise.all([launch(s, ['start', t, '--as', 'Claude Opus 5.5']), launch(s, ['next', '--claim', '--json', '--as', 'Claude Opus 5.5'])]);
    assert.equal(started(s.item(t)), 1, JSON.stringify(ran));
  } finally {
    s.cleanup();
  }
});

test('a thread a chat has is refused to another chat of the same name; its own stopped work is taken back', () => {
  const { s, t } = project();
  try {
    s.sp('start', t, '--as', 'Claude Opus 5.5');
    // The same name does not say it is the same chat: refused, with who has it and since when.
    assert.match(s.fails('start', t, '--as', 'Claude Opus 5.5'), new RegExp(`${t} is being worked by Claude Opus 5.5, claimed just now`));
    assert.equal(s.json('next', '--claim', '--as', 'Claude Opus 5.5').task, null);
    // --force is how a builder takes its own back.
    s.sp('start', t, '--force', '--as', 'Claude Opus 5.5');
    // Stopped, it waits in build, and the same builder goes back into it.
    s.sp('build', '--abort', t);
    s.sp('start', t, '--as', 'Claude Opus 5.5');
  } finally {
    s.cleanup();
  }
});
