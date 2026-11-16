import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { withoutBlock, upsertBlock } from '../src/prime.ts';
import { CLI, Sandbox, pause, spool, startPage, until } from './helpers.ts';

test('disable takes the Spool block out, keeps the queue, and every command then says Spool is off', () => {
  const s = new Sandbox();
  s.write('CLAUDE.md', '# My project\n\nMy own rules.\n');
  s.sp('init', '--name', 'demo');
  const pointed = s.read('CLAUDE.md');
  s.sp('task', 'Tighten the jump');

  const out = s.sp('disable');
  assert.match(out, /^Spool is off in demo\.\n {2}Took the Spool block out of CLAUDE\.md\.\nThe queue is kept as it was\. spool enable turns it back on\.$/);
  assert.equal(s.read('CLAUDE.md'), '# My project\n\nMy own rules.\n');
  assert.deepEqual(JSON.parse(s.read('.spool/config.json')).disabled.block, ['CLAUDE.md']);

  // An agent sent here by habit is told, and told what to do instead.
  for (const args of [['status'], ['capture', 'the jump is floaty'], ['list'], ['loop', '--dry-run'], ['watch']]) {
    const said = s.exec(args);
    assert.equal(said.code, 1, `spool ${args.join(' ')} is refused`);
    assert.match(said.err, /^spool: Spool is off in demo\n {2}Nothing here goes through it: work as you would without Spool\. spool enable turns it back on, on the human's word\.$/);
  }
  assert.match(s.sp('page', '--status'), /No Spool page is up/);
  assert.match(s.sp('disable'), /^Spool is already off in demo\.$/);

  // On again: the block is back where it was, and so is the work.
  assert.match(s.sp('enable'), /^Spool is on in demo again\.\n {2}Put the Spool block back in CLAUDE\.md\.$/);
  assert.equal(s.read('CLAUDE.md'), pointed);
  assert.equal(JSON.parse(s.read('.spool/config.json')).disabled, undefined);
  assert.match(s.sp('status'), /Tighten the jump/);
  assert.match(s.sp('enable'), /^Spool is already on in demo\.$/);
  s.cleanup();
});

test('a file that held only the Spool block goes when it is switched off, and comes back as it was', () => {
  const s = spool();
  const pointed = s.read('AGENTS.md');
  assert.match(s.sp('disable'), /Took out AGENTS\.md, which held only the Spool block\./);
  assert.equal(s.exists('AGENTS.md'), false);
  assert.match(s.sp('enable'), /Put AGENTS\.md back, with the Spool block in it\./);
  assert.equal(s.read('AGENTS.md'), pointed);
  s.cleanup();
});

test('enable puts the block back only where disable took it out', () => {
  const s = new Sandbox();
  s.write('CLAUDE.md', '# Mine, with no pointer\n');
  s.sp('init', '--name', 'demo', '--no-agents-file');
  assert.match(s.sp('disable'), /Had no Spool block to take out\./);
  assert.match(s.sp('enable'), /Had no Spool block taken out, so none was put back\./);
  assert.equal(s.read('CLAUDE.md'), '# Mine, with no pointer\n');
  assert.equal(s.exists('AGENTS.md'), false);

  // The file names are a project's own data: enable writes the two Spool writes, and nothing else.
  const config = JSON.parse(s.read('.spool/config.json'));
  s.write('.spool/config.json', JSON.stringify({ ...config, disabled: { since: '2026-01-01T00:00:00Z', block: ['../elsewhere.md', 'AGENTS.md'] } }));
  s.sp('enable');
  assert.equal(s.exists('../elsewhere.md'), false);
  assert.match(s.read('AGENTS.md'), /<!-- spool:start -->/);
  s.cleanup();
});

test('--all switches every spool in this folder and below it, and a project switched off is left out of the folder above', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'top');
  const one = s.cd('apps/one');
  one.sp('init', '--name', 'one');
  one.sp('task', 'A thread in one');
  const two = s.cd('games/two');
  two.sp('init', '--name', 'two');

  // One switched off on its own: the folder above no longer shows it.
  one.sp('disable');
  const shown = s.sp('status');
  assert.doesNotMatch(shown, /apps\/one|A thread in one/);
  assert.ok(s.fails('list', '-P', 'apps/one').includes('no project "apps/one"'));

  const all = s.sp('disable', '--all');
  assert.match(all, /^Spool is off in 3 projects \(1 already was\)\.\n {2}top {8}took out AGENTS\.md, which held only the Spool block\n {2}apps\/one {3}was already off\n {2}games\/two {2}took out AGENTS\.md, which held only the Spool block\nTheir queues are kept as they were\. spool enable --all turns them back on\.$/);
  for (const at of [s, one, two]) assert.equal(at.exec(['status']).code, 1);

  // From a folder of its own, --all reaches only what is under it.
  assert.match(s.cd('apps').sp('enable', '--all'), /^Spool is on in one again\./);
  assert.equal(s.exec(['status']).code, 1);
  assert.match(one.sp('status'), /A thread in one/);

  const back = s.json('enable', '--all');
  assert.deepEqual(back.projects.map((p: { name: string; changed: boolean }) => [p.name, p.changed]), [['top', true], ['one', false], ['two', true]]);
  assert.match(s.sp('status'), /A thread in one/);
  s.cleanup();
});

test('--all with no spool below says so, and so does enable where there is no spool', () => {
  const s = new Sandbox();
  assert.match(s.fails('disable', '--all'), /no spool in this folder or below it/);
  assert.match(s.fails('enable'), /no \.spool\/ here or in any parent directory/);
  s.cleanup();
});

test('init leaves a spool that is switched off as it is, and doctor says it is off', () => {
  const s = spool();
  s.sp('disable');
  const again = s.sp('init', '--refresh');
  assert.match(again, /^Spool is set up in demo, but switched off\. Nothing was changed\.\n {2}spool enable turns it back on$/);
  assert.equal(s.exists('AGENTS.md'), false);
  // Doctor ends wrong here for want of git; what it says of the spool is the point.
  const found = JSON.parse(s.exec(['doctor', '--json']).out).checks.find((c: { id: string }) => c.id === 'spool');
  assert.equal(found.status, 'advice');
  assert.match(found.label, /switched off/);
  assert.deepEqual(found.fix, ['spool enable']);
  s.cleanup();
});

test('taking the block out leaves the rest of the file as it was, wherever the block sits', () => {
  for (const before of ['# Mine\n', '# Mine\n\nMore.\n', '', 'Above.\n']) {
    assert.equal(withoutBlock(upsertBlock(before)), before.trim() ? before : '');
  }
  const between = `Above.\n\n${upsertBlock('').trim()}\n\nBelow.\n`;
  assert.equal(withoutBlock(between), 'Above.\n\nBelow.\n');
  assert.equal(withoutBlock('No block here.\n'), 'No block here.\n');
});

test('a page up when Spool is switched off starts no new work, and builds again once it is on', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const worker = path.join(s.root, 'worker.sh');
  fs.writeFileSync(worker, `#!/bin/sh\ncat > /dev/null\n"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m "built" > /dev/null\n`);
  fs.chmodSync(worker, 0o755);
  const { url, token, stop } = await startPage(s, '--agent', worker);
  const post = (action: string, body: unknown) =>
    fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('move', { id: jump, to: 'build' })).status, 200);
    s.sp('disable');
    assert.equal((await post('runner', { on: true })).status, 200);
    await pause(1500);
    assert.doesNotMatch(s.item(jump), /handed to|^started:/m, 'in Build, and not started');
    s.sp('enable');
    await until('the thread is built', () => /^status: done$/m.test(s.item(jump)));
  } finally {
    await stop();
    s.cleanup();
  }
});
