/**
 * `spool demo`: a throwaway project to try Spool on before pointing it at real work.
 *
 * It writes a tiny program that runs with no installs, makes it a git repository
 * (undo needs git), and fills its spool with threads in every state the board
 * shows. The threads are made by running the same commands an agent runs, so
 * what is on the board is exactly what real use would leave there.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The commands are run through the CLI's own entry, the way an agent's would be. That import
// goes round in a circle (the CLI holds the command table that holds this), which is fine:
// nothing here is used until the command runs.
import { run } from './cli.ts';
import type { Bare, Result } from './commands.ts';
import type { Ctx } from './context.ts';
import { markLine } from './mark.ts';
import { SpoolError } from './model.ts';
import { servePage } from './page.ts';
import { findHome } from './store.ts';

/** The sample: a bill splitter with a test, small enough to read in a minute, with real rough edges. */
const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'tip-splitter', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'tip.js': `#!/usr/bin/env node
// Split a bill, tip included:  node tip.js <total> <people> [tip %]

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function split(total, people, tip = 15) {
  const withTip = total * (1 + tip / 100);
  return {
    total: Math.round(withTip * 100) / 100,
    share: Math.round((withTip / people) * 100) / 100,
  };
}

// Run as a command, not imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [total, people, tip] = process.argv.slice(2).map(Number);
  const bill = split(total, people, tip ?? 15);
  console.log(\`Total with tip: \${bill.total.toFixed(2)}\`);
  console.log(\`Each of \${people} pays: \${bill.share.toFixed(2)}\`);
}
`,
  'tip.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { split } from './tip.js';

test('a bill splits evenly, tip included', () => {
  assert.deepEqual(split(100, 4, 20), { total: 120, share: 30 });
});

test('each share is rounded to the cent', () => {
  assert.equal(split(84.5, 3, 18).share, 33.24);
});
`,
  'README.md': `# Tip splitter

Splits a bill between friends, tip included.

    node tip.js 84.50 3 18

Test it with \`npm test\`. Nothing to install.

This is a Spool demo: a throwaway project to try the board and the loop on.
Delete the folder when you are done with it.
`,
};

/** What every thread carries, the way /spool-record writes it. */
interface Spec {
  what: string;
  why: string;
  doneWhen: string;
}

interface Thread extends Spec {
  title: string;
  size: string;
}

const spec = (t: Spec): string => `What: ${t.what}\nWhy: ${t.why}\nDone when: ${t.doneWhen}`;

/** Where the demo goes: a fresh folder in the temp directory, or an empty one the person named. */
function placeFor(ctx: Ctx, named: string | undefined): string {
  if (!named) return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-demo-')));
  const dir = path.resolve(ctx.cwd, named);
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new SpoolError(`${dir} is a file`, 'Name a new folder, or leave it out for one in the temp directory: spool demo');
    if (fs.readdirSync(dir).length) {
      throw new SpoolError(`${dir} already has files in it`, 'The demo only goes in an empty folder. Name a new one, or leave it out: spool demo');
    }
  }
  // It is a project of its own: inside someone's repository or spool, it would show up in theirs.
  let up = dir;
  while (!fs.existsSync(up)) up = path.dirname(up);
  const home = findHome(up);
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: up, encoding: 'utf8' });
  const inside = home ?? (repo.status === 0 ? repo.stdout.trim() : '');
  if (inside) throw new SpoolError(`${dir} is inside ${inside}`, 'The demo is a project of its own. Name a folder outside it, or leave it out: spool demo');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(dir: string, args: string[]): string {
  const ran = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (ran.error) throw new SpoolError('git is not installed', 'The demo needs git: undoing a thread is undoing its commits.');
  if (ran.status !== 0) throw new SpoolError(`git ${args[0]} failed in ${dir}: ${ran.stderr.trim()}`);
  return ran.stdout.trim();
}

export function demo({ ctx, args, opts, p }: Bare): Result {
  const dir = placeFor(ctx, args.length ? args.join(' ') : undefined);
  for (const [file, text] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, file), text);

  // Each step a second apart, all of it just past, so the threads keep the order they were made in.
  let step = 0;
  const start = ctx.now().getTime() - 120_000;
  const spool = (argv: string[], stdin = ''): any => {
    const out: string[] = [];
    const err: string[] = [];
    const sub: Ctx = {
      ...ctx,
      cwd: dir,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      now: () => new Date(start + step * 1000),
      stdin: () => stdin,
      lines: () => {},
      color: false,
      inherit: false,
    };
    step++;
    const code = run([...argv, '--json'], sub);
    if (code !== 0) throw new SpoolError(`the demo could not run spool ${argv[0]}: ${err.join(' ') || out.join(' ')}`);
    return JSON.parse(out.join('\n'));
  };
  let threads = 0;
  const file = (argv: string[]): string => {
    threads++;
    return spool(argv).task.id as string;
  };
  const task = (t: Thread, ...more: string[]): string => file(['task', t.title, '-s', t.size, '-b', spec(t), ...more]);

  // A git repository with one first commit, so a built thread's commits can be undone. Its own
  // spool is ignored by git, as it is by default anywhere.
  git(dir, ['init', '-q', '-b', 'main']);
  spool(['init', '--name', 'tip-splitter', '--about', 'A bill splitter in one file, to try Spool on', '--gate']);
  // An agent builds by committing. Where this machine has no name for git yet, the throwaway repository gets one of its own.
  if (!spawnSync('git', ['config', 'user.email'], { cwd: dir, encoding: 'utf8' }).stdout.trim()) {
    git(dir, ['config', 'user.name', 'Spool demo']);
    git(dir, ['config', 'user.email', 'demo@spool.invalid']);
  }
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'A bill splitter, with its test']);

  // Done already, so Done is not empty: what a finished thread looks like, with its result.
  const rounded = task({
    title: 'Round each share to the cent',
    size: 'xs',
    what: 'A share like 33.2366… printed in full. Round every amount to two places.',
    why: 'Money has cents, and nobody pays a third of one.',
    doneWhen: 'node tip.js 84.50 3 18 prints 33.24 each, and a test covers it.',
  });
  spool(['build', rounded]);
  spool(['start', rounded, '--as', 'claude']);
  spool(['done', rounded, '--as', 'claude', '-m', 'Every amount is rounded to the cent and printed with two places: node tip.js 84.50 3 18 says 33.24 each. The test "each share is rounded to the cent" covers it.']);

  // A plan, built: its report, and the two parts it was cut into, the second waiting on the first.
  const plan = file(['plan', 'Make it a page that works on a phone', '-s', 'm', '-b', spec({
    what: 'One tip.html, with no build step, that does what tip.js does.',
    why: 'Nobody opens a terminal at a restaurant table.',
    doneWhen: 'a plan names the parts, each small enough to build in one go.',
  })]);
  spool(['build', plan]);
  spool(['start', plan, '--as', 'claude']);
  const form = task({
    title: 'Draw the tip page: total, people and tip',
    size: 's',
    what: 'tip.html beside tip.js: three number fields and a large answer, readable on a phone without zooming. It keeps its own copy of split(), since a page opened from a file cannot import tip.js.',
    why: 'The first part of the plan for a phone page.',
    doneWhen: 'opening tip.html shows the form at phone width, with no sideways scrolling.',
  }, '--from', plan);
  task({
    title: 'Show each share as you type',
    size: 's',
    what: 'Fill in the answer as the fields change, with the same rounding as tip.js. No button.',
    why: 'The second part of the plan: at a table, a button is one thing too many.',
    doneWhen: 'typing 84.50, 3 and 18 shows 33.24 each straight away.',
  }, '--from', plan, '--needs', form);
  spool(
    ['done', plan, '--as', 'claude', '-m', 'One tip.html in two parts: the form first, then the answer as you type.', '--report', '-'],
    `# A tip page for a phone

One file, tip.html, next to tip.js, opened straight from the folder. A page opened from a file
cannot import a module, so it keeps its own copy of split(), six lines long.

1. Draw the form: total, people and tip, and a large answer. Phone width first.
2. Fill the answer in as the fields change, with the same rounding as tip.js.

The second needs the first. Neither needs anything installed.
`,
  );

  // The first sprint: three small fixes to what anyone trying it hits first. It waits for play.
  const sprint = spool(['sprint', 'First round', '--goal', 'tip.js never prints nonsense', '--why', 'These are the first things anyone who tries it runs into', '--done-when', 'every wrong way of running it gets a plain sentence back']).sprint.id as string;
  const nan = spool(['capture', "I ran it with no numbers and it said NaN. That's embarrassing."]).note.id as string;
  task({
    title: 'Say how to use it when the numbers are missing',
    size: 'xs',
    what: 'Run with no total or no people, tip.js prints NaN. Print one line instead, usage: node tip.js <total> <people> [tip %], and exit with 1.',
    why: 'NaN is the first thing a person sees if they run it bare.',
    doneWhen: 'node tip.js prints the usage line and exits with 1.',
  }, '--from', nan, '-p', '1', '--sprint', sprint);
  task({
    title: 'Refuse to split a bill between no one',
    size: 'xs',
    what: 'node tip.js 50 0 says each of 0 pays Infinity. Say "Split it between at least one person." and exit with 1; split() throws for fewer than one person.',
    why: 'Infinity is not an answer.',
    doneWhen: 'both the command and split() refuse 0 and negative people, with a test.',
  }, '--sprint', sprint);
  task({
    title: 'Show the tip on a line of its own',
    size: 's',
    what: 'Print the tip before the total: Tip (18%): 15.21.',
    why: 'People check the tip before they trust the total.',
    doneWhen: 'node tip.js 84.50 3 18 shows the tip, the total and each share, in that order.',
  }, '--sprint', sprint);

  // In Build already: an agent may start this one now.
  const percent = spool(['capture', 'can I type 18% instead of 18? I always do']).note.id as string;
  const sign = task({
    title: 'Accept a tip written with a percent sign',
    size: 'xs',
    what: 'node tip.js 84.50 3 18% gives NaN. Read 18% as 18.',
    why: 'It is how people write a tip.',
    doneWhen: '18 and 18% give the same answer, with a test.',
  }, '--from', percent);
  spool(['build', sign]);

  // In Build, and waiting on a call that is the user's.
  const cent = task({
    title: 'Make the shares add up to the bill',
    size: 's',
    what: '10.00 between three, with no tip, is 3.33 each, which adds up to 9.99.',
    why: 'Whenever it does not divide evenly, somebody is a cent short.',
    doneWhen: 'the shares always add up to the total, to the cent, and the output says who pays the extra.',
  });
  spool(['build', cent]);
  spool(['ask', 'Who pays the cent that is left over?', '--option', 'The first person: 3.34, 3.33, 3.33', '--option', 'Everyone rounds up, and the total shows 10.02', '--recommend', '1', '--why', 'Both are fair. It changes what the output says.', '--for', cent, '--as', 'claude']);

  // An agent's own idea, waiting for a yes.
  file(['audit', 'Read the README as someone who has never seen this project', '-s', 's', '--suggested', 'The README is a few lines: a newcomer may not get past them.', '-b', spec({
    what: 'Follow README.md from the top, as a person new to the project, and note each place they would get stuck.',
    why: 'A README is read once, by someone who has nobody to ask.',
    doneWhen: 'a short report, with each problem filed as a thread.',
  })]);

  const shown = /^[\w./-]+$/.test(dir) ? dir : `"${dir}"`;
  const out = [
    `A demo project is ready: ${p.bold(dir)}`,
    p.dim(`  tip.js splits a bill, with a test (npm test). Its spool has ${threads} threads, a sprint and a question for you.`),
    '',
    ...[markLine(ctx)].filter(Boolean),
    opts.open ? 'The board opens in your browser, at the address below.' : `Open the board:  spool page -C ${shown}`,
    'Then try:',
    '  move a thread from Backlog to Build: drag it, or press ▶ on it',
    '  in the Backlog view, press play on the sprint "First round"',
    '  answer the question on "Make the shares add up to the bill"',
    'Agents build only what is in Build. To have one build it, open the folder in Claude Code and type',
    `/spool-loop, or start the page with --run. When you are done:  rm -rf ${shown}`,
  ];
  // The page starts listening once these lines are out, and prints its own address after them.
  if (opts.open) servePage({ ctx: { ...ctx, cwd: dir }, args: [], opts: {}, actor: 'human', p });
  return { text: out.join('\n'), data: { dir, threads } };
}
