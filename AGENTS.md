<!-- spool:start -->
## Spool

This project's work queue lives in `.spool/` and is managed with the `spool` CLI.
Never edit those files by hand.

- Start of a session: `spool prime`, then `spool status`.
- The human gives feedback: `spool capture "<their exact words>"`, then file it.
- Looking for work: `spool next --claim`.
<!-- spool:end -->
