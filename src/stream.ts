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
}

const short = (s: string, n = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A tool call, as a person would say it: the tool, and the one thing it was given that says the most. */
export function toolCall(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'].find((k) => typeof i[k] === 'string');
  return key ? `${name}: ${short(String(i[key]), 160)}` : name;
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
    return { lines, session, denials, ...(lost ? { lost: true as const } : {}) };
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
