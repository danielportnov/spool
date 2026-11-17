/**
 * The repository is public: no tracked file may carry a personal home path, and no tracked
 * file may be anything of the project's private queue. A fixture that really needs such a
 * path builds it at run time (as the parts below do) rather than writing it out.
 */

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function tracked(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter((f) => f && fs.existsSync(path.join(root, f)));
}

const HOME_PATH = new RegExp(`(/${'Users'}/|/${'home'}/)[A-Za-z0-9._-]+|[A-Z]:\\\\${'Users'}\\\\`);

test('no tracked file holds an absolute personal home path', () => {
  const hits: string[] = [];
  for (const file of tracked()) {
    const buf = fs.readFileSync(path.join(root, file));
    if (buf.includes(0)) continue; // binary
    buf
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        if (HOME_PATH.test(line)) hits.push(`${file}:${i + 1}`);
      });
  }
  assert.deepEqual(hits, [], 'home paths in tracked files (use a placeholder like /home/you):');
});

test('nothing of the private queue is tracked', () => {
  const bad = tracked().filter((f) => f.startsWith('.spool/') || f.startsWith('.codex/') || f.startsWith('.claude/'));
  assert.deepEqual(bad, []);
});
