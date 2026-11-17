---
name: spool-init
description: Set Spool up in this folder or repository so agents can work it on their own - create the work queue, describe the project, agree what agents may decide without asking, pick who builds, and take the first piece of work. Use for /spool-init [folder], or when the user says "set up spool here", "start a spool", "add this project to spool", "set up spool for <a folder>", or runs another Spool skill where no .spool/ exists.
---

# Spool init

Get this project from nothing to agents working it, in one short conversation.
`spool` is your tool; the human should not have to type anything but answers.

Only trying Spool, not setting this project up? Offer `spool demo --open`: a
throwaway project with threads in its spool, and its board in their browser.
None of their own code is touched.

1. **Check the engine.** `spool --version`. Not found? It is a one-time install
   on this machine. Ask before running it, since it installs a global package:

       npm install -g spool-ai
       spool install

2. **Settle which folder.** With no folder named, it is the one this chat is in.
   With one named (`/spool-init sky hop`), it is a folder inside this one:
   find it, matching the name loosely, since "sky hop" means
   `games/sky_hop`. Several match? Ask which. None does? Say so; never
   create a folder.

3. **Stop if it is already set up.** If that folder has a `.spool/` of its
   own, tell them Spool is already set up for that folder, show them
   `spool overview --table` for it, and stop here. Do not set it up again.
   A `.spool/` in a folder above it is different, and fine: this project gets
   its own queue and also appears in the parent's as a project.

4. **Set it up.** Work out the project's name and one line on what it is from
   that folder's README or code. Do not ask for them. That line is how feedback
   gets routed to the right project.

       spool init [<folder>] --name "<name>" --about "<what this project is, in one line>" --gate

   `--gate` turns the build gate on: every new thread starts as proposed, and
   nothing is built until they move it to build. Tell them so in a line.

   Offer the lock once, in a line: with `spool init --lock`, moving work to
   build takes them in person, on the Spool page or at their own terminal, and
   an agent that tries is refused. Without it, an agent passes their word on
   when they say "build that" in a chat. Their choice; do not pick for them.

   `spool init` takes the folder as a path or by name, and is safe to get
   wrong: where a spool exists it changes nothing and says "already set up".
   If you see that, step 3 applies.

   The queue is private by default: git ignores everything under `.spool/`,
   because it is working state for agents and holds the human's words exactly
   as they said them. Tell them so in a line. Only if they ask to share the
   queue with a team, or to keep its history in git: `spool init --refresh --share`.

   A folder holding several projects? Set up the folder, then offer to set up
   each project inside it that has its own repository or README. Ask before
   setting up more than the one they named.

5. **Agree the rope.** Read `.spool/policy.md` and tell them, in two or three
   sentences, what agents will decide on their own and what they will stop and
   ask about. Ask if they want it looser or tighter, and edit the file to match
   their words. It is theirs: this is the one file under `.spool/` you edit by hand.

6. **Agree the goals.** Ask in one question what this project is for and the
   two or three things it is heading towards. Write their answer in plain
   words, a `For:` line and a line for each, with `spool goals --edit -`.
   Every agent reads it first. No answer yet? Leave the starter
   `.spool/goals.md` for another day.

7. **Ask who builds,** in one line. **Headless**: the board builds what is in
   Build by itself, with no chat open. **Chat**: a chat builds it, where they
   can watch and step in. Run `spool builder headless` or `spool builder chat`
   for their pick. Their choice; it stays Headless until they make one.
   Refused, because they chose the lock? They pick it on the board.

8. **Offer a check.** Find the command that proves a change is sound here:
   the project's tests, a build, a lint (`npm test`, `cargo test`, `pytest`).
   Tell them which you found and offer it in a line: with it set, no thread can
   be marked done unless it passes. On their yes: `spool checks "<command>"`.
   It is kept on their machine, not in the project. None to be found? Skip this.

9. **Take the first work.** If they have already given an idea, a wish or a
   bug for this project in this chat, capture and file it now by the
   `spool-record` rules; what they asked of you about the setup is not one.
   Otherwise ask what is on their mind for this project.

10. **Check it.** `spool doctor` says what a run still needs, with the line
    that fixes each: a git repository with a commit, an agent command that
    may edit files (Headless builds with it), a notifier, the skills. Fix
    what is yours to fix, and tell them the rest, a line each.

End with what happens next, in one line each:

- `/spool` to steer it from any chat: "open the board", "build that one",
  "catch me up", "why is nothing building"
- `/spool-loop` to make a chat the builder, if they picked Chat. With
  Headless, they switch **Agents** on at the top of the board instead
- `/spool-record` in front of anything they type or say, in any chat, to
  have that message filed as threads
