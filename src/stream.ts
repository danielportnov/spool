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

/** Add the stream flags to a `claude -p` command that does not choose an output of its own. */
export function streaming(command: string): string {
  const program = path.basename(command.trim().split(/\s+/)[0] ?? '');
  if (program !== 'claude') return command;
  if (!/(^|\s)(-p|--print)(\s|$)/.test(command)) return command;
  if (/(^|\s)--output-format(\s|=)/.test(command)) return command;
  let out = `${command.trim()} --output-format stream-json`;
  if (!/(^|\s)--verbose(\s|$)/.test(command)) out += ' --verbose';
  return out;
}

/** What one line of the stream says. */
export interface Heard {
  /** The lines to show a person, if any. */
  lines: string[];
  /** The agent's session, so its transcript can be opened again. */
  session?: string;
  /** Tool calls the agent was not allowed to make, read from its last event. */
  denials?: string[];
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
  if (!raw.startsWith('{')) return { lines: [raw.slice(0, 400)] };
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
    return { lines, session, denials };
  }
  return { lines, session };
}

/**
 * The file the agent's stream is kept in, one per run of a thread: under the
 * spool's `runs/`, which keeps itself out of git, since a transcript holds
 * whatever the agent read.
 */
export function transcriptFile(spoolDir: string, id: string, began: Date): string {
  const dir = path.join(spoolDir, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(spoolDir, 'runs', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# What agents printed while they worked threads. Kept on this machine only.\n*\n');
  return path.join(dir, `${began.toISOString().replace(/[:.]/g, '-')}.jsonl`);
}
