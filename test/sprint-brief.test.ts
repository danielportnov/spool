import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { hearLine, readTook, tookLine } from '../src/stream.ts';
import { spool } from './helpers.ts';

test('a finished run says its minutes, turns and cost, read from its last event', () => {
  const heard = hearLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', duration_ms: 12 * 60_000, num_turns: 30, total_cost_usd: 1.234 }));
  assert.deepEqual(heard.took, { minutes: 12, turns: 30, usd: 1.234 });
  assert.equal(tookLine(heard.took!), 'run took 12 min · 30 turns · $1.23');
  assert.deepEqual(readTook('run took 12 min · 30 turns · $1.23'), { minutes: 12, turns: 30, usd: 1.23 });
  assert.equal(readTook('started'), null);
});

test('the notifier hears of a finished sprint once, with the brief headline; the brief sums what runs took', () => {
  const s = spool();
  s.gitInit();
  s.write('README.md', 'a\n');
  s.commitAll('Start');
  s.sp('sprint', 'Polish');
  const a = s.id('task', 'One', '--sprint', 'Polish');
  const b = s.id('task', 'Two', '--sprint', 'Polish');
  s.sp('builder', 'headless');
  s.sp('notify', 'on', 'sprint');
  const marker = path.join(s.root, 'notified.txt');
  const env = { SPOOL_NOTIFY: `echo "$SPOOL_EVENT $SPOOL_TITLE" >> "${marker}"` };
  for (const id of [a, b]) {
    s.sp('start', id);
    s.write(`src/${id}.txt`, 'x\n');
    s.commitAll(`Do ${id}\n\nSpool: ${id}`);
  }
  s.exec(['done', a, '-m', 'one'], { env });
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', '');
  s.exec(['done', b, '-m', 'two'], { env });
  const told = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(told.length, 1);
  assert.match(told[0]!, /^sprint 2 threads shipped since you last looked/);
  s.cleanup();
});
