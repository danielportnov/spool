import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A backup left by an editor or `sed -i -E` (BSD) must not be committed under test/ or src/.
test('no editor or sed backup is tracked under test/ or src/', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = execFileSync('git', ['ls-files', 'test', 'src'], { cwd: root, encoding: 'utf8' }).split('\n');
  const backups = files.filter((f) => /(-E|\.bak|\.orig|~)$/.test(f));
  assert.deepEqual(backups, [], `remove these tracked backups with git rm: ${backups.join(', ')}`);
});
