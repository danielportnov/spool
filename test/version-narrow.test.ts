/**
 * `spool --version` prints the number in every form of the mark: wide, narrow, and at a terminal
 * that reports no width.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.ts';
import type { Ctx } from '../src/context.ts';
import { MARK_LINE } from '../src/mark.ts';

const VERSION = (JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

function typed(columns: number | undefined, color = false): string {
  const written: string[] = [];
  const ctx: Ctx = {
    cwd: '.',
    env: { TERM: 'xterm-256color' },
    out: (text) => written.push(text),
    err: (text) => written.push(text),
    now: () => new Date('2026-01-01T00:00:00Z'),
    stdin: () => '',
    lines: () => {},
    color,
    inherit: false,
    tty: true,
    columns,
  };
  assert.equal(run(['--version'], ctx), 0);
  return written.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

test('--version always prints the number, however wide the terminal says it is', () => {
  // A terminal that reports no width: the one-line mark and the number.
  assert.equal(typed(0), `${MARK_LINE}  v${VERSION}`);
  assert.equal(typed(0, true), `${MARK_LINE}  v${VERSION}`);
  // Narrow: the same line. Narrower still, the mark gives way and the number stays.
  assert.equal(typed(40), `${MARK_LINE}  v${VERSION}`);
  assert.equal(typed(`spool  v${VERSION}`.length), `spool  v${VERSION}`);
  assert.equal(typed(4), `v${VERSION}`);
  // Wide, and unknown: the number beside the ball.
  for (const columns of [undefined, 120]) assert.match(typed(columns), new RegExp(`   v${VERSION.replace(/\./g, '\\.')}\n`));
});
