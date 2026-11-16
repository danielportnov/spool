import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, type Page, Sandbox, gone, pause, startPage, until } from './helpers.ts';

/** A stand-in agent: a shell script that reads its prompt and drives the real CLI. */
function agent(s: Sandbox, name: string, script: string): string {
  const file = path.join(s.root, name);
  fs.writeFileSync(file, `#!/bin/sh\nspool() { "${process.execPath}" "${CLI}" "$@"; }\ncat > "${path.join(s.root, 'last-prompt.txt')}"\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('with the runner on, the page builds what is moved to Build, with no chat at all', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset');
  const worker = agent(s, 'worker.sh', 'echo "reading the brief"; echo "raising gravity"; spool done "$SPOOL_TASK" -m "finished by $SPOOL_ACTOR" > /dev/null');

  const { url, token, stop } = await startPage(s, '--run', '--agent', worker);
  const board = async () => (await (await fetch(`${url}api/board`)).json()) as Record<string, any>;
  const post = (action: string, body: unknown) =>
    fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
  try {
    // On, and idle: nothing is in Build, so nothing is built. A proposed thread is never touched.
    assert.deepEqual([(await board()).runner.on, (await board()).runner.agent], [true, worker]);
    await pause(1300);
    assert.equal(s.json('show', jump).item.state, 'proposed');

    // The human presses play. Nobody types anything, and the thread ends up done.
    assert.equal((await post('move', { id: jump, to: 'build' })).status, 200);
    await until('the thread is built', async () => s.json('show', jump).item.status === 'done');
    const built = s.json('show', jump).item;
    assert.deepEqual([built.by, built.summary], ['worker.sh', 'finished by worker.sh'], 'the agent is named by the program it is');
    assert.match(s.item(jump), /page: handed to `[^`]*worker\.sh`/);
    assert.match(fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8'), /unattended[\s\S]*## Working a thread[\s\S]*YOUR TASK[\s\S]*Tighten the jump arc/);
    const after = await until('the runner is idle again', async () => { const b = await board(); return !b.runner.running.length && b; });
    assert.deepEqual(after.runner.recent[0], { id: jump, title: 'Tighten the jump arc', outcome: 'done' });
    assert.equal(s.json('show', coins).item.state, 'proposed', 'what was not moved to build was not built');

    // Switched off, it leaves Build alone; switched on again, it picks the thread up.
    assert.equal((await post('runner', { on: false })).status, 200);
    await post('move', { id: coins, to: 'build' });
    await pause(1300);
    assert.equal(s.json('show', coins).item.state, 'ready');
    await post('runner', { on: true });
    await until('the second thread is built', async () => s.json('show', coins).item.status === 'done');
  } finally {
    await stop();
    s.cleanup();
  }
});

test('an agent that walks away has its thread put back once; one that hangs can be stopped from the page', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const hard = s.id('task', 'Too hard');
  s.sp('build', hard);
  const runs = path.join(s.root, 'runs.txt');
  const quitter = agent(s, 'quitter.sh', `echo run >> "${runs}"; echo "permission denied: cannot edit files" >&2; exit 3`);

  const first = await startPage(s, '--run', '--agent', quitter);
  try {
    const board = async () => (await (await fetch(`${first.url}api/board`)).json()) as Record<string, any>;
    const told = await until('the runner says how it went', async () => { const b = await board(); return b.runner.recent[0] && b; });
    assert.match(told.runner.recent[0].outcome, /^unfinished: the agent exited 3 — permission denied: cannot edit files$/, 'the reason is what the agent last said');
    const back = s.json('show', hard).item;
    assert.deepEqual([back.state, back.by], ['ready', undefined]);
    assert.match(s.item(hard), /page: agent exited 3 without finishing; back in build/);
    await pause(2300);
    assert.equal(fs.readFileSync(runs, 'utf8').trim().split('\n').length, 1, 'not tried again in a spin');
  } finally {
    await first.stop();
  }

  const sleeper = agent(s, 'sleeper.sh', 'echo "thinking hard"; sleep 30');
  const second = await startPage(s, '--run', '--agent', sleeper);
  try {
    const board = async () => (await (await fetch(`${second.url}api/board`)).json()) as Record<string, any>;
    const live = await until('the agent is heard working', async () => { const b = await board(); return b.runner.running[0]?.lines.length && b; });
    assert.deepEqual([live.runner.running[0].id, live.runner.running[0].lines], [hard, ['thinking hard']]);
    assert.equal(s.json('show', hard).item.state, 'active');
    const stop = await fetch(`${second.url}api/stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': second.token }, body: '{}' });
    assert.equal(stop.status, 200);
    const stopped = await until('the thread is back in build', async () => { const b = await board(); return !b.runner.running.length && b; });
    assert.deepEqual([stopped.runner.on, stopped.runner.recent[0].outcome], [false, 'stopped'], 'stopping also switches the runner off');
    assert.equal(s.json('show', hard).item.state, 'ready');
    assert.match(s.item(hard), /page: stopped from the page; back in build/);
  } finally {
    await second.stop();
    s.cleanup();
  }
});

test('a thread being built can be aborted straight to the backlog, from the page or the command line', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const hard = s.id('task', 'Too hard');
  const next = s.id('task', 'Next one');
  s.sp('build', hard);
  const sleeper = agent(s, 'sleeper.sh', 'echo "thinking hard"; sleep 30');
  const page = await startPage(s, '--run', '--agent', sleeper);
  try {
    const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
    await until('the agent is heard working', async () => { const b = await board(); return b.runner.running[0]?.lines.length && b; });
    const post = (body: unknown) => fetch(`${page.url}api/abort`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) });
    assert.equal((await post({ id: hard })).status, 200);
    const after = await until('the agent is ended', async () => { const b = await board(); return !b.runner.running.length && b.runner.recent[0] && b; });
    assert.equal(after.runner.on, true, 'the runner stays on for the next thread');
    assert.match(after.runner.recent[0].outcome, /^back in the backlog; edits undone/);
    const back = s.json('show', hard).item;
    assert.deepEqual([back.state, back.by], ['proposed', undefined]);
    assert.match(s.item(hard), /aborted while sleeper\.sh was building it; moved back to proposed/);
    await pause(1300);
    assert.equal(s.json('show', next).item.state, 'proposed', 'nothing else was picked up');
  } finally {
    await page.stop();
  }

  // An agent the page did not start: the thread is taken off it, and its done is refused.
  s.sp('build', hard);
  s.sp('start', hard);
  assert.match(s.fails('propose', hard), /being built[\s\S]*spool propose --abort/);
  s.sp('propose', '--abort', hard);
  assert.equal(s.json('show', hard).item.state, 'proposed');
  assert.match(s.fails('done', hard, '-m', 'finished anyway'), /moved back to the backlog/);
  s.cleanup();
});

test('a card dragged to any column: to the backlog, the agent is ended and everything it changed is undone', async () => {
  // A git repository, so the page builds each thread in a worktree of its own: what the agent changes is there, not in the checkout.
  const s = new Sandbox();
  s.gitInit();
  fs.writeFileSync(path.join(s.root, '.git', 'info', 'exclude'), '.home/\n');
  s.sp('init', '--name', 'skyhop', '--gate');
  fs.writeFileSync(path.join(s.root, 'physics.txt'), 'gravity 9\n');
  fs.writeFileSync(path.join(s.root, 'sound.txt'), 'quiet\n');
  fs.writeFileSync(path.join(s.root, 'mine.txt'), 'the human\'s\n');
  const hard = s.id('task', 'Tighten the jump arc');
  const easy = s.id('task', 'Make coins shine');
  const worker = agent(
    s,
    'worker.sh',
    [
      'echo "gravity 20" > physics.txt',
      `git add physics.txt && git commit -q -m "Raise gravity" -m "Spool: $SPOOL_TASK"`,
      'echo loud > sound.txt',
      'echo new > new.txt',
      'echo "changing things"',
      'sleep 30',
    ].join('\n'),
  );
  s.commitAll('start');
  // The human was already in the middle of something: it is not the agent's to undo.
  fs.writeFileSync(path.join(s.root, 'mine.txt'), 'the human, half way\n');
  s.sp('build', hard);

  const page = await startPage(s, '--run', '--agent', worker);
  const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
  const move = async (id: string, to: string) => {
    const res = await fetch(`${page.url}api/move`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify({ id, to }) });
    return { status: res.status, ...((await res.json()) as { ok: boolean; text: string }) };
  };
  try {
    await until('the agent has made its changes', async () => { const b = await board(); return b.runner.running[0]?.lines.includes('changing things') && b; });
    const start = s.git('rev-parse', 'HEAD');
    assert.deepEqual([s.cd(`.spool/worktrees/${hard}`).read('physics.txt'), s.read('physics.txt')], ['gravity 20\n', 'gravity 9\n']);

    // Building, dragged to the backlog.
    const back = await move(hard, 'proposed');
    assert.equal(back.status, 200, back.text);
    const after = await until('the agent is ended and its work undone', async () => { const b = await board(); return !b.runner.running.length && b.runner.recent[0] && b; });
    assert.equal(after.runner.recent[0].outcome, 'back in the backlog; edits undone: its worktree and branch are gone, with the 1 commit(s) made there; nothing had reached the checkout');
    assert.equal(s.json('show', hard).item.state, 'proposed');
    assert.deepEqual([s.read('physics.txt'), s.read('sound.txt'), s.exists('new.txt'), s.exists(`.spool/worktrees/${hard}`)], ['gravity 9\n', 'quiet\n', false, false]);
    assert.equal(s.read('mine.txt'), 'the human, half way\n', 'what was changed before the agent began is left alone');
    assert.equal(s.git('rev-parse', 'HEAD'), start, 'the checkout never had any of it');

    // The backlog, dragged straight to Building: it is built next.
    s.git('checkout', '-q', '--', 'mine.txt');
    const now = await move(easy, 'building');
    assert.equal(now.status, 200, now.text);
    await until('it is picked up and at work', async () => { const c = (await board()).runner.running[0]; return c?.id === easy && c.lines.includes('changing things'); });
    // Building, dragged to Done: the human says it is finished, and the agent is ended. Done lands the worktree's
    // commits on the checkout, and a landing refuses what is not committed, so the rest is committed first.
    s.cd(`.spool/worktrees/${easy}`).commitAll(`Make the coins loud\n\nSpool: ${easy}`);
    const done = await move(easy, 'done');
    assert.equal(done.status, 200, done.text);
    assert.equal(s.json('show', easy).item.status, 'done');
    assert.equal(s.read('sound.txt'), 'loud\n', 'what it built has landed');
    await until('the agent is ended', async () => !(await board()).runner.running.length);
    // Done, dragged back to Build: undone, and waiting there.
    assert.equal((await move(easy, 'build')).status, 200);
    assert.equal(s.json('show', easy).item.state, 'ready');
    assert.equal((await move(easy, 'nowhere')).status, 400);
  } finally {
    await page.stop();
  }

  // The same from the command line: a done thread, undone and back in the backlog; one being built, stopped and back in build.
  s.sp('build', hard);
  s.sp('start', hard);
  assert.match(s.fails('build', hard), /being built already[\s\S]*spool build --abort/);
  s.sp('build', '--abort', hard);
  assert.equal(s.json('show', hard).item.state, 'ready');
  s.sp('start', hard);
  s.sp('done', hard, '-m', 'finished');
  assert.match(s.fails('propose', hard), /already done[\s\S]*spool propose --undo/);
  s.sp('propose', '--undo', hard);
  assert.equal(s.json('show', hard).item.state, 'proposed');
  s.cleanup();
});

test('a page stopped mid-build puts its thread back, and a page starting up rescues one left behind', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const hard = s.id('task', 'Too hard');
  s.sp('build', hard);
  const sleeper = agent(s, 'sleeper.sh', 'echo "thinking hard"; sleep 30');
  const working = async (url: string) =>
    until('the agent is heard working', async () => ((await (await fetch(`${url}api/board`)).json()) as Record<string, any>).runner.running[0]?.lines.length);
  const started: Page[] = [];

  try {
    // Ctrl-C on the page while its agent works: the thread is back in Build at once.
    const first = await startPage(s, '--run', '--agent', sleeper);
    started.push(first);
    await working(first.url);
    assert.equal(s.json('show', hard).item.state, 'active');
    first.child.kill('SIGINT');
    await gone(first.child);
    assert.deepEqual([s.json('show', hard).item.state, s.json('show', hard).item.by], ['ready', undefined]);
    assert.match(s.item(hard), /page: the page was stopped; back in build/);

    // A page killed outright cannot put anything back: the next page to start does.
    const second = await startPage(s, '--run', '--agent', sleeper);
    started.push(second);
    await working(second.url);
    second.child.kill('SIGKILL');
    await gone(second.child);
    assert.equal(s.json('show', hard).item.state, 'active', 'left marked as handed out');

    const worker = agent(s, 'worker.sh', 'spool done "$SPOOL_TASK" -m "finished" > /dev/null');
    const third = await startPage(s, '--run', '--agent', worker);
    try {
      await until('the rescued thread is built', async () => s.json('show', hard).item.status === 'done');
      assert.match(s.item(hard), /page: its page had stopped with nobody working it; back in build/);
    } finally {
      await third.stop();
    }
  } finally {
    for (const page of started) await page.stop();
    // The agent of the page killed outright was left running, as it would be: end it here.
    spawnSync('pkill', ['-f', sleeper]);
    s.cleanup();
  }
});

test('the agent’s stream is kept with the thread: its steps, a denied tool call, and its session', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const events = [
    { type: 'system', subtype: 'init', session_id: 'abc-123', model: 'claude-opus-5-5' },
    {
      type: 'assistant',
      session_id: 'abc-123',
      message: { content: [{ type: 'text', text: 'Reading the jump code.' }, { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf build' } }] },
    },
    { type: 'user', session_id: 'abc-123', message: { content: [{ type: 'tool_result', is_error: true, content: 'This command requires approval' }] } },
    {
      type: 'result',
      subtype: 'success',
      session_id: 'abc-123',
      num_turns: 3,
      result: 'Could not clean the build.',
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }],
    },
  ];
  const stream = path.join(s.root, 'stream.jsonl');
  fs.writeFileSync(stream, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const worker = agent(s, 'worker.sh', `cat "${stream}"; echo "a warning" >&2; sleep 1; exit 1`);
  const { url, stop } = await startPage(s, '--run', '--agent', worker);
  try {
    const board = async () => (await (await fetch(`${url}api/board`)).json()) as Record<string, any>;
    const live = await until('the steps are heard', async () => { const b = await board(); return b.runner.running[0]?.lines.length >= 6 && b; });
    assert.deepEqual(live.runner.running[0].lines.slice(0, 6), [
      'session abc-123 · claude-opus-5-5',
      'Reading the jump code.',
      '→ Bash: rm -rf build',
      '✗ This command requires approval',
      'denied → Bash: rm -rf build',
      'finished · 3 turns — Could not clean the build.',
    ]);
    await until('the run is over', async () => { const b = await board(); return !b.runner.running.length && b.runner.recent[0]; });
    const item = s.item(jump);
    const kept = /page: session abc-123 · transcript (\.spool\/runs\/[\w-]+\/[\w-]+\.jsonl) · open it with `claude --resume abc-123`/.exec(item);
    assert.ok(kept, item);
    assert.match(item, /page: permission denied: Bash: rm -rf build/);
    const saved = fs.readFileSync(path.join(s.root, kept[1]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(saved.slice(0, 4), events, 'the stream is kept as it came');
    assert.deepEqual(saved[4], { type: 'stderr', text: 'a warning' });
    assert.equal(fs.readFileSync(path.join(s.root, '.spool', 'runs', '.gitignore'), 'utf8').split('\n')[1], '*', 'transcripts stay out of git');
  } finally {
    await stop();
    s.cleanup();
  }
});

test('the runner is off unless asked for: opening the page builds nothing', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const { url, stop } = await startPage(s);
  try {
    const b = (await (await fetch(`${url}api/board`)).json()) as Record<string, any>;
    assert.deepEqual([b.runner.on, b.runner.agent, b.runner.running], [false, 'claude -p', []]);
    await pause(1300);
    assert.equal(s.json('show', jump).item.state, 'ready');
  } finally {
    await stop();
    s.cleanup();
  }
});

test('with Chat picked, the page starts no agent: a chat builds, the pick is kept, and the page says who is listening', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset');
  const worker = agent(s, 'worker.sh', 'spool done "$SPOOL_TASK" -m "finished by $SPOOL_ACTOR" > /dev/null');
  const config = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(s.root, '.home', '.config', 'spool', 'config.json'), 'utf8'));
  const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 1300));

  let page = await startPage(s, '--run', '--agent', worker);
  const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
  const post = (action: string, body: unknown) =>
    fetch(`${page.url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) });
  let watch: ChildProcess | undefined;
  try {
    // Headless until the human says otherwise, with the runner on as asked.
    assert.deepEqual([(await board()).runner.builder, (await board()).runner.watching, (await board()).runner.on], ['headless', false, true]);
    assert.equal((await post('builder', { builder: 'a robot' })).status, 400, 'only the two picks there are');

    // Chat picked: kept on the user's machine, by the project's folder.
    const picked = await post('builder', { builder: 'chat' });
    assert.equal(picked.status, 200);
    assert.match(((await picked.json()) as { text: string }).text, /chat builds now.*\/spool-loop.*starts no agents/i);
    assert.equal((await board()).runner.builder, 'chat');
    assert.deepEqual(config().builder, { [s.root]: 'chat' });

    // Moved to Build, and even dragged into Building: the page starts nothing, with its runner on.
    await post('move', { id: jump, to: 'build' });
    const dragged = await post('move', { id: coins, to: 'building' });
    assert.match(((await dragged.json()) as { text: string }).text, /In build, for the chat to take/);
    await quiet();
    assert.deepEqual([s.json('show', jump).item.state, s.json('show', coins).item.state], ['ready', 'ready']);
    assert.ok(!fs.existsSync(path.join(s.root, 'last-prompt.txt')), 'no agent was started');
    assert.equal((await board()).runner.watching, false, 'and nobody is listening yet');

    // A chat running the loop watches the spool: the page says so, for as long as it does.
    watch = spawn(process.execPath, [CLI, 'watch', '--interval', '40', '-C', s.root], { env: { ...process.env, HOME: `${s.root}/.home` }, stdio: 'ignore' });
    await until('the page sees the watch', async () => (await board()).runner.watching);
    watch.kill();
    await until('the page sees the watch go', async () => !(await board()).runner.watching);
    watch = undefined;

    // The pick outlives the page.
    await page.stop();
    page = await startPage(s, '--run', '--agent', worker);
    assert.equal((await board()).runner.builder, 'chat');
    await quiet();
    assert.equal(s.json('show', jump).item.state, 'ready', 'a page started with --run still starts nothing');

    // Back to Headless: the page builds what waited, as it always did.
    assert.equal((await post('builder', { builder: 'headless' })).status, 200);
    await until('both threads are built', async () => s.json('show', jump).item.status === 'done' && s.json('show', coins).item.status === 'done');
    assert.deepEqual(config().builder, {}, 'headless is what a project is with nothing kept');
  } finally {
    watch?.kill();
    await page.stop();
    s.cleanup();
  }
});
