# Contributing to Spool

Spool is a small TypeScript CLI, a page it serves, and four agent skills. This page gets you from a
clone to a tested change. For where things live in the code, read [the tour](docs/architecture.md).

## Get it running

You need git, and a Node.js that runs TypeScript files as they are: 22.18 or newer. The installed
`spool` asks for Node 20, but the tests and the sources run straight from `.ts` files, and CI tries
Node 22 and 24.

```bash
git clone https://github.com/danielportnov/spool.git && cd spool
npm ci
```

`npm ci` also builds `dist/`, the JavaScript that `spool` runs once installed.

Run the CLI from the sources, with no build:

```bash
node src/cli.ts --version
mkdir -p /tmp/try-spool
node src/cli.ts init /tmp/try-spool
node src/cli.ts status -C /tmp/try-spool
```

`-C` points it at another folder. Without it, inside your clone, it works on the repository's own
`.spool/` (see the end of this page). It reads your own settings from
`~/.config/spool/config.json`, so `node src/cli.ts page --run` starts the same agent your installed
Spool would.

Run it from the build:

```bash
npm run build          # tsc, from src/ into dist/
node dist/cli.js --version
```

Check it:

```bash
npm run check          # tsc over src/ and test/, writing nothing
npm test               # every test, straight from the sources
node --test test/revert.test.ts                       # one file
node --test --test-name-pattern "revert" test/*.test.ts   # tests whose name matches
```

The whole suite takes about half a minute.

Install it as a newcomer would, on a machine that has never seen Spool:

```bash
bash scripts/fresh-install.sh   # npm pack, npm install -g the tarball, then install, demo, init, doctor, page
```

It runs every step under one temp folder, with an empty HOME and its own npm prefix, so nothing on
your machine is read or changed, and it deletes the folder when it passes (`KEEP=1` keeps it). CI
runs it on Ubuntu and macOS.

**What the tests need.** Git: many tests make real repositories. Chrome, for one test only:
`test/browser.test.ts` drives the page in the Chrome on your machine through `playwright-core`,
which brings no browser of its own. Where there is no Chrome it skips itself. Set
`SPOOL_SHOTS=<folder>` and it leaves a picture of each view there. Set `SPOOL_WIDE_FONT=1` and
the page is drawn in a font as wide as the one Linux, and so CI, draws it in: what wraps or is cut
there shows on a Mac too. Each test runs with a home folder of its own, so your own settings stay
out of it. A test that runs past five minutes fails, and the browser and page it left open are
closed, so a stuck test fails the run instead of hanging it.

## The rules of the house

**No runtime dependencies.** `package.json` has none, and it stays that way. TypeScript, the Node
types and `playwright-core` are for building and testing only. Where Spool needs a protocol, such
as MCP in `src/mcp.ts`, it is written out by hand.

**Commands go through `Ctx`.** A command gets the working directory, the environment, the clock,
its input and its output from a `Ctx` (`src/context.ts`), never from `process`. That is what lets a
test call every command in-process against a temp folder. Only `src/cli.ts` builds a `Ctx` from
the real `process`. A few places still reach it: `page` and `watch` for signals and their own pid,
and `src/git.ts`, which hands git the real environment.

**A repository's files are data.** Nothing in `.spool/` is ever run. The only programs Spool starts,
an agent, a notifier and a project's check, come from the user's machine: an environment variable
or `~/.config/spool/config.json`. Cloning someone's repo and running `spool` in it must never run
their code. Words that come from a project's files and go near a shell are checked first, as
`src/agent.ts` does with model names.

**The page is one page, and does only what a command can.** The whole client is three strings in
`src/client/`: its HTML (`page.html.ts`), its CSS (`page.css.ts`) and its script (`page.js.ts`),
joined into the one `PAGE` the server sends, with nothing else to load and no build step. Every
change the page makes is an ordinary command run as the user (`change` and `act` in
`src/act.ts`), so the page can do nothing the command line cannot. A new button starts as a
command.

**A command lives in one table.** `COMMANDS` in `src/commands.ts`. `spool help`, `--json` and the
MCP tools are all made from it, so a new entry shows up in all three. An error is a `SpoolError`
with a hint that says what to do instead. A test checks that every `spool <verb>` a skill names is
a real command.

**Plain words.** In every message, error, comment and document: short sentences, the plain word,
no jargon where a plain one will do. Output is read by an agent paying per token and by a person
glancing at a phone. Read the header comment of any file in `src/` for the voice.

## Writing a test

Tests use `node:test` and drive the real CLI in-process. `test/helpers.ts` has the `Sandbox`: a
temp folder with its own home, and a clock that moves one minute for each command run, so
creation order is never a tie. `spool()` gives you a Sandbox with a spool already in it.

- `s.sp(...args)` runs a command that must succeed and returns its output. `s.fails(...)` runs one
  that must fail and returns its error.
- `s.json(...)` adds `--json` and parses it. `s.id(...)` files something and returns its id.
- `s.write`, `s.read`, `s.exists` and `s.item(id)` look at files. `s.gitInit()` and
  `s.commitAll(message)` make a real repository. `s.advance(hours)` moves the clock.
- `s.cleanup()` at the end.

A real one, from `test/flow.test.ts`:

```ts
test('capture points at work that looks related', () => {
  const s = spool();
  s.sp('task', 'Tighten the jump arc so it feels less floaty');
  s.sp('task', 'Add a settings screen');
  const data = s.json('capture', 'jump is still floaty over the long gap');
  assert.equal(data.related.length, 1);
  assert.match(data.related[0].title, /jump arc/);
  s.cleanup();
});
```

Tests are named for what they show, in a sentence. Where a test needs an agent, it writes a small
shell script that stands in for one and drives the real CLI: see `agent()` in `test/loop.test.ts`.

**A test that needs the page running.** Several suites may run on one machine at once, so a test
never names a port and never sleeps to wait for something. The helpers do both:

```ts
const page = await startPage(s, '--run', '--agent', worker); // a free port, picked for you
try {
  await until('the thread is built', () => s.json('show', jump).item.status === 'done');
} finally {
  await page.stop(); // ends the page as Ctrl-C would, and its agents with it
  s.cleanup();
}
```

- `startPage(s, ...args)` starts `spool page` on a port the system says is free, tries once more
  if something took it first, and gives back `url`, `port`, `token`, `child`, `out()` and `stop()`.
  Pass `--port String(page.port)` to start a page again where the last one was.
- `until(what, look)` looks every 50ms and returns as soon as `look` gives something truthy, for up
  to 30 seconds. A fixed `pause(ms)` is only for showing that something does not happen.
- `freePort()` and `freePorts(n)` are for a test about ports themselves.
- `openChrome()` launches the Chrome on the machine for a browser test (it throws where there is
  none: skip then), with Playwright's waits raised to suit a busy machine.

## Proposing a change

Open a pull request with the tests passing. CI (`.github/workflows/ci.yml`) runs on every pull
request and every push to `main`, on Ubuntu and macOS, with Node 22 and 24. It runs `npm ci`,
`npm run check`, `npm test`, and then `node dist/cli.js --version` to see that the build starts.
Run the same before you push. Open a pull request describing what changed, why, and how you tested it.
Issues are welcome too: use the bug report or idea form to give us the context we need.

## Spool is built with Spool

The repository carries its own `.spool/`, kept in git: the threads, notes and decisions Spool's own
work came from. Commits made for a thread end with a trailer such as `Spool: t-4kq7`, which is how
`spool revert` finds them. You do not need any of it to contribute. Leave `.spool/` out of your
pull request, and never edit its files by hand: the `spool` commands are the only writers.
