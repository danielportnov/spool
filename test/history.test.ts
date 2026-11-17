import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CLI, spool } from './helpers.ts';
import { KEEP_DAYS, KEEP_PER_FILE } from '../src/queue-journal.ts';

test('item history keeps signed edits and byte-for-byte undo across commands', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'Old title', '-b', 'Original description', '--as', 'Recorder');
  const was = s.item(id);
  s.sp('edit', id, '--title', 'New title', '-b', 'Rewritten description', '--as', 'Builder');
  const left = s.item(id);
  const entry = s.json('history', id).entries[0];
  assert.equal(entry.actor, 'Builder');
  assert.equal(entry.command, 'edit');
  assert.equal(entry.before, was);
  assert.equal(entry.after, left);
  assert.match(s.sp('history', id), /- Original description[\s\S]*\+ Rewritten description/);

  s.sp('edit', id, '--tag', 'later', '--as', 'Another person');
  const latest = s.item(id);
  // Only what the tag changed is shown: the tag and its log line, not the lines around them.
  const tagged = s.sp('history', id).split(/\n(?=j-)/)[0]!;
  assert.match(tagged, /\+ tags: \[?later/);
  assert.doesNotMatch(tagged, /Rewritten description|New title/);
  assert.match(s.fails('undo', entry.id), /changed after/);
  assert.equal(s.item(id), latest);

  const later = s.json('history', id).entries[0];
  s.sp('undo', later.id);
  assert.equal(s.item(id), left);
  const undo = s.json('undo', entry.id, '--as', 'Reviewer').entry;
  assert.equal(s.item(id), was);
  assert.equal(undo.undoOf, entry.id);
  assert.equal(undo.actor, 'Reviewer');
  assert.equal(s.json('history', id).entries[0].id, undo.id);
  s.sp('undo', undo.id);
  assert.equal(s.item(id), left);
});

test('note creation, answers, drops and policy lessons have history', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const note = s.id('capture', 'The original words');
  const capture = s.json('history', note).entries[0];
  assert.equal(capture.before, null);
  assert.match(capture.after, /The original words/);
  s.sp('undo', capture.id);
  assert.equal(s.exists(`.spool/items/${note}.md`), false);
  assert.equal(s.json('history', note).entries[0].after, null);

  const call = s.id('ask', 'Which way?', '--option', 'Left', '--option', 'Right');
  const unasked = s.item(call);
  s.sp('answer', call, '2');
  const answer = s.json('history', call).entries[0];
  assert.match(answer.after, /^choice: Right$/m);
  s.sp('undo', answer.id);
  assert.equal(s.item(call), unasked);

  const task = s.id('task', 'Use the shortcut');
  const before = s.item(task);
  s.sp('drop', task);
  s.sp('undo', s.json('history', task).entries[0].id);
  assert.equal(s.item(task), before);

  const policy = s.read('.spool/policy.md');
  s.sp('done', task, '-m', 'Added a shortcut');
  s.sp('revert', task, '-m', 'The shortcut confused people');
  const lesson = s.json('history', 'policy').entries[0];
  assert.equal(lesson.actor, 'human');
  assert.equal(lesson.before, policy);
  assert.match(lesson.after, /The shortcut confused people/);
  s.sp('undo', lesson.id);
  assert.equal(s.read('.spool/policy.md'), policy);
});

test('config receipts stay local and leave unrelated settings out of the journal', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  s.gitInit();
  s.sp('init', '--share');
  const raw = JSON.parse(s.read('.spool/config.json'));
  s.write('.spool/config.json', JSON.stringify({ ...raw, otherCredential: 'KEEP OUT OF HISTORY' }));
  s.sp('init', '--gate', '--as', 'Owner');
  const entry = s.json('history', 'config').entries[0];
  assert.equal(entry.actor, 'Owner');
  assert.deepEqual(JSON.parse(entry.before), {});
  assert.deepEqual(JSON.parse(entry.after), { gate: true });
  assert.doesNotMatch(s.sp('history', 'config', '--json'), /KEEP OUT OF HISTORY/);
  assert.match(s.git('status', '--short', '--untracked-files=all'), /\.spool\/config\.json/);
  assert.doesNotMatch(s.git('status', '--short', '--untracked-files=all'), /\.spool\/history\//);
  s.sp('undo', entry.id);
  const after = JSON.parse(s.read('.spool/config.json'));
  assert.equal(after.otherCredential, 'KEEP OUT OF HISTORY');
  assert.equal(after.gate, undefined);

  const initial = s.json('history', 'config').entries.at(-1);
  assert.match(s.fails('undo', initial.id), /needs its first config/);
  s.sp('disable');
  const disabled = s.json('history', 'config').entries[0];
  assert.equal(disabled.command, 'disable');
  assert.match(s.fails('undo', disabled.id), /Use spool enable/);
  s.sp('enable');
  const enabled = s.json('history', 'config').entries[0];
  assert.equal(enabled.command, 'enable');
  assert.match(s.fails('undo', enabled.id), /Use spool disable/);

  s.sp('init', '--lock');
  const locked = s.json('history', 'config').entries[0];
  assert.match(s.fails('undo', locked.id), /gate is locked/);
  assert.equal(s.exec(['undo', locked.id], { tty: true }).code, 0);
});

test('manual edits and Git-coupled writes are kept intact', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'First title');
  s.sp('edit', id, '--title', 'Second title');
  const entry = s.json('history', id).entries[0];
  const manual = s.item(id).replace('Second title', 'Edited by hand');
  s.write(`.spool/items/${id}.md`, manual);
  assert.match(s.fails('undo', entry.id), /changed after/);
  assert.equal(s.item(id), manual);

  s.gitInit();
  s.commitAll('Initial project');
  s.write('source.txt', 'new code\n');
  const sha = s.commitAll(`Change code\n\nSpool: ${id}`);
  s.sp('done', id, '-m', 'Landed code');
  const landed = s.json('history', id).entries[0];
  assert.match(landed.after, new RegExp(sha));
  assert.match(s.fails('undo', landed.id), new RegExp(`spool revert ${id}`));
  assert.equal(s.git('rev-parse', 'HEAD'), sha);
});

test('two processes cannot both undo the same receipt', async (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'First title');
  const file = s.item(id);
  s.sp('edit', id, '--title', 'Second title');
  const entry = s.json('history', id).entries[0];
  const exec = promisify(execFile);
  const results = await Promise.allSettled(['First person', 'Second person'].map((actor) =>
    exec(process.execPath, [CLI, 'undo', entry.id, '--as', actor], { cwd: s.dir })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(rejected?.reason.stderr, /changed after/);
  assert.equal(s.item(id), file);
  assert.equal(s.json('history', id).entries.filter((item: { undoOf?: string }) => item.undoOf === entry.id).length, 1);
});

test('an interrupted receipt is kept only if its write reached the queue', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'First title');
  s.sp('edit', id, '--title', 'Second title');
  const entry = s.json('history', id).entries[0];
  const history = path.join(s.dir, '.spool', 'history');
  const receipt = path.join(history, `${entry.id}.json`);
  const pending = path.join(history, '.pending.json');
  fs.renameSync(receipt, pending); // A writer stopped after replacing the item.
  assert.equal(s.json('history', id).entries[0].id, entry.id);
  s.sp('edit', id, '--title', 'Third title');
  assert.equal(fs.existsSync(receipt), true);

  const next = s.json('history', id).entries[0];
  const uncommitted = path.join(history, `${next.id}.json`);
  fs.renameSync(uncommitted, pending); // This time its queue write did not happen.
  s.write(`.spool/items/${id}.md`, next.before);
  assert.ok(!s.json('history', id).entries.some((entry: { id: string }) => entry.id === next.id));
  s.sp('edit', id, '--title', 'Fourth title');
  assert.equal(fs.existsSync(uncommitted), false);
  assert.equal(fs.existsSync(pending), false);
});

test('manager-run undo stays on project history without changing the run journal', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'A waiting thread');
  const run = s.json('manage', '--start').env.SPOOL_RUN;
  const env = { SPOOL_RUN: run };
  assert.equal(s.exec(['edit', id, '--size', 's', '--as', 'Manager'], { env }).code, 0);
  const entry = s.json('history', id).entries[0];
  assert.equal(entry.actor, 'Manager');
  s.sp('revert', run);
  const replay = s.json('history', id).entries[0];
  assert.equal(replay.command, 'revert');
  assert.equal(replay.after, entry.before);
  assert.equal(replay.before, entry.after);
  assert.match(s.fails('revert', run), /was undone already/);
});

test('history follows items and reports into a nested project', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const sub = s.cd('nested');
  sub.sp('init');
  const id = sub.id('task', 'Audit a change', '--type', 'audit');
  const finished = sub.exec(['done', id, '-m', 'Audited the rules', '--report', '-'], { stdin: 'The original report.' });
  assert.equal(finished.code, 0, finished.err);
  const entries = s.json('history', id).entries;
  const report = entries.find((entry: { target: string }) => entry.target === `report-${id}`);
  assert.equal(report.project, 'nested');
  assert.equal(report.after, 'The original report.\n');
  assert.equal(s.json('history', 'config', '-P', 'nested').entries[0].project, 'nested');
  s.sp('undo', report.id);
  assert.equal(sub.exists(`.spool/reports/${id}.md`), false);
});

test('undo never follows an item directory symlink out of the queue', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'First title');
  s.sp('edit', id, '--title', 'Second title');
  const entry = s.json('history', id).entries[0];
  const items = path.join(s.dir, '.spool', 'items');
  const outside = path.join(s.dir, 'outside');
  fs.renameSync(items, outside);
  fs.symlinkSync(outside, items, 'dir');
  assert.match(s.fails('undo', entry.id), /expected a directory/);
  assert.equal(s.read(`outside/${id}.md`), entry.after);
});

test('restoring a thread to Build through history respects a locked gate', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'Return this task to Build');
  s.sp('init', '--lock');
  s.sp('propose', id);
  const entry = s.json('history', id).entries[0];
  assert.match(s.fails('undo', entry.id, '--as', 'human'), /the user's alone.*its gate is locked/);
  assert.equal(s.json('show', id).item.state, 'proposed');
  assert.equal(s.exec(['undo', entry.id], { tty: true }).code, 0);
  assert.match(s.item(id), /^status: open$/m);
});

test('an unsigned write on a claimed thread is kept under the claimer, as its log line is', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'Claimed work');
  s.sp('build', id);
  s.sp('start', id, '--as', 'Claude Opus 5.5');
  s.sp('log', id, 'A fact for the next agent');
  const entry = s.json('history', id).entries[0];
  assert.equal(entry.command, 'log');
  assert.equal(entry.actor, 'Claude Opus 5.5');
});

test('hold defaults to the user on a claimed thread, while log defaults to its claimer', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'Claimed work');
  s.sp('build', id);
  s.sp('start', id, '--as', 'Claude Opus 5.5');
  s.sp('log', id, 'A fact for the next agent');
  s.sp('hold', id, '-m', 'wait for the launch');

  const entries = s.json('history', id).entries;
  assert.deepEqual(entries.slice(0, 2).map((entry: { command: string; actor: string }) => [entry.command, entry.actor]), [
    ['hold', 'human'],
    ['log', 'Claude Opus 5.5'],
  ]);

  const explicit = s.id('task', 'Explicitly signed hold');
  s.sp('hold', explicit, '-m', 'wait', '--as', 'Project owner');
  assert.equal(s.json('history', explicit).entries[0].actor, 'Project owner');
});

test('the history is kept in check: old entries and all but each file\'s newest few go, once a day', (t) => {
  const s = spool();
  t.after(() => s.cleanup());
  const id = s.id('task', 'A busy thread');
  const other = s.id('task', 'A quiet thread');
  for (let i = 0; i < KEEP_PER_FILE + 5; i++) s.sp('log', id, `fact ${i}`);
  // Within the day nothing is pruned.
  assert.equal(s.json('history', id).entries.length, KEEP_PER_FILE + 6);

  const history = path.join(s.dir, '.spool', 'history');
  const quiet = s.json('history', other).entries[0];
  const old = new Date(Date.parse('2026-01-01T00:00:00Z') - (KEEP_DAYS + 1) * 86_400_000);
  fs.utimesSync(path.join(history, `${quiet.id}.json`), old, old);
  s.advance(25);
  s.sp('log', id, 'the next day');
  const kept = s.json('history', id).entries;
  assert.equal(kept.length, KEEP_PER_FILE);
  assert.match(kept[0].after, /the next day/);
  assert.equal(s.json('history', other).entries.length, 0);
  assert.match(s.fails('undo', quiet.id), /no history entry/);
  // Only the history folder is touched, and the queue itself is as it was.
  assert.match(s.item(id), /fact 0/);
  assert.match(s.item(other), /A quiet thread/);
});
