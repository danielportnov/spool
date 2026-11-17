import assert from 'node:assert/strict';
import { test } from 'node:test';
import { section, shipped } from '../src/builtin.ts';

// Every command it names is pinned by "every command a skill tells an agent to run exists", in test/init.test.ts.
test('in a chat that can start subagents, the loop builds several threads at once, each by a subagent in a worktree of its own', () => {
  const loop = shipped('spool-loop').replace(/\s+/g, ' ');
  assert.match(
    loop,
    /\*\*Several at once, with subagents\.\*\* If your harness can start subagents and the project is a git repository, build several threads side by side, each by a fresh subagent in a git worktree of its own\. How many: what `spool builder` says is yours; a claim past it is refused\./,
  );
  assert.match(loop, /`spool next --claim --worktree --as "<your model>"`, or `spool start <t-id> --worktree --as "<your model>"`\. It prints the brief, and the brief names the folder to work in\./);
  assert.match(
    loop,
    /the brief as printed, that folder, the worker's rules \(`spool prime worker`\), and this: work only in that folder; commit there, every commit ending with the `Spool: <t-id>` trailer; sign every `spool` command the same way; finish with `spool done`, which lands it, or `spool ask` if it needs a decision\./,
  );
  // A landing that is refused is the subagent's to fix: the lead is told so in a line, and the worker's rules say how.
  assert.match(loop, /A landing that is refused is fixed there and tried again, never forced\./);
  assert.match(section('Working a thread').replace(/\s+/g, ' '), /It refuses, and lands nothing, when:[\s\S]*your work conflicts with what landed before it\.[\s\S]*resolve each file, `git rebase --continue`, and run `spool done` again\./);
  assert.match(loop, /Meanwhile you build nothing yourself\. Say one line as each thread starts \("[^"]+"\) and one as each lands \("[^"]+"\), notify them of each where they picked it \(below\), take the next from build as a slot frees, and answer the user\./);
  assert.match(loop, /One folder and no git\? One thread at a time, still by a fresh subagent where you can: two agents in one folder edit each other's files\. No subagents\? Build each yourself: `spool next --claim --as "<your model>"`, then by the worker's rules\./);
  // The old rule, one subagent at a time whatever the project, is gone.
  assert.doesNotMatch(loop, /one at a time, and in the background/);
});
