/**
 * A night of work in a project that is not Spool, for the tests of what the page shows first: five
 * threads shipped, each with a call its agent made (so all five are worth a look), one question
 * holding up a thread in Build, and three threads waiting in the backlog.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Browser } from 'playwright-core';
import { CLI, Sandbox, openChrome } from './helpers.ts';

/** Build, claim, commit and finish a thread, with the steps to check it and a call made on the way. */
export function ship(s: Sandbox, id: string, summary: string, steps: string[] = [], call = ''): void {
  s.sp('build', id);
  s.sp('start', id);
  if (call) s.sp('assume', call, '--chose', 'The plain way', '--for', id);
  s.write(`src/${id}.txt`, `${summary}\n`);
  s.commitAll(`${summary}\n\nSpool: ${id}`);
  s.sp('done', id, '-m', summary, ...steps.flatMap((step) => ['--steps', step]));
}

/** A project called tip-splitter, in git, with its spool set up and nothing in it yet. */
export function tipProject(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'tip-splitter', '--gate');
  s.gitInit();
  s.write('README.md', 'splits a bill\n');
  s.commitAll('Start');
  return s;
}

export function tipNight(): Sandbox {
  const s = tipProject();
  const shipped: [string, string, string[]][] = [
    ['Accept a tip written with a percent sign', 'A tip written `18%` now reads as **18**, and a test covers it', ['Run node tip.js 84.50 3 18%', 'See 33.24 each, the same as with 18']],
    ['Round each share to the cent', 'Every amount is rounded to the cent and printed with two places', ['Run node tip.js 84.50 3 18']],
    ['Colour the total in green', 'The total is green in a terminal that has colour', []],
    ['Show the tip on its own line', 'The tip has a line of its own, under the shares', ['Run node tip.js 50 2 10']],
    ['Explain rounding in the README', 'The README says who pays the odd cent, and why', []],
  ];
  for (const [title, summary, steps] of shipped) ship(s, s.id('task', title, '-s', 'xs'), summary, steps, `How to go about: ${title}?`);
  const cent = s.id('task', 'Make the shares add up to the bill', '-s', 's', '-b', 'What: shares that add up\nWhy: whenever it does not divide evenly, somebody is a cent short\nDone when: the shares always sum to the total');
  s.sp('build', cent);
  s.sp('ask', 'Who pays the cent that is left over?', '--option', 'The first person: 3.34, 3.33, 3.33', '--option', 'Everyone rounds up, and the total shows 10.02', '--recommend', '1', '--for', cent);
  for (const title of ['Say how to use it when the numbers are missing', 'Refuse to split a bill between no one', 'Remember the last tip used']) s.id('task', title, '-s', 's', '-b', 'Why: people ask for it');
  return s;
}

/** A stand-in agent that is not claude: it works on and on, saying so. */
export function slowAgent(s: Sandbox): string {
  const file = path.join(s.root, 'agent.sh');
  fs.writeFileSync(file, `#!/bin/sh\nspool() { "${process.execPath}" "${CLI}" "$@"; }\ncat > /dev/null\ni=1; while [ $i -le 600 ]; do sleep 0.25; echo "Still working, tick $i"; i=$((i+1)); done\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Chrome, or the test skipped where there is none. */
export async function chrome(t: { skip: (why: string) => void }): Promise<Browser | null> {
  try {
    return await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return null;
  }
}
