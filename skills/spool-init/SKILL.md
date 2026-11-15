---
name: spool-init
description: Set Spool up in this folder or repository so agents can work it on their own - create the work queue, describe the project, agree what agents may decide without asking, and take the first piece of work. Use for /spool-init, or when the user says "set up spool here", "start a spool", "add this project to spool", or runs another Spool skill where no .spool/ exists.
---

# Spool init

Get this project from nothing to agents working it, in one short conversation.
`spool` is your tool; the human should not have to type anything but answers.

1. **Check the engine.** `spool --version`. Not found? It is a one-time install
   on this machine. Ask before running it, since it installs a global package:

       npm install -g github:danielportnov/spool
       spool install

2. **Check what is here.** `spool status`.
   - It shows a queue for this folder: Spool is already set up. Show
     `/spool-overview` instead, and stop.
   - It shows a parent folder's queue: fine. This project gets its own queue
     and appears in the parent's as a project.

3. **Set it up.** Work out the project's name and one line on what it is from
   the README or the code. Do not ask for them. That line is how feedback gets
   routed to the right project.

       spool init --name "<name>" --about "<what this project is, in one line>"

   A folder holding several projects? Run it in the folder, then offer to run
   it in each project that has its own repository or README. Ask before setting
   up more than this one.

4. **Agree the rope.** Read `.spool/policy.md` and tell them, in two or three
   sentences, what agents will decide on their own and what they will stop and
   ask about. Ask if they want it looser or tighter, and edit the file to match
   their words. It is theirs: this is the one file under `.spool/` you edit by hand.

5. **Offer a ping.** Agents stop for the human's calls, so it helps if the
   human hears about them. Offer once to set a notifier: a shell command under
   `notify` in `~/.config/spool/config.json`, run whenever an agent asks them
   something. Skip it if they are not interested.

6. **Take the first work.** If they have already said what they want in this
   chat, capture and file it now by the `spool-recorder` rules. Otherwise ask
   what is on their mind for this project.

End with what happens next, in one line each:

- `/spool-recorder` to talk, and have everything they say filed
- `/spool-loop 2` to set agents working now and every two hours
- `/spool-blockers` when agents need them
