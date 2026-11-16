import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sandbox, spool } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

/** Call one tool through `spool mcp`, in-process, and return what the command answered. */
function call(s: Sandbox, name: string, args: object): { data: Any; isError: boolean } {
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } };
  const result = s.exec(['mcp'], { stdin: JSON.stringify(message) });
  assert.equal(result.code, 0, result.err);
  const reply = JSON.parse(result.out);
  return { data: JSON.parse(reply.result.content[0].text), isError: reply.result.isError };
}

test('an agent with no shell reads the report of a finished audit through spool_show', () => {
  const s = spool();
  const audit = s.id('audit', 'How does it feel to a new player?');
  s.sp('build', audit);
  s.sp('start', audit);
  assert.equal(s.exec(['done', audit, '-m', 'Two things would make them quit', '--report', '-'], { stdin: '# First hour\n\nThe jump, and the coins.' }).code, 0);
  const shown = call(s, 'spool_show', { args: [audit], report: true });
  assert.notEqual(shown.isError, true);
  assert.deepEqual(shown.data, { id: audit, report: '# First hour\n\nThe jump, and the coins.' });
});

test('the report of an item that has none is an answer that says so, and show is as it was without the option', () => {
  const s = spool();
  const task = s.id('task', 'Tighten the jump arc');
  const none = call(s, 'spool_show', { args: [task], report: true });
  assert.equal(none.isError, true);
  assert.match(none.data.error, /has no report/);
  assert.equal(call(s, 'spool_show', { args: [task] }).data.item.id, task);
});
