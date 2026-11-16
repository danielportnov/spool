import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { RETIRED, SKILL_NAMES, shipped } from '../src/builtin.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { Sandbox } from './helpers.ts';

// Every command it names is pinned by "every command a skill tells an agent to run exists", in test/init.test.ts.

/** The rows of the skill's table: what they say, and what to run. */
function rows(skill: string): [string, string][] {
  return skill
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| They say'))
    .map((l) => l.slice(2, -2).split(' | ') as [string, string]);
}

test('/spool is the one skill for the chat: status first, a short reply, and one table of what they say and what to run', () => {
  const skill = shipped('spool');
  const flat = skill.replace(/\s+/g, ' ');

  // It starts by looking: one screen says where the board is, who builds, and why nothing moves.
  assert.match(flat, /\*\*First, `spool status`\.\*\* One screen: what waits on them, the board's address, who builds, and why Build is not moving when it is not\./);
  assert.match(flat, /No `\.spool\/` here\? Say so in a line and set it up by the `spool-init` skill\./);

  // The reply is short and leads with the ask or the result. The board has the rest.
  assert.match(flat, /\*\*Be brief\. The board holds the detail\.\*\*/);
  assert.match(flat, /\*\*Lead with what you need from them, or with the result,\*\* in one line/);
  assert.match(flat, /\*\*A few lines at most\.\*\* No tables, no plans, no lists of reasons\./);
  assert.match(flat, /A thread 🧵 is "the jump", never `t-4kq7`\./);
  assert.match(flat, /\*\*End with the board's address\.\*\* A thread's own place is that, then `#<t-id>`; one project of a folder of them, that, then `\?project=<name>`\./);

  // One table, and each thing they say has its command.
  assert.equal(skill.match(/^\| --- \| --- \|$/gm)?.length, 1, 'one table');
  const table = rows(skill);
  const run = (says: string): string => {
    const row = table.find(([they]) => they.includes(says));
    assert.ok(row, `a row for ${says}`);
    return row[1];
  };
  // The rows the loop's table and the recorder's answer table had.
  assert.equal(run('"build 3", "go on that one", "yes, do it"'), '`spool build <t-id>`');
  assert.equal(run('"not yet"'), '`spool propose <t-id>`');
  assert.match(run('"the second one", "a", "no, do X"'), /^`spool answer <d-id> <n or their words>`/);
  assert.match(run('"that\'s fine"'), /^`spool approve <id>`/);
  assert.equal(run('"all good"'), '`spool approve --all`; it never covers plans');
  assert.equal(run('"go ahead with the plan"'), '`spool approve <t-id>`, always by id, one plan at a time');
  assert.match(run('"park that until the launch"'), /`spool hold <t-id> -m "<their words>"`; "take it off hold" is `spool release <t-id>`/);
  assert.match(run('"drop that"'), /^`spool drop <t-id> -m "<their words>"`/);
  assert.match(run('"X is urgent"'), /^`spool edit <id> -p <0-3>`/);
  assert.match(run('anything new'), /`spool capture "<their exact words>"`, then file it by the `spool-record` skill/);
  assert.equal(run('how to work'), 'nothing to record: do it');
  // The new ones: the board, who builds, catching up, and tidying.
  assert.match(run('"open the board"'), /^`spool page -d`: it starts the board in the background, or finds the one already up, and gives its address\.[\s\S]*Do not describe the board in the chat/);
  assert.match(run('"switch to chat mode"'), /^`spool builder chat`, then build here by the `spool-loop` skill/);
  assert.match(run('"let the page build"'), /^`spool builder headless`, then `spool agents on`\. No board up\? `spool page -d --run`/);
  assert.equal(run('"turn the agents off"'), '`spool agents off`, `spool agents on`');
  assert.equal(run('"build three at once"'), '`spool builder --at-once <n>`');
  assert.match(run('"what happened overnight"'), /^`spool brief`, as it comes; `--since 8h` or `--since yesterday`/);
  assert.equal(run('"what needs me"'), '`spool review`');
  assert.match(run('"where do things stand"'), /^`spool overview --brief`, as it comes/);
  assert.match(run('"show me everything"'), /^`spool overview --table`, as it comes/);
  assert.match(run('"why is nothing building"'), /^`spool status`: its "Build is not moving" line says why[\s\S]*`spool doctor`/);
  assert.match(run('"tidy the backlog"'), /^`spool list --alike`, then propose merges, archives and drops in a few lines; act only on their yes/);
  assert.match(run('"make a sprint of these"'), /^`spool sprint "<name>" --goal "<what it is for>" --add <t-id…>`/);
  assert.match(run('"make a sprint of these and play it"'), /^`spool play <sprint>`, once it is made: everything in it moves to Build at once/);
  assert.match(run('"archive that"'), /^`spool archive <t-id>`; it is kept, and `spool archive --undo <t-id>` brings it back/);
  assert.match(run('"do X first"'), /^`spool order <t-id> --first`, or `--before <t-id>`\. `spool loop --dry-run` lists Build in the exact order it will be built/);
  assert.match(run('"undo that"'), /^`spool revert <t-id> -m "<their reason, in their words>"`: every agent reads the reason before it works/);

  // Where things are heading is on the board: the Roadmap, and a reached sprint's review, not a walk through threads in the chat.
  assert.match(run('"how is the sprint going"'), /^The Roadmap on the board: its address, then `\?view=roadmap`\. A sprint that is reached has its review there, `\?review=<r-id>`: send them to it/);
  assert.match(run('"the goal has changed"'), /^`spool goals`; `spool goals --edit -` with their words/);

  // The gate: only they start work, and a locked gate is not to be got round.
  assert.match(flat, /\*\*Only they start work\.\*\* Moving a thread to Build is the only way anything gets built, and `spool build`, `spool play`, `spool release`, `spool builder` and `spool agents on` are theirs: run one only on their plain word\./);
  assert.match(flat, /Never guess a go, an answer or an approval\. If their reply does not plainly say it, ask in one line\./);
  assert.match(flat, /\*\*Where the gate is locked,\*\* those commands refuse you\.[\s\S]*Do not look for a way round it: that refusal is the point\./);
  // Their commands run as them: signed by an agent, an undo keeps no lesson (test/lessons.test.ts).
  assert.match(flat, /run their commands as them, with no `--as`: an undo signed by you keeps no lesson\. The chat is not the record: the spool is\./);

  // What the page skill said that is still true. Opening the board no longer starts a loop, and its buttons are not listed.
  assert.match(flat, /Opening the board builds nothing\./);
  assert.match(flat, /never stop and start it yourself: that ends the agents it is running\. `spool page --stop` only when they ask\./);
  assert.doesNotMatch(skill, /On the page \| What it does|Keep the board live/);

  // Short enough to be read on every project: about seventy lines, the table most of it.
  assert.ok(skill.trimEnd().split('\n').length <= 85, `${skill.trimEnd().split('\n').length} lines`);
});

test("/spool's description says when to load it, and when not to", () => {
  const description = String(parseFrontmatter(shipped('spool')).data.get('description'));
  for (const said of ['open the board', 'where do things stand', 'what needs me', 'catch me up', 'why is nothing building', 'build that one', 'undo that', 'tidy the backlog', 'switch to chat mode', 'turn the agents off']) {
    assert.ok(description.includes(`"${said}"`), `it loads for "${said}"`);
  }
  assert.match(description, /Use for \/spool \[what you want\]/);
  assert.match(description, /Not for building, which is \/spool-loop, or for filing a new idea, which is \/spool-record\.$/);
  // The loop no longer loads for a question about the spool.
  const loop = String(parseFrontmatter(shipped('spool-loop')).data.get('description'));
  assert.doesNotMatch(loop, /where do things stand|catch me up|what needs me/);
  assert.match(loop, /Not for questions about the spool or for steering it, which is \/spool\.$/);
});

test('the page skill is retired into /spool: install takes an untouched copy away and says where its job went', () => {
  const s = new Sandbox();
  try {
    assert.equal(SKILL_NAMES.includes('spool-page' as never), false);
    assert.equal(RETIRED['spool-page'], 'ask for the board: /spool opens it, and steers the spool from the chat');

    // A copy an older Spool wrote, and nobody touched since.
    const old = '.home/.claude/skills/spool-page/SKILL.md';
    const body = '---\nname: spool-page\n---\n\n# Spool page\n';
    const stamp = (text: string): string => `${text}\n<!-- spool 0.16.0 · ${createHash('sha256').update(text).digest('hex').slice(0, 12)} · written by \`spool install\` -->\n`;
    s.write(old, stamp(body));
    const out = s.sp('install');
    assert.match(out, /installed {2}spool\n/);
    assert.match(out, /removed {4}spool-page {2}· retired: ask for the board: \/spool opens it, and steers the spool from the chat$/m);
    assert.equal(s.exists('.home/.claude/skills/spool-page'), false);
    assert.ok(s.exists('.home/.claude/skills/spool/SKILL.md'));

    // One somebody edited is theirs, and stays until they say otherwise.
    s.write(old, `${body}\nMy own notes on the board.\n`);
    assert.match(s.sp('install'), /kept {7}spool-page {2}· retired \(ask for the board: [^\n]*\), but edited here, so left alone; --force removes it/);
    assert.ok(s.exists(old));
    assert.match(s.sp('install', '--force'), /removed {4}spool-page/);
    assert.equal(s.exists(old), false);

    // It is retired for every harness the same way, and never listed among a project's own skills.
    const codex = '.home/.codex/skills/spool-page/SKILL.md';
    s.write(codex, stamp(body));
    assert.match(s.sp('install', '--for', 'codex'), /removed {4}spool-page/);
    assert.equal(s.exists(codex), false);
    for (const name of SKILL_NAMES) assert.doesNotMatch(shipped(name), /spool-page/, `${name} sends nobody to it`);
  } finally {
    s.cleanup();
  }
});
