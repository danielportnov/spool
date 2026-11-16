import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox } from './helpers.ts';

const configFile = (s: Sandbox): string => path.join(s.root, '.home', '.config', 'spool', 'config.json');
const config = (s: Sandbox): Record<string, any> => JSON.parse(fs.readFileSync(configFile(s), 'utf8'));

test('spool builder reads, sets and reads back who builds and how many at once', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    // Not a git repository: its threads would share one folder, so one at a time, whatever is set.
    assert.match(s.sp('builder'), /The page builds skyhop, headless, 1 thread at once: it is not a git repository, so its threads cannot have a worktree each\. Switch its Agents on to start\./);
    s.gitInit();
    s.write('.gitignore', '.home/\n');
    s.commitAll('start');
    assert.match(s.sp('builder'), /The page builds skyhop, headless, 3 threads at once, each in a worktree of its own\. Switch its Agents on to start\./);
    assert.match(s.sp('builder', '--at-once', '1'), /The page builds skyhop, headless, 1 thread at once\. Switch/);
    assert.match(s.sp('builder', 'chat'), /A chat builds skyhop: say \/spool-loop in a Claude Code chat there\. The page starts no agents\./);
    assert.deepEqual(config(s).builder, { [s.root]: 'chat' });
    assert.equal(s.json('builder').builder, 'chat');
    assert.match(s.sp('builder', 'headless', '--at-once', '3'), /headless, 3 threads at once/);
    assert.equal(config(s).parallel, 3);
    assert.deepEqual(config(s).builder, {});
    assert.deepEqual(s.json('builder'), { project: 'skyhop', builder: 'headless', atOnce: 3 });
  } finally {
    s.cleanup();
  }
});

test('a bad word and a bad number are refused in words', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    assert.match(s.fails('builder', 'robot'), /"robot" is not a way to build.*headless.*chat/s);
    for (const bad of ['0', 'many', '1.5']) assert.match(s.fails('builder', '--at-once', bad), /is not a number of threads/);
    assert.match(s.fails('builder', '--at-once=-2'), /is not a number of threads/);
    assert.equal(fs.existsSync(configFile(s)), false, 'nothing was kept');
  } finally {
    s.cleanup();
  }
});

test('where the gate is locked, an agent may read but not set; the human may', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--lock');
    assert.match(s.sp('builder'), /headless/);
    assert.match(s.fails('builder', 'chat'), /human's alone.*locked/s);
    assert.match(s.fails('builder', '--at-once', '2'), /human's alone/);
    assert.equal(s.json('builder').builder, 'headless');
    assert.match(s.exec(['builder', 'chat'], { tty: true }).out, /A chat builds skyhop/);
  } finally {
    s.cleanup();
  }
});

test('a page already running follows the command without a restart', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const child: ChildProcess = spawn(process.execPath, [CLI, 'page', '--no-open', '-C', s.root, '--port', String(15000 + (process.pid % 1500))], {
    env: { ...process.env, HOME: `${s.root}/.home`, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`the page did not start: ${out}`)), 10_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const found = /Spool page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]!);
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
    });
    const builder = async (): Promise<string> => ((await (await fetch(`${url}api/board`)).json()) as any).runner.builder;
    assert.equal(await builder(), 'headless');
    s.sp('builder', 'chat');
    assert.equal(await builder(), 'chat');
    s.sp('builder', 'headless');
    assert.equal(await builder(), 'headless');
  } finally {
    child.kill();
    s.cleanup();
  }
});
