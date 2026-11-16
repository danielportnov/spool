/**
 * The engine by itself: a Runner with no server behind it and no page in front of it.
 *
 * Whatever builds (the page's server today; a terminal, or `spool loop`, later) holds a Runner
 * and reads its fields. This test holds one the same way, with nothing listening on any port.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Ctx } from '../src/context.ts';
import { Runner } from '../src/engine.ts';
import { CLI, Sandbox } from './helpers.ts';

async function until(what: string, look: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (look()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`never happened: ${what}`);
}

test('the runner builds a thread with no server: it hands it out, hears its agent, and settles it', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  // A stand-in agent: a shell script that reads its prompt, says a line, and drives the real CLI.
  const worker = path.join(s.root, 'worker.sh');
  const go = path.join(s.root, 'go');
  fs.writeFileSync(
    worker,
    `#!/bin/sh\nspool() { "${process.execPath}" "${CLI}" "$@"; }\ncat > /dev/null\necho "raising gravity"\nwhile [ ! -f "${go}" ]; do sleep 0.1; done\nspool done "$SPOOL_TASK" -m "finished" > /dev/null\n`,
  );
  fs.chmodSync(worker, 0o755);
  const ctx: Ctx = {
    cwd: s.root,
    env: { ...process.env, HOME: `${s.root}/.home`, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined },
    out: () => {},
    err: () => {},
    now: () => new Date(),
    stdin: () => '',
    lines: () => {},
    color: false,
    inherit: false,
  };

  const runner = new Runner(ctx, undefined, worker, true);
  try {
    // Asked to look, it takes what is in Build at once: no tick to wait for, and no request.
    runner.wake();
    assert.deepEqual([[...runner.runs.keys()], runner.handedOut, s.json('show', jump).item.state], [[jump], 1, 'active']);
    await until('the agent is heard', () => runner.runs.get(jump)?.lines.at(-1) === 'raising gravity');

    // The agent finishes, and the runner settles the thread by what the spool now says of it.
    fs.writeFileSync(go, '');
    await until('the agent has gone', () => !runner.runs.size);
    assert.deepEqual(runner.recent.map((r) => [r.id, r.outcome]), [[jump, 'done']]);
    assert.equal(s.json('show', jump).item.state, 'done');
  } finally {
    runner.close();
  }
});
