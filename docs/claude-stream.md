# Claude Code's two-way stream

What Spool knows about talking to a `claude -p` session while it runs, and how it was found out.

Tried on Claude Code **2.1.325** (macOS, 15 November 2026): a dozen short runs on `haiku`, each a
one-line task. What was written to Claude and what it printed is kept, line for line, in
`test/fixtures/claude-stream/`, and the stand-in agent in the tests speaks those lines
(`test/claude.ts`). Paths, the lists of installed tools and plugins, usage figures and thinking
signatures were taken out of the recordings; nothing else was changed.

`--permission-prompt-tool` and the control messages are not in `claude --help`. They are what the
Agent SDK speaks to the same program, so they may change without notice. Everything Spool knows of
them is in `src/stream.ts` and `src/session.ts`.

## The flags

```
claude -p --output-format stream-json --verbose   one JSON event a line on stdout
          --input-format stream-json              one JSON message a line on stdin
          --permission-prompt-tool stdio          permission questions on stdout, answers on stdin
          --session-id <uuid>                     a new session, by an id you choose
          --resume <uuid>                         or: pick up one that has ended
```

No `initialize` message is needed first.

## The messages

Written to stdin:

```
{"type":"user","message":{"role":"user","content":"keep gravity at 34"}}
{"type":"control_request","request_id":"s1","request":{"subtype":"interrupt"}}
{"type":"control_response","response":{"subtype":"success","request_id":"<its id>",
  "response":{"behavior":"allow","updatedInput":{…the input it sent…},"updatedPermissions":[…]}}}
{"type":"control_response","response":{"subtype":"success","request_id":"<its id>",
  "response":{"behavior":"deny","message":"The human said no: not from an agent."}}}
```

Printed on stdout, among the events Spool already read (`system/init`, `assistant`, `user` with a
tool's result, `result`):

```
{"type":"control_request","request_id":"73fb…","request":{"subtype":"can_use_tool",
  "tool_name":"Bash","input":{"command":"touch k1.txt","description":"Create file k1.txt"},
  "description":"Create file k1.txt","permission_suggestions":[…],"tool_use_id":"toolu_…"}}
{"type":"control_response","response":{"subtype":"success","request_id":"s1","response":{"still_queued":[]}}}
```

Also printed, and of no use to Spool yet: `system` events with the subtypes `post_turn_summary`,
`task_summary`, `task_started`, `task_notification`, `thinking_tokens` and `status`, and
`rate_limit_event`.

## What was found

| Question | What happened | Recording |
| --- | --- | --- |
| Does the session stay up between turns while stdin is open? | Yes. A turn ends with a `result` event and the process waits (one sat idle for two and a half minutes). The next message starts the next turn, which opens with `system/init` again. Closing stdin ends it, exit 0. | `two-turns` |
| Is a message sent in the middle of a turn read? | Yes, at the agent's next step. Sent while a tool ran, it was taken in straight after the tool's result, and the reply did what it said. With `--replay-user-messages` it is printed back when it is read. | `mid-turn-and-interrupt` |
| Does an interrupt work? | Yes. It is answered at once, a running tool is ended, and the turn ends with a `result` whose subtype is `error_during_execution`. The session stays up and takes the next message. With stdin closed after it, the process is gone within a second, exit 1. | `mid-turn-and-interrupt`, `interrupt-running-tool` |
| Do permission questions arrive? | Yes, as `control_request` / `can_use_tool`, with the tool, its input, a description, and what Claude would suggest allowing. The session waits for the answer (held 8 seconds here). | `permission`, `permission-refused` |
| Does an answer reach it? | Yes. `allow` (with the input handed back as `updatedInput`) runs the tool. `deny` gives the agent the `message` as the tool's error. A refused call is also listed in that turn's `result`, under `permission_denials`. | `permission` |
| Can an answer hold for the rest of the run? | Yes: `updatedPermissions` on an allow. Handing back the request's own `permission_suggestions` with `destination` set to `session` kept it to that session, and wrote no settings file. For a Bash command that made a file, the suggestions included switching the session to accept all edits, which is more than the one command. | `allow-for-the-run` |
| Does `--resume <id>` continue a session that has ended, in the same folder? | Yes, under the same id, knowing what was said. One that was interrupted knows that too. | `resume`, `resume-after-interrupt` |
| And from another folder? | Also yes, even from outside the repository: the session is found by its id and carries on with the new folder as its own. The plan expected a refusal ("This conversation is from a different directory" is in the program); with `-p --resume <id>` there was none. | `resume-other-folder` |
| Resuming an id Claude does not have? | `No conversation found with session ID: <id>` on stderr, a `result` that is an error and names it under `errors`, exit 1. | `resume-unknown-id` |
| `--session-id` with an id already used? | `Error: Session ID <id> is already in use.`, exit 1, before anything is read. | `session-id-in-use` |
| What if stdin closes in the middle of a turn? | The turn is finished first, then exit 0. So an agent whose Spool died works on to the end of its turn. | `input-closed-mid-turn` |

## What was not tried

- Two programs on one session at the same time.
- A permission question left unanswered for minutes, or still open when stdin closes.
- Permission questions from a sub-agent's tool calls.
- Linux and Windows, and any version but 2.1.325.
- Claude's own background sessions (`claude --bg`, `claude attach`).

## What Spool does with it

- **A session of its own choosing.** A `claude -p` agent command that names no session is started
  with `--session-id <a new uuid>`, and the id is on the thread's log from the hand-off on.
- **Carry on.** A thread whose run ended unfinished (you stopped it, the agent gave up, or the page
  was stopped) is started the next time with `--resume <that id>`, in the same folder, and told only
  what changed since. If Claude has no such session, the thread is started afresh at once, in a new
  one, and its log says so.

Any other agent command is run exactly as before: Spool does not know its flags.
