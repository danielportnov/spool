/**
 * The verbs as MCP tools, for agents with no shell: a chat app on a phone.
 *
 * `spool mcp` is a Model Context Protocol server over stdio. Each tool is one
 * command from the table in `commands.ts`, run in-process through the same
 * door the shell uses, and it answers with the JSON that command prints under
 * `--json`. There is no second list of verbs here, and no second set of rules.
 *
 * The set-up verbs are left out: `loop` starts agents, `install` and `init`
 * write wherever they are pointed, and this server is not a tool of itself.
 * What is offered keeps the line drawn in `context.ts`. A call cannot name a
 * working directory, cannot pass a flag the tool does not list, and where the
 * command line would read a file it gives the text instead, so nothing a
 * caller sends reaches outside the tree the server was started in.
 *
 * The protocol is written out by hand, like everything else here:
 * newline-delimited JSON-RPC 2.0. It speaks both eras of MCP. From 2026-07-28
 * there is no handshake: every request names its protocol version in `_meta`
 * and stands alone. Before that a client opened with `initialize`, and the
 * ones that still do are answered the way they expect.
 */

import { version } from './builtin.ts';
import { run } from './cli.ts';
import { type Bare, COMMANDS, type Command, type Result } from './commands.ts';
import type { Ctx } from './context.ts';
import { SpoolError } from './model.ts';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// -------------------------------------------------------------------- tools

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Json>; additionalProperties: false };
  annotations?: { readOnlyHint: true };
}

/** A client may show tools from many servers in one list, where a bare `list` or `edit` says nothing. */
const PREFIX = 'spool_';

function offered(): Command[] {
  return COMMANDS.filter((c) => c.group !== 'setup');
}

/** The positional part of a usage line: everything before its first flag. */
function positionals(c: Command): string {
  const rest = c.usage.slice(c.name.length).trim();
  const flag = rest.search(/(^|\s)\[?--?[a-z]/i);
  return (flag < 0 ? rest : rest.slice(0, flag)).replace(/\s*\|$/, '').trim();
}

/** How the usage line spells an option, with what it takes: `-s xs|s|m|l|xl`. */
function spelled(c: Command, name: string, short?: string): string | undefined {
  const flags = short ? `--${name}|-${short}` : `--${name}`;
  return new RegExp(`(?<![\\w-])(?:${flags})\\s+(?:<[^>]*>|[^\\s\\[\\]]+)…?`).exec(c.usage)?.[0];
}

function describe(c: Command): string {
  const lines = [`${c.group === 'you' ? 'For the user: ' : ''}${c.summary}.`];
  if (c.human) lines.push('This acts for the user. Call it only when the user says so, never on your own judgment.');
  lines.push(`The command: spool ${c.usage}`);
  return lines.join('\n');
}

/** One command as a tool: `args` for its positionals, and a property for each of its options. */
export function toolFor(c: Command): Tool {
  const properties: Record<string, Json> = {};
  const where = positionals(c);
  if (where) properties.args = { type: 'array', items: { type: 'string' }, description: `In order: ${where}` };
  for (const [name, option] of Object.entries(c.options ?? {})) {
    const hint = name === c.reads ? `The ${name} itself, as text: there is no file to name here.` : spelled(c, name, option.short);
    const type =
      option.type === 'boolean' ? { type: 'boolean' } : option.multiple ? { type: 'array', items: { type: 'string' } } : { type: 'string' };
    properties[name] = option.type !== 'boolean' && hint ? { ...type, description: hint } : type;
  }
  // Only what changes the queue is signed, so only that asks who is signing.
  if (c.write) properties.as = { type: 'string', description: `Who is acting, if not "${c.human ? 'human' : 'agent'}"` };
  return {
    name: PREFIX + c.name,
    description: describe(c),
    inputSchema: { type: 'object', properties, additionalProperties: false },
    ...(c.write ? {} : { annotations: { readOnlyHint: true } }),
  };
}

export function tools(): Tool[] {
  return offered().map(toolFor);
}

// -------------------------------------------------------------------- calls

function text(key: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new SpoolError(`"${key}" must be a string`);
}

function texts(key: string, value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => text(key, v)) : [text(key, value)];
}

/**
 * A tool call as the command line it stands for. Options are spelled
 * `--name=value` and the positionals follow `--`, so nothing a caller sends
 * can be read as a flag the tool does not list: there is no way to say `-C`.
 */
function argvFor(c: Command, tool: Tool, input: Json): { argv: string[]; stdin: string } {
  const flags: string[] = [];
  let args: string[] = [];
  let stdin = '';
  for (const [key, value] of Object.entries(input)) {
    const option = c.options?.[key];
    // A model fills in what it has nothing to say about with null or "": both mean the option was not given.
    if (value === null || value === undefined || value === '') continue;
    if (!Object.hasOwn(tool.inputSchema.properties, key)) {
      throw new SpoolError(`${tool.name} takes no "${key}"`, `It takes: ${Object.keys(tool.inputSchema.properties).join(', ')}`);
    }
    if (key === 'args') args = texts(key, value);
    else if (key === 'as') flags.push(`--as=${text(key, value)}`);
    else if (option!.type === 'boolean') {
      if (typeof value !== 'boolean') throw new SpoolError(`"${key}" must be true or false`);
      if (value) flags.push(`--${key}`);
    } else if (key === c.reads) {
      stdin = text(key, value);
      flags.push(`--${key}=-`);
    } else {
      for (const v of option!.multiple ? texts(key, value) : [text(key, value)]) flags.push(`--${key}=${v}`);
    }
  }
  return { argv: [c.name, '--json', ...flags, '--', ...args], stdin };
}

/** Run one command and hand back what it printed. A command that fails is still an answer: its error and hint, marked as one. */
function callTool(c: Command, tool: Tool, input: Json, ctx: Ctx): Json {
  const out: string[] = [];
  let code: number;
  try {
    const { argv, stdin } = argvFor(c, tool, input);
    code = run(argv, { ...ctx, out: (line) => out.push(line), stdin: () => stdin, lines: () => {}, color: false, inherit: false });
  } catch (error) {
    if (!(error instanceof SpoolError)) throw error;
    // A badly shaped argument is the caller's to fix, so it reads like any other mistake the commands point out.
    out.push(JSON.stringify({ error: error.message, hint: error.hint ?? null }));
    code = error.code;
  }
  // The same JSON, without the indentation a terminal wants and a model pays for.
  return { content: [{ type: 'text', text: JSON.stringify(JSON.parse(out.join('\n'))) }], isError: code !== 0 };
}

// ----------------------------------------------------------------- protocol

/** Revisions where every request carries its own version, newest first. */
const MODERN = ['2026-07-28'];
/** Revisions that open with `initialize`, newest first. */
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];

const META = 'io.modelcontextprotocol/';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

/** The tool list changes only when Spool is upgraded, so a client may keep it for an hour. */
const CACHE = { ttlMs: 3_600_000, cacheScope: 'public' };

const INSTRUCTIONS = [
  "Spool is this project's work queue. Each tool is one `spool` command and answers with the JSON that command prints: `spool next --claim` is spool_next with {\"claim\": true}.",
  'Positional arguments go in `args`, in order. Each option is a property of the same name.',
  'An error says what to do instead, written as a command: read `spool answer d-x7k2 1` as spool_answer with {"args": ["d-x7k2", "1"]}.',
  'Start with spool_prime. It returns the rules for working the queue, or with {"args": ["recorder"]} the rules for filing what the user says.',
  'The tools that say they act for the user are theirs. Call one only when the user says so.',
].join('\n');

class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function failure(id: string | number | null, code: number, message: string, data?: unknown): Json {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * The server: give it a line from the client, get back the line to answer
 * with, or nothing when the message was a notification. Commands run in `ctx`,
 * so every call works in the directory the server was started in.
 */
export function server(ctx: Ctx): (line: string) => string | undefined {
  const info = { name: 'spool', title: 'Spool', version: version() };
  const capabilities = { tools: {} };
  const listed = tools();
  const byName = new Map(offered().map((c, i) => [listed[i]!.name, { command: c, tool: listed[i]! }]));
  /** A client from before 2026-07-28 has opened with `initialize`: its later requests carry no version. */
  let handshaken = false;

  function list(params: Json): Json {
    if (params.cursor !== undefined) throw new RpcError(INVALID_PARAMS, 'Invalid cursor: the tool list is a single page');
    return { tools: listed };
  }

  function call(params: Json): Json {
    const { name, arguments: input = {} } = params;
    if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs the name of a tool');
    const found = byName.get(name);
    if (!found) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    if (!isObject(input)) throw new RpcError(INVALID_PARAMS, 'tools/call arguments must be an object');
    return callTool(found.command, found.tool, input, ctx);
  }

  function initialize(params: Json): Json {
    const asked = params.protocolVersion;
    if (typeof asked !== 'string') throw new RpcError(INVALID_PARAMS, 'initialize needs a protocolVersion');
    handshaken = true;
    // The client's revision if it is one of these; otherwise the newest of them, for the client to take or leave.
    return { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities, serverInfo: info, instructions: INSTRUCTIONS };
  }

  /** A request with no version of its own: it belongs to a session that `initialize` opened. */
  function inSession(method: string, params: Json): Json {
    if (method === 'ping') return {};
    if (!handshaken) {
      throw new RpcError(
        INVALID_PARAMS,
        `Invalid params: a request names its protocol version in _meta["${META}protocolVersion"], or the connection opens with initialize`,
        { supported: SUPPORTED },
      );
    }
    if (method === 'tools/list') return list(params);
    if (method === 'tools/call') return call(params);
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  /** A request that stands alone: it says which revision it speaks, and nothing is remembered from the one before. */
  function standalone(method: string, params: Json, meta: Json): Json {
    const asked = meta[`${META}protocolVersion`];
    if (typeof asked !== 'string' || !MODERN.includes(asked)) {
      throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED, requested: String(asked) });
    }
    if (!isObject(meta[`${META}clientCapabilities`])) {
      throw new RpcError(INVALID_PARAMS, `Invalid params: _meta["${META}clientCapabilities"] is missing`);
    }
    let body: Json;
    if (method === 'server/discover') body = { supportedVersions: SUPPORTED, capabilities, instructions: INSTRUCTIONS, ...CACHE };
    else if (method === 'tools/list') body = { ...list(params), ...CACHE };
    else if (method === 'tools/call') body = call(params);
    else throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    return { resultType: 'complete', ...body, _meta: { [`${META}serverInfo`]: info } };
  }

  function answer(message: unknown): Json | undefined {
    if (!isObject(message) || message.jsonrpc !== '2.0') return failure(null, INVALID_REQUEST, 'Invalid Request: not a JSON-RPC 2.0 message');
    const { id, method, params = {} } = message;
    if (typeof method !== 'string') {
      // A response. This server asks the client nothing, so there is nothing for it to be the answer to.
      if ('result' in message || 'error' in message) return undefined;
      return failure(null, INVALID_REQUEST, 'Invalid Request: no method');
    }
    // A notification, `notifications/initialized` or `notifications/cancelled`: each call is over before the next line is read.
    if (id === undefined) return undefined;
    if (typeof id !== 'string' && typeof id !== 'number') return failure(null, INVALID_REQUEST, 'Invalid Request: the id must be a string or a number');
    try {
      if (!isObject(params)) throw new RpcError(INVALID_PARAMS, 'Invalid params: params must be an object');
      const meta = isObject(params._meta) ? params._meta : {};
      let result: Json;
      if (method === 'initialize') result = initialize(params);
      else if (meta[`${META}protocolVersion`] === undefined) result = inSession(method, params);
      else result = standalone(method, params, meta);
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (error instanceof RpcError) return failure(id, error.code, error.message, error.data);
      return failure(id, INTERNAL_ERROR, `Internal error: ${(error as Error).message}`);
    }
  }

  return (line) => {
    if (!line.trim()) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return JSON.stringify(failure(null, PARSE_ERROR, 'Parse error: invalid JSON'));
    }
    let reply: unknown;
    if (!Array.isArray(message)) reply = answer(message);
    else if (!message.length) reply = failure(null, INVALID_REQUEST, 'Invalid Request: an empty batch');
    else {
      // Revision 2025-03-26, and only it, lets a client send several messages as one array.
      const replies = message.map(answer).filter((r) => r !== undefined);
      reply = replies.length ? replies : undefined;
    }
    return reply === undefined ? undefined : JSON.stringify(reply);
  };
}

/** `spool mcp`: answer the client line by line until it closes stdin. Nothing else is ever written to stdout. */
export function serve({ ctx }: Bare): Result {
  const receive = server(ctx);
  ctx.lines((line) => {
    const reply = receive(line);
    if (reply !== undefined) ctx.out(reply);
  });
  return { text: '' };
}
