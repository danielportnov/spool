import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

/** One numbered part of the worksheet: from its heading to the next blank line. */
function part(sheet: string, n: number): string {
  const from = sheet.indexOf(`\n${n}  `);
  assert.ok(from >= 0, `the worksheet has a part ${n}`);
  const rest = sheet.slice(from + 1);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

test('the ideation worksheet gathers the goals, what shipped, what is there, what was said and what was said no to, and writes nothing', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo');
  s.sp('goals', '--edit', 'For: splitting a bill at the table\n\n- works on a phone');
  s.write('README.md', 'a tip splitter\n');
  s.write('docs/how.md', 'how\n');
  s.write('CHANGELOG.md', '# Changelog\n\n## 0.2.0\n\n- Shares add up to the bill.\n\n## 0.1.0\n\n- First.\n');
  const shipped = s.id('task', 'Round each share to the cent', '-s', 's');
  s.sp('start', shipped);
  s.sp('done', shipped, '-m', 'Shares are rounded to the cent', '--steps', 'Split 10 by 3');
  const open = s.id('task', 'Show each share as you type', '-s', 's');
  const note = s.id('capture', 'can I type 18% instead of 18?');
  const csv = s.id('task', 'Export the split as CSV', '-s', 's', '--suggested', 'for spreadsheets');
  s.sp('drop', csv, '-m', 'nobody uses spreadsheets at dinner');

  const before = s.json('list', '--all').items.length;
  const sheet = s.sp('ideate');
  assert.equal(s.json('list', '--all').items.length, before, 'it files nothing itself');

  assert.match(sheet, /^New ideas for demo/);
  assert.match(sheet, /\nNew ideas: 5 at most this pass\. No earlier AI idea is waiting for an answer\.\n/);
  assert.match(part(sheet, 1), /For: splitting a bill at the table/);
  assert.match(part(sheet, 2), new RegExp(`${shipped} {2}Round each share to the cent .*Shares are rounded to the cent`));
  assert.match(part(sheet, 2), /The changelog's newest, 0\.2\.0:\n\s+- Shares add up to the bill\./);
  assert.doesNotMatch(part(sheet, 2), /First\./, 'only the newest version');
  assert.match(part(sheet, 3), new RegExp(`${open} .*Show each share as you type`));
  assert.doesNotMatch(part(sheet, 3), new RegExp(csv), 'a dropped thread is not open');
  assert.match(part(sheet, 4), new RegExp(`${note} {2}"can I type 18% instead of 18\\?" .*unfiled`));
  assert.match(part(sheet, 5), new RegExp(`✗ ${csv} {2}Export the split as CSV .*an AI idea, dropped: nobody uses spreadsheets at dinner`));
  assert.match(part(sheet, 6), /README\.md\n {2}docs\/how\.md/);
  assert.match(sheet, /spool task "<the idea>" --suggested "<why, in a line they would agree with>"/);

  // As data, for a harness to read.
  const data = s.json('ideate');
  assert.equal(data.cap, 5);
  assert.deepEqual(data.saidNo.dropped.map((d: { id: string }) => d.id), [csv]);
  s.cleanup();
});

test('a pass files no idea while too many earlier ones wait, unless the user named a number', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo');
  for (let i = 0; i < 10; i++) s.sp('task', `An idea about thing number ${i}`, '-s', 'xs', '--suggested', 'why not');
  assert.match(s.sp('ideate'), /\nNew ideas: none this pass\. 10 earlier AI ideas still wait for an answer/);
  assert.match(s.sp('ideate', '--max', '3'), /\nNew ideas: 3 at most this pass\. 10 earlier AI ideas still wait for an answer\.\n/);
  assert.match(s.fails('ideate', '--max', 'lots'), /--max takes a number of ideas/);
  s.cleanup();
});

test('without goals, the worksheet says to ask for them', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo');
  assert.match(part(s.sp('ideate'), 1), /No goals yet\. Ask the user what it is for/);
  s.cleanup();
});
