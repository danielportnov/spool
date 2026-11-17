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

test('where the gate is locked an agent may read the target and report usage, but only the user sets it', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--lock');
    assert.match(s.fails('target', '--weekly', '80'), /spool target is the user's alone in skyhop: its gate is locked/);
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
    assert.match(s.sp('builder'), /The chat builds 1 thread at once: it is not a git repository, so its threads cannot have a worktree each\. It works up to the usage target, weekly 80%: spool usage says when to stop\.$/m);
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
    assert.deepEqual((await board()).usage, { agent: 'Claude', target: {}, own: {}, cannotRead: false, read: null, reached: [], fableCap: null, all: {} });
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

test('Fable has its own weekly figure and target: spent, a thread set to Fable or stepping up to it is built on Opus, and says why', () => {
  const s = spool();
  try {
    s.sp('target', '--weekly', '80', '--fable', '90');
    assert.deepEqual(config(s).usageTarget, { weekly: 80, fable: 90 });
    // Fable under its target: it does not stop the chat, and threads may still go to Fable.
    assert.match(s.sp('usage', '--weekly', '40', '--fable', '70', '--as', 'Claude Opus 5.5'), /^Keep building: weekly 40% of 80%\.\n {2}Fable is at 70% of its 90% target: threads may still go to Fable\./);
    const t = s.id('task', 'Fix a typo', '--size', 'xs');
    s.sp('edit', t, '--model', 'fable');
    assert.equal(s.json('start', t, '--as', 'Claude Opus 5.5').model.model, 'fable');

    // Fable over its target: the weekly is fine, so the chat keeps building, but not on Fable.
    const over = s.json('usage', '--weekly', '40', '--fable', '96', '--as', 'Claude Opus 5.5');
    assert.equal(over.keepBuilding, true);
    assert.equal(over.fableCap, 96);
    assert.match(s.sp('usage'), /Fable is at 96% of its 90% target: no thread goes to Fable now/);
    const t2 = s.id('task', 'Fix another typo', '--size', 'xs');
    s.sp('edit', t2, '--model', 'fable');
    const started = s.json('start', t2, '--as', 'Claude Opus 5.5');
    assert.equal(started.model.model, 'opus');
    assert.match(s.item(t2), /Claude Opus 5\.5: is set to Fable, but Fable's weekly usage is at 96%: built on Opus/);
    assert.match(s.sp('show', t2), /built on Opus/);
    // With no Fable target, 95% is where it counts as spent.
    s.sp('target', '--fable', 'none');
    assert.equal(s.json('usage', '--fable', '94').fableCap, null);
    assert.equal(s.json('usage', '--fable', '95').fableCap, 95);
  } finally {
    s.cleanup();
  }
});

test('each agent is held to its own target: Codex stops at 50% while Claude keeps going to 80%', () => {
  const s = spool();
  try {
    s.gitInit();
    s.write('.gitignore', '.home/\n');
    s.commitAll('start');
    s.sp('builder', 'chat');
    for (const agent of ['Claude', 'Codex']) s.sp('builder', '--agent', agent, '--at-once', '3');
    const threads = Array.from({ length: 4 }, (_, i) => s.id('task', `Thread ${i + 1}`));
    for (const t of threads) s.sp('build', t);

    // The target for all is Claude's; Codex has one of its own, any other limit taken from the one for all.
    s.sp('target', '--weekly', '80', '--five-hour', '90');
    assert.match(s.sp('target', '--agent', 'codex', '--weekly', '50'), /^Codex's usage target: weekly 50%, 5-hour 90% \(its own weekly 50%\)\. Codex works up to it/);
    assert.deepEqual(config(s).agentTargets, { Codex: { weekly: 50 } });
    assert.match(s.sp('target'), /^Usage target: weekly 80%, 5-hour 90%\.[^\n]*\n {2}Codex: weekly 50%, its own\./);
    assert.deepEqual(s.json('target', '--agent', 'Claude').target, { weekly: 80, fiveHour: 90 });

    // Each reports its own plan, signed with its name, and hears its own answer.
    assert.equal(s.sp('usage', '--weekly', '60', '--five-hour', '10', '--as', 'Claude Opus 5.5'), 'Keep building: weekly 60% of 80%, 5-hour 10% of 90%.');
    assert.match(s.sp('usage', '--weekly', '55', '--five-hour', '10', '--as', 'Codex GPT-6'), /^Stop: Codex's usage target is reached, weekly 55% of 50%, 5-hour 10% of 90%\./);
    const kept = JSON.parse(fs.readFileSync(readingFile(s), 'utf8'));
    assert.deepEqual(Object.keys(kept.agents), ['Claude', 'Codex']);
    assert.equal(kept.by, 'Codex GPT-6', 'the last reading of all stays at the top, as it was');
    assert.deepEqual(s.json('usage', '--as', 'Claude Opus 5.5').read.used, { weekly: 60, fiveHour: 10 });

    // Codex takes no new thread; Claude keeps going.
    assert.match(s.fails('next', '--claim', '--as', 'Codex GPT-6'), /Codex's usage target is reached, weekly 55% of 50%[\s\S]*spool target --agent Codex/);
    assert.match(s.sp('next', '--claim', '--as', 'Claude Opus 5.5'), /^t-/);
    // Raised, Codex carries on from the same reading.
    s.sp('target', '--agent', 'Codex', '--weekly', '70');
    assert.match(s.sp('next', '--claim', '--as', 'Codex GPT-6'), /^t-/);
    // Its own taken off, it is held to the one for all again.
    s.sp('target', '--agent', 'Codex', '--weekly', 'none');
    assert.equal(config(s).agentTargets, undefined);
    assert.deepEqual(s.json('usage', '--as', 'Codex').target, { weekly: 80, fiveHour: 90 });

    // A reading from the last half hour only: an old one refuses nothing, the agent reads it again first.
    // (Six hours on, so the headroom near the end of the budget does not hold it either.)
    s.sp('target', '--agent', 'Codex', '--weekly', '50');
    s.sp('usage', '--weekly', '55', '--as', 'Codex');
    s.advance(6);
    assert.match(s.sp('next', '--claim', '--as', 'Codex GPT-6'), /^t-/);
  } finally {
    s.cleanup();
  }
});

test('an agent that cannot read its usage says so, and the board shows each agent against its own target', async () => {
  const s = spool();
  s.sp('builder', 'chat');
  const page = await startPage(s);
  const board = async (): Promise<any> => (await fetch(`${page.url}api/board`)).json();
  const post = async (body: unknown): Promise<any> =>
    (await fetch(`${page.url}api/target`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) })).json();
  try {
    s.sp('target', '--weekly', '80');
    s.sp('usage', '--weekly', '62', '--as', 'Claude Opus 5.5');
    assert.match(s.sp('usage', '--cannot-read', '--as', 'Codex GPT-6'), /^Noted: Codex cannot read its usage\. The board says so/);
    assert.match(s.fails('usage', '--cannot-read', '--weekly', '4', '--as', 'Codex'), /give one or the other/);
    // From Settings, an agent's own target.
    assert.equal((await post({ agent: 'Codex', weekly: 50 })).ok, true);
    assert.deepEqual(config(s).agentTargets, { Codex: { weekly: 50 } });
    const b = await board();
    assert.deepEqual(b.usage.all, { weekly: 80 });
    const [claude, codex] = b.runner.agents.map((a: any) => a.usage);
    assert.deepEqual([claude.agent, claude.target, claude.read.used, claude.cannotRead], ['Claude', { weekly: 80 }, { weekly: 62 }, false]);
    assert.deepEqual([codex.agent, codex.target, codex.own, codex.cannotRead, codex.read.by], ['Codex', { weekly: 50 }, { weekly: 50 }, true, 'Codex GPT-6']);
    assert.match(s.sp('usage', '--as', 'Codex'), /Codex GPT-6 said \S+ ago that it cannot read its usage, so it is not held to a target\./);
    assert.equal((await post({ agent: 'Codex', weekly: null })).ok, true);
    assert.equal(config(s).agentTargets, undefined);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
