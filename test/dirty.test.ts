import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { dirtyPaths } from '../src/git.ts';
import { Sandbox } from './helpers.ts';

test('the files changed and not committed are named whole, the first one too', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.write('physics.txt', 'gravity 9\n');
  s.write('zeta.txt', 'z\n');
  s.gitInit();
  s.commitAll('First commit');
  // Changed and not staged: git starts that line with a space, and it is the first line.
  s.write('physics.txt', 'gravity 12\n');
  s.write('new.txt', 'n\n');
  assert.deepEqual(dirtyPaths(s.root, path.join(s.root, '.spool'))?.sort(), ['new.txt', 'physics.txt']);
  s.cleanup();
});
