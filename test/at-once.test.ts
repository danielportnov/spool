/** The board and the runner agree on how many threads are built at once. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox, startPage, until } from './helpers.ts';

function agent(s: Sandbox): string {
  const file = path.join(s.root, '.home', 'worker.sh');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ncat > /dev/null\nwhile [ ! -f "${path.join(s.root, '.home', 'go')}" ]; do sleep 0.1; done\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

async function run(git: boolean): Promise<[number, number]> {
  const s = new Sandbox();
  if (git) {
    s.gitInit();
    fs.writeFileSync(path.join(s.root, '.git', 'info', 'exclude'), '.home/\n');
  }
  s.sp('init', '--name', 'skyhop');
  const ids = ['One', 'Two', 'Three'].map((t) => s.id('task', t));
  if (git) {
    s.write('physics.txt', 'gravity 9\n');
    s.commitAll('start');
  }
  for (const id of ids) s.sp('build', id);
  const page = await startPage(s, '--run', '--agent', agent(s));
  try {
    const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
    const b = await until('the agents have started', async () => {
      const b = await board();
      return b.runner.running.length > 0 && b;
    });
    await new Promise((r) => setTimeout(r, 2500));
    return [b.runner.parallel, (await board()).runner.running.length];
  } finally {
    fs.writeFileSync(path.join(s.root, '.home', 'go'), '');
    await page.stop();
    s.cleanup();
  }
}

test('without git the board shows one and the runner builds one; with git, three', async () => {
  assert.deepEqual(await run(false), [1, 1]);
  assert.deepEqual(await run(true), [3, 3]);
});
