<!-- spool:start -->
## Spool

This project's work queue lives in `.spool/`. The human drives it by talking to you, through the
Spool skills: `/spool-init`, `/spool-loop`, `/spool-record` and `/spool-page`. The `spool` CLI is your tool for it: never edit those
files by hand, and never ask the human to run a command you can run.

- The human gives feedback, an idea or a bug, even in passing: `spool capture "<their exact words>"`,
  then file it with `spool task "<title>" --from <note-id>`. The `spool-record` skill has the rules.
- Asked to do some work: `spool status` first. If it is already a task, `spool start <id>`, and
  work it by the rules in the `spool-loop` skill, so the work is on record and can be undone.
- No skills in your harness? `spool prime` prints the worker's rules, `spool prime recorder` the recorder's.
<!-- spool:end -->
