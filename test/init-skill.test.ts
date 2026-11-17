import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shipped } from '../src/builtin.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { Sandbox } from './helpers.ts';

// Every command it names is pinned by "every command a skill tells an agent to run exists", in test/init.test.ts.

test('set-up asks who builds, ends with the doctor, and names the three skills that come next', () => {
  const init = shipped('spool-init');
  const flat = init.replace(/\s+/g, ' ');

  // Headless or Chat, offered in a line; the pick is theirs and is set with the command.
  assert.match(
    flat,
    /\*\*Ask who builds,\*\* in one line\. \*\*Headless\*\*: the board builds what is in Build by itself, with no chat open\. \*\*Chat\*\*: a chat builds it, where they can watch and step in\. Run `spool builder headless` or `spool builder chat` for their pick\. Their choice; a new project starts in Chat until they pick otherwise\./,
  );
  assert.match(flat, /Refused, because they chose the lock\? They pick it on the board\./);
  assert.match(String(parseFrontmatter(init).data.get('description')), /pick who builds/);

  // The last step looks at what a run needs, and says what is still missing.
  const steps = [...init.matchAll(/^(\d+)\. \*\*([^*]+?)[.,]?\*\*/gm)].map((m) => m[2]);
  assert.deepEqual(steps, ['Check the engine', 'Settle which folder', 'Stop if it is already set up', 'Set it up', 'Agree the rope', 'Agree the goals', 'Ask who builds', 'Offer a check', 'Take the first work', 'Check it']);
  assert.match(flat, /10\. \*\*Check it\.\*\* `spool doctor` says what a run still needs, with the line that fixes each/);

  // What comes next: the skill for the chat, the one that builds, and the one that records.
  const next = init.slice(init.indexOf('End with what happens next'));
  assert.deepEqual([...next.matchAll(/^- `(\/[a-z-]+)`/gm)].map((m) => m[1]), ['/spool', '/spool-loop', '/spool-record']);
  assert.match(next.replace(/\s+/g, ' '), /`\/spool-loop` to make a chat the builder, if they picked Chat\. Headless is then greyed on the board until \*\*Offer Headless\*\* is on in Settings, behind the gear\. With Headless, they switch \*\*Agents\*\* on there instead/);

  // Someone only trying it is offered the sample project, not a set-up of their own.
  assert.match(flat, /Only trying Spool, not setting this project up\? Offer `spool demo --open`: a throwaway project with threads in its spool, and its board in their browser\. None of their own code is touched\./);
});

test('the pick is kept, a fresh project is built from a chat, and saying so again is refused nowhere', () => {
  const s = new Sandbox();
  s.freshBuilder = true;
  try {
    s.sp('init', '--name', 'skyhop', '--lock');
    // Set up fresh, it is built from a chat: Headless is for them to pick later.
    assert.equal(s.json('builder').builder, 'chat');
    assert.match(s.sp('builder', 'chat'), /^A chat builds skyhop/);
    // Headless is a change, so where they chose the lock it is theirs to pick: on the board, or at their terminal.
    assert.match(s.fails('builder', 'headless'), /user's alone.*locked/s);
    assert.match(s.exec(['builder', 'headless'], { tty: true }).out, /^The page builds skyhop, headless/);
    assert.match(s.fails('builder', 'chat'), /user's alone.*locked/s);
    assert.match(s.exec(['builder', 'chat'], { tty: true }).out, /^A chat builds skyhop/);
    // The doctor then says what the pick still needs.
    const builder = (JSON.parse(s.exec(['doctor', '--json']).out).checks as { id: string; status: string; label: string }[]).find((c) => c.id === 'builder')!;
    assert.equal(builder.status, 'advice');
    assert.match(builder.label, /a chat builds here, but no spool watch is up/);
  } finally {
    s.cleanup();
  }
});
