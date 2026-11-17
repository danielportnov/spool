import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { CLI, Sandbox, gone, pause, until, watchUp } from './helpers.ts';

function startWatch(s: Sandbox): { child: ChildProcess; lines: string[] } {
  const child = spawn(process.execPath, [CLI, 'watch', '--interval', '40', '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  return { child, lines };
}

test('a note filed straight after it is captured is never reported, one left unfiled is', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const { child, lines } = startWatch(s);
  try {
    await watchUp(child.pid);
    await pause(250);
    // Captured and filed in the same breath, as the page's + Add does.
    const quick = s.id('capture', 'a Grand Prix mode');
    s.sp('task', 'A Grand Prix mode', '--from', quick);
    await pause(500);
    assert.deepEqual(lines, []);

    const slow = s.id('capture', 'snappy, not heavy');
    assert.deepEqual(lines, [], 'not reported at once');
    await until('the unfiled note is reported', () => lines.length, { every: 25 });
    assert.deepEqual(lines, [`unfiled: ${slow} "snappy, not heavy"`]);
  } finally {
    child.kill();
    await gone(child);
    s.cleanup();
  }
});
