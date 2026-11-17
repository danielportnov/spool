import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { change } from '../src/act.ts';
import { notify } from '../src/context.ts';
import { engineCtx } from './claude.ts';
import { type Sandbox, spool } from './helpers.ts';

const configFile = (s: Sandbox): string => path.join(s.root, '.home', '.config', 'spool', 'config.json');
const config = (s: Sandbox): Record<string, any> => JSON.parse(fs.readFileSync(configFile(s), 'utf8'));

test('spool notify says what tells the human, changes it, and goes back to the defaults', () => {
  const s = spool();
  try {
    // With nothing said: what always told them, and never progress.
    const listed = s.sp('notify');
    assert.match(listed, /^Notify on: question, empty, stuck, budget \(the default\)\. Everything else is quiet\./);
    assert.match(listed, /^ {2}○ started {3}A thread starts$/m);
    assert.match(listed, /^ {2}● question {2}A question is asked$/m);
    assert.match(listed, /In Chat mode the chat that builds sends each as one line, a Claude notification\./);
    assert.equal(fs.existsSync(configFile(s)), false, 'saying what is set keeps nothing');

    // Exactly the two he picked, in the order they are listed, whatever order he said them in.
    assert.match(s.sp('notify', 'only', 'question', 'started'), /^Notify on: started, question\. Everything else/);
    assert.deepEqual(config(s).notifyOn, ['started', 'question']);
    s.sp('notify', 'on', 'done,sprint');
    s.sp('notify', 'off', 'question');
    assert.deepEqual(s.json('notify').on, ['started', 'done', 'sprint']);
    assert.match(s.sp('notify', 'only', 'none'), /^Notify on: nothing\./);
    assert.deepEqual(config(s).notifyOn, []);
    // The defaults are what nothing said means, so nothing is kept for them.
    s.sp('notify', 'default');
    assert.equal(config(s).notifyOn, undefined);
    assert.equal(s.json('notify').default, true);

    // What is not an event is refused in words, and nothing changes.
    assert.match(s.fails('notify', 'on', 'lunch'), /"lunch" is not something that can notify you/);
    assert.match(s.fails('notify', 'loudly'), /spool notify cannot loudly/);
    assert.equal(fs.existsSync(configFile(s)) && config(s).notifyOn, undefined);
  } finally {
    s.cleanup();
  }
});

test('the chat that builds asks spool notify check before each, and hears send or quiet', () => {
  const s = spool();
  try {
    s.sp('notify', 'only', 'started', 'question');
    assert.equal(s.sp('notify', 'check', 'started'), 'Send it: a thread starts tells them. One short line.');
    assert.equal(s.sp('notify', 'check', 'question'), 'Send it: a question is asked tells them. One short line.');
    for (const quiet of ['done', 'sprint', 'empty', 'stuck', 'budget']) {
      assert.equal(s.sp('notify', 'check', quiet), `Quiet: ${quiet} is off. Send nothing for it.`);
      assert.equal(s.json('notify', 'check', quiet).send, false);
    }
    assert.equal(s.json('notify', 'check', 'started').send, true);
    assert.match(s.fails('notify', 'check', 'lunch'), /which event\?/);
  } finally {
    s.cleanup();
  }
});

test('headless, the notifier runs for the events picked and stays quiet for the rest', () => {
  const s = spool();
  try {
    const told = path.join(s.root, 'told.txt');
    const ctx = engineCtx(s);
    ctx.env.SPOOL_NOTIFY = `echo "$SPOOL_EVENT" >> "${told}"`;
    // The defaults: a question and an idle loop tell them; a thread starting does not.
    assert.equal(notify(ctx, 'ask', 'Which way?'), true);
    assert.equal(notify(ctx, 'started', 'Started: the jump'), false);
    assert.equal(notify(ctx, 'idle', 'Spool is idle'), true);
    s.sp('notify', 'only', 'started');
    assert.equal(notify(ctx, 'started', 'Started: the jump'), true);
    assert.equal(notify(ctx, 'ask', 'Which way?'), false);
    assert.equal(notify(ctx, 'done', 'Done: the jump'), false);
    assert.deepEqual(fs.readFileSync(told, 'utf8').trim().split('\n'), ['ask', 'idle', 'started']);
  } finally {
    s.cleanup();
  }
});

test('the page switches one event on or off, and back to the defaults', () => {
  const s = spool();
  try {
    assert.equal(change(engineCtx(s), 'notify', { event: 'started', on: true }).ok, true);
    assert.deepEqual(config(s).notifyOn, ['started', 'question', 'empty', 'stuck', 'budget']);
    assert.equal(change(engineCtx(s), 'notify', { event: 'budget', on: false }).ok, true);
    assert.deepEqual(config(s).notifyOn, ['started', 'question', 'empty', 'stuck']);
    assert.equal(change(engineCtx(s), 'notify', { event: 'started' }).ok, false, 'on or off has to be said');
    assert.equal(change(engineCtx(s), 'notify', { default: true }).ok, true);
    assert.equal(config(s).notifyOn, undefined);
  } finally {
    s.cleanup();
  }
});
