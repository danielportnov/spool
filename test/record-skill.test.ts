import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shipped } from '../src/builtin.ts';
import { spool } from './helpers.ts';

// What it says about one message, the split, the spec and sizes is pinned in test/init.test.ts;
// where each thread goes, in test/record-sprint.test.ts; what is not recorded, in test/record-rules.test.ts.

test('/spool-record files ideas and nothing else: answers and steering are /spool', () => {
  const record = shipped('spool-record');
  const flat = record.replace(/\s+/g, ' ');

  // No table of answers, and no command that answers, approves, undoes or starts work.
  assert.doesNotMatch(record, /When what they said is an answer|\| They say \| Run \||^## Rules$/m);
  assert.doesNotMatch(record, /spool (answer|approve|revert|release|build|hold|play)\b/);
  assert.match(flat, /A go, a no, an answer or an approval is a command: the `spool` skill has the table\./);
  assert.match(flat, /One message, then out: never keep recording what they say next\. A new thread is proposed, not started\. You build nothing: they move it to Build\./);

  // One table says how each kind of thing is filed.
  const filed = record.split('\n').filter((l) => l.startsWith('   | ') && !l.includes('| --- |') && !l.includes('| It is |')).map((l) => l.trim().slice(2, -2).split(' | '));
  assert.deepEqual(filed.map(([what]) => what!.replace(/:.*$/, '')), [
    'a change', 'a look and a report', 'something to find out, not build',
    'something big or open, or too big to see its parts', 'a change that waits on another', '"not yet", "just an idea", "after the launch"',
    'what a stretch of work should achieve', 'more on an existing thread', 'a thread Spool says looks like one already there', 'nothing to do',
  ]);
  const run = (what: string): string => filed.find(([it]) => it!.startsWith(what))![1]!;

  // A duplicate: the words go onto the thread that is there, and a dropped one is not quietly filed again.
  assert.equal(
    run('a thread Spool says looks like one already there'),
    'read that one. The same wish: `spool file <note-id> --into <id>`, then `spool drop <new-id> -m "same as <id>"`. Only the same subject: leave both. A dropped one says why it was dropped: tell them, do not file it again',
  );
  // A stretch of work is a sprint, made and filled in one go, and never played for them.
  assert.match(run('what a stretch of work should achieve'), /`spool sprint "<name>" --goal "<what it is for>" --why "<why now>" --done-when "<what will be true>" --from <note-id> --add <t-id…>`\. Show them its goal and its threads, a line each\. Never play it for them$/);
  assert.match(run('"not yet"'), /`--hold "<their words>"`: nothing starts it until they say/);

  // Short: what filing needs, and no more.
  assert.ok(record.trimEnd().split('\n').length <= 105, `${record.trimEnd().split('\n').length} lines`);
});

test('an agent with no skills is primed with the same rules for recording', () => {
  const s = spool();
  try {
    const primed = s.sp('prime', 'recorder');
    const rules = shipped('spool-record');
    assert.ok(primed.includes(rules.slice(rules.indexOf('## Recording it')).trim()), 'the skill from its first heading on');
    assert.match(primed, /## Recording it[\s\S]*## Splitting what they said[\s\S]*## What is not recorded[\s\S]*PROJECTS/);
  } finally {
    s.cleanup();
  }
});
