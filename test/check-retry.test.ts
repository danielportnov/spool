/**
 * A failed check is handed back: when the check refuses an agent's `spool done` and it stops, the
 * same session is given what the check said and one more go. A second failure puts the thread back.
 *
 * The stand-in agent speaks lines recorded from Claude Code (see test/claude.ts), and prints the
 * refusal `spool done` gave it as the tool result Claude Code would.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runner } from '../src/engine.ts';
import { stepUp } from '../src/agent.ts';
import { printed, claude, engineCtx } from './claude.ts';
import { Sandbox, until } from './helpers.ts';

const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');
const results = printed('two-turns', (e) => e.type === 'result');
const turns = { first: [init, said[0]!], over: [results[0]!] };

// The agent runs `spool done`, and prints what it said as the result of the tool call, then ends its turn.
const tryDone = [
  'out=$(spool done "$SPOOL_TASK" -m "finished" 2>&1)',
  'printf "%s" "$out" | node -e \'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>console.log(JSON.stringify({type:"user",session_id:process.argv[1],message:{role:"user",content:[{type:"tool_result",tool_use_id:"t1",is_error:true,content:t}]}})))\' "$sid"',
  'say over',
];

function sandbox(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.sp('checks', 'test -f passed.txt || { echo "FAIL: jump arc is wrong"; exit 1; }');
  return s;
}

test('a thread whose first try fails the check is given the output in its own session, fixes it and lands', async () => {
  const s = sandbox();
  const jump = s.id('task', 'Tighten the jump arc');
  const fake = claude(s, ['say first', ...tryDone, 'hear', 'hear', 'touch passed.txt', 'spool done "$SPOOL_TASK" -m "finished" > /dev/null'].join('\n'), turns);
  const runner = new Runner(engineCtx(s), undefined, fake.agent, true);
  try {
    runner.wake();
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    assert.equal(fake.args().length, 1, 'one run: the same agent, not a new one');
    const told = String(fake.heard(1)[1]?.message?.content ?? '');
    assert.match(told, /The check failed[\s\S]*FAIL: jump arc is wrong[\s\S]*run spool done again/);
    const log = s.item(jump);
    assert.match(log, /page: the check refused spool done; the agent was given its output and one more go/);
    assert.doesNotMatch(log, /without finishing/);
    assert.equal(stepUp(s.json('show', jump).item, undefined as never), undefined, 'landing after the retry is not a run that did not work');
    await until('the agent has gone', () => !runner.runs.size);
  } finally {
    runner.close();
    s.cleanup();
  }
});

test('a second failure puts the thread back, with the output on its log, and is not tried a third time', async () => {
  const s = sandbox();
  const jump = s.id('task', 'Tighten the jump arc');
  const fake = claude(s, ['say first', ...tryDone, 'hear', 'hear', ...tryDone, 'hear'].join('\n'), turns);
  const runner = new Runner(engineCtx(s), undefined, fake.agent, true);
  try {
    runner.wake();
    await until('the agent has given up', () => runner.recent[0]?.outcome.startsWith('unfinished'));
    assert.equal(fake.args().length, 1, 'the retry is the same run');
    const item = s.json('show', jump).item;
    assert.equal(item.status, 'open');
    const log = s.item(jump);
    assert.match(log, /page: the check failed again after one more go: [\s\S]*FAIL: jump arc is wrong/);
    assert.match(log, /agent exited \d+ without finishing; back in build/);
    assert.equal(String(fake.heard(1).filter((h) => /The check failed/.test(String(h.message?.content ?? ''))).length), '1', 'handed back once');
  } finally {
    runner.close();
    s.cleanup();
  }
});
