/** A write that fails while an agent is being started costs only that thread: it is put back, and the runner keeps ticking. */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Ctx } from '../src/context.ts';
import { Runner } from '../src/engine.ts';
import { Sandbox } from './helpers.ts';

test('a thread whose agent could not be started is put back with the reason, and not tried again', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  const ctx: Ctx = {
    cwd: s.root,
    env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined },
    out: () => {},
    err: () => {},
    now: () => new Date(),
    stdin: () => '',
    lines: () => {},
    color: false,
    inherit: false,
  };
  // The temp folder the prompt file is written to is not there to be written to.
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = path.join(s.root, 'no', 'such', 'folder');
  const runner = new Runner(ctx, undefined, 'true', true);
  try {
    runner.wake();
    assert.equal(runner.runs.size, 0);
    assert.equal(s.json('show', jump).item.state, 'ready', 'back in build');
    assert.match(s.item(jump), /could not be started \(.*ENOENT.*\); back in build/);

    // Not every second: another look hands out nothing, and the runner is still there to look.
    runner.wake();
    runner.wake();
    assert.equal(runner.handedOut, 1);
    assert.equal(s.item(jump).match(/could not be started/g)?.length, 1);
  } finally {
    runner.close();
    if (tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmp;
    s.cleanup();
  }
});
