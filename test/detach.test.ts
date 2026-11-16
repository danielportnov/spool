import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox, WAIT_MS, freePort, until } from './helpers.ts';

/**
 * The real CLI, run as a person or an agent would and waited for. A browser opener that only
 * leaves a mark stands first on the PATH, so a test can tell whether anything tried to open one.
 */
function spool(s: Sandbox, ...args: string[]): Ran {
  return spoolOf(CLI, s, ...args);
}

interface Ran {
  code: number | null;
  out: string;
  err: string;
  ms: number;
}

function env(s: Sandbox): Record<string, string | undefined> {
  const bin = path.join(s.root, 'bin');
  return { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, PATH: `${bin}:${process.env.PATH}`, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined, SPOOL_PAGE_RESUME: undefined };
}

function spoolOf(cli: string, s: Sandbox, ...args: string[]): Ran {
  const bin = path.join(s.root, 'bin');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(bin);
    for (const name of ['open', 'xdg-open']) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" >> "${path.join(s.root, 'opened.txt')}"\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  }
  const started = Date.now();
  const ran = spawnSync(process.execPath, [cli, '-C', s.root, ...args], {
    env: env(s),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: ran.status, out: ran.stdout.trim(), err: ran.stderr.trim(), ms: Date.now() - started };
}

/** Every page the sandbox has a record of, ended outright: a failing test must not leave one running. */
function killPages(s: Sandbox): void {
  const dir = path.join(s.root, '.home', '.config', 'spool', 'pages');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { pid: number };
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('spool page -d comes back with the address, and the page stays up without it until --stop', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  try {
    assert.equal(spool(s, 'page', '--status').out, 'No Spool page is up for this project. spool page -d starts one.');

    const port = await freePort();
    const started = spool(s, 'page', '-d', '--port', String(port));
    assert.equal(started.code, 0, started.err);
    const url = `http://127.0.0.1:${port}/`;
    assert.match(started.out, new RegExp(`^Spool page: ${url}\nIt runs in the background`));
    assert.ok(started.ms < 10_000, `came back in ${started.ms}ms`);

    // The process that started it has exited; the page answers anyway.
    const board = (await (await fetch(`${url}api/board`)).json()) as { project: string; runner: { on: boolean } };
    assert.equal(board.project, 'skyhop');
    assert.match(JSON.stringify(board), new RegExp(jump));

    const status = spool(s, 'page', '--status');
    assert.equal(status.code, 0);
    assert.match(status.out, new RegExp(`^Spool page: ${url}\nUp since \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d, in the background \\(pid (\\d+)\\)\\.\nAgents are off\\. The page builds here itself \\(Headless\\)\\.$`));
    const pid = Number(/pid (\d+)/.exec(status.out)![1]);
    assert.ok(alive(pid));

    // A second start, detached or not, finds the first instead of taking the next port.
    for (const again of [['page', '-d'], ['page', '--no-open'], ['page']]) {
      const second = spool(s, ...again);
      assert.equal(second.code, 0, second.err);
      assert.equal(second.out, `The Spool page is already up for this project: ${url}`);
    }
    // Plain `spool page` with one up shows the one that is up.
    const opened = path.join(s.root, 'opened.txt');
    await until('the page is shown', () => fs.existsSync(opened), { every: 20 });
    assert.equal(fs.readFileSync(opened, 'utf8').trim(), url);
    fs.rmSync(path.join(s.root, 'opened.txt'));

    // A chat building is said as it is set.
    const config = path.join(s.root, '.home', '.config', 'spool', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ builder: { [s.root]: 'chat' } }));
    assert.match(spool(s, 'page', '--status').out, /\nAgents are off\. A chat builds here \(Chat\)\.$/);

    const stopped = spool(s, 'page', '--stop');
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(stopped.out, `Stopped the Spool page at ${url}`);
    assert.ok(!alive(pid), 'the page process is gone');
    await assert.rejects(fetch(`${url}api/board`));
    assert.equal(spool(s, 'page', '--status').out, 'No Spool page is up for this project. spool page -d starts one.');
    assert.equal(spool(s, 'page', '--stop').out, 'No Spool page is up for this project.');
    assert.ok(!fs.existsSync(path.join(s.root, 'opened.txt')), 'nothing opened a browser');
  } finally {
    killPages(s);
    s.cleanup();
  }
});

test('a detached page that cannot start says why, and the command fails', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  try {
    const taken = spool(s, 'page', '-d', '--port', String((holder.address() as net.AddressInfo).port));
    assert.notEqual(taken.code, 0);
    assert.match(taken.err, /^spool: the page did not start: .*EADDRINUSE/);
    assert.equal(spool(s, 'page', '--status').out, 'No Spool page is up for this project. spool page -d starts one.');

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-none-'));
    try {
      const nowhere = spawnSync(process.execPath, [CLI, '-C', empty, 'page', '-d'], { env: { ...process.env, HOME: `${s.root}/.home` }, encoding: 'utf8' });
      assert.notEqual(nowhere.status, 0);
      assert.match(nowhere.stderr, /^spool: /);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    holder.close();
    killPages(s);
    s.cleanup();
  }
});

test('--stop ends a detached page as Ctrl-C would, putting back the thread its agent was building', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const hard = s.id('task', 'Too hard');
  s.sp('build', hard);
  const sleeper = path.join(s.root, 'sleeper.sh');
  fs.writeFileSync(sleeper, '#!/bin/sh\ncat > /dev/null\necho "thinking hard"\nsleep 30\n');
  fs.chmodSync(sleeper, 0o755);
  try {
    const started = spool(s, 'page', '-d', '--run', '--agent', sleeper, '--port', String(await freePort()));
    assert.equal(started.code, 0, started.err);
    assert.match(started.out, /\nAgents are on: this page builds what is in Build, with no chat open\.\n/);
    await until('the thread is being built', () => s.json('show', hard).item.state === 'active');
    assert.equal(s.json('show', hard).item.state, 'active');
    assert.match(spool(s, 'page', '--status').out, /\nAgents are on\. The page builds here itself \(Headless\)\.$/);

    assert.equal(spool(s, 'page', '--stop').code, 0);
    assert.deepEqual([s.json('show', hard).item.state, s.json('show', hard).item.by], ['ready', undefined]);
  } finally {
    killPages(s);
    s.cleanup();
  }
});

test('a page started in a terminal is seen too: --status finds it, a second start points at it, --stop ends it', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  spool(s, 'page', '--status');
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '-C', s.root, '--port', String(port)], { env: env(s), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`the page did not start: ${out}`)), WAIT_MS);
      child.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('Spool page: ')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const url = `http://127.0.0.1:${port}/`;
    assert.match(spool(s, 'page', '--status').out, new RegExp(`^Spool page: ${url}\nUp since .*, in a terminal \\(pid ${child.pid}\\)\\.`));
    assert.equal(spool(s, 'page', '-d').out, `The Spool page is already up for this project: ${url}`);
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    // Run without blocking: the page is this test's child, and only a test that is free to look sees it go.
    const stop = spawn(process.execPath, [CLI, '-C', s.root, 'page', '--stop'], { env: env(s), stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    stop.stdout!.on('data', (chunk: Buffer) => (said += chunk.toString()));
    assert.equal(await new Promise((r) => stop.once('close', r)), 0);
    assert.equal(said.trim(), `Stopped the Spool page at ${url}`);
    assert.equal(await exited, 0);
  } finally {
    child.kill('SIGKILL');
    s.cleanup();
  }
});

test('a detached page restarts onto new code as any page does, and is still the one --status and --stop find', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-copy-')));
  const repo = path.dirname(path.dirname(CLI));
  fs.cpSync(path.join(repo, 'src'), path.join(root, 'dist'), { recursive: true });
  fs.cpSync(path.join(repo, 'skills'), path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'spool-copy', version: '9.9.9', type: 'module' }));
  const cli = path.join(root, 'dist', 'cli.ts');
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  try {
    const port = await freePort();
    assert.equal(spoolOf(cli, s, 'page', '-d', '--port', String(port)).code, 0);
    const url = `http://127.0.0.1:${port}/`;
    const before = spoolOf(cli, s, 'page', '--status').out;
    const build = ((await (await fetch(`${url}api/board`)).json()) as { build: string }).build;

    fs.appendFileSync(path.join(root, 'dist', 'watch.ts'), '\n// built again\n');
    // A page that is restarting answers nobody for a moment: until looks again.
    const now = await until('the page is on the new build', async () => {
      const b = ((await (await fetch(`${url}api/board`)).json()) as { build: string }).build;
      return b !== build && b;
    });
    assert.notEqual(now, build, 'the page is on the new build');
    // The same page as far as anyone can tell: the same process to signal, up since the same time.
    assert.equal(spoolOf(cli, s, 'page', '--status').out, before);
    const pid = Number(/pid (\d+)/.exec(before)![1]);
    assert.equal(spoolOf(cli, s, 'page', '--stop').out, `Stopped the Spool page at ${url}`);
    assert.ok(!alive(pid));
    await assert.rejects(fetch(`${url}api/board`), 'nothing is left listening');
  } finally {
    killPages(s);
    s.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
