import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { test } from 'node:test';
import { version } from '../src/builtin.ts';
import { COMMANDS } from '../src/commands.ts';
import { CLI, Sandbox, spool } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const INIT = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

/** A request the way a client has made it since 2026-07-28: it names its own protocol version. */
function request(id: number | string, method: string, params: object = {}): object {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: META } };
}

/** One sitting with `spool mcp`, in-process: each message goes in as a line, and the replies come back parsed. */
function converse(s: Sandbox, ...messages: (object | string)[]): Any[] {
  const result = s.exec(['mcp'], { stdin: messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n') });
  assert.equal(result.code, 0, result.err);
  return result.out ? result.out.split('\n').map((line) => JSON.parse(line)) : [];
}

/** Call one tool. Returns what the command answered, and whether it was marked as an error. */
function call(s: Sandbox, name: string, args: object = {}): { data: Any; isError: boolean } {
  const [reply] = converse(s, request(1, 'tools/call', { name, arguments: args }));
  assert.ok(reply.result, JSON.stringify(reply));
  assert.equal(reply.result.content.length, 1);
  assert.equal(reply.result.content[0].type, 'text');
  return { data: JSON.parse(reply.result.content[0].text), isError: reply.result.isError };
}

function toolList(s: Sandbox): Any[] {
  return converse(s, request(1, 'tools/list'))[0].result.tools;
}

test('a client that opens with initialize is answered in its own revision', () => {
  const s = spool();
  const [hello, pong, listed] = converse(
    s,
    { ...INIT, params: { ...INIT.params, protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'p', method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  );
  assert.equal(hello.id, 0);
  assert.equal(hello.result.protocolVersion, '2025-06-18');
  assert.deepEqual(hello.result.capabilities, { tools: {} });
  assert.deepEqual(hello.result.serverInfo, { name: 'spool', title: 'Spool', version: version() });
  assert.match(hello.result.instructions, /spool_prime/);
  assert.deepEqual(pong, { jsonrpc: '2.0', id: 'p', result: {} }, 'the notification got no reply, and the ping got an empty one');
  assert.ok(listed.result.tools.length > 20);
  assert.equal(listed.result.resultType, undefined, 'an older client is not sent fields from a revision it never asked for');

  // A revision this server does not speak is answered with the newest handshake revision it does.
  const [other] = converse(s, { ...INIT, params: { ...INIT.params, protocolVersion: '1999-01-01' } });
  assert.equal(other.result.protocolVersion, '2025-11-25');
  assert.equal(converse(s, { ...INIT, params: {} })[0].error.code, -32602);
  s.cleanup();
});

test('a request that names its protocol version needs no handshake', () => {
  const s = spool();
  const [found, listed] = converse(s, request('d', 'server/discover'), request(2, 'tools/list'));
  assert.equal(found.result.resultType, 'complete');
  assert.deepEqual(found.result.supportedVersions.slice(0, 2), ['2026-07-28', '2025-11-25']);
  assert.deepEqual(found.result.capabilities, { tools: {} });
  assert.deepEqual(found.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'spool', title: 'Spool', version: version() });
  assert.ok(found.result.ttlMs > 0);
  assert.equal(found.result.cacheScope, 'public');
  assert.equal(listed.result.resultType, 'complete');
  assert.ok(listed.result.ttlMs > 0 && listed.result.cacheScope === 'public');
  assert.ok(listed.result.tools.length > 20);

  const future = { ...META, 'io.modelcontextprotocol/protocolVersion': '2031-01-01' };
  const [unsupported, noCapabilities, noVersion, ping] = converse(
    s,
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: future } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    request(4, 'ping'),
  );
  assert.equal(unsupported.error.code, -32022);
  assert.equal(unsupported.error.data.requested, '2031-01-01');
  assert.ok(unsupported.error.data.supported.includes('2026-07-28'));
  assert.equal(noCapabilities.error.code, -32602);
  assert.equal(noVersion.error.code, -32602, 'with no version and no handshake, there is no telling what the client speaks');
  assert.match(noVersion.error.message, /protocolVersion.*initialize/);
  assert.equal(ping.error.code, -32601, 'ping left the protocol with the handshake');
  s.cleanup();
});

test('the tools are the command table, without the set-up verbs', () => {
  const s = spool();
  const tools = toolList(s);
  const names = tools.map((t) => t.name);
  const offered = COMMANDS.filter((c) => c.group !== 'setup');
  assert.deepEqual(names, offered.map((c) => `spool_${c.name}`), 'one tool per command, in the table’s order');
  for (const name of names) assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/);
  for (const gone of ['spool_loop', 'spool_install', 'spool_init', 'spool_mcp']) assert.ok(!names.includes(gone), `${gone} is not offered`);
  for (const kept of ['capture', 'review', 'answer', 'approve', 'revert', 'release', 'next', 'done', 'ask', 'task', 'status', 'show']) {
    assert.ok(names.includes(`spool_${kept}`), `${kept} is offered`);
  }

  const tool = (name: string) => tools.find((t) => t.name === `spool_${name}`);
  for (const c of offered) {
    const { description, inputSchema, annotations } = tool(c.name);
    assert.equal(inputSchema.type, 'object');
    assert.equal(inputSchema.additionalProperties, false);
    for (const option of Object.keys(c.options ?? {})) assert.ok(inputSchema.properties[option], `${c.name} takes ${option}`);
    assert.ok(description.includes(c.summary) && description.includes(`spool ${c.usage}`));
    // What acts in the human's name says so, in every such tool and in no other.
    assert.equal(/acts for the human\. Call it only when the human says so/.test(description), !!c.human, c.name);
    assert.deepEqual(annotations, c.write ? undefined : { readOnlyHint: true }, c.name);
  }

  const task = tool('task').inputSchema.properties;
  assert.deepEqual(task.args, { type: 'array', items: { type: 'string' }, description: 'In order: <title…>' });
  assert.deepEqual(task.size, { type: 'string', description: '-s xs|s|m|l|xl' });
  assert.deepEqual(task.from, { type: 'array', items: { type: 'string' }, description: '--from <id>…' });
  assert.deepEqual(tool('next').inputSchema.properties.claim, { type: 'boolean' });
  assert.equal(tool('approve').inputSchema.properties.args.description, 'In order: <id…>');
  assert.equal(tool('status').inputSchema.properties.args, undefined, 'a command with no positionals takes none');
  assert.match(tool('done').inputSchema.properties.report.description, /as text/);
  assert.match(tool('review').description, /^For the human: /);
  s.cleanup();
});

test('feedback becomes finished, approved work without a shell', () => {
  const s = spool();
  const words = 'the jump feels floaty, and "coins" are hard to see';
  const note = call(s, 'spool_capture', { args: [words] }).data.note;
  assert.equal(note.by, 'human');
  assert.ok(s.item(note.id).includes(words), 'the words are on disk exactly as said');

  const task = call(s, 'spool_task', { args: ['Tighten the jump arc'], from: [note.id], size: 's', priority: 1, hold: null, as: '' }).data.task;
  assert.equal(task.priority, 1, 'a number is taken where the command line takes a string');
  assert.equal(task.state, 'ready', 'and an option left null or empty was not given');
  assert.deepEqual(task.from, [note.id]);
  assert.equal(s.json('show', note.id).item.status, 'filed');

  const next = call(s, 'spool_next', { claim: true, as: 'phone' }).data;
  assert.equal(next.task.id, task.id);
  assert.equal(s.json('show', task.id).item.by, 'phone');

  // The agent reaches a call that is the human's. The task waits; the human answers through the same server.
  const asked = call(s, 'spool_ask', { args: ['Snappy or heavy?'], option: ['Snappy', 'Heavy'], recommend: '1', for: task.id }).data.decision;
  assert.equal(s.json('show', task.id).item.state, 'blocked');
  assert.equal(call(s, 'spool_next').data.task, null);
  const answered = call(s, 'spool_answer', { args: [asked.id, '1'] }).data;
  assert.equal(answered.decision.choice, 'Snappy');
  assert.deepEqual(answered.unblocked, [task.id]);

  call(s, 'spool_start', { args: [task.id], as: 'phone' });
  const done = call(s, 'spool_done', { args: [task.id], message: 'Gravity 9.8 → 12', as: 'phone' });
  assert.equal(done.isError, false);
  assert.equal(done.data.task.state, 'done');
  assert.equal(call(s, 'spool_review').data.shipped[0].id, task.id);
  assert.deepEqual(call(s, 'spool_approve', { all: true }).data.approved, [task.id]);

  const item = s.item(task.id);
  assert.match(item, /^status: done$/m);
  assert.match(item, /phone: done: Gravity 9\.8 → 12/);
  assert.match(item, /human: approved/);
  assert.equal(s.json('review').shipped.length, 0);
  s.cleanup();
});

test('a command that fails is an answer marked as an error, with its hint', () => {
  const s = spool();
  const missing = call(s, 'spool_show', { args: ['t-nope'] });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.data, { error: 'no item "t-nope"', hint: 'See what exists with: spool list --all' });

  // Arguments of the wrong shape are the caller's to fix, so they read like any other mistake.
  assert.deepEqual(call(s, 'spool_next', { claim: 'yes' }), { data: { error: '"claim" must be true or false', hint: null }, isError: true });
  assert.match(call(s, 'spool_task', { args: [{ title: 'x' }] }).data.error, /"args" must be a string/);
  const stray = call(s, 'spool_status', { cwd: '/' });
  assert.equal(stray.isError, true);
  assert.equal(stray.data.error, 'spool_status takes no "cwd"');
  assert.equal(stray.data.hint, 'It takes: project');

  // Not finding the tool, or not being asked properly, is the protocol's error and not the tool's.
  const [unknown, unnamed, badArguments] = converse(
    s,
    request(1, 'tools/call', { name: 'spool_loop', arguments: {} }),
    request(2, 'tools/call', { arguments: {} }),
    request(3, 'tools/call', { name: 'spool_status', arguments: [] }),
  );
  assert.deepEqual(unknown.error, { code: -32602, message: 'Unknown tool: spool_loop' });
  assert.equal(unnamed.error.code, -32602);
  assert.equal(badArguments.error.code, -32602);
  s.cleanup();
});

test('a call cannot reach outside the project the server was started in', () => {
  const s = new Sandbox();
  s.cd('inside').sp('init', '--name', 'inside');
  s.cd('outside').sp('init', '--name', 'outside');
  s.write('outside/secret.txt', 'not for the queue');
  const inside = s.cd('inside');

  // What looks like a flag among the words is words: there is no way to say -C.
  const note = call(inside, 'spool_capture', { args: ['-C', '../outside', '--json', '--as=root'] }).data.note;
  assert.equal(note.body, '-C ../outside --json --as=root');
  assert.equal(note.by, 'human');
  assert.equal(note.project, 'inside');
  assert.equal(s.cd('outside').json('list', '--all').items.length, 0);
  assert.equal(call(inside, 'spool_capture', { args: ['x'], project: '../outside' }).isError, true);

  // Where the command line reads a file, the tool takes the text: a path is only a string.
  const audit = call(inside, 'spool_audit', { args: ['Play it as a new player'] }).data.task.id;
  assert.match(call(inside, 'spool_done', { args: [audit], message: 'x' }).data.error, /finished by its report/);
  const done = call(inside, 'spool_done', { args: [audit], message: 'Players quit at the first boss', report: '../outside/secret.txt' });
  assert.equal(done.isError, false);
  assert.equal(inside.read(`.spool/reports/${audit}.md`), '../outside/secret.txt\n');
  s.cleanup();
});

test('what is not a request gets the JSON-RPC error for it, or silence', () => {
  const s = spool();
  const replies = converse(
    s,
    request(1, 'resources/list'),
    '{not json',
    '',
    { id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3 },
    { jsonrpc: '2.0', id: null, method: 'tools/list', params: { _meta: META } },
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: [] },
    request(5, 'tools/list', { cursor: 'page-2' }),
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    { jsonrpc: '2.0', id: 9, result: {} },
    '[]',
  );
  assert.deepEqual(replies.map((r) => [r.id, r.error.code]), [
    [1, -32601],
    [null, -32700],
    [null, -32600],
    [null, -32600],
    [null, -32600],
    [4, -32602],
    [5, -32602],
    [null, -32600],
  ]);
  assert.equal(replies[0].error.message, 'Method not found: resources/list');
  assert.equal(s.exec(['--json', 'mcp'], { stdin: '' }).out, '', 'even asked for JSON, the command itself prints nothing');

  // Revision 2025-03-26 lets a client send several messages as one array, and expects one array back.
  const [, batch] = converse(s, { ...INIT, params: { ...INIT.params, protocolVersion: '2025-03-26' } }, [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spool_status' } },
  ]);
  assert.deepEqual(batch.map((r: Any) => r.id), [1, 2]);
  assert.equal(batch[1].result.isError, false);
  s.cleanup();
});

test('outside any spool the server still starts, and each call says what is missing', () => {
  const s = new Sandbox();
  assert.equal(toolList(s).length, COMMANDS.filter((c) => c.group !== 'setup').length);
  const status = call(s, 'spool_status');
  assert.equal(status.isError, true);
  assert.match(status.data.error, /no \.spool\/ here/);
  s.cleanup();
});

test('the real server speaks nothing but the protocol on stdout, and ends when stdin closes', async () => {
  const s = spool();
  // Started somewhere else and pointed at the project, the way a client's config would start it.
  const child = spawn(process.execPath, [CLI, 'mcp', '-C', s.dir], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, HOME: path.join(s.root, '.home') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ended = new Promise<number | null>((resolve) => child.on('close', resolve));
  const ask = async (message: object): Promise<Any> => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const { value, done } = await lines.next();
    assert.equal(done, false, `the server stopped answering: ${stderr}`);
    return JSON.parse(value);
  };

  const hello = await ask(INIT);
  assert.equal(hello.result.protocolVersion, '2025-11-25');
  assert.equal(hello.result.serverInfo.version, version());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.deepEqual(await ask({ jsonrpc: '2.0', id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, result: {} });

  const captured = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spool_capture', arguments: { args: ['the music is too loud'] } } });
  const note = JSON.parse(captured.result.content[0].text).note;
  const queued = await ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spool_task', arguments: { args: ['Lower the music'], from: [note.id] } } });
  const task = JSON.parse(queued.result.content[0].text).task;
  // The same process serves a client of the newer kind, which names its version on each request.
  const claimed = await ask(request('c', 'tools/call', { name: 'spool_next', arguments: { claim: true } }));
  assert.equal(claimed.result.resultType, 'complete');
  assert.equal(JSON.parse(claimed.result.content[0].text).task.id, task.id);
  const failed = await ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spool_done', arguments: { args: [task.id] } } });
  assert.equal(failed.result.isError, true);
  assert.equal(JSON.parse(failed.result.content[0].text).error, 'the summary is missing');
  assert.equal((await ask({ jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);

  child.stdin.end();
  assert.equal(await ended, 0);
  assert.equal((await lines.next()).done, true, 'nothing was written that was not an answer');
  assert.equal(stderr, '');
  assert.equal(s.json('show', task.id).item.state, 'active', 'the work is in the project the server was pointed at');
  assert.ok(s.item(note.id).includes('the music is too loud'));
  s.cleanup();
});
