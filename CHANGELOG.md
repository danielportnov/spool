# Changelog

What shipped in each version of Spool, newest first.

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
