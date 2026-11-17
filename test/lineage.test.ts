import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Workspace } from '../src/store.ts';
import { Sandbox } from './helpers.ts';

test('why joins source words, decisions, moves, checks, trailers and recorded shas', (t) => {
  const s = new Sandbox();
  t.after(() => s.cleanup());
  s.gitInit();
  s.sp('init', '--gate');
  s.sp('checks', 'git diff --check');
  const words = 'Keep the short trail visible.\n\n## Log\nThis heading is part of the original words.';
  const note = s.id('capture', words, '--as', 'Riley');
  const plan = s.id('task', 'Plan the trail map', '--type', 'plan', '--from', note);
  const thread = s.id('task', 'Add the short trail', '--from', plan);
  s.sp('build', thread);
  s.sp('start', thread, '--as', 'Builder');
  s.sp('log', thread, 'stepped up to a different model', '--as', 'Foreman');
  const decision = s.id('assume', 'Map legend?', '--chose', 'dashed line', '--why', 'Matches printed maps', '--for', thread, '--as', 'Builder');
  s.sp('answer', decision, 'dashed line', '--as', 'Riley');
  s.write('trails/short: route.txt', 'short trail\n');
  const recorded = s.commitAll('Original map\n\nCo-Authored-By: Old Builder <old@example.com>');
  s.write('trails/short: route.txt', 'short trail\naccessible trail\n');
  const stamped = s.commitAll(`Extend the map\n\nSpool-Agent: Builder\nSpool-Model: model-a\nSpool: ${thread}`);
  s.sp('done', thread, '-m', 'Both trails are marked', '--commit', recorded, '--as', 'Builder');
  s.sp('edit', thread, '--version', '0.8.0');

  const data = s.json('why', thread);
  assert.equal(data.thread.id, thread);
  assert.equal(data.thread.version, '0.8.0');
  assert.equal(data.thread.checked, 'git diff --check');
  assert.equal(data.sources.find((source: { id: string }) => source.id === note).words, words);
  assert.equal(data.calls[0].by, 'Builder');
  assert.equal(data.calls[0].choice, 'dashed line');
  assert.match(data.calls[0].activity[0], /Riley: approved/);
  assert.ok(data.activity.some((line: string) => line.includes('Foreman: stepped up')));
  assert.ok(data.activity.some((line: string) => line.includes('human: moved to build')));
  assert.equal(data.commits.find((commit: { sha: string }) => commit.sha === stamped).model, 'model-a');
  assert.deepEqual(data.commits.find((commit: { sha: string }) => commit.sha === recorded).coauthors, ['Old Builder <old@example.com>']);
  assert.equal(data.undo.command, `spool revert ${thread}`);
  assert.equal(s.json('why', recorded.slice(0, 8)).thread.id, thread);
  assert.equal(s.cd('trails').json('why', 'short: route.txt:2').target.commit.sha, stamped);
  assert.match(s.fails('why', 'trails/short: route.txt:0'), /line numbers start at 1/);
  assert.match(s.fails('why', '../outside:1'), /outside this repository/);
  assert.match(s.fails('why', '--', '--all'), /no Git commit/);

  s.git('revert', '--no-edit', stamped);
  const manual = s.git('rev-parse', 'HEAD');
  assert.equal(s.json('why', thread).reverts[0].sha, manual);
  assert.equal(s.json('why', manual).thread.id, thread);
});

test('why reconstructs a legacy revert after the original shas were cleared from the thread', (t) => {
  const s = new Sandbox();
  t.after(() => s.cleanup());
  s.gitInit();
  s.sp('init');
  const thread = s.id('task', 'Adjust the map scale');
  const decision = s.id('assume', 'Which scale?', '--chose', '1:5000', '--for', thread, '--as', 'Builder');
  s.write('scale.txt', '1:5000\n');
  const original = s.commitAll('Set the scale');
  s.sp('done', thread, '-m', 'The scale is set', '--commit', original);
  s.sp('revert', thread, '-m', 'The map needs more detail', '--as', 'Riley');
  const undo = s.git('rev-parse', 'HEAD');

  assert.equal(s.json('why', thread).undo.label, 'Put the work back');
  const ws = Workspace.open(s.root, undefined, true);
  try {
    const task = ws.get(thread, 'task');
    task.reverted = [];
    task.revert = undefined;
    ws.save(task);
  } finally {
    ws.close();
  }

  for (const ref of [thread, original, undo]) {
    const data = s.json('why', ref);
    assert.equal(data.thread.id, thread);
    assert.deepEqual(data.commits.map((commit: { sha: string }) => commit.sha), [original]);
    assert.deepEqual(data.reverts.map((commit: { sha: string }) => commit.sha), [undo]);
    assert.equal(data.calls[0].id, decision);
    assert.equal(data.calls[0].status, 'dropped');
    assert.ok(data.activity.some((line: string) => line.includes('Riley: reverted 1 commit(s): The map needs more detail')));
    assert.equal(data.undo, undefined);
  }
});

test('why shows queue history without Git and identifies commits with no thread', (t) => {
  const s = new Sandbox();
  t.after(() => s.cleanup());
  s.sp('init');
  const thread = s.id('task', 'Update the legend');
  assert.equal(s.json('why', thread).thread.id, thread);
  assert.match(s.fails('why', 'HEAD'), /no Git repository/);
  s.gitInit();
  s.write('legend.txt', 'Added a legend\n');
  const sha = s.commitAll('Standalone change');
  const unlinked = s.json('why', 'HEAD');
  assert.equal(unlinked.target.commit.sha, sha);
  assert.equal(unlinked.thread, undefined);
  assert.match(unlinked.notice, /No Spool thread/);
});

test('a shared revert does not attribute another thread’s old commits to this one', (t) => {
  const s = new Sandbox();
  t.after(() => s.cleanup());
  s.gitInit();
  s.sp('init');
  const first = s.id('task', 'Outline the short trail');
  const second = s.id('task', 'Outline the long trail');
  s.write('short.txt', 'short trail\n');
  const short = s.commitAll('Outline the short trail');
  s.sp('done', first, '-m', 'Short trail marked', '--commit', short);
  s.write('long.txt', 'long trail\n');
  const long = s.commitAll('Outline the long trail');
  s.sp('done', second, '-m', 'Long trail marked', '--commit', long);
  s.git('revert', '--no-commit', long, short);
  const undo = s.commitAll([
    'Undo both outlines', '', `This reverts commit ${long}.`, `This reverts commit ${short}.`,
    '', `Spool-Revert: ${first}`, `Spool-Revert: ${second}`,
  ].join('\n'));

  const lineage = s.json('why', first);
  assert.deepEqual(lineage.commits.map((commit: { sha: string }) => commit.sha), [short]);
  assert.deepEqual(lineage.reverts.map((commit: { sha: string }) => commit.sha), [undo]);
  assert.match(s.json('why', undo).notice, new RegExp(`${first}.*${second}`));
});
