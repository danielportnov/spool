import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { test } from 'node:test';
import { blockIn, upsertBlock } from '../src/prime.ts';
import { Sandbox } from './helpers.ts';

interface Finding {
  id: string;
  status: 'ok' | 'advice' | 'wrong';
  label: string;
  fix?: string[];
}

const byId = (s: Sandbox): Record<string, Finding> => Object.fromEntries((JSON.parse(s.exec(['doctor', '--json']).out).checks as Finding[]).map((f) => [f.id, f]));

/** A skill copy as an older Spool's install wrote it: stamped, and not touched since. */
const stamped = (text: string): string => `${text}\n<!-- spool 0.16.0 · ${createHash('sha256').update(text).digest('hex').slice(0, 12)} · written by \`spool install\` -->\n`;
const PAGE = '---\nname: spool-page\n---\n\n# Spool page\n';

/** The block an older Spool wrote: it names a skill that is gone. */
const OLD_BLOCK = `<!-- spool:start -->
## Spool

This project's work queue lives in \`.spool/\`. The human drives it by talking to you, through the
Spool skills: \`/spool-init\`, \`/spool-loop\`, \`/spool-record\` and \`/spool-page\`.
<!-- spool:end -->`;

test('doctor says when a retired skill is still installed, for any harness, with the line that takes it away', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'demo');
    s.sp('install');
    assert.equal(Object.keys(byId(s)).some((id) => id.startsWith('retired')), false, 'nothing retired, nothing said');

    // A copy Spool wrote and nobody touched: the install takes it away.
    const mine = path.join(s.root, '.home', '.claude', 'skills');
    s.write('.home/.claude/skills/spool-page/SKILL.md', stamped(PAGE));
    let found = byId(s)['retired-claude']!;
    assert.equal(found.status, 'advice');
    assert.equal(found.label, `a retired Spool skill is still installed for Claude Code in ${mine}: spool-page`);
    assert.deepEqual(found.fix, ['spool install']);
    assert.match(s.exec(['doctor']).out, /^! a retired Spool skill is still installed for Claude Code in .*: spool-page\n {4}spool install$/m);
    s.sp('install');
    assert.equal(byId(s)['retired-claude'], undefined, 'the fix is the fix');

    // One somebody edited is theirs: the install leaves it, so the fix names that folder and no other.
    s.write('.home/.claude/skills/spool-page/SKILL.md', `${PAGE}\nMy own notes.\n`);
    s.write('.home/.claude/skills/spool-help/SKILL.md', stamped('---\nname: spool-help\n---\n'));
    found = byId(s)['retired-claude']!;
    assert.equal(found.label, `retired Spool skills are still installed for Claude Code in ${mine}: spool-help, spool-page (edited there, so spool install leaves it)`);
    assert.deepEqual(found.fix, ['spool install', `rm -r ${path.join(mine, 'spool-page')}`]);

    // The same for another harness, and for copies checked into the project.
    s.write('.home/.codex/skills/spool-page/SKILL.md', stamped(PAGE));
    s.write('.claude/skills/spool-page/SKILL.md', stamped(PAGE));
    s.write('.cursor/skills/spool-recorder/SKILL.md', stamped('---\nname: spool-recorder\n---\n'));
    const all = byId(s);
    assert.deepEqual(all['retired-codex']!.fix, ['spool install --for codex']);
    assert.match(all['retired-codex']!.label, /still installed for Codex in .*\.codex\/skills: spool-page$/);
    assert.deepEqual(all['retired-claude-here']!.fix, ['spool install --here']);
    assert.deepEqual(all['retired-cursor-here']!.fix, ['spool install --for cursor --here']);
    assert.match(all['retired-cursor-here']!.label, /for Cursor in .*\.cursor\/skills: spool-recorder$/);
    // It is advice: a run works, an agent is only offered a command that is gone.
    for (const id of ['retired-claude', 'retired-codex', 'retired-claude-here', 'retired-cursor-here']) assert.equal(all[id]!.status, 'advice', id);
    s.sp('install', '--for', 'codex');
    s.sp('install', '--here');
    assert.equal(byId(s)['retired-codex'], undefined);
    assert.equal(byId(s)['retired-claude-here'], undefined);
  } finally {
    s.cleanup();
  }
});

test("doctor says when a project's Spool block is not the one this version writes, and spool init --refresh fixes it", () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'demo');
    let found = byId(s).block!;
    assert.equal(found.status, 'ok');
    assert.equal(found.label, 'AGENTS.md has the Spool block this version writes');

    // An older Spool's block, with the project's own words around it.
    s.write('AGENTS.md', `# My project\n\nMy own rules.\n\n${OLD_BLOCK}\n\nMore of my rules.\n`);
    found = byId(s).block!;
    assert.equal(found.status, 'advice');
    assert.equal(found.label, 'the Spool block in AGENTS.md is not the one this version writes: it is from an older Spool, or was edited');
    assert.deepEqual(found.fix, ['spool init --refresh']);
    assert.match(s.exec(['doctor']).out, /^! the Spool block in AGENTS\.md is not the one this version writes: .*\n {4}spool init --refresh$/m);

    // The fix writes the block again and leaves the rest of the file alone.
    s.sp('init', '--refresh');
    assert.equal(byId(s).block!.status, 'ok');
    const now = s.read('AGENTS.md');
    assert.ok(now.startsWith('# My project\n\nMy own rules.\n\n<!-- spool:start -->') && now.endsWith('<!-- spool:end -->\n\nMore of my rules.\n'));
    assert.doesNotMatch(now, /spool-page/);

    // A project that uses CLAUDE.md is looked at there; both are named when both are behind.
    s.write('CLAUDE.md', `${OLD_BLOCK}\n`);
    assert.equal(byId(s).block!.label, 'the Spool block in CLAUDE.md is not the one this version writes: it is from an older Spool, or was edited');
    s.write('AGENTS.md', `${OLD_BLOCK}\n`);
    assert.match(byId(s).block!.label, /^the Spool block in CLAUDE\.md and AGENTS\.md is not/);
    s.sp('init', '--refresh');
    assert.equal(byId(s).block!.label, 'CLAUDE.md and AGENTS.md have the Spool block this version writes');

    // A project that chose to have no block is not told to get one.
    const bare = new Sandbox();
    bare.sp('init', '--no-agents-file');
    assert.equal(byId(bare).block, undefined);
    bare.write('AGENTS.md', '# Rules of my own\n');
    assert.equal(byId(bare).block, undefined);
    bare.cleanup();
  } finally {
    s.cleanup();
  }
});

test('the block names the skills as they are now, and owns the words every skill uses', () => {
  const block = upsertBlock('');
  const flat = block.replace(/\s+/g, ' ');
  assert.match(flat, /through five skills: `\/spool-init` sets a project up, `\/spool` steers the spool, `\/spool-steer` steers how you work without recording anything, `\/spool-loop` makes a chat the builder, and `\/spool-record` files an idea\./);
  assert.doesNotMatch(block, /spool-page/);
  // The vocabulary, and the rule that the store is never edited by hand, are said here, once.
  assert.match(flat, /It is the project's spool 🧶, and each piece of work in it is a thread 🧵; the commands call a thread a task\./);
  assert.match(flat, /never edit those files by hand, and never ask the human to run a command you can run\./);
  assert.match(flat, /A go, a no or a choice is a verb: `spool build`, `spool propose`, `spool answer`; the `spool` skill has the table\./);
  assert.match(flat, /work it by the worker's rules \(`spool prime worker`\)/);
  // What it says of itself: current as written, other once anything in it differs, none without one.
  assert.equal(blockIn(block), 'current');
  assert.equal(blockIn(block.replace('five skills', 'skills')), 'other');
  assert.equal(blockIn(OLD_BLOCK), 'other');
  assert.equal(blockIn('# Just my rules\n'), 'none');
});
