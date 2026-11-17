import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { CLI, Sandbox, gone, pause, until as untilThat, watchUp } from './helpers.ts';

/** Start the real watcher and collect what it prints. */
function startWatch(s: Sandbox): { child: ChildProcess; lines: string[]; until: (n: number) => Promise<void> } {
  const child = spawn(process.execPath, [CLI, 'watch', '--interval', '40', '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  const until = async (n: number): Promise<void> => {
    await untilThat(`${n} line(s)`, () => lines.length >= n, { every: 25 }).catch(() => {
      throw new Error(`waited for ${n} line(s), got: ${JSON.stringify(lines)}`);
    });
  };
  return { child, lines, until };
}

const settle = (): Promise<void> => pause(250);

test('the watcher prints a line the moment the human gives the loop something to do, and nothing otherwise', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const { child, lines, until } = startWatch(s);
  try {
    await watchUp(child.pid);
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

    // A question an agent asks is news: the chat that builds puts it to the human. The thread it stops is not.
    s.sp('build', coins);
    await until(4);
    s.sp('ask', 'Outline, or teal?', '--option', 'Outline', '--option', 'Teal', '--for', coins);
    await until(5);
    const question = s.json('review').questions[0].id;
    assert.equal(lines[4], `ask: ${question} for ${coins} Make coins readable at sunset — "Outline, or teal?" 1) Outline  2) Teal`);
    await settle();
    assert.equal(lines.length, 5, 'a thread that stops being buildable is not news');

    // An answer frees a thread: that is work to build too. The question going is not news.
    s.sp('answer', question, '1');
    await until(6);
    assert.equal(lines[5], `build: ${coins} Make coins readable at sunset`);

    // Claiming and finishing are the loop's own doing, and say nothing.
    s.sp('start', jump);
    s.sp('done', jump, '-m', 'Snappier');
    await settle();
    assert.equal(lines.length, 6);
  } finally {
    child.kill();
    await gone(child);
    s.cleanup();
  }
});

test('the watcher tells of each question once, as it is asked, with its recommendation; a call an agent made itself is not one', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('ask', 'Which licence?', '--option', 'MIT', '--option', 'Apache');
  const { child, lines, until } = startWatch(s);
  try {
    await watchUp(child.pid);
    await settle();
    assert.deepEqual(lines, [], 'a question already waiting is not news');

    s.sp('assume', 'Coin size', '--chose', '12px', '--for', coins);
    await settle();
    assert.deepEqual(lines, [], 'a receipt waits for their review, it asks nothing');

    s.sp('ask', 'Outline, or teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '2', '--for', coins);
    s.sp('ask', 'Ship the beta to testers?');
    await until(2);
    const asked = (title: string): string => s.json('review').questions.find((d: { title: string }) => d.title === title).id;
    const outline = asked('Outline, or teal?');
    const beta = asked('Ship the beta to testers?');
    assert.deepEqual(lines, [
      `ask: ${outline} for ${coins} Make coins readable at sunset — "Outline, or teal?" 1) Outline  2) Teal (recommended)`,
      `ask: ${beta} "Ship the beta to testers?"`,
    ]);

    s.sp('answer', beta, 'Not yet');
    await settle();
    assert.equal(lines.length, 2, 'once only');
  } finally {
    child.kill();
    await gone(child);
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
