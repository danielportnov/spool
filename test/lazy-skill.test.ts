import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKILL_NAMES, shipped } from '../src/builtin.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';

// Every command it names is pinned by "every command a skill tells an agent to run exists", in test/init.test.ts.

test('the lazy skill is registered, and triggered by its name and by "Spool lazy dev"', () => {
  assert.ok(SKILL_NAMES.includes('spool-lazy'));
  const lazy = parseFrontmatter(shipped('spool-lazy'));
  assert.equal(lazy.data.get('name'), 'spool-lazy');
  const description = String(lazy.data.get('description'));
  assert.match(description, /Use for \/spool-lazy, \/spool-lazy off, or when the user says "Spool lazy dev"/);
  assert.match(description, /Not for steering the spool, which is \/spool, or for filing one idea, which is \/spool-record\.$/);
});

test('lazy dev decides how, and never decides what is built', () => {
  const lazy = shipped('spool-lazy');
  const flat = lazy.replace(/\s+/g, ' ');
  assert.deepEqual([...lazy.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['On', 'Decide, don\'t ask', 'Show, don\'t report', 'Their reaction is the queue', 'Off']);
  // It composes the loop, it does not copy it.
  assert.match(flat, /do what the `spool-loop` skill does/);
  assert.match(flat, /\*\*They still decide what is built\.\*\*/);
  // A question becomes a receipt; the irreversible still stops that one thread.
  assert.match(flat, /take the recommended option and leave the receipt: `spool assume "<the question>" --chose "<what you did>" --why "<reason>" --for <t-id>`/);
  assert.match(flat, /\*\*Still stops that one thread, quietly:\*\* what the policy says never or ask first, and what cannot be undone, costs money, publishes, deletes or adds a dependency\./);
  // The policy's gate is kept: no answering itself, no moving a thread to build.
  assert.match(flat, /\*\*Never answer your own question or approve your own assumption or plan\*\*/);
  assert.match(flat, /\*\*Never move a thread to build yourself\.\*\*/);
  assert.match(flat, /\*\*A go is theirs to give\.\*\*[^"]*"Do it", "ship it", "yes", "go"[^`]*`spool build <id>`/);
  assert.doesNotMatch(lazy, /spool build --all|spool approve --all/);
});

test('lazy dev shows before it reports, in few plain words, and turns their reaction into threads', () => {
  const flat = shipped('spool-lazy').replace(/\s+/g, ' ');
  assert.match(flat, /Come to them only when there is something to see\. Until then, say nothing\./);
  assert.match(flat, /`spool attach <t-id> <file> --as before\|after`, shown in the chat as it lands\. Lead with the picture\. Then at most two plain lines/);
  assert.match(flat, /No ids, no tables, no lists, no jargon/);
  assert.match(flat, /`spool capture "<their exact words>"`, then file it by the `spool-record` skill/);
  assert.match(flat, /Keep what you showed and what they said/);
  // Off returns to normal, in a line.
  assert.match(flat, /`\/spool-lazy off`, or "back to normal": questions are asked again[^.]*\. Say so in one line: "Lazy dev is off\."/);
  assert.ok(shipped('spool-lazy').trimEnd().split('\n').length <= 90);
});
