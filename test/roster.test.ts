import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox, gone, startPage, until, watchUp } from './helpers.ts';

const configFile = (s: Sandbox): string => path.join(s.root, '.home', '.config', 'spool', 'config.json');

/** A git project built by chats, with `n` threads in Build. */
function chatProject(n: number): { s: Sandbox; threads: string[] } {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.gitInit();
  s.write('.gitignore', '.home/\n');
  s.commitAll('start');
  s.sp('builder', 'chat');
  const threads = Array.from({ length: n }, (_, i) => s.id('task', `Thread ${i + 1}`));
  for (const t of threads) s.sp('build', t);
  return { s, threads };
}

test('Claude and Codex are on the roster to start with, each at the shared number, and each can be set', () => {
  const { s } = chatProject(0);
  try {
    assert.deepEqual(
      s.json('builder').agents.map((a: any) => [a.name, a.atOnce, a.watching]),
      [['Claude', 3, false], ['Codex', 3, false]],
    );
    assert.match(s.sp('builder', '--agent', 'Claude', '--at-once', '3'), /\nAgents: Claude 3 at once, not watching · Codex 3 at once, not watching\. Set one: spool builder --agent <name> --at-once <n> \[--sizes xs-m\] \[--lean <stop>\]\n {2}Claude, leaning balanced: xs haiku, s sonnet, m opus, l opus·high, xl opus·xhigh\n {2}Codex, leaning balanced: xs gpt-6-luna, s gpt-6\.1-terra, m gpt-6\.1-sol, l gpt-6\.1-sol·high, xl gpt-6\.1-sol·xhigh$/);
    assert.match(s.sp('builder', '--agent', 'codex', '--at-once', '2'), /Codex 2 at once/);
    // One entry adds an agent, with the model it builds on.
    assert.match(s.sp('builder', '--agent', 'Gemini', '--at-once', '1', '--model', 'gemini-3'), /Gemini 1 at once on gemini-3, not watching/);
    const kept = JSON.parse(fs.readFileSync(configFile(s), 'utf8')).roster[s.root];
    assert.deepEqual(kept.map((e: any) => [e.name, e.atOnce]), [['Claude', 3], ['Codex', 2], ['Gemini', 1]]);
    // An agent asking is told its own count; anyone else, the shared one.
    assert.match(s.sp('builder', '--as', 'Codex GPT-6'), /The chat builds 2 threads at once/);
    assert.match(s.sp('builder', '--as', 'Claude Opus 5.5'), /The chat builds 3 threads at once/);
    assert.match(s.fails('builder', '--model', 'opus'), /--model goes with --agent/);
    assert.match(s.fails('builder', '--agent', 'Codex', '--at-once', '0'), /is not a number of threads/);
  } finally {
    s.cleanup();
  }
});

test('Claude at 3 and Codex at 2 build at once, neither past its count, and neither takes the other\'s threads', () => {
  const { s, threads } = chatProject(6);
  try {
    s.sp('builder', '--agent', 'Claude', '--at-once', '3');
    s.sp('builder', '--agent', 'Codex', '--at-once', '2');
    const codex = [s.sp('next', '--claim', '--as', 'Codex GPT-6'), s.sp('next', '--claim', '--as', 'Codex')].map((out) => out.split(/\s/)[0]!);
    assert.match(s.fails('next', '--claim', '--as', 'Codex GPT-6'), /Codex is at its 2 threads: .*\n.*spool builder --agent Codex --at-once 3/);
    for (let i = 0; i < 3; i++) s.sp('next', '--claim', '--as', 'Claude Opus 5.5');
    assert.match(s.fails('next', '--claim', '--as', 'Claude Opus 5.5'), /Claude is at its 3 threads/);
    // Codex cannot take one of Claude's: it is being worked.
    const claude = threads.filter((t) => !codex.includes(t)).slice(0, 3);
    assert.match(s.fails('start', claude[0]!, '--as', 'Codex'), /is being worked by Claude Opus 5.5/);
    // Picking up its own again is no new claim.
    s.sp('start', codex[0]!, '--as', 'Codex GPT-6');
    const agents = s.json('builder').agents;
    assert.deepEqual(agents.map((a: any) => [a.name, a.building.length]), [['Claude', 3], ['Codex', 2]]);
    assert.match(s.sp('status'), /\n {2}Agents: Claude 3 at once, not watching, building t-\S+, t-\S+, t-\S+ · Codex 2 at once, not watching, building t-\S+, t-\S+\n/);
    // Done with one, Codex takes the next.
    s.sp('done', codex[0]!, '-m', 'did it');
    assert.match(s.sp('next', '--claim', '--as', 'Codex GPT-6'), /^t-/);
    // Headless, the page's own agents are not held to the roster.
    s.sp('builder', 'headless');
    assert.match(s.sp('start', threads.find((t) => !codex.includes(t) && !claude.includes(t))!, '--as', 'Codex'), /^t-/);
  } finally {
    s.cleanup();
  }
});

test('a watch says which agent it is, and the board shows each agent, its count, what it builds, and the count set from the page', async () => {
  const { s } = chatProject(1);
  const watcher = spawn(process.execPath, [CLI, 'watch', '--as', 'Codex GPT-6', '--interval', '100', '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined },
    stdio: 'ignore',
  });
  const page = await startPage(s);
  try {
    await watchUp(watcher.pid);
    // Claimed on the real clock, as the page reads it: on the sandbox's, the claim would look long quiet.
    execFileSync(process.execPath, [CLI, 'next', '--claim', '--as', 'Codex GPT-6', '-C', s.root], { env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined } });
    const agents = async (): Promise<any[]> => ((await (await fetch(`${page.url}api/board`)).json()) as any).runner.agents;
    const seen = await until('the board shows what Codex builds', async () => {
      const now = await agents();
      return now[1].building.length ? now : undefined;
    });
    assert.deepEqual(seen.map((a) => [a.name, a.atOnce, a.watching, a.building.length]), [['Claude', 3, false, 0], ['Codex', 3, true, 1]]);
    assert.deepEqual([seen[1].model, seen[1].how, seen[1].listed, !!Date.parse(seen[1].since)], ['gpt-6', 'Chat loop', true, true]);
    assert.match(s.sp('status'), /Codex 3 at once on gpt-6, watching since \d\d:\d\d, building t-/);
    const res = await fetch(`${page.url}api/roster`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify({ agent: 'Codex', atOnce: 2 }) });
    assert.match(((await res.json()) as any).text, /Codex builds up to 2 threads at once/);
    await until('the board shows the new count', async () => (await agents())[1].atOnce === 2);
    const bad = await fetch(`${page.url}api/roster`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify({ agent: 'Codex', atOnce: 0 }) });
    assert.equal(bad.status, 400);
  } finally {
    watcher.kill('SIGTERM');
    await gone(watcher);
    await page.stop();
    s.cleanup();
  }
});

test('an agent set to medium at most never claims a large thread, and Claude still does', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    s.gitInit();
    s.write('.gitignore', '.home/\n');
    s.commitAll('start');
    s.sp('builder', 'chat');
    const big = s.sp('task', 'A large one', '--size', 'l').match(/t-\w+/)![0];
    const plain = s.sp('task', 'No size given').match(/t-\w+/)![0];
    const small = s.sp('task', 'A small one', '--size', 's').match(/t-\w+/)![0];
    for (const t of [big, plain, small]) s.sp('build', t);
    assert.match(s.sp('builder', '--agent', 'Codex', '--max-size', 'm'), /Codex 3 at once, up to M/);
    assert.deepEqual(s.json('builder').agents.find((a: any) => a.name === 'Codex').sizes, ['xs', 'm']);
    assert.match(s.sp('builder', '--agent', 'Claude'), /Claude 3 at once, not watching/);
    // Codex is handed only what it takes, and no size counts as medium.
    const got = [s.sp('next', '--claim', '--as', 'Codex GPT-6'), s.sp('next', '--claim', '--as', 'Codex GPT-6')].map((o) => o.match(/t-\w+/)![0]);
    assert.deepEqual(got.sort(), [plain, small].sort());
    assert.match(s.sp('next', '--claim', '--as', 'Codex GPT-6'), /Nothing ready is in the sizes you take/);
    assert.match(s.fails('start', big, '--as', 'Codex GPT-6'), /is L, and Codex takes up to M/);
    // Claude takes the large one.
    assert.match(s.sp('next', '--claim', '--as', 'Claude Opus 5.5'), new RegExp(big));
    assert.match(s.fails('builder', '--max-size', 'm'), /--sizes goes with --agent/);
    assert.match(s.fails('builder', '--agent', 'Codex', '--sizes', 'm-xs'), /runs from large to small/);
    assert.match(s.sp('builder', '--agent', 'Codex', '--sizes', 'all'), /Codex 3 at once, not watching/);
  } finally {
    s.cleanup();
  }
});

test('a watch by an agent that is not on the roster is shown anyway', async () => {
  const { s } = chatProject(1);
  const watcher = spawn(process.execPath, [CLI, 'watch', '--as', 'Gemini 3', '--interval', '100', '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined },
    stdio: 'ignore',
  });
  try {
    await watchUp(watcher.pid);
    const agents = s.json('builder').agents;
    const g = agents.find((a: any) => a.name === 'Gemini');
    assert.deepEqual([g.watching, g.listed, g.how, g.model], [true, false, 'Another agent', '3']);
    assert.match(s.sp('status'), /Gemini \(not on the roster\) .*watching since/);
  } finally {
    watcher.kill('SIGTERM');
    await gone(watcher);
    s.cleanup();
  }
});
