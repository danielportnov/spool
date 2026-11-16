/**
 * What an agent said on a run, read back by line number: from a transcript written by hand, and
 * from the page of a real run through `/api/run`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { heardRun } from '../src/heard.ts';
import { transcriptFile } from '../src/stream.ts';
import { Sandbox, startPage, until } from './helpers.ts';

/** One event of Claude's stream, as a line. */
const event = (e: unknown): string => `${JSON.stringify(e)}\n`;
const says = (text: string): string => event({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const calls = (name: string, input: unknown): string => event({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('a run is read back as the lines that were heard, numbered, and then only where it has grown', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-heard-')));
  try {
    assert.deepEqual(heardRun(dir, 't-none'), { run: '', from: 0, next: 0, lines: [] }, 'a thread no page ever ran has nothing to read');

    const file = transcriptFile(dir, 't-4kq7', new Date('2026-01-01T10:00:00Z'));
    const run = path.basename(file, '.jsonl');
    fs.writeFileSync(
      file,
      event({ type: 'system', subtype: 'init', session_id: '3b7f38ef', model: 'opus' }) +
        says('Reading the jump code first.') +
        calls('Read', { file_path: 'src/player/jump.ts' }) +
        // An event that says nothing a person reads, a line that is no event at all, and what was printed on stderr.
        event({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }) +
        'plain words from another agent\n' +
        event({ type: 'stderr', text: '\x1b[31mwarning:\x1b[0m slow disk' }) +
        event({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: '1 test failed' }] } }),
    );
    const first = heardRun(dir, 't-4kq7');
    assert.deepEqual(first, {
      run,
      from: 0,
      next: 6,
      lines: ['session 3b7f38ef · opus', 'Reading the jump code first.', '→ Read: src/player/jump.ts', 'plain words from another agent', 'warning: slow disk', '✗ 1 test failed'],
    });

    // From a number on; from the end, with a negative one; and nothing at all when nothing is new.
    assert.deepEqual(heardRun(dir, 't-4kq7', 4), { run, from: 4, next: 6, lines: ['warning: slow disk', '✗ 1 test failed'] });
    assert.deepEqual(heardRun(dir, 't-4kq7', -2).lines, ['warning: slow disk', '✗ 1 test failed']);
    assert.equal(heardRun(dir, 't-4kq7', -2).from, 4);
    assert.deepEqual(heardRun(dir, 't-4kq7', -50).from, 0);
    assert.deepEqual(heardRun(dir, 't-4kq7', 6, run), { run, from: 6, next: 6, lines: [] });
    assert.deepEqual(heardRun(dir, 't-4kq7', 99), { run, from: 6, next: 6, lines: [] });

    // More is written: a line, and the start of another, cut in the middle of a letter.
    const wide = Buffer.from(says('頂点での浮遊感が強すぎる'));
    fs.appendFileSync(file, says('Gravity is up from 28 to 34.'));
    fs.appendFileSync(file, wide.subarray(0, 60));
    assert.deepEqual(heardRun(dir, 't-4kq7', 6, run), { run, from: 6, next: 7, lines: ['Gravity is up from 28 to 34.'] }, 'half a line is not a line yet');
    fs.appendFileSync(file, wide.subarray(60));
    assert.deepEqual(heardRun(dir, 't-4kq7', 7, run), { run, from: 7, next: 8, lines: ['頂点での浮遊感が強すぎる'] }, 'and whole, it is read as it was written');
    assert.equal(heardRun(dir, 't-4kq7').lines.length, 8, 'the numbers of the lines before it never changed');

    // What else is kept in the thread's folder is not a run: the journal of changes made under it, for one.
    fs.writeFileSync(path.join(path.dirname(file), 'journal.jsonl'), `${JSON.stringify({ at: '2026-01-01T10:30:00Z', item: 't-4kq7', change: 'changed' })}\n`);
    assert.equal(heardRun(dir, 't-4kq7').run, run);
    assert.equal(heardRun(dir, 't-4kq7').lines.length, 8);

    // The thread is run again: the newest run is the one read, and to someone holding the old one it is all new.
    const again = transcriptFile(dir, 't-4kq7', new Date('2026-01-01T11:00:00Z'));
    fs.writeFileSync(again, says('Picking it up where it was left.'));
    assert.deepEqual(heardRun(dir, 't-4kq7', 8, run), { run: path.basename(again, '.jsonl'), from: 0, next: 1, lines: ['Picking it up where it was left.'] });
    assert.deepEqual(heardRun(dir, 't-4kq7', 1, path.basename(again, '.jsonl')).lines, []);

    // A long run is given a part at a time, and `next` says where to go on from.
    const long = transcriptFile(dir, 't-long', new Date('2026-01-01T10:00:00Z'));
    fs.writeFileSync(long, Array.from({ length: 4500 }, (_, i) => `line ${i}\n`).join(''));
    const part = heardRun(dir, 't-long');
    assert.deepEqual([part.from, part.next, part.lines.length, part.lines[0], part.lines.at(-1)], [0, 2000, 2000, 'line 0', 'line 1999']);
    const rest = heardRun(dir, 't-long', 4000);
    assert.deepEqual([rest.from, rest.next, rest.lines[0], rest.lines.at(-1)], [4000, 4500, 'line 4000', 'line 4499']);
    assert.deepEqual(heardRun(dir, 't-long', -3).lines, ['line 4497', 'line 4498', 'line 4499']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the page gives a run\'s lines by number: what its agent said from the start, and then only what is new', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset');
  // A stand-in agent: it says which thread it is on, then a line each time `say` is written to, until `go` is there.
  const agent = path.join(s.root, 'agent.sh');
  fs.writeFileSync(
    agent,
    [
      '#!/bin/sh',
      'cat > /dev/null',
      'echo "working on $SPOOL_TASK"',
      'echo "a warning, on stderr" >&2',
      `while [ ! -f "${s.root}/go" ]; do`,
      `  if [ -f "${s.root}/say" ]; then cat "${s.root}/say"; rm "${s.root}/say"; fi`,
      '  sleep 0.05',
      'done',
    ].join('\n'),
  );
  fs.chmodSync(agent, 0o755);
  const page = await startPage(s, '--run', '--agent', agent);
  try {
    const heard = async (query: string): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${page.url}api/run?${query}`);
      return { status: res.status, body: await res.json() };
    };
    s.sp('build', jump);
    const first = await until('the agent has been heard', async () => {
      const { body } = await heard(`id=${jump}`);
      return body.lines?.length >= 2 && body;
    });
    assert.equal(first.id, jump);
    assert.match(first.run, /^\d{4}-\d\d-\d\dT[\d-]+Z$/, 'the run is named for when it began');
    assert.deepEqual([...first.lines].sort(), ['a warning, on stderr', `working on ${jump}`]);
    assert.deepEqual([first.from, first.next], [0, 2]);
    // The same lines the board carries for its card.
    const board = (await (await fetch(`${page.url}api/board`)).json()) as { runner: { running: { id: string; lines: string[] }[] } };
    assert.deepEqual(board.runner.running.find((r) => r.id === jump)?.lines, first.lines);

    // Nothing new, nothing sent; then one line more, and only that.
    assert.deepEqual((await heard(`id=${jump}&from=2&run=${first.run}`)).body.lines, []);
    fs.writeFileSync(path.join(s.root, 'say.part'), 'Gravity is up from 28 to 34.\n');
    fs.renameSync(path.join(s.root, 'say.part'), path.join(s.root, 'say'));
    const more = await until('the new line', async () => {
      const { body } = await heard(`id=${jump}&from=2&run=${first.run}`);
      return body.lines.length > 0 && body;
    });
    assert.deepEqual([more.from, more.next, more.lines], [2, 3, ['Gravity is up from 28 to 34.']]);
    assert.deepEqual((await heard(`id=${jump}&from=-1`)).body.lines, ['Gravity is up from 28 to 34.']);

    // A thread nobody has run has no lines; a thread that is not there, or no line number, is refused.
    assert.deepEqual((await heard(`id=${coins}`)).body, { id: coins, run: '', from: 0, next: 0, lines: [] });
    assert.equal((await heard('id=../../etc')).status, 400);
    assert.equal((await heard(`id=${jump}&from=soon`)).status, 400);
    assert.notEqual((await heard('id=t-zzzz')).status, 200);

    // After the run has ended it is still there to read, as the thread's last run.
    fs.writeFileSync(path.join(s.root, 'go'), '');
    await until('the agent has gone', async () => ((await (await fetch(`${page.url}api/board`)).json()) as typeof board).runner.running.length === 0);
    assert.deepEqual((await heard(`id=${jump}`)).body.lines.slice(-1), ['Gravity is up from 28 to 34.']);
  } finally {
    fs.writeFileSync(path.join(s.root, 'go'), '');
    await page.stop();
    s.cleanup();
  }
});
