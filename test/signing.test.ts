/**
 * Who signs a line on a thread: a command nobody signed takes the claimer's name, an agent has one
 * name on a thread whatever form it signs with, and a claim says the model that builds it.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { signAs, signer, stepUp } from '../src/agent.ts';
import type { Item } from '../src/model.ts';
import { spool } from './helpers.ts';
import { png } from './pictures-helpers.ts';

test('an agent’s name and the model in it', () => {
  assert.deepEqual(signer('Claude Opus 5.5'), { agent: 'Claude', model: 'opus-5.5' });
  assert.deepEqual(signer('Codex GPT-6'), { agent: 'Codex', model: 'gpt-6' });
  assert.deepEqual(signer('Codex'), { agent: 'Codex' });
  assert.deepEqual(signer('Claude Code'), { agent: 'Claude Code' });
  assert.equal(signAs(undefined, 'Codex GPT-6', 'agent'), 'Codex GPT-6', 'nobody signed: the claimer');
  assert.equal(signAs('agent', 'Codex GPT-6', 'agent'), 'Codex GPT-6', '"agent" is nobody');
  assert.equal(signAs('Codex', 'Codex GPT-6', 'agent'), 'Codex GPT-6', 'one name per agent');
  assert.equal(signAs('codex gpt-6', 'Codex', 'agent'), 'Codex');
  assert.equal(signAs('Claude Opus 5.5', 'Codex', 'agent'), 'Claude Opus 5.5', 'another agent signs as itself');
  assert.equal(signAs('human', 'Codex', 'agent'), 'human');
  assert.equal(signAs(undefined, 'loop', 'agent'), 'agent', 'the loop is not an agent to sign as');
});

test('a command nobody signed, on a claimed thread, signs as the claimer: by its id, its agent’s SPOOL_TASK, or its worktree', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Fix the jump', '--size', 's');
    s.sp('build', t);
    s.sp('start', t, '--as', 'Codex GPT-6');
    s.sp('log', t, 'the jump height is in physics.ts');
    assert.match(s.item(t), /Codex GPT-6: the jump height is in physics\.ts/);
    s.sp('edit', t, '--steps', 'Jump');
    assert.match(s.item(t), /Codex GPT-6: edited: 1 step/);
    assert.doesNotMatch(s.item(t), / agent: /);

    s.sp('log', t, 'one name for Codex', '--as', 'Codex');
    assert.match(s.item(t), /Codex GPT-6: one name for Codex/);
    s.sp('log', t, 'someone else', '--as', 'Claude Opus 5.5');
    assert.match(s.item(t), /Claude Opus 5\.5: someone else/);

    const other = s.id('task', 'A thread to ask on');
    s.sp('build', other);
    s.sp('start', other, '--as', 'Claude Sonnet 5');
    const asked = s.exec(['assume', 'Which height?', '--chose', '2', '--why', 'feel', '--for', other]);
    assert.equal(asked.code, 0, asked.err);
    assert.match(s.item(other), /Claude Sonnet 5: assumed d-/);

    // Its agent, run by the loop or the page, is told the thread it was started on.
    const env = s.exec(['log', t, 'from the agent’s own env'], { env: { SPOOL_TASK: t } });
    assert.equal(env.code, 0, env.err);
    assert.match(s.item(t), /Codex GPT-6: from the agent’s own env/);

    // Run from inside the thread's worktree, the thread is the worktree's.
    fs.mkdirSync(path.join(s.dir, '.spool', 'worktrees', t), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'shot.png'), png());
    const inside = s.cd(path.join('.spool', 'worktrees', t));
    const attached = inside.exec(['attach', other, path.join(s.dir, 'shot.png'), '--as', 'after']);
    assert.equal(attached.code, 0, attached.err);
    assert.match(s.item(other), /Claude Sonnet 5: attached picture/, 'a picture’s side is not its signer');
    inside.sp('attach', t, path.join(s.dir, 'shot.png'), '--as', 'before', '--by', 'Codex');
    assert.match(s.item(t), /Codex GPT-6: attached picture/);
  } finally {
    s.cleanup();
  }
});

test('a claim says the model that builds the thread, and the step up reads it', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Fix a typo', '--size', 'xs');
    s.sp('build', t);
    const out = s.sp('start', t, '--model', 'sonnet', '--as', 'Claude Opus 5.5');
    assert.match(out, /MODEL — built on sonnet, as the claim says \(Spool would pick haiku · medium, by its size\)\./);
    assert.match(s.item(t), /Claude Opus 5\.5: built on sonnet; Spool suggested haiku · medium, by its size/);
    assert.doesNotMatch(s.item(t), /builder model/);
    const item = { body: s.item(t).split('\n---\n').slice(1).join('\n---\n'), size: 'xs' } as Item;
    item.body += '\n- 2026-01-01 00:10Z Claude Opus 5.5: done: ok\n- 2026-01-01 00:11Z human: reverted 1 commit(s)';
    assert.equal(stepUp(item, undefined)?.from, 'sonnet', 'stepped up from what ran, not what the size gave');
    assert.match(s.fails('next', '--model', 'opus'), /--model goes with --claim/);
  } finally {
    s.cleanup();
  }
});
