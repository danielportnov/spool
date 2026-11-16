import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { section, shipped, workerRules } from '../src/builtin.ts';
import { spool } from './helpers.ts';

/**
 * "Working a thread" as `spool prime worker` printed it while it was a section of the loop skill
 * (commit 131b10a): the sha256 of that text. The rules moved to rules/worker.md and did not change.
 * Changed them on purpose since? Put the new hash here.
 */
const WORKING_A_THREAD = '181318037121d03da6af77114efa6ac69982362ceb477389572fae944baa170f';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

test("the worker's rules are one shipped file, and spool prime worker prints them as it did", () => {
  const s = spool();
  try {
    const working = section('Working a thread');
    assert.equal(sha(working), WORKING_A_THREAD, `"Working a thread" is not the text it was. Meant? The hash is now ${sha(working)}`);

    // What a worker is primed with: the protocol's few lines, then the rules from their first heading on, then the project.
    const primed = s.sp('prime', 'worker');
    assert.ok(primed.startsWith('# Spool · worker protocol\n'));
    assert.ok(primed.includes(`\n\n${workerRules()}\n\nPOLICY (.spool/policy.md)`), 'the whole file, between the protocol and the policy');
    assert.ok(workerRules().startsWith(`${working}\n\n## A version for what shipped\n`), 'working a thread first, as before, then versions');
    assert.doesNotMatch(primed, /# The worker's rules|\/spool-loop/, 'not the lines that say what the file is');
    assert.equal(s.sp('prime'), primed, 'worker is the role when none is named');

    // The rule for versions came with them, and says whose it is when an agent has one thread only.
    assert.match(section('A version for what shipped'), /Audits and plans alone change no version\.\nHanded one thread and nothing more\? Then only a sprint reached is yours to cut\./);

    // With --context a worker gets none of it.
    assert.doesNotMatch(s.sp('prime', 'worker', '--context'), /Working a thread|A version for what shipped/);
    assert.throws(() => section('No such part'), /the worker's rules have no "No such part" section/);
  } finally {
    s.cleanup();
  }
});

test('the loop skill points at the rules and repeats none of them', () => {
  const loop = shipped('spool-loop');
  assert.match(loop, /`spool prime worker`/);
  assert.doesNotMatch(loop, /^#+ (Working a thread|A version for what shipped|Size: how much would have to change|Choices the thread doesn't settle|The human's verbs)$/m);
  assert.doesNotMatch(loop, /\*\*An audit\.\*\*|\*\*In a worktree\.\*\*|\*\*Find the version\*\*/);
});

test('the rules ship in the package, beside the skills', () => {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('rules'), 'package.json ships rules/');
  assert.ok(pkg.files.includes('skills'));
  assert.ok(fs.existsSync(fileURLToPath(new URL('../rules/worker.md', import.meta.url))));
});
