# Security

## Reporting a problem

Please report a vulnerability privately, not in a public issue.

Use GitHub's private vulnerability reporting: on this repository's **Security** tab, choose
**Report a vulnerability**. That opens a private security advisory that only you and the
maintainers can see. Say what you found, how to reproduce it, and which version of Spool.

You will get an answer there. Please give us a reasonable time to fix it before you share it.

## Supported versions

Spool is young and moves fast. Fixes go into the latest release only; if you are on an older one,
update first (`npm install -g spool-ai@latest`).

## What Spool does on your machine, and what it does not

Spool is a local tool for one person on one machine. It assumes you trust the other processes and
users on that machine. Here is what it does to keep the rest out.

**The board listens on 127.0.0.1 only.** It is never reachable from another computer. It also
refuses any request whose `Host` name is not this machine, which stops DNS rebinding. A test
starts the board and checks that it answers on 127.0.0.1 and on no other address.

**Every change needs the page's token.** Moving, building, starting and undoing are all POSTs, and
each is refused without the token the board hands to its own page. A change that comes from
another origin is refused even with the token right, and the page sends `frame-ancestors 'none'`,
so another website cannot frame it and trick a click. Pictures are served only by names Spool
gave and checked on disk, under a strict content security policy. The page builds its HTML from
data as text, and links allow http and https only.

**The token is not a secret from your own machine.** Any process running as anyone on the same
machine that can reach 127.0.0.1 can fetch the page and read the token from it, and so can act as
you on the board. Spool does not defend against that: on a shared or untrusted machine, do not
run the board. (This is a known limit, found in our own security audit.)

**Agents work in their own worktrees.** Each thread the board builds gets a git worktree of its
own, and that worktree refuses `git push` with a hook. Be honest about what that is: it is a guard
against a mistake, not a lock. `git push --no-verify` skips a hook, and the worktree can use your
git credentials, so an agent told to, or tricked into it, could still publish. Review what agents
do, and use a credential that cannot push where you can.

**What an agent may run is what you allow Claude.** Spool starts your agent command (by default
`claude -p`) and the agent runs with the permissions you give it. `spool doctor` suggests
`--permission-mode acceptEdits --allowedTools 'Bash(spool *)' 'Bash(git *)' Edit Write Read`. Know
that `Bash(git *)` is broad: through git aliases, hooks and `-c` options it can run other
commands. Narrow it if that matters to you. A repo's own config is data: it never sets the agent
or notifier command, and is never executed.

**Your queue stays local.** `.spool/` (items, transcripts, screenshots and notes, in your words)
is ignored by git and is never committed or pushed by Spool, unless you choose to share it. The
page's own record there is written readable by you alone (0600). Spool has no install scripts and
no runtime dependencies.

## Out of scope

Anything that needs the attacker to already run code as you on your machine, such as reading the
token from the page or editing `.spool/` directly.
