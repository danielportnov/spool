import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { CLI, Sandbox, WAIT_MS, freePorts, gone } from './helpers.ts';

/** Start `spool page` and give back what it printed first: the address of a page, its own or the one already up. */
function page(s: Sandbox, ...args: string[]): Promise<{ child: ChildProcess; said: string }> {
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '-C', s.root, ...args], {
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the page said nothing: ${out}`)), WAIT_MS);
    const hear = (chunk: Buffer): void => {
      out += chunk.toString();
      if (!/http:\/\/127\.0\.0\.1:\d+\//.test(out)) return;
      clearTimeout(timer);
      resolve({ child, said: out });
    };
    child.stdout!.on('data', hear);
    child.stderr!.on('data', hear);
  });
}

test('a second page for a project is pointed at the first, unless it asks for a port of its own', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const [a, b] = await freePorts(2);
  const first = await page(s, '--port', String(a));
  let second: ChildProcess | undefined;
  try {
    assert.match(first.said, new RegExp(`Spool page: http://127\\.0\\.0\\.1:${a}/`));

    // No port asked for, or the same one: it is the page already up.
    assert.match((await page(s)).said, new RegExp(`already up for this project: http://127\\.0\\.0\\.1:${a}/`));
    assert.match((await page(s, '--port', String(a))).said, /already up for this project/);

    // A port of its own: something is counting on that address, so it gets a page there.
    const other = await page(s, '--port', String(b));
    second = other.child;
    assert.match(other.said, new RegExp(`Spool page: http://127\\.0\\.0\\.1:${b}/`));
    assert.equal((await fetch(`http://127.0.0.1:${b}/api/board`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${a}/api/board`)).status, 200);
  } finally {
    for (const child of [second, first.child]) {
      child?.kill();
      if (child) await gone(child);
    }
    s.cleanup();
  }
});
