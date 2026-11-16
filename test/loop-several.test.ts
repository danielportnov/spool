import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shipped } from '../src/builtin.ts';

// Every command it names is pinned by "every command a skill tells an agent to run exists", in test/init.test.ts.
test('in a chat that can start subagents, the loop builds several threads at once, each by a subagent in a worktree of its own', () => {
  const loop = shipped('spool-loop');
  assert.match(
    loop,
    /\*\*Several at once, with subagents\.\*\* If your harness can start subagents and\nthe project is a git repository[\s\S]*How many: what `spool builder`\nsays, three unless they set it\./,
  );
  assert.match(loop, /`spool next --claim --worktree --as "<your model>"`, or\n {2}`spool start <t-id> --worktree --as "<your model>"`/);
  assert.match(loop, /the brief as\n {2}printed, that folder, the worker's rules \(`spool prime worker`\), and this:\n {2}work only in that folder; commit there, every commit ending with the\n {2}`Spool: <t-id>` trailer; finish with `spool done`, which lands it, or\n {2}`spool ask` if it needs a decision\./);
  assert.match(loop, /`spool done` may refuse to land[\s\S]*The\n {2}subagent fixes it in its worktree and runs `spool done` again[\s\S]*It never forces anything\./);
  assert.match(loop, /Meanwhile you build nothing yourself\. Say one line as each thread starts\n {2}and one as each lands, take the next from build as a slot frees, and\n {2}answer the human\./);
  assert.match(loop, /One folder and no git\? One thread at a time/);
  // The old rule, one subagent at a time whatever the project, is gone.
  assert.doesNotMatch(loop, /one at a time, and in the background/);
});
