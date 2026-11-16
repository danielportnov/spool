import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox, spool, startPage } from './helpers.ts';

const configFile = (s: Sandbox): string => path.join(s.root, '.home', '.config', 'spool', 'config.json');
const config = (s: Sandbox): Record<string, any> => JSON.parse(fs.readFileSync(configFile(s), 'utf8'));
const readingFile = (s: Sandbox): string => path.join(s.root, '.home', '.config', 'spool', 'usage.json');

test('spool target sets how much of the plan a chat may use, reads it back, and takes it off', () => {
  const s = spool();
  try {
    assert.match(s.sp('target'), /^No usage target: a chat in Chat mode builds what is in Build, whatever the usage\.\n {2}Set one on the page, in the header, or: spool target --weekly 80$/);
    assert.equal(fs.existsSync(configFile(s)), false, 'saying what is set keeps nothing');

    assert.match(s.sp('target', '--weekly', '80', '--five-hour', '90%'), /^Usage target: weekly 80%, 5-hour 90%\. A chat in Chat mode works up to it, then takes no new thread\.\n {2}No usage has been read yet/);
    assert.deepEqual(config(s).usageTarget, { weekly: 80, fiveHour: 90 });
    assert.deepEqual(s.json('target').target, { weekly: 80, fiveHour: 90 });

    // One limit changed or taken off leaves the other as it was.
    s.sp('target', '--weekly', '75');
    assert.deepEqual(config(s).usageTarget, { weekly: 75, fiveHour: 90 });
    assert.match(s.sp('target', '--five-hour', 'none'), /^Usage target: weekly 75%\./);
    assert.deepEqual(config(s).usageTarget, { weekly: 75 });
    // None at all is what nothing said means, so nothing is kept for it.
    s.sp('target', '--weekly', 'none');
    assert.equal(config(s).usageTarget, undefined);
    assert.deepEqual(s.json('target').target, {});
  } finally {
    s.cleanup();
  }
});

test('a target that is not a whole percent from 1 to 100 is refused in words, and nothing is kept', () => {
  const s = spool();
  try {
    for (const bad of ['0', '101', 'most', '80.5', '-5']) {
      assert.match(s.fails('target', `--weekly=${bad}`), new RegExp(`"${bad.replace('.', '\\.')}" is not a weekly target`));
    }
    assert.match(s.fails('target', '--five-hour', '0'), /"0" is not a 5-hour target[\s\S]*whole percent from 1 to 100, or none/);
    assert.match(s.fails('target', '80'), /a target is given with its flag[\s\S]*spool target --weekly 80/);
    assert.equal(fs.existsSync(configFile(s)), false);
  } finally {
    s.cleanup();
  }
});

test('the chat reports the usage it read, and hears keep building until the target is reached, then stop', () => {
  const s = spool();
  try {
    // With no target, a reading changes nothing: build what is in Build.
    assert.equal(s.sp('usage', '--weekly', '40', '--as', 'Claude Opus 5.5'), 'No usage target is set: build what is in Build, whatever the usage.');
    assert.equal(s.json('usage', '--weekly', '40').keepBuilding, true);

    s.sp('target', '--weekly', '80', '--five-hour', '90');
    assert.equal(s.sp('usage', '--weekly', '62', '--five-hour', '18', '--as', 'Claude Opus 5.5'), 'Keep building: weekly 62% of 80%, 5-hour 18% of 90%.');
    const kept = JSON.parse(fs.readFileSync(readingFile(s), 'utf8'));
    assert.deepEqual(kept.used, { weekly: 62, fiveHour: 18 });
    assert.equal(kept.by, 'Claude Opus 5.5');
    assert.equal(kept.at, s.json('usage').read.at, 'the reading is kept with when it was read');

    // Reaching one limit is enough to stop.
    const stop = s.sp('usage', '--weekly', '79', '--five-hour', '90');
    assert.match(stop, /^Stop: the usage target is reached, weekly 79% of 80%, 5-hour 90% of 90%\.\n {2}Claim no new thread, and let what is being built land\. Tell them once\./);
    const data = s.json('usage', '--weekly', '81');
    assert.deepEqual([data.reached, data.keepBuilding], [['weekly'], false]);
    // A limit with a target the reading left out is said not to be checked.
    assert.match(s.sp('usage', '--weekly', '50'), /^Keep building: weekly 50% of 80%\.\n {2}The 5-hour figure was not given, so its target was not checked\.$/);

    // Raising the target lets it carry on from the same reading.
    s.sp('usage', '--weekly', '81', '--five-hour', '20');
    assert.match(s.sp('target'), /Reached: weekly\. The chat takes no new thread until it is under again, or the target is raised\./);
    s.sp('target', '--weekly', '95');
    assert.deepEqual(s.json('usage').reached, []);
    assert.match(s.sp('usage'), /Last read 4m ago by agent: weekly 81%, 5-hour 20%\./);

    assert.match(s.fails('usage', '--weekly', '120'), /"120" is not a percent used[\s\S]*from 0 to 100/);
    assert.match(s.fails('usage', '62'), /a figure is given with its flag/);
  } finally {
    s.cleanup();
  }
});

test('where the gate is locked an agent may read the target and report usage, but only the human sets it', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--lock');
    assert.match(s.fails('target', '--weekly', '80'), /spool target is the human's alone in skyhop: its gate is locked/);
    assert.match(s.exec(['target', '--weekly', '80'], { tty: true }).out, /^Usage target: weekly 80%/);
    // Saying what is already so changes nothing, so the lock has nothing to refuse.
    assert.match(s.sp('target', '--weekly', '80'), /^Usage target: weekly 80%/);
    assert.match(s.sp('usage', '--weekly', '30', '--as', 'Claude Opus 5.5'), /^Keep building: weekly 30% of 80%\.$/);
  } finally {
    s.cleanup();
  }
});

test('spool builder chat tells the loop the target it works up to', () => {
  const s = spool();
  try {
    assert.doesNotMatch(s.sp('builder', 'chat'), /usage/);
    s.sp('target', '--weekly', '80');
    assert.match(s.sp('builder'), /The chat builds 1 thread at once: it is not a git repository, so its threads cannot have a worktree each\. It works up to the usage target, weekly 80%: spool usage says when to stop\.$/);
    // Headless, the page's own agents build, and the target is not theirs.
    assert.doesNotMatch(s.sp('builder', 'headless'), /usage/);
  } finally {
    s.cleanup();
  }
});

test('the board carries the target and the last reading, and the page sets the target as spool target', async () => {
  const s = spool();
  s.sp('builder', 'chat');
  const page = await startPage(s);
  const board = async (): Promise<any> => (await fetch(`${page.url}api/board`)).json();
  const post = async (body: unknown): Promise<any> =>
    (await fetch(`${page.url}api/target`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) })).json();
  try {
    assert.deepEqual((await board()).usage, { target: {}, read: null, reached: [] });
    s.sp('target', '--weekly', '80');
    s.sp('usage', '--weekly', '62', '--five-hour', '18', '--as', 'Claude Opus 5.5');
    const { usage } = await board();
    assert.deepEqual(usage.target, { weekly: 80 });
    assert.deepEqual([usage.read.used, usage.read.by, usage.reached], [{ weekly: 62, fiveHour: 18 }, 'Claude Opus 5.5', []]);

    // The header's slider and box: a percent for a limit, or null to take it off.
    assert.equal((await post({ weekly: 60, fiveHour: 90 })).ok, true);
    assert.deepEqual(s.json('target').target, { weekly: 60, fiveHour: 90 });
    assert.deepEqual((await board()).usage.reached, ['weekly']);
    assert.equal((await post({ weekly: null })).ok, true);
    assert.deepEqual(s.json('target').target, { fiveHour: 90 });
    const refused = await post({ weekly: 0 });
    assert.deepEqual([refused.ok, refused.text], [false, '"0" is not a weekly target']);
    assert.deepEqual(await post({ weekly: 'lots' }), { ok: false, text: 'a target is a percent, or none' });
    assert.deepEqual(await post({}), { ok: false, text: 'which target?' });
    assert.deepEqual(s.json('target').target, { fiveHour: 90 });
  } finally {
    await page.stop();
    s.cleanup();
  }
});
