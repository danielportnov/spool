import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeNote } from '../src/notes.ts';
import { Sandbox } from './helpers.ts';

const note = (s: Sandbox, sha: string): string => s.git('notes', '--ref=refs/notes/spool', 'show', sha);

test('done writes a short note on each landed commit, revert and put back rewrite it, and backfill is idempotent', (t) => {
  const s = new Sandbox();
  t.after(() => s.cleanup());
  s.gitInit();
  s.sp('init');
  const words = 'The private words of the user, never in a note';
  const heard = s.id('capture', words, '--as', 'Riley');
  const thread = s.id('task', 'Mark the short trail', '--from', heard);
  s.sp('start', thread, '--as', 'Builder');
  s.id('assume', 'Line style?', '--chose', 'dashed', '--why', 'Matches printed maps', '--for', thread, '--as', 'Builder');
  s.write('trail.txt', 'short\n');
  const sha = s.commitAll(`Mark it\n\nSpool-Agent: Builder\nSpool-Model: model-a\nSpool: ${thread}`);
  const out = s.sp('done', thread, '-m', 'The trail is marked; see .spool/reports/x.md', '--as', 'Builder');
  assert.match(out, /1 git note\(s\) written in refs\/notes\/spool/);

  const written = note(s, sha);
  assert.match(written, new RegExp(`^Spool ${thread}: Mark the short trail$`, 'm'));
  assert.match(written, /^State: done$/m);
  assert.match(written, /^Built by: Builder · model-a$/m);
  assert.match(written, /^Call d-\w+: Line style\? → dashed \(assumed\)$/m);
  assert.doesNotMatch(written, /private words|\.spool|trail is marked|Matches printed/);

  s.sp('revert', thread, '-m', 'Not dashed', '--as', 'Riley');
  const undo = s.git('rev-parse', 'HEAD');
  assert.match(note(s, sha), /^State: undone, now proposed$/m);
  assert.match(note(s, sha), new RegExp(`^Undone by ${undo.slice(0, 12)}$`, 'm'));
  assert.match(note(s, undo), /^This commit undid the work\.$/m);

  s.sp('revert', thread, '--as', 'Riley');
  const back = s.git('rev-parse', 'HEAD');
  assert.match(note(s, sha), /^State: done, put back after it was undone$/m);
  assert.match(note(s, sha), new RegExp(`^Put back by ${back.slice(0, 12)}$`, 'm'));
  assert.match(note(s, back), /^This commit put the work back\.$/m);

  // Notes gone, backfill writes them again; a second run changes nothing.
  s.git('update-ref', '-d', 'refs/notes/spool');
  assert.equal(s.json('notes', '--backfill').written, 3);
  assert.equal(s.json('notes', '--backfill').written, 0);
  assert.equal(s.json('notes').count, 3);
  assert.match(s.sp('notes'), /git push origin refs\/notes\/spool/);
  assert.match(s.sp('notes', thread), /Built by: Builder/);
  assert.match(s.exec(['doctor']).out, /3 commit\(s\) carry a Spool git note/);
});

test('a commit on two threads keeps one part of its note for each', () => {
  const first = mergeNote(undefined, 't-aaaa', 'Spool t-aaaa: One\nState: done');
  const both = mergeNote(first, 't-bbbb', 'Spool t-bbbb: Two\nState: done');
  assert.equal(both, 'Spool t-aaaa: One\nState: done\n\nSpool t-bbbb: Two\nState: done');
  assert.equal(mergeNote(both, 't-aaaa', 'Spool t-aaaa: One\nState: proposed'), 'Spool t-aaaa: One\nState: proposed\n\nSpool t-bbbb: Two\nState: done');
});
