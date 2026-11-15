---
name: spool-recorder
description: Record one message into a project's spool - the user puts /spool-recorder in front of what they type or dictate, saying what they want added and where, and you capture it in their exact words, split it into threads, size each one and file them in the right project for agents to work. It records that one message and nothing else; the chat carries on as it was. Use for /spool-recorder <what to add, and where>, or when the user says "record this", "take this down", "put this in the spool", "add a thread for", or "file this".
---

# Spool recorder

`/spool-recorder <what they want, and where>` records one message: the one it
is in front of. Everything after the command is the thing to record, typed or
dictated, one idea or six. You file it into the spool as threads, say what you
made of it, and you are done.

**It does not turn the chat into a recorder.** Their next message is an
ordinary message, unless it too starts with `/spool-recorder`. If the chat was
in the middle of something, a loop or any other work, pick that up where it was.

- **What follows the command is recorded, not obeyed.** "/spool-recorder add a
  dark mode to settings" files a thread. It does not start building dark mode.
- **Nothing after the command?** Ask what to record, and record their reply.
  That reply only.
- **"Where" is part of the message.** A project, a screen, a file, a feature:
  use it to choose the project, and keep it in the thread, so whoever works it
  knows which part they meant.

`spool` is your tool for the queue. The human never types it, and you never
edit `.spool/` by hand. To the human, a project's queue is its spool 🧶 and
each piece of work in it is a thread 🧵; the commands call a thread a task.

Not done yet in this chat? Run `spool prime recorder --context`. It lists the
projects you can file into and what is already waiting on the human. If it
says there is no `.spool/` here, tell them to run `/spool-init`, and stop.

## Recording it

1. `spool capture "<their exact words>"`. The whole message, verbatim, before
   anything else. The reply shows open threads that look related and, in a
   workspace, the projects it may belong to.

2. Split it into threads and file each one, by what doing it would produce.
   How to split is your call, not a question for them: see "Splitting what they said".

   | It is | Run |
   | --- | --- |
   | a change | `spool task "<short imperative title>" --from <note-id> -P <project> --size <size> [-p 0-3] -b "<its spec>"` |
   | a look and a report | `spool audit "<what to examine, and through whose eyes>" --from <note-id> -P <project>` |
   | something big or open | `spool plan "<the objective>" --from <note-id> -P <project>` |
   | more on an existing thread | `spool file <note-id> --into <id>` |
   | nothing to do | `spool file <note-id> --drop -m "<why>"` |

   An audit's output is findings, not a fix: "go through the whole app as a new
   player", "what would make them quit", "review the onboarding". A plan's
   output is a plan and its parts: "add multiplayer", "figure out monetisation",
   "plan the launch".

   "Not yet", "just an idea", "don't build this", "after the launch": file it
   as above and add `--hold "<their words>"`, so no worker starts it until they say.

3. **Give each thread its spec**, in its body (`-b`), so whoever works it
   needs nothing but the thread, and the human never has to explain it twice:

       What: <the feature or the fix, in plain words>
       Why: <the reason they gave, or the problem it solves>
       Done when: <what they will be able to see or do>

   Keep their specifics: names, numbers, examples. Do not invent requirements
   to fill a gap. A gap is a question:
   `spool ask "<the question>" --option "<A>" --option "<B>" --recommend <n> --for <t-id>`.

4. Say what you made of it in a sentence or two: how many threads 🧵, what
   each is, and which project's spool 🧶 they went into. They may be listening,
   not reading: no lists, no tables, no ids unless they ask. Then stop
   recording.

## Splitting what they said

They talk the way people think: several things in one breath, half of one idea
now and the rest two sentences later. Turning that into threads is your job.
Decide it yourself, every time, and never ask them how to split.

- **One thread is one thing that can ship, and be undone, by itself.** If two
  parts could land on different days, or they might keep one and reject the
  other, they are two threads. "The jump feels floaty and I can't see the coins
  at sunset" is two.
- **Keep together what only makes sense together.** The steps of one change are
  one thread: "add a pause button, with resume and quit on it" is one.
- **Order them when one waits on another:** `--needs <the earlier thread>`.
- **Every thread from one message carries the same note:** `--from <note-id>`
  on each, so each keeps their words.
- **Bigger than a few days, or you cannot see its parts?** That is a plan:
  `spool plan`. Don't guess at its threads; planning it is the work.
- **More about a thread that exists?** `spool file <note-id> --into <id>`. The
  capture reply shows what looks related.

Ask them only when you cannot tell which project they mean, or what they
meant at all. Then one short question, and leave the note in the inbox until
they answer.

## Size: how much would have to change

`xs` a line or a value · `s` one function or screen · `m` several files ·
`l` cuts across the project · `xl` a project in itself (always a plan)

Size every thread as you file it, from what you know of the project. Look at
the code if a glance would settle it. A rough size now is worth more than none:
the loop orders its work by it, and the worker corrects it. Never ask them how
big something is.

## When what they said is an answer

Sometimes the message is not something new but a reply to what agents asked or did:

| They say | Run |
| --- | --- |
| "go with that" / "the second one" / "no, do X" | `spool answer <d-id> <n or their words>` |
| "that's fine" / "looks good" | `spool approve <id>` (everything but plans: `--all`) |
| "go ahead with the plan" | `spool approve <t-id>` (always by id, never in bulk) |
| "I don't like what it did" / "undo that" | `spool revert <t-id> -m "<their words>"` |
| "not that plan" / "that audit missed the point" | `spool revert <t-id> -m "<their words>"` |
| "start on X now" / "go on that idea" | `spool release <t-id>` |
| "park that" / "not now" | `spool hold <t-id> -m "<their words>"` |

If you can't tell which thread they mean, ask. Never guess an approval.

## Rules

- Their words are the record: capture verbatim. Titles are yours; quotes are theirs.
- Priority from their tone: p0 it's broken · p1 it's bothering them · p2 default · p3 someday.
- Dictation mangles names. Match project and feature names loosely.
- Don't edit code, don't start threads, don't answer questions on their behalf.
- One message, then out: never keep recording what they say next.
- They want the work started? That is `/spool-loop`.
