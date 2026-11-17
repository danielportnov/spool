import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox, spool } from './helpers.ts';

/** A stand-in agent: a shell script that reads its prompt and drives the real CLI. */
function agent(s: Sandbox, name: string, script: string): string {
  const file = path.join(s.root, name);
  const spoolCmd = `"${process.execPath}" "${CLI}"`;
  fs.writeFileSync(file, `#!/bin/sh\nspool() { ${spoolCmd} "$@"; }\ncat > "${path.join(s.root, 'last-prompt.txt')}"\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('the loop hands each ready task to the agent until none are left', async () => {
  const s = spool();
  const urgent = s.id('task', 'Urgent', '-p', '0');
  const normal = s.id('task', 'Normal');
  const worker = agent(s, 'worker.sh', 'spool done "$SPOOL_TASK" -m "finished by $SPOOL_ACTOR" > /dev/null');

  const out = await s.spLater('loop', '--agent', worker);
  assert.match(out, new RegExp(`▶ ${urgent}  Urgent[\\s\\S]*✓ done — finished by worker.sh[\\s\\S]*▶ ${normal}  Normal`));
  assert.match(out, /Loop stopped after 2 run\(s\): 2 done, 0 waiting, 0 unfinished\. 0 still ready\./);
  assert.equal(s.json('review').shipped.length, 2);

  // The agent was given the protocol, the policy and the task — everything it needs, on stdin.
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /unattended/);
  assert.match(prompt, /# Spool · worker protocol[\s\S]*## Working a thread/);
  assert.doesNotMatch(prompt, /## The schedule|## Watch the spool|## Show the spool|## Reaching them|CronCreate|PushNotification|\/spool-loop/, 'an unattended agent is given one task, not the loop');
  assert.match(prompt, /## Ask first/);
  assert.match(prompt, new RegExp(`YOUR TASK\\n\\n${normal}  p2  Normal`));
  assert.doesNotMatch(prompt, /\x1b\[/, 'no colour codes');
  assert.match(s.item(normal), /loop: handed to/);
  s.cleanup();
});

test('an agent that asks leaves its task waiting, and the loop moves on', async () => {
  const s = spool();
  const hard = s.id('task', 'Needs a decision', '-p', '0');
  const easy = s.id('task', 'Easy');
  const worker = agent(
    s,
    'asker.sh',
    `if grep -q "Needs a decision" "${path.join(s.root, 'last-prompt.txt')}"; then
  spool ask "Which way?" --option Left --option Right --for "$SPOOL_TASK" > /dev/null
else
  spool done "$SPOOL_TASK" -m ok > /dev/null
fi`,
  );
  const marker = path.join(s.root, 'idle.txt');
  const result = await s.execLater(['loop', '--agent', worker], {
    env: { SPOOL_NOTIFY: `echo "$SPOOL_EVENT" >> "${marker}"` },
  });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /1 done, 1 waiting, 0 unfinished/);
  assert.match(result.out, /1 question\(s\) are waiting on you — spool review/);
  assert.equal(s.json('show', hard).item.state, 'blocked');
  assert.equal(s.json('show', easy).item.state, 'done');
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['ask', 'idle'], 'told when asked, and again when it ran dry');
  s.cleanup();
});

test('an agent that walks away has its task released, once', async () => {
  const s = spool();
  const task = s.id('task', 'Too hard');
  const quitter = agent(s, 'quitter.sh', 'exit 3');
  const out = await s.spLater('loop', '--agent', quitter, '--max', '5');
  assert.match(out, /↺ unfinished — agent exited 3; released/);
  assert.match(out, /Loop stopped after 1 run\(s\): 0 done, 0 waiting, 1 unfinished\. 1 still ready\./, 'not retried in a spin');
  const item = s.json('show', task).item;
  assert.equal(item.state, 'ready');
  assert.equal(item.by, undefined);
  assert.match(item.body, /loop: agent exited 3 without finishing/);
  s.cleanup();
});

test('--once and --dry-run bound what the loop does', async () => {
  const s = spool();
  const a = s.id('task', 'A');
  const b = s.id('task', 'B');
  const worker = agent(s, 'worker.sh', 'spool done "$SPOOL_TASK" -m ok > /dev/null');

  const dry = s.sp('loop', '--dry-run', '--agent', worker);
  assert.match(dry, new RegExp(`Would run .* on 2 task\\(s\\)[\\s\\S]*${a}[\\s\\S]*${b}`));
  assert.equal(s.json('show', a).item.state, 'ready', 'a dry run claims nothing');

  assert.match(await s.spLater('loop', '--once', '--agent', worker), /1 run\(s\): 1 done[\s\S]*1 still ready/);
  assert.match(s.fails('loop', '--max', '0'), /--max must be a whole number above zero/);

  // The agent command comes from the user's own config when no flag is given — never from the repo.
  s.write('.home/.config/spool/config.json', JSON.stringify({ agent: worker }));
  s.write('.spool/config.json', JSON.stringify({ version: 1, name: 'demo', agent: 'exit 9', notify: 'exit 9' }));
  assert.match(await s.spLater('loop'), /1 run\(s\): 1 done/);
  s.cleanup();
});

test('the loop builds with the page’s engine: what the agent says is printed, and its transcript and session are on the thread', async () => {
  const s = spool();
  const task = s.id('task', 'Tighten the jump arc');
  const dir = path.join(s.root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  // A stand-in `claude`: it says which session it is in, as Claude does, says a line, and finishes the thread.
  const claude = path.join(dir, 'claude');
  fs.writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'sid=""; while [ $# -gt 0 ]; do [ "$1" = "--session-id" ] && sid="$2"; shift; done',
      'echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"model\\":\\"sonnet\\"}"',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"raising gravity"}]}}\'',
      `"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m "arc tightened" > /dev/null`,
    ].join('\n'),
  );
  fs.chmodSync(claude, 0o755);

  const out = await s.spLater('loop', '--agent', `${claude} -p`);
  assert.match(out, new RegExp(`▶ ${task}  Tighten the jump arc[\\s\\S]*\\n    raising gravity\\n[\\s\\S]*✓ done — arc tightened`));
  const log = s.item(task);
  const session = /loop: session ([0-9a-f-]{36}) · transcript (\S+) · open it with `claude --resume \1`/.exec(log);
  assert.ok(session, `a session and a transcript on the thread:\n${log}`);
  assert.match(fs.readFileSync(path.join(s.root, session[2]!), 'utf8'), /raising gravity/, 'the transcript is the agent’s stream, as it came');
  assert.match(log, new RegExp(`loop: handed to \`.*claude -p .*--session-id ${session[1]}\``));
  s.cleanup();
});

test('in a git repository the loop builds several threads at once, each in a worktree of its own', async () => {
  const s = new Sandbox();
  s.gitInit();
  fs.writeFileSync(path.join(s.root, '.git', 'info', 'exclude'), '.home/\nbin/\n');
  s.sp('init', '--name', 'skyhop');
  s.commitAll('start');
  const ids = ['Jump', 'Coins'].map((title) => s.id('task', title));
  const bin = path.join(s.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // Each waits until both are started, so the loop can only finish if it ran them side by side.
  const worker = path.join(bin, 'worker.sh');
  fs.writeFileSync(
    worker,
    `#!/bin/sh
cat > /dev/null
touch "${bin}/started-$SPOOL_TASK"
n=0; while [ "$(ls "${bin}" | grep -c '^started-')" -lt 2 ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done
pwd -P > "${bin}/cwd-$SPOOL_TASK"
"${process.execPath}" "${CLI}" done "$SPOOL_TASK" -m "both at once: $(ls "${bin}" | grep -c '^started-')" > /dev/null
`,
  );
  fs.chmodSync(worker, 0o755);

  const out = await s.spLater('loop', '--agent', worker);
  assert.match(out, /Loop stopped after 2 run\(s\): 2 done, 0 waiting, 0 unfinished\./);
  assert.equal(out.match(/✓ t-\S+ done — both at once: 2/g)?.length, 2, 'each line names its thread where several are going');
  for (const id of ids) {
    assert.equal(s.json('show', id).item.state, 'done');
    assert.match(fs.readFileSync(path.join(bin, `cwd-${id}`), 'utf8').trim(), new RegExp(`\\.spool/worktrees/${id}$`));
  }
  s.cleanup();
});
