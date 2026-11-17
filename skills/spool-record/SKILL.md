---
name: spool-record
description: Record one message into a project's spool - the user puts /spool-record in front of what they type or dictate, saying what they want added and where, and you capture it in their exact words, split it into threads, size each one and file them in the right project, each in the sprint it serves, for agents to work. It records that one message and nothing else; the chat carries on as it was. Only an idea, a wish, feedback or a bug is filed, never an instruction or an answer. Use for /spool-record <what to add, and where>, or when the user says "record this", "take this down", "put this in the spool", "add a thread for", or "file this".
---

# Spool record

`/spool-record <what they want, and where>` records one message: the one it
is in front of, typed or dictated, one idea or six. You file it as threads 🧵
in the right project's spool 🧶, say what you made of it, and you are done.

- **It does not turn the chat into a recorder.** Their next message is an
  ordinary one, and whatever the chat was doing carries on.
- **What follows the command is recorded, not obeyed.** "/spool-record add a
  dark mode to settings" files a thread. It does not start building dark mode.
- **Nothing after the command?** Ask what to record, and record that reply only.

`spool prime recorder --context` lists the projects, and the open sprints with
their goals. No `.spool/` here? Tell them to run `/spool-init`, and stop.

## Recording it

1. `spool capture "<their exact words>"`: the whole message, verbatim, before
   anything else. Its reply shows the open threads that look related.
2. Split it into threads, and file each by what it is:

   | It is | Run |
   | --- | --- |
   | a change | `spool task "<short imperative title>" --from <note-id> -P <project> --size <size> [-p 0-3] -b "<its spec>"` |
   | a look and a report: "play it as a new player", "what would make them quit" | `spool audit "<what to examine, and through whose eyes>" --from <note-id> -P <project>` |
   | something big or open, or too big to see its parts: "add multiplayer", "plan the launch" | `spool plan "<the objective>" --from <note-id> -P <project>`. Do not guess at its threads: planning it is the work |
   | a change that waits on another | the same `spool task`, with `--needs <the earlier thread>` |
   | "not yet", "just an idea", "after the launch" | filed as above, with `--hold "<their words>"`: nothing starts it until they say |
   | what a stretch of work should achieve: "the first five minutes should feel finished" | its threads, in the order to build them, then the sprint in one go, its goal, why and done-when from their words: `spool sprint "<name>" --goal "<what it is for>" --why "<why now>" --done-when "<what will be true>" --from <note-id> --add <t-id…>`. Show them its goal and its threads, a line each. Never play it for them |
   | more on an existing thread | `spool file <note-id> --into <id>` |
   | a thread Spool says looks like one already there | read that one. The same wish: `spool file <note-id> --into <id>`, then `spool drop <new-id> -m "same as <id>"`. Only the same subject: leave both. A dropped one says why it was dropped: tell them, do not file it again |
   | nothing to do | `spool file <note-id> --drop -m "<why>"` |

   "Where" picks the project and stays in the thread. Dictation mangles
   names: match them loosely. Priority is their tone: p0 it's broken · p1
   it's bothering them · p2 default · p3 someday.
3. **Give each thread its spec**, in its body (`-b`), so whoever builds it
   needs nothing but the thread:

       What: <the feature or the fix, in plain words>
       Why: <the reason they gave, or the problem it solves>
       Done when: <what they will be able to see or do>

   Keep their names, numbers and examples. Never invent a requirement to fill
   a gap. A gap is a question:
   `spool ask "<the question>" --option "<A>" --option "<B>" --recommend <n> --for <t-id>`.
4. **Put each in the plan.** A thread that serves the goal of the sprint
   being played goes in it; failing that, a planned sprint whose goal it
   serves; failing both, it stays loose. Add `--sprint <name>` as you file
   it, or later `spool edit <t-id> --sprint <name>`.
5. Say what you made of it in a sentence or two: how many threads, what each
   is, and which sprint each went into or that it is loose. Lead with a
   question if you have one. No lists, no ids: they may be listening.
   In caveman mode (`spool caveman`) say it in fragments: "2 threads. Dark mode: loose. Fix: Sprint 3."

## Splitting what they said

They say several things in one breath. Turning that into threads is your job:
decide it yourself, every time, and never ask them how to split.

- **One thread is one thing that can ship, and be undone, by itself.** "The
  jump feels floaty and I can't see the coins at sunset" is two. "Add a pause
  button, with resume and quit on it" is one.
- **Every thread from one message carries the same note:** `--from <note-id>`
  on each, so each keeps their words.
- **Size every thread as you file it:** `xs` a line or a value · `s` one
  function or screen · `m` several files · `l` cuts across the project · `xl`
  a project in itself, always a plan. Never ask them how big something is.
- **Cannot tell which project they mean, or what they meant at all?** Ask one
  short question, and leave the note in the inbox until they answer.

## What is not recorded

A thread is an idea, a wish, feedback or a bug about the project. An
instruction to you about the work ("stop at midnight", "use subagents") is
done, not recorded. A go, a no, an answer or an approval is a command: the
`spool` skill has the table. A message that mixes them? Capture each idea on
its own, in their words, and act on the rest. Not sure whether it is an idea
or an instruction? Record nothing and act; an idea that matters will come back.

One message, then out: never keep recording what they say next.
A new thread is proposed, not started. You build nothing: they move it to Build.
