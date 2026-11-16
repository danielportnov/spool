import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hearLine, streaming } from '../src/stream.ts';

test('a claude -p command is run with the stream on; anything else is left as it is', () => {
  assert.equal(streaming('claude -p --model opus'), 'claude -p --model opus --output-format stream-json --verbose');
  assert.equal(streaming('/usr/local/bin/claude --print'), '/usr/local/bin/claude --print --output-format stream-json --verbose');
  assert.equal(streaming('claude -p --verbose'), 'claude -p --verbose --output-format stream-json');
  assert.equal(streaming('claude -p --output-format json'), 'claude -p --output-format json', 'an output the user chose is kept');
  assert.equal(streaming('claude'), 'claude', 'not print mode');
  assert.equal(streaming('./worker.sh -p'), './worker.sh -p');
});

test('stream events read as short lines; other lines as themselves', () => {
  assert.deepEqual(hearLine('just text'), { lines: ['just text'] });
  assert.deepEqual(hearLine('{not json'), { lines: ['{not json'] });
  assert.deepEqual(hearLine('   '), { lines: [] });
  assert.deepEqual(hearLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' })), { lines: ['session s-1'], session: 's-1' });
  assert.equal(hearLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'bad id; rm' })).session, undefined, 'only a plain id is kept');
  const edit = hearLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }, { type: 'thinking', thinking: 'x' }] } }),
  );
  assert.deepEqual(edit.lines, ['→ Edit: src/a.ts']);
  const end = hearLine(
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/etc/x' } }] }),
  );
  assert.deepEqual(end.lines, ['denied → Write: /etc/x', 'ended: error_max_turns']);
  assert.deepEqual(end.denials, ['Write: /etc/x']);
});
