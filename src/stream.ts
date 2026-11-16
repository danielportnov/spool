/**
 * What an agent is doing, read from the stream it prints.
 *
 * Plain `claude -p` prints only its last message, so nobody can see what it did
 * on the way, or that it was refused a tool. Claude is run with
 * `--output-format stream-json --verbose` instead: one JSON event a line, for
 * every message, tool call and tool result, and a last one that lists each
 * tool call it was denied. Spool keeps the stream as it came, with the thread,
 * and reads it into short lines a person can follow.
 *
 * Any other agent prints what it prints; a line that is not one of these
 * events is shown as it is.
 *
 * The stream goes both ways. With `--input-format stream-json` a session reads
 * a message a line from its input for as long as that is open, so what the
 * human writes on a thread can be said to the agent building it, and it can be
 * told to stop what it is doing. With `--permission-prompt-tool stdio` a tool
 * call that needs a yes is put to Spool as a line on that stream, and waits
 * for the answer. The lines Spool writes are made here too.
 * `docs/claude-stream.md` has what was tried against Claude Code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Whether a command is `claude -p`: the one agent whose flags Spool knows. */
function claudePrint(command: string): boolean {
  const program = path.basename(command.trim().split(/\s+/)[0] ?? '');
  return program === 'claude' && /(^|\s)(-p|--print)(\s|$)/.test(command);
}

/** Whether a command names one of these flags itself. */
const names = (command: string, ...flags: string[]): boolean => flags.some((flag) => new RegExp(`(^|\\s)${flag}(\\s|=|$)`).test(command));

/** Add the stream flags to a `claude -p` command that does not choose an output of its own. */
export function streaming(command: string): string {
  if (!claudePrint(command)) return command;
  if (/(^|\s)--output-format(\s|=)/.test(command)) return command;
  let out = `${command.trim()} --output-format stream-json`;
  if (!/(^|\s)--verbose(\s|$)/.test(command)) out += ' --verbose';
  return out;
}

const STREAM_OUT = /(^|\s)--output-format[ =]stream-json(\s|$)/;
const STREAM_IN = /(^|\s)--input-format[ =]stream-json(\s|$)/;

/**
 * Open the input of a `claude -p` command whose stream Spool reads, so that its session can be
 * spoken to while it works. Left as it is where the command chooses its own input, or takes its
 * prompt from the file: given the prompt as a message too, it would be told everything twice.
 */
export function listening(command: string): string {
  if (!claudePrint(command) || !STREAM_OUT.test(command) || names(command, '--input-format') || command.includes('{prompt_file}')) return command;
  return `${command.trim()} --input-format stream-json`;
}

/** Whether a command's session can be spoken to: it is `claude -p`, with the stream on both ways. */
export function listens(command: string): boolean {
  return claudePrint(command) && STREAM_OUT.test(command) && STREAM_IN.test(command);
}

/**
 * Have a session that can be spoken to put its permission questions to Spool: a tool call it is
 * not allowed arrives as a line on its stream and waits for an answer, where on its own it would
 * be refused in silence. Left alone where the command says who answers them itself.
 */
export function asking(command: string): string {
  if (!listens(command) || names(command, '--permission-prompt-tool', '--permission-prompts')) return command;
  return `${command.trim()} --permission-prompt-tool stdio`;
}

/** What the human says to a session, as the line written to its input. */
export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

/** Telling a session to stop what it is doing: its turn ends, and it waits for the next message. */
export function interruptLine(id: string): string {
  return JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
}

/** A tool call an agent needs a yes for: Claude's question, as it arrives on the stream. */
export interface Ask {
  /** The question's id: the answer names it. */
  id: string;
  tool: string;
  /** The call as a person would say it: "Bash: npm publish". */
  call: string;
  /** The call with nothing cut out of it: a long command whole, as it was written. */
  whole: string;
  /** What the agent said the call is for, where it said. */
  why: string;
  /** The tool's input, which a yes hands back as it came. */
  input: unknown;
  /** What Claude suggests allowing so that it need not ask the like again, where it suggests anything. */
  suggestions: Record<string, unknown>[];
}

/**
 * What of a question's suggestions a yes "for the rest of this run" grants: rules that allow a
 * tool, folders to work in, and file edits accepted without asking. Each is kept to the session,
 * whatever it says of itself, so nothing is written to a settings file; anything else Claude may
 * suggest (another mode, a rule that denies) is left out.
 */
function kept(ask: Ask): Record<string, unknown>[] {
  return ask.suggestions
    .filter((p) => (p.type === 'addRules' && p.behavior === 'allow') || p.type === 'addDirectories' || (p.type === 'setMode' && p.mode === 'acceptEdits'))
    .map((p) => ({ ...p, destination: 'session' }));
}

/** The same, in a line a person can read; empty where a yes can only be for the once. */
export function keeps(ask: Ask): string {
  const said = kept(ask).flatMap((p) => {
    if (p.type === 'setMode') return ['every file edit'];
    if (p.type === 'addDirectories') return (Array.isArray(p.directories) ? p.directories : []).map((dir) => `files in ${String(dir)}`);
    return (Array.isArray(p.rules) ? p.rules : []).map((rule: { toolName?: unknown; ruleContent?: unknown }) =>
      typeof rule?.ruleContent === 'string' ? `${String(rule.toolName)}: ${short(rule.ruleContent, 120)}` : `every ${String(rule?.toolName)}`,
    );
  });
  return [...new Set(said)].join(', ');
}

/** The answer to a question, as the line written to the session's input: yes, for this call or for the rest of the run. */
export function allowLine(ask: Ask, forRun = false): string {
  const grant = forRun ? kept(ask) : [];
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: ask.id, response: { behavior: 'allow', updatedInput: ask.input, ...(grant.length ? { updatedPermissions: grant } : {}) } },
  });
}

/** Or no, with the reason: the agent is given it as the tool's error. */
export function denyLine(ask: Ask, message: string): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: ask.id, response: { behavior: 'deny', message } } });
}

/**
 * A session id as Claude takes one: a UUID. One to pick up again is read from a thread's log,
 * which anyone can write to, so it is checked here before it goes near a shell.
 */
export const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Put a `claude -p` command in a session of Spool's choosing: a new one, by the id given, or one
 * it ran before, picked up where it was. Nothing comes back where Spool does not choose: another
 * agent, whose flags it does not know, or a command that says which session it wants itself.
 */
export function inSession(command: string, id: string, resume = false): string | undefined {
  if (!claudePrint(command) || !SESSION_ID.test(id)) return undefined;
  if (names(command, '--session-id', '--resume', '-r', '--continue', '-c', '--fork-session', '--no-session-persistence', '--from-pr', '--teleport')) return undefined;
  return `${command.trim()} ${resume ? '--resume' : '--session-id'} ${id}`;
}

/** The session a command was put in, and whether it picks one up: read back from the flags `inSession` adds. */
export function sessionOf(command: string): { id: string; resumed: boolean } | undefined {
  const found = /(?:^|\s)(--session-id|--resume)[ =](\S+)/.exec(command);
  return found && claudePrint(command) && SESSION_ID.test(found[2]!) ? { id: found[2]!, resumed: found[1] === '--resume' } : undefined;
}

/** How Claude says there is no session by the id it was told to pick up. */
const NO_SESSION = /No conversation found with session ID/i;

/** What one line of the stream says. */
export interface Heard {
  /** The lines to show a person, if any. */
  lines: string[];
  /** The agent's session, so its transcript can be opened again. */
  session?: string;
  /** Tool calls the agent was not allowed to make, read from its last event. */
  denials?: string[];
  /** The session it was told to pick up is not there: nothing was carried on. */
  lost?: true;
  /** Its turn has ended: a session whose input is open now waits for the next message. */
  over?: true;
  /** It needs a yes for a tool call, and waits for the answer. */
  asks?: Ask;
}

const short = (s: string, n = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Of what a tool was given, the one thing that says the most, where it was given one of these. */
function telling(input: unknown): string | undefined {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'].find((k) => typeof i[k] === 'string');
  return key ? String(i[key]) : undefined;
}

/** A tool call, as a person would say it: the tool, and the one thing it was given that says the most. */
export function toolCall(name: string, input: unknown): string {
  const said = telling(input);
  return said === undefined ? name : `${name}: ${short(said, 160)}`;
}

/** How much of a call is kept to show in full: enough for any command a person would read through. */
const WHOLE = 4000;

/**
 * The same call with nothing cut out of it, as it was written: what a person reads before saying
 * yes to it. A tool given none of the usual things is shown with everything it was given.
 */
function wholeCall(name: string, input: unknown): string {
  const said = telling(input) ?? (input && typeof input === 'object' && Object.keys(input).length ? JSON.stringify(input) : undefined);
  return said === undefined ? name : `${name}: ${said.trim().slice(0, WHOLE)}`;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join(' ');
  }
  return '';
}

/** Read one line the agent printed. A line that is not a stream event comes back as itself. */
export function hearLine(line: string): Heard {
  const raw = line.trim();
  if (!raw) return { lines: [] };
  if (!raw.startsWith('{')) return { lines: [raw.slice(0, 400)], ...(NO_SESSION.test(raw) ? { lost: true as const } : {}) };
  let e: Record<string, any>;
  try {
    e = JSON.parse(raw);
  } catch {
    return { lines: [raw.slice(0, 400)] };
  }
  if (!e || typeof e !== 'object' || typeof e.type !== 'string') return { lines: [raw.slice(0, 400)] };
  const session = typeof e.session_id === 'string' && /^[\w-]{1,100}$/.test(e.session_id) ? e.session_id : undefined;
  const lines: string[] = [];
  if (e.type === 'system' && e.subtype === 'init') {
    lines.push(`session ${session ?? '?'}${typeof e.model === 'string' ? ` · ${e.model}` : ''}`);
  } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) lines.push(short(c.text, 400));
      else if (c?.type === 'tool_use' && typeof c.name === 'string') lines.push(`→ ${toolCall(c.name, c.input)}`);
    }
  } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c?.type === 'tool_result' && c.is_error) lines.push(`✗ ${short(textOf(c.content)) || 'the tool failed'}`);
    }
  } else if (e.type === 'spool') {
    // What Spool itself said to the session. It is kept in the transcript between the agent's own lines, so that a
    // run reads back as it was shown: the human's words, their answer to a question, and being told to stop.
    if (e.event === 'said' && typeof e.text === 'string') lines.push(`you: ${short(e.text, 300)}`);
    else if (e.event === 'interrupt') lines.push('told to stop what it is doing');
    else if (e.event === 'answered' && typeof e.call === 'string') lines.push(`${e.answer === 'no' ? 'refused' : 'allowed'} → ${e.call}`);
  } else if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool' && typeof e.request_id === 'string' && typeof e.request.tool_name === 'string') {
    const r = e.request;
    const call = toolCall(r.tool_name, r.input);
    const told = typeof r.input?.description === 'string' ? r.input.description : typeof r.description === 'string' ? r.description : '';
    const asks: Ask = {
      id: e.request_id,
      tool: r.tool_name,
      call,
      whole: wholeCall(r.tool_name, r.input),
      // What it is for, unless that is only the file's name over again.
      why: told && !call.includes(told) ? short(told) : '',
      input: r.input ?? {},
      suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions.filter((p: unknown) => p && typeof p === 'object') : [],
    };
    return { lines: [`asks → ${call}`], session, asks };
  } else if (e.type === 'result') {
    const denials = Array.isArray(e.permission_denials)
      ? e.permission_denials
          .filter((d: any) => d && typeof d.tool_name === 'string')
          .map((d: any) => toolCall(d.tool_name, d.tool_input))
      : [];
    for (const d of denials) lines.push(`denied → ${d}`);
    const how = e.is_error || (typeof e.subtype === 'string' && e.subtype !== 'success') ? `ended: ${e.subtype ?? 'error'}` : 'finished';
    const turns = typeof e.num_turns === 'number' ? ` · ${e.num_turns} turns` : '';
    lines.push(`${how}${turns}${typeof e.result === 'string' && e.result.trim() ? ` — ${short(e.result)}` : ''}`);
    const lost = Array.isArray(e.errors) && e.errors.some((x: unknown) => NO_SESSION.test(String(x)));
    return { lines, session, denials, over: true, ...(lost ? { lost: true as const } : {}) };
  }
  return { lines, session };
}

/**
 * A thread's folder under the spool's `runs/`, made if it is not there. `runs/` keeps itself out
 * of git: a transcript holds whatever the agent read, and the journal of a run (journal.ts) is this
 * machine's own record.
 */
export function runDir(spoolDir: string, id: string): string {
  const dir = path.join(spoolDir, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(spoolDir, 'runs', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# What agents printed while they worked threads. Kept on this machine only.\n*\n');
  return dir;
}

/** The file the agent's stream is kept in, one per run of a thread. */
export function transcriptFile(spoolDir: string, id: string, began: Date): string {
  return path.join(runDir(spoolDir, id), `${began.toISOString().replace(/[:.]/g, '-')}.jsonl`);
}
