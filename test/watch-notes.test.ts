import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { CLI, Sandbox, watchUp } from './helpers.ts';

function startWatch(s: Sandbox): { child: ChildProcess; lines: string[] } {
  const child = spawn(process.execPath, [CLI, 'watch', '--interval', '40', '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  return { child, lines };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a note filed straight after it is captured is never reported, one left unfiled is', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const { child, lines } = startWatch(s);
  try {
    await watchUp(child.pid);
    await wait(250);
    // Captured and filed in the same breath, as the page's + Add does.
    const quick = s.id('capture', 'a Grand Prix mode');
    s.sp('task', 'A Grand Prix mode', '--from', quick);
    await wait(500);
    assert.deepEqual(lines, []);

    const slow = s.id('capture', 'snappy, not heavy');
    assert.deepEqual(lines, [], 'not reported at once');
    for (let i = 0; i < 100 && !lines.length; i++) await wait(25);
    assert.deepEqual(lines, [`unfiled: ${slow} "snappy, not heavy"`]);
  } finally {
    child.kill();
    s.cleanup();
  }
});
