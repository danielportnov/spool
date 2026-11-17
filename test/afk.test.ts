import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { change } from '../src/act.ts';
import { engineCtx } from './claude.ts';
import { spool } from './helpers.ts';

// AFK: the human is away. An agent's question that is not truly theirs is taken, on record, and the
// thread goes on; one marked --human still waits for them.

test('spool afk says and switches it, for every project', () => {
  const s = spool();
  try {
    assert.match(s.sp('afk'), /AFK is off\. Agents ask you as usual\./);
    assert.match(s.sp('afk', 'on'), /AFK is on\./);
    assert.equal(s.json('afk').afk, true);
    const config = JSON.parse(fs.readFileSync(path.join(s.root, '.home', '.config', 'spool', 'config.json'), 'utf8'));
    assert.equal(config.afk, true);
    assert.match(s.sp('afk', 'off'), /AFK is off/);
    s.fails('afk', 'maybe');
  } finally {
    s.cleanup();
  }
});

test('with AFK on, a question takes the recommendation as a call and the thread carries on, with no ping', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Coins');
    s.sp('start', t);
    s.sp('afk', 'on');
    const out = s.json('ask', 'Outline the coins, or teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '2', '--why', 'Reads better small', '--for', t);
    assert.equal(out.afk, true);
    assert.equal(out.notified, false);
    assert.equal(out.decision.status, 'assumed');
    assert.equal(out.decision.choice, 'Teal');
    assert.match(s.sp('show', t), /^▶ /m, 'still being built');
    assert.match(s.sp('show', out.decision.id), /Taken while you were AFK/);
    assert.match(
      s.sp('ask', 'Round corners?', '--option', 'Yes', '--option', 'No', '--recommend', '1', '--for', t),
      /^AFK: took your recommendation, "Yes", recorded as d-[a-z0-9]+\. Carry on with t-/,
    );
    // No recommendation, no pick: it does not ping them either, it says how to go on.
    assert.match(s.fails('ask', 'Which?', '--option', 'A', '--option', 'B', '--for', t), /AFK is on[\s\S]*--recommend[\s\S]*--human/);
  } finally {
    s.cleanup();
  }
});

test('with AFK on, a question that is truly theirs still asks and waits; with it off, every question does', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Release');
    s.sp('start', t);
    s.sp('afk', 'on');
    const asked = s.json('ask', 'Push the tag?', '--option', 'Push', '--option', 'Keep it local', '--recommend', '2', '--human', 'publish', '--for', t);
    assert.equal(asked.afk, undefined);
    assert.equal(asked.decision.status, 'open');
    assert.match(s.sp('show', asked.decision.id), /Truly the human's: it publishes, pushes or sends something outside the repo\./);
    assert.match(s.sp('show', t), /waiting on d-/);
    assert.match(s.fails('ask', 'Spend?', '--option', 'A', '--human', 'lunch'), /--human is one of money, publish, delete, account, product, machine/);

    s.sp('afk', 'off');
    const u = s.id('task', 'Colour');
    s.sp('start', u);
    const plain = s.json('ask', 'Teal?', '--option', 'Yes', '--option', 'No', '--recommend', '1', '--for', u);
    assert.equal(plain.decision.status, 'open');
    assert.doesNotMatch(s.sp('show', u), /^▶ /m, 'it waits');
  } finally {
    s.cleanup();
  }
});

test('the page switches AFK, as the human', () => {
  const s = spool();
  try {
    const ctx = engineCtx(s);
    assert.equal(change(ctx, 'afk', { on: 'yes' }).ok, false);
    assert.equal(change(ctx, 'afk', { on: true }).ok, true);
    assert.match(s.sp('afk'), /AFK is on/);
    assert.equal(change(ctx, 'afk', { on: false }).ok, true);
    assert.match(s.sp('afk'), /AFK is off/);
  } finally {
    s.cleanup();
  }
});
