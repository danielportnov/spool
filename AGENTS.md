<!-- spool:start -->
## Spool

This project's work queue lives in `.spool/`. It is the project's spool 🧶, and each piece of work
in it is a thread 🧵; the commands call a thread a task. The human drives it by talking to you,
through four skills: `/spool-init` sets a project up, `/spool` steers it and opens the board,
`/spool-loop` makes a chat the builder, and `/spool-record` files an idea. The `spool` CLI is
your tool for it: never edit those files by hand, and never ask the human to run a command you
can run.

- The human gives an idea, a wish, feedback or a bug about the project, even in passing:
  `spool capture "<their exact words>"`, then file it with `spool task "<title>" --from <note-id>`.
  The `spool-record` skill has the rules.
- Not everything they say is a note. An instruction to you about the work ("work the backlog
  until midnight", "use subagents") is done, not recorded. A go, a no or a choice is a verb:
  `spool build`, `spool propose`, `spool answer`; the `spool` skill has the table. In a long
  message, capture each idea on its own and act on the rest. Not sure whether it is an idea or
  an instruction? Record nothing and act.
- Asked to do some work: `spool status` first. If it is already a task, `spool start <id>`, and
  work it by the worker's rules (`spool prime worker`), so the work is on record and can be undone.
- No skills in your harness? `spool prime` prints the worker's rules, `spool prime recorder` the recorder's.
<!-- spool:end -->
