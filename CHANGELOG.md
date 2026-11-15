# Changelog

What shipped in each version of Spool, newest first.

## 0.5.0 · 2026-11-15

- The loop is simpler. Every run shows one table of every open thread, numbered in the order it
  suggests, then works them one by one without waiting for a go-ahead.
- As it starts each thread it says what the thread is and its plan, and it can be steered at any time.
- It notifies you when the list is done, when nothing can move without you, or when a question stops
  a thread.
- The schedule is only a check back in for anything new or more pressing: no sessions, no hours to
  fill.

## 0.4.0 · 2026-11-15

- The loop's check-in is one fixed layout: where the project stands, what shipped, a table of the
  whole spool (thread, status, difficulty, priority, what to talk through), what the loop recommends
  for the session, and what needs talking through.
- Nothing starts until you say go. The ten-minute timer is gone.
- The loop sets exactly one scheduled job. `/spool-loop again` and `/spool-loop go` no longer exist.
- `/spool-recorder <what, and where>` records the one message it is in front of; it no longer turns
  the chat into a recorder.
- `/spool-blockers` is removed: the loop's check-in walks you through everything waiting on you.
  `spool install` takes the old copy away.

## 0.3.0 · 2026-11-15

- `/spool-loop` is the main command: a cycle every three hours (or `/spool-loop <hours>`) that takes
  stock of the spool, checks in, waits ten minutes for you to steer, then works until the next check-in.
- A spool 🧶 holds threads 🧵: the overview, the skills and the check-in all say so, and every thread
  is marked 🧵 under its colour.
- Every check-in is three parts: the whole spool, a numbered proposal of what the loop intends to
  ship before the next one, then the questions.
- The loop's first return is a full interval away, not minutes after it starts.
- The loop notifies you through Claude when a check-in is waiting, when a question stops a thread,
  and when nothing can move without you.
- The recorder decides how to split what you dictate into threads, and sizes each one.
- The loop gives what shipped a version at the end of each cycle: a bump, a changelog entry and a tag.
