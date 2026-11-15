# Spool

**You talk. Agents turn it into work, keep working, and come back only for the calls that are yours.**

Spool is a small CLI that keeps a work queue inside your repository, as plain markdown shaped for
coding agents to read and write. You give feedback the moment you have it — while playing the build,
from your phone, by voice. A *recorder* agent files it. *Worker* agents take it from there, around the
clock. When a worker reaches a choice, it either makes the call and leaves a receipt, or asks you and
gets on with something else. Anything it ships can be taken back with one command.

```mermaid
flowchart LR
  you(["You"]) -- "the jump feels floaty" --> rec["Recorder"]
  rec -- "files it" --> q[(".spool/")]
  q -- "next task" --> w["Workers"]
  w -- "commits" --> code[("your code")]
  w -- "questions · receipts · new skills" --> rev["spool review"]
  rev --> you
  you -- "answer · approve · revert" --> q
```

Agents are fast now. The slow part is the person: writing specs up front, re-explaining context,
sitting at a keyboard approving things. Spool is built on one idea — **your attention is the scarce
resource** — and spends it only on judgment. No daemon, no database, no account, no runtime
dependencies.

## What it looks like

You say something. The recorder captures your words exactly and splits them into work:

```console
$ spool capture "the jump feels floaty, and I can barely see the coins at sunset"
n-5exe captured in skyhop's inbox.

$ spool task "Tighten the jump arc" --from n-5exe -p 1
$ spool task "Make coins readable at sunset" --from n-5exe
```

Workers pick those up with `spool next --claim`, commit with a `Spool: <task-id>` trailer, and report
back. One made a call on its own; one needs yours. Hours later, this is everything waiting for you:

```console
$ spool review
NEEDS YOU  work is stopped on these
  d-bfm2  Coins at sunset: outline them, or change their colour?  · blocks 1 task
      1) Dark outline  ← recommended
      2) Shift coins to teal while the sun is low
      An outline works on every background; teal changes the look of the game
      spool answer d-bfm2 1

WENT AHEAD  approve, or say what you want instead
  d-xbye  How should the jump be tightened?
      chose: Raise gravity 9.8 → 12, keep the height
      Shorter hang time without changing what the player can reach
      spool approve d-xbye   ·   spool answer d-xbye "<what you want>"

SHIPPED  nothing to do unless you dislike it
  t-whnb  Tighten the jump arc  · 1 commit
      Gravity 9.8 → 12. The jump lands about 20% sooner — try the first level.
      spool revert <id> -m "<why>"

all good?  spool approve --all   (2 items)
```

You answer the question with a number, try the build, and don't like the jump:

```console
$ spool answer d-bfm2 1
d-bfm2 decided: Dark outline
Now ready:
  ○ t-w48r  p2  Make coins readable at sunset

$ spool revert t-whnb -m "too heavy now. I wanted snappy, not heavy"
t-whnb reverted — 1 commit(s) undone in one new commit.
  dropped the assumption behind it: d-xbye Raise gravity 9.8 → 12, keep the height
It is back in the queue at p1 with your reason attached.
```

The code is back where it was, the task is back at the front of the queue, and the next agent to pick
it up is briefed with both things you said.

## Install

Node 20 or newer. Not on npm yet; install from GitHub, which builds from source:

```bash
npm install -g github:danielportnov/spool
```

```bash
cd your-project
spool init
```

`init` creates `.spool/`, writes two [Agent Skills](#skills-compound) (`spool` and `recorder`) where
your harness will find them, and adds a short pointer to `CLAUDE.md` or `AGENTS.md`. From then on,
any agent that opens the project knows the queue exists and how to use it.

## The ideas

### Every interruption has to earn your attention

A worker that reaches a choice the task doesn't settle has two moves, and the difference between them
is the whole product:

| The choice is… | The agent runs | What happens | What you do |
| --- | --- | --- | --- |
| easily undone, and within policy | `spool assume` | It decides and keeps working. The call is on record. | Approve in one command — or say what you wanted, and the rework is queued for you. |
| yours to make | `spool ask` | That task stops; every other task continues. You get a notification with options and a recommendation. | Answer with a number. |

Finished work is a third lane: it needs nothing from you unless you dislike it.

Where the line falls is written in `.spool/policy.md` — plain prose, yours to edit, read by every
worker before it starts. The default lets agents assume anything one revert undoes, and makes them ask
before spending money, publishing, deleting, adding dependencies, or deciding matters of taste.

### Everything can be taken back

Agents end each commit message with `Spool: <task-id>`. That one line ties work to the task that asked
for it and, unlike a recorded hash, survives a rebase. `spool revert <task>` finds those commits and
undoes them in a single new commit. It is designed for a repository that is in use:

- It reverses only the files that task's commits changed, and only those files need to be clean. An
  agent halfway through something else is not in the way.
- It never touches `.spool/`. The queue is a record of what happened; undoing code does not rewrite it.
- It is all or nothing. If later work conflicts, every file is put back and nothing is committed.
- The task reopens at higher priority with your reason quoted in it, and any unconfirmed assumption
  the work was built on is dropped, so the second attempt isn't briefed to repeat the first.

### Two roles: a recorder and workers

The **recorder** is a chat you leave open — a mid-sized model is plenty. You dictate; it captures your
exact words, works out which project and which task they belong to, and files them. It never does the
work. In Claude Code, type `/recorder`. Anywhere else, start a session with the role's instructions:

```bash
claude --model sonnet "$(spool prime recorder)"
```

**Workers** take tasks off the queue. `spool prime` teaches the protocol to any agent in any harness
with one command, so the rules live in one versioned place rather than in a prompt you maintain.

The recorder's scope is wherever you start it: one repository, or a folder of them.

### Skills compound

When an agent works out a multi-step procedure — shipping a beta, regenerating assets — it can write
it down as a standard `SKILL.md`, which your harness loads natively from then on. Spool adds the part
the format lacks, a ledger:

```console
$ spool skills
games/sky_hop  1 skill
  ◆ ship-to-testflight  Build and upload a TestFlight beta. Use when asked to ship, release o…
                        s-9qap · by claude · from t-j586 · used 1× · new · .claude/skills/ship-to-testflight
```

Every skill records which task taught it, who wrote it and how often it has been used. New ones show
up in `spool review` like anything else done on your behalf: approve, or drop and it is deleted. A
task's brief lists the skills that fit it, and in a workspace a skill at the top is available to every
project below. Skills you wrote by hand are listed too.

### Blocked is computed, never stored

A task has no "blocked" status. It lists what it `needs`, and whether it is ready is worked out from
those items each time someone asks. Answer a question and everything behind it is ready in the same
instant; there is no second field to forget to update, and no state to repair.

### Plain files, one per item

```markdown
---
id: t-whnb
kind: task
title: Tighten the jump arc
status: open
priority: 1
created: 2026-11-15T17:11:14Z
updated: 2026-11-15T17:11:15Z
from: [n-5exe]
---

> the jump feels floaty, and I can barely see the coins at sunset
> — [[n-5exe]], 2026-11-15

> too heavy now. I wanted snappy, not heavy
> — on reverting the first attempt, 2026-11-15

## Log
- 2026-11-15 17:11Z claude: started
- 2026-11-15 17:11Z claude: assumed d-xbye: How should the jump be tightened? → Raise gravity 9.8 → 12, keep the height
- 2026-11-15 17:11Z claude: done: Gravity 9.8 → 12. The jump lands about 20% sooner — try the first level.
- 2026-11-15 17:11Z human: reverted 1 commit(s): too heavy now. I wanted snappy, not heavy
```

Four kinds of item — `note` (what you said, verbatim), `task`, `decision`, `skill` — linked by `from`
(where it came from) and `needs` (what must be settled first). That makes the store a small typed
graph: `spool graph` draws it, and because the links are `[[wikilinks]]` the folder opens as an
Obsidian vault.

- **Git is the history.** One small file per item diffs and merges cleanly.
- **Ids are random** (`t-whnb`), so two agents or two branches adding items never collide.
- **Agents never write these files.** They use verbs — `ask`, `assume`, `done` — and the CLI enforces
  what may follow what, so no agent can leave the queue in a shape the next one can't read.
- **Fields Spool doesn't own are kept.** Add `tags:` in your editor and they survive every rewrite.
- **Writes are atomic and locked**, so a recorder and several workers can share one queue.

### One project, or a folder of them

A workspace is the spool you are standing in plus every spool below it. Nothing is registered:

```console
$ cd ~/code/studio && spool status
studio · 3 projects
for you: 1 question blocking 1 task  → spool review

studio  no tasks yet

apps/tidy_up  no tasks yet

games/sky_hop  1 ready · 1 active · 1 blocked · 0 done
  ▶ t-ecpj  p1  Tighten the jump arc  · claude, now
  ○ t-s3gm  p2  Coin magnet radius is too small
  ◌ t-ac73  p2  New title screen  · needs d-3jwn
```

Run from the top and you see, record into and loop over everything; run from inside one project and
you see just that one. A recorder at the top routes each thing you say to the right project.

### A repository's config is never executed

Spool can start two programs: a notifier and an agent. Both are configured only on your own machine —
an environment variable or `~/.config/spool/config.json` — never in `.spool/config.json`. Cloning a
repository and running `spool` in it cannot run that repository's code.

## Running it

**Notifications.** Set a command and Spool runs it when a worker asks you something, or when the loop
runs dry with questions outstanding. Details arrive in `SPOOL_EVENT`, `SPOOL_TITLE`, `SPOOL_ID` and
`SPOOL_PROJECT`:

```json
{ "notify": "curl -s -d \"$SPOOL_TITLE\" https://ntfy.sh/your-private-topic" }
```

**The loop.** Spool contains no agent and doesn't care which one you use. `spool loop` claims the next
ready task, starts your agent in that task's project with the protocol and the brief on stdin, and
looks at the queue again when it exits:

```bash
spool loop                 # until nothing is ready
spool loop --watch 300     # forever: look again every five minutes
spool loop --dry-run       # what would it do?
spool loop --agent 'claude -p --permission-mode acceptEdits --allowedTools "Bash(git *) Bash(spool *)"'
```

The default agent is `claude -p`; anything that reads a prompt on stdin works. What the agent is
allowed to do is your harness's business, not Spool's. A task the agent finishes is done; one it asks
a question on waits for you; one it walks away from is released and not retried until something
changes. The lock is never held while an agent runs.

You don't need the runner: inside any agent session, "work the Spool queue until nothing is ready"
does the same thing.

## Commands

| You | |
| --- | --- |
| `spool capture <words…>` | Drop feedback in, exactly as said |
| `spool review` | Everything waiting on you, most blocking first |
| `spool answer <d-id> <n \| text>` | Answer a question, or overrule an assumption |
| `spool approve <id…> \| --all` | Accept an agent's call, finished work, or a new skill |
| `spool revert <t-id> [-m why]` | Undo a task's commits and reopen it with your reason |

| Agents | |
| --- | --- |
| `spool prime [worker\|recorder]` | Print the protocol for a role |
| `spool next [--claim]` | The most important ready task, with all its context |
| `spool ask <question> --option … [--recommend n] [--for t-id]` | Put a call to the human |
| `spool assume <question> --chose … [--why …] [--for t-id]` | Record a call you made |
| `spool done <t-id> -m <summary> [--skill name]` | Finish, and record how to undo it |
| `spool task <title> [--from id] [--needs id] [-p 0-3]` | Queue a piece of work |
| `spool file <n-id> --into <id> \| --drop` | Attach a note to existing work, or set it aside |
| `spool log <id> <text>` | Leave a note for whoever comes next |
| `spool skill add <name> -d <when to use it> -b <steps>` | Write a procedure down |
| `spool start` · `edit` · `drop` | Claim, change, abandon |

| See | |
| --- | --- |
| `spool status` | What is ready, active, blocked and waiting on you |
| `spool list [-k kind] [-s state] [--search words]` | Find items, closed ones included |
| `spool show <id>` · `inbox` · `skills` | One item · unfiled feedback · every skill |
| `spool graph` | The items and their links, as Mermaid |
| `spool check` | Validate the store: bad files, dangling links, cycles |

Every command takes `--json`, `-C <dir>` and `--as <name>`. Errors say what to do instead.

## Prior art

[OpenSpec](https://github.com/Fission-AI/OpenSpec) showed how well a small CLI over plain files works
as the interface between people and coding agents, and Spool borrows that shape. Where spec-first
tools begin with a proposal you write before the work, Spool begins with what you say after using the
thing — and treats the question "does this need the human?" as the central design problem.

## Roadmap

Spool is developed with Spool; the queue is in [`.spool/`](.spool/items). Clone it and run
`spool status`. Next up:

- **MCP server** — the same verbs as tools, for agents with no shell.
- **Memory** — free-standing facts linked into the graph and recalled into briefs by following edges.
- **Skill suggestions** — notice procedures that recur across finished tasks and propose them.
- **Obsidian** — a vault that opens with a useful graph view out of the box.
- **Semantic matching** — related work and skills are matched lexically today.

Not tested on Windows yet.

## Development

```bash
npm install
npm test          # node --test, straight from the TypeScript sources
npm run check     # tsc
npm run build     # dist/
```

The source is twelve small files with no runtime dependencies; [`src/model.ts`](src/model.ts) is the
schema and [`src/prime.ts`](src/prime.ts) is the protocol. Commands take their working directory,
environment and clock as arguments, so the tests drive the real CLI in-process against temp
directories, including real git repositories and stand-in agents.

## License

MIT
