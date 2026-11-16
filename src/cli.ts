#!/usr/bin/env node
/**
 * spool — a feedback-driven work queue for coding agents.
 *
 * This file only parses arguments and routes; `run` is a pure function of its
 * arguments and context, so the whole CLI can be driven in-process by tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COMMANDS, type Command, type Options, type Result, type Values } from './commands.ts';
import { version } from './builtin.ts';
import type { Ctx } from './context.ts';
import { canUnwind, inColor, mark, unwind } from './mark.ts';
import { SpoolError } from './model.ts';
import { paint } from './render.ts';
import { record } from './journal.ts';
import { Workspace, findHome } from './store.ts';
import { openQueue } from './tui.ts';

const GLOBAL: Options = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  as: { type: 'string' },
  cwd: { type: 'string', short: 'C' },
};

const GROUPS: [Command['group'], string][] = [
  ['agents', 'Working the queue'],
  ['you', 'The human\'s verbs — run these only on their word'],
  ['see', 'Seeing'],
  ['setup', 'Set up'],
];

function help(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = [
    'spool — the engine under the Spool skills',
    '',
    'People use Spool by talking to their agent: /spool-init once, /spool to steer, /spool-loop to build, /spool-record to add.',
    'These are the verbs those skills run. If you are a person, you rarely need them.',
    '',
  ];
  for (const [group, title] of GROUPS) {
    lines.push(title);
    for (const c of COMMANDS.filter((c) => c.group === group)) lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
    lines.push('');
  }
  lines.push('spool alone, in a terminal, opens the queue full-screen (--run switches agents on); spool --plain prints the status.');
  lines.push('Every command takes --json, -C <dir> and --as <name>.   spool help <command> for details.');
  return lines.join('\n');
}

/** What was asked for, under the yarn mark when a person is at the terminal: for anyone else `head` is empty and nothing is added. */
function under(head: string, text: string): string {
  return head ? `${head}\n\n${text}` : text;
}

function commandHelp(c: Command): string {
  const lines = [`spool ${c.usage}`, '', `  ${c.summary}`];
  if (c.aliases?.length) lines.push(`  Also: ${c.aliases.map((a) => `spool ${a}`).join(', ')}`);
  return lines.join('\n');
}

function find(name: string): Command {
  const command = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  if (command) return command;
  const close = COMMANDS.filter((c) => c.name.startsWith(name.slice(0, 3))).map((c) => c.name);
  throw new SpoolError(`no command "${name}"`, close.length ? `Did you mean: ${close.join(', ')}?` : 'See: spool help');
}

/**
 * A command's words made safe for `parseArgs`, which reads any value that starts with a dash as a
 * mistake: `--edit "- first goal"`, `-m "-1 is now refused"`. Here an option that takes a value
 * takes the word after it, whatever it starts with, unless that word is itself one of the
 * command's options. A word that starts with a dash but is no option and has a space in it is
 * text (a title such as "--steps takes several steps"), not a flag. Options go first, spelled
 * `--name=value`, and the words after `--`, so nothing is read twice.
 *
 * `follows` says which words came straight after an option's value, by their place among the
 * words: `--steps "a" "b"` gives the steps "b".
 */
export function readable(argv: string[], options: Options): { args: string[]; follows: Record<string, number[]> } {
  const byShort = new Map(Object.entries(options).flatMap(([name, o]) => (o.short ? [[o.short, name] as const] : [])));
  const nameOf = (arg: string): string | undefined => {
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]!;
      return Object.hasOwn(options, name) ? name : undefined;
    }
    return /^-[^-]$/.test(arg) ? byShort.get(arg[1]!) : undefined;
  };
  const flags: string[] = [];
  const words: string[] = [];
  const follows: Record<string, number[]> = {};
  let after: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    const name = arg.length > 1 && arg.startsWith('-') ? nameOf(arg) : undefined;
    if (name === undefined) {
      if (arg.length > 1 && arg.startsWith('-') && !/\s/.test(arg)) {
        // No option of this command, and not text either: parseArgs says so.
        flags.push(arg);
        after = undefined;
        continue;
      }
      if (after) (follows[after] ??= []).push(words.length);
      words.push(arg);
      continue;
    }
    after = undefined;
    const next = argv[i + 1];
    if (options[name]!.type !== 'string' || arg.includes('=')) {
      flags.push(arg);
      continue;
    }
    if (next === undefined || next === '--') throw new Error(`Option '${arg}' needs a value`);
    // The one word that cannot be told apart: it is an option of this command. parseArgs says it is ambiguous.
    if (nameOf(next) !== undefined) {
      flags.push(arg);
      continue;
    }
    flags.push(`--${name}=${next}`);
    after = name;
    i++;
  }
  return { args: [...flags, '--', ...words], follows };
}

function dispatch(argv: string[], ctx: Ctx): { result: Result; json: boolean } {
  // Globals may come before the command name; after it, parseArgs handles them.
  let json = false;
  let wantHelp = false;
  let actor: string | undefined;
  let cwd: string | undefined;
  // The mark is for a person reading: asked for --json anywhere, none is drawn. `mark` itself draws none for a program.
  const art = !argv.includes('--json');
  const beside = paint(inColor(ctx));
  const versioned = (): string[] => [beside.bold(`v${version()}`)];
  // For `spool` with no command: the status and not the interface, and agents switched on.
  let plain = false;
  let agentsOn = false;
  let i = 0;
  for (; i < argv.length && argv[i]!.startsWith('-'); i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--plain') plain = true;
    else if (arg === '--run') agentsOn = true;
    else if (arg === '-h' || arg === '--help') wantHelp = true;
    else if (arg === '-V' || arg === '--version') {
      // With --unwind the thread is drawn writing the word, a frame at a time, and nothing more is printed here.
      if (art && argv[i + 1] === '--unwind' && canUnwind(ctx)) {
        void unwind(ctx, { lines: versioned() });
        return { result: { text: '' }, json };
      }
      return { result: { text: (art && mark(ctx, { lines: versioned() })) || version(), data: { version: version() } }, json };
    } else if (arg === '--as') actor = argv[++i];
    else if (arg === '-C' || arg === '--cwd') cwd = argv[++i];
    else throw new SpoolError(`unknown option ${arg}`, 'See: spool help');
  }
  let name = argv[i];
  let rest = argv.slice(i + 1);
  const greeted = (): string => under(art ? mark(ctx, { lines: versioned() }) : '', help());
  if (name === 'help') {
    if (!rest[0]) return { result: { text: greeted() }, json };
    return { result: { text: commandHelp(find(rest[0])) }, json };
  }
  const bare = !name;
  if (name && (plain || agentsOn)) throw new SpoolError(`unknown option ${plain ? '--plain' : '--run'}`, 'It goes with spool alone. See: spool help');
  if (!name) {
    const here = path.resolve(ctx.cwd, cwd ?? '.');
    if (wantHelp || !findHome(here)) return { result: { text: greeted() }, json };
    // A person at their own terminal gets the queue, full-screen. A pipe, an agent, --json and --plain get the status, as always.
    const opened = ctx.tty && !json && !plain ? openQueue({ ...ctx, cwd: here }, { run: agentsOn }) : undefined;
    if (opened) return { result: opened, json };
    name = 'status';
    rest = [];
  }

  const command = find(name);
  let values: Values;
  let positionals: string[];
  const options = { ...GLOBAL, ...command.options };
  try {
    const { args } = readable(rest, options);
    ({ values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true }) as { values: Values; positionals: string[] });
  } catch (error) {
    const message = (error as Error).message.split(/\.?\s*(?:Did you forget|To specify)/)[0]!;
    // What cannot be told from an option is still given as text, one of two ways: the help says which.
    const dash = /ambiguous|Unknown option/.test(message)
      ? `\n  Text that starts with a dash: join it to its option with = (--<option>="--like this"), or put it after -- (spool ${command.name} -- "--like this").`
      : '';
    throw new SpoolError(message, `usage: spool ${command.usage}${dash}`);
  }
  if (wantHelp || values.help) return { result: { text: commandHelp(command) }, json };
  json ||= !!values.json;
  actor = (typeof values.as === 'string' ? values.as : actor) ?? ctx.env.SPOOL_ACTOR ?? (command.human ? 'human' : 'agent');
  cwd = typeof values.cwd === 'string' ? values.cwd : cwd;

  const scoped: Ctx = { ...ctx, cwd: path.resolve(ctx.cwd, cwd ?? '.'), color: ctx.color && !json };
  const base = { ctx: scoped, args: positionals, opts: values, actor, p: paint(scoped.color) };
  if (command.bare) return { result: command.bare(base), json };

  // Anything slow a command has to do first is done here, before the store is locked for it.
  const before = command.before?.(base);
  try {
    const ws = Workspace.open(scoped.cwd, scoped.now, !!command.write);
    try {
      // Under a run (SPOOL_RUN), what the command writes is kept, so the whole run can be undone as one.
      if (command.write) record(ws, scoped.env, command.name);
      const result = command.run!({ ...base, ws, before });
      if (!bare || !art) return { result, json };
      // Typed with nothing after it, the status opens under the mark, with the version and the project beside it.
      const head = mark(scoped, { lines: [...versioned(), ws.home.name, beside.dim('spool help lists the commands')] });
      return { result: { ...result, text: under(head, result.text) }, json };
    } finally {
      ws.close();
    }
  } finally {
    // Whatever `before` took to do its work is let go of here, however the command ended.
    command.after?.(before);
  }
}

/** Run one command. Returns the exit code. */
export function run(argv: string[], ctx: Ctx): number {
  const json = argv.includes('--json');
  try {
    const { result, json: asJson } = dispatch(argv, ctx);
    // `spool mcp` returns with nothing to say: its output is the conversation that follows, and nothing else may be on stdout.
    if (!result.text && result.data === undefined) return result.code ?? 0;
    if (asJson) ctx.out(JSON.stringify(result.data ?? { text: result.text }, null, 2));
    else if (result.text) ctx.out(result.text);
    return result.code ?? 0;
  } catch (error) {
    if (!(error instanceof SpoolError)) throw error;
    if (json) ctx.out(JSON.stringify({ error: error.message, hint: error.hint ?? null }, null, 2));
    else ctx.err(`spool: ${error.message}${error.hint ? `\n  ${error.hint}` : ''}`);
    return error.code;
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    now: () => new Date(),
    stdin: () => fs.readFileSync(0, 'utf8'),
    // Nothing here waits: the process stays up while stdin is open, and ends by itself when it closes.
    lines: (each) => void readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', each),
    color: !!process.stdout.isTTY && !process.env.NO_COLOR,
    inherit: true,
    tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
    columns: process.stdout.columns,
  });
}
