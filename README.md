# 🧶 Spool

**Tell your agents what you want. Go outside. Come back to it built.**

A spool holds threads. Every idea, bug and feature in your repo is a thread 🧵. Agents propose
them, you pick the ones worth building, and Claude builds them while you do something better.

Spool itself has no cloud and no account of its own: it is plain files in your repo. You bring Claude.

![The Spool page: a board with Backlog, Build, Building and Done](docs/spool-page.png)

## Already use Claude Code?

```bash
npm install -g github:danielportnov/spool && spool install
```

Then, in Claude Code inside your project: `/spool-init`, and after it `/spool-page`. That's it.

## New to this? Set up in five minutes

**What you need**

- **A Claude account on a paid plan.** Claude Code, the part of Claude that works on your files, is
  not included in the free plan.
- **A project folder** with the code you want worked on. A git repository is best: git is what lets
  Spool undo a thread.
- **A Mac, Linux or Windows computer.** Spool has been built and tried on macOS so far.

**1. Get Claude Code**

The easy way is the Claude desktop app: [download it](https://claude.ai/download), sign in, open the
**Code** tab, choose **Open folder…** and pick your project.

Prefer a terminal? Install it, then start it inside your project:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

```bash
cd your-project && claude
```

On Windows, and for every other way to install, see
[Claude Code's own setup guide](https://code.claude.com/docs/en/setup).

**2. Get Node.js**

Spool runs on Node.js 20 or newer. Get it from [nodejs.org](https://nodejs.org), then check:

```bash
node --version
```

**3. Install Spool**

In a terminal, anywhere:

```bash
npm install -g github:danielportnov/spool
```

```bash
spool install
```

The first downloads and builds Spool, which takes a minute. The second gives Claude Code four new
commands, called skills. Nothing is added to your project yet.

**4. Set up your project**

In Claude Code, with your project open, type:

```
/spool-init
```

Claude reads your project, creates a `.spool/` folder in it for the threads, and tells you what
agents may decide for themselves. Claude asks before it runs a command: when it asks about `spool`,
choose **Yes, and don't ask again**.

**5. Open the board, and build something**

```
/spool-page
```

A board opens in your browser. Press **+ Add** under Backlog and type what you want, in your own
words. Press **▶ Build** on it. Claude starts on it, and the card moves to Building, then Done.

Keep that chat open while you want things built: that is where Claude is working.

**If something does not work**

| You see | Do this |
| --- | --- |
| `/spool-init` is not in the list | Run `spool install` again, then type `/reload-skills` or start a new chat. |
| `spool: command not found` | Close the terminal and open a new one. Still missing? Node's global folder is not on your PATH: `npm prefix -g` shows where it is. |
| The board did not open | Go to the address Claude printed, usually `http://127.0.0.1:4747`. |
| Nothing gets built | Is the thread under **Build**? Is the chat where you typed `/spool-page` still open? |
| Claude keeps asking permission | Choose **Yes, and don't ask again** for `spool` commands. |

## Every day

Got an idea? Put this in front of it, typed or dictated, in any Claude Code chat in the project:

```
/spool-record the jump feels floaty, and I can't see the coins at sunset
```

Two threads land in the backlog, in your words. Nothing is built until you move them to Build.

## How it works

| 🟠 Backlog | 🟢 Build | 🔵 Building | ✅ Done |
| --- | --- | --- | --- |
| Every new thread. Yours, or an agent's ✨. | The ones you picked. | An agent has it. | Shipped, and undoable. |

1. **Threads start in the backlog.** Agents size them, explain them and suggest their own. They cannot start them.
2. **You move a thread to Build.** Drag it, press ▶, or say "build that one". Or group a few into a **sprint** and press ▶ on the sprint.
3. **The loop builds it.** One thread at a time, in order, a line when it starts and a line when it ships.
4. **You can take it back.** "Undo that" reverts everything that thread changed, and nothing else.

**Nothing is built unless you put it in Build.** That is the contract.

Want that enforced, not just promised? `spool init --lock`. Then the commands that start work run
only for a person: a click on the page, or your own terminal. An agent that tries is refused, so
"build that" in a chat gets you a link to press ▶ on. It stops an agent starting work by mistake or
on its own reading of you; it is not a wall against a program running as you.

## The page

```bash
spool page
```

A board of your spool, served from your own machine, with a Jira-shaped **Backlog** view beside it:
sprints you fill by dragging and start with one ▶. Sprints have no dates; agents work in hours, so
a sprint is over when its threads are done. On the board, drag threads between Backlog and Build, add
one with **+ Add**, answer an agent's question with one button. Open any card and you get the
ticket: what you said, what was done and by which agent, everything in between, and its fields at
the side — status, priority, difficulty, tags, version — all yours to change. Click a tag or a
version to narrow the board to it. Reply on a thread, and press **Mark as complete** when you have
looked at the change. Agents keep working while it is
open, and you watch threads move.

![The Backlog view: sprints to fill and play, and the backlog under them](docs/spool-backlog.png)

![A thread, opened: what you said, what Claude did, and the ticket's fields](docs/spool-ticket.png)

The pictures are a made-up project.

## No chat at all

```bash
spool page --run
```

With `--run`, or the **Agents** switch at the top of the page, the page builds what is in Build by
itself: it starts your agent on each thread, shows what it prints on the card, and has a Stop. One
thread at a time. Close every chat; press ▶; come back to Done.

Next to that switch you pick who builds. **Headless** is the above: the page starts the agent
itself. **Chat** hands building to a Claude Code chat running `/spool-loop`, where you can watch
the work and step in; the page then starts nothing, and the switch says whether a chat is building,
watching, or not there. The pick is kept for the project.

The agent it starts is a command on your machine, `claude -p` unless you say otherwise, and it can
only do what you allow it. To let it edit files and commit, say so once in
`~/.config/spool/config.json`:

```json
{ "agent": "claude -p --permission-mode acceptEdits --allowedTools 'Bash(spool *)' 'Bash(git *)' Edit Write Read" }
```

## While you're away

- ⚡ The loop watches the spool. Press ▶ on the page and it starts within seconds; no timer, nobody typing.
- 🔔 It notifies you when Build is empty, or when it needs a call that is yours.
- ❓ A question stops one thread, never the loop. It asks with options and a recommendation, and moves on.
- 🧾 A call it makes by itself leaves a receipt you can overrule.
- ✅ Name your tests once (`spool checks "npm test"`) and no thread can be marked done unless they pass.
- 🏷️ What ships gets a version: a bump, a changelog entry, and a tag that stays on your machine.

## The four skills

| | |
| --- | --- |
| `/spool-init` | Set Spool up in a repo, or in a folder of repos. Once. |
| `/spool-page` | The board. Where you plan and decide what gets built. Opening it starts the loop. |
| `/spool-loop` | The loop by itself, with no board: builds what is in Build, then watches for more. |
| `/spool-record <idea>` | Files one message as threads. The chat carries on as it was. |

## Under the hood

- **Plain files.** One markdown file per thread in `.spool/`, ignored by git unless you choose to share it.
- **A small CLI.** `spool` holds the queue, the lock, the order and the undo. The skills run it; you rarely type it.
- **Any agent.** The skills are plain [Agent Skills](https://agentskills.io). `spool mcp` serves the same commands as tools to an agent with no shell, and `spool loop` runs with no chat at all.
- **Your machine.** A repo's config is data and is never executed. The page listens on `127.0.0.1` only.

The long version, with every idea and every command: [how it works](docs/how-it-works.md).

## Status

Early, and moving fast. Built on macOS with Claude Code. Not on npm yet, and not tested on Windows.
See the [changelog](CHANGELOG.md).

## Develop

```bash
npm install
npm test        # node --test, straight from the TypeScript sources
npm run check   # tsc
```

No runtime dependencies. PRs and issues welcome.

## License

MIT
