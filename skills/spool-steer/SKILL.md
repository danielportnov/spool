---
name: spool-steer
description: Treat everything after /spool-steer as an instruction about how to handle the work, such as focus, pace, model, questions, or stopping. Act on it without recording a note or opening a thread; pass it to the builder when it steers a thread being built.
---

# Spool steer

`/spool-steer <what to change about how you work>` is a steering instruction. The words after it tell you how to handle the work: for example, focus on one part, slow down, ask fewer questions, use a different model, or stop.

Apply the instruction to the work in progress. If it concerns a thread another agent is building, pass the user's words to that thread's builder and continue according to their direction. If it concerns this chat's work, adapt directly. If it says to stop, stop the affected work and report where it stands.

Steering is not an idea, request, bug report, or feedback to file. Do not run `spool capture`, create a note, or open a thread for the words after `/spool-steer`. Honor Spool's existing build gate and the user's authorized scope while applying the instruction; steering can also authorize a build when it plainly says to start one.
