import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { CLI, Sandbox } from './helpers.ts';

/** Start the real watcher and collect what it prints. */
function startWatch(s: Sandbox): { child: ChildProcess; lines: string[]; until: (n: number) => Promise<void> } {
  const child = spawn(process.execPath, [CLI, 'watch', '--interval', '40', '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  const until = async (n: number): Promise<void> => {
    for (let i = 0; i < 200 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 25));
    if (lines.length < n) throw new Error(`waited for ${n} line(s), got: ${JSON.stringify(lines)}`);
  };
  return { child, lines, until };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

test('the watcher prints a line the moment the human gives the loop something to do, and nothing otherwise', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const { child, lines, until } = startWatch(s);
  try {
    await settle();
    assert.deepEqual(lines, [], 'what was already there is not news');

    // Proposed work arriving is not something to build, so it is not news either.
    s.sp('task', 'A Grand Prix mode');
    await settle();
    assert.deepEqual(lines, []);

    // Moved to build: one line, naming the thread.
    s.sp('build', jump);
    await until(1);
    assert.equal(lines[0], `build: ${jump} Tighten the jump arc`);

    // A reply on a thread, in the human's words.
    const note = s.id('capture', 'snappy, not heavy');
    await until(2);
    assert.equal(lines[1], `unfiled: ${note} "snappy, not heavy"`);
    s.sp('file', note, '--into', jump);
    await until(3);
    assert.equal(lines[2], `reply: ${jump} Tighten the jump arc — "snappy, not heavy"`);

    // An answer frees a thread: that is work to build too.
    s.sp('build', coins);
    await until(4);
    s.sp('ask', 'Outline, or teal?', '--option', 'Outline', '--option', 'Teal', '--for', coins);
    await settle();
    assert.equal(lines.length, 4, 'a thread that stops being buildable is not news');
    s.sp('answer', s.json('review').questions[0].id, '1');
    await until(5);
    assert.equal(lines[4], `build: ${coins} Make coins readable at sunset`);

    // Claiming and finishing are the loop's own doing, and say nothing.
    s.sp('start', jump);
    s.sp('done', jump, '-m', 'Snappier');
    await settle();
    assert.equal(lines.length, 5);
  } finally {
    child.kill();
    s.cleanup();
  }
});

test('the watcher says so where there is no spool, and checks its interval', () => {
  const s = new Sandbox();
  assert.match(s.fails('watch'), /no \.spool|spool init/i);
  s.sp('init');
  assert.match(s.fails('watch', '--interval', '5'), /--interval is in milliseconds, 20 or more/);
  s.cleanup();
});
