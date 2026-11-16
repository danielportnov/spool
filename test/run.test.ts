import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOf } from '../src/run.ts';

test('a thread says what its agent was started with: the model, the effort, why, and its session', () => {
  const log = [
    '- 2026-01-01 00:01Z human: moved to build',
    '- 2026-01-01 00:02Z page: fable chose opus · xhigh: a small change, worth care',
    '- 2026-01-01 00:02Z page: handed to `claude -p --model opus --effort xhigh --output-format stream-json --verbose`',
    '- 2026-01-01 00:02Z page: session 5f2c9e1a-77b0 · transcript .spool/runs/x.jsonl · open it with `claude --resume 5f2c9e1a-77b0`',
  ];
  assert.deepEqual(runOf(log), { model: 'opus', effort: 'xhigh', why: 'a small change, worth care', session: '5f2c9e1a-77b0' });
  assert.deepEqual(runOf(log.slice(0, 3)), { model: 'opus', effort: 'xhigh', why: 'a small change, worth care', session: '' }, 'no session yet');
  // Without a router, the command is all there is; a command that names no model says none.
  assert.deepEqual(runOf(['- 2026-01-01 00:02Z page: handed to `claude -p --model=sonnet`']), { model: 'sonnet', effort: '', why: '', session: '' });
  assert.deepEqual(runOf(['- 2026-01-01 00:02Z page: handed to `./agent.sh`']), { model: '', effort: '', why: '', session: '' });
  // A chat that took it after the page did, or never a page at all: nothing is known.
  assert.equal(runOf([...log, '- 2026-01-01 00:09Z claude: started']), null);
  assert.equal(runOf(['- 2026-01-01 00:02Z claude: started']), null);
  // Only plain words reach the page.
  assert.equal(runOf(['- 2026-01-01 00:02Z page: handed to `claude --model <b>x</b>`'])?.model, '');
});
