import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

// A mode is a named set of the switches there are: picking one moves them all, off puts them back.

const config = (s: Sandbox): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(s.root, '.home', '.config', 'spool', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
};

test('with nothing picked, Hands-on is the mode; moved by hand, it is your own settings', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    const mode = s.json('mode').mode;
    assert.equal(mode.name, 'hands-on');
    assert.equal(mode.default, true);
    assert.match(s.sp('mode'), /^Mode: Hands-on \(the default\)\./);
    s.sp('afk', 'on');
    assert.equal(s.json('mode').mode.name, null);
    assert.match(s.sp('mode'), /^Mode: your own settings\./);
  } finally {
    s.cleanup();
  }
});

test('spool mode hands-on moves the switches, says what it changed, and off puts them back', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    s.sp('afk', 'on');
    s.sp('takeover', 'on');
    s.sp('notify', 'only', 'done');
    const out = s.sp('mode', 'hands-on');
    assert.match(out, /^Hands-on is on\. Changed:/);
    assert.match(out, /AFK: on → off/);
    assert.match(out, /Take-over: on → off/);
    assert.match(out, /Notifications: done → question, empty, stuck, budget/);
    assert.equal(s.json('afk').afk, false);
    assert.equal(s.json('takeover').on, false);
    assert.equal(config(s).notifyOn, undefined, 'the default notifications are kept as nothing said');
    assert.equal(s.json('mode').mode.label, 'Hands-on');

    // A switch moved by hand: the mode says so.
    s.sp('caveman', 'on');
    assert.equal(s.json('mode').mode.label, 'Hands-on', 'caveman is not one Hands-on sets');
    s.sp('afk', 'on');
    const changed = s.json('mode').mode;
    assert.equal(changed.label, 'Hands-on, changed');
    assert.deepEqual(changed.changed, ['AFK']);
    s.sp('afk', 'off');

    const back = s.sp('mode', 'off');
    assert.match(back, /^Hands-on is off\. Put back:/);
    assert.equal(s.json('afk').afk, true);
    assert.equal(s.json('takeover').on, true);
    assert.deepEqual(s.json('notify').on, ['done']);
    assert.equal(config(s).mode, undefined);
    assert.match(s.sp('mode'), /^Mode: your own settings\./);
    assert.match(s.sp('mode', 'off'), /No mode is on, so nothing to put back/);
  } finally {
    s.cleanup();
  }
});

test('a mode already as set changes nothing; an unknown one is refused', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    assert.match(s.sp('mode', 'Hands-on'), /Nothing to change/);
    assert.match(s.fails('mode', 'nonsense'), /"nonsense" is not a mode[\s\S]*hands-on/);
    assert.match(s.fails('mode', 'a', 'b'), /one mode at a time/);
  } finally {
    s.cleanup();
  }
});

test('where the gate is locked, an agent cannot put back AFK or take-over on; a person at a terminal can', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--lock');
    assert.equal(s.exec(['afk', 'on'], { tty: true }).code, 0);
    s.sp('mode', 'hands-on');
    assert.equal(s.json('afk').afk, false, 'switching off is anyone\'s');
    assert.match(s.fails('mode', 'off'), /spool afk on is the human's alone in skyhop/);
    assert.equal(s.json('afk').afk, false, 'refused, nothing moved');
    assert.equal(s.exec(['mode', 'off'], { tty: true }).code, 0);
    assert.equal(s.json('afk').afk, true);
  } finally {
    s.cleanup();
  }
});

test('a preset added to the table moves the time, the target, the lean and the count through their own commands, and off puts them back', async () => {
  const { PRESETS } = await import('../src/modes.ts');
  PRESETS.push({ name: 'push', label: 'Push', for: 'A test mode', sets: { time: '2h', target: { weekly: 70 }, lean: 'development', atOnce: 5, caveman: true } });
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    s.sp('target', '--weekly', '90');
    const out = s.sp('mode', 'push');
    assert.match(out, /Time to work: none → until \d+:\d\d/);
    assert.match(out, /Usage target: weekly 90% → weekly 70%/);
    assert.match(out, /Lean: balanced → development/);
    assert.match(out, /Threads at once: 3 → 5/);
    assert.match(out, /Caveman: off → on/);
    assert.ok(s.json('until').time, 'a time to work is set');
    assert.equal(config(s).parallel, 5);
    assert.equal(s.json('mode').mode.label, 'Push');

    s.sp('mode', 'off');
    assert.equal(s.json('until').time, null);
    assert.deepEqual(s.json('target').all, { weekly: 90 });
    assert.equal(config(s).parallel, 3);
    assert.ok(s.json('builder').agents.every((a: { lean: string }) => a.lean === 'balanced'));
    assert.equal(s.json('caveman').caveman, false);
  } finally {
    PRESETS.pop();
    s.cleanup();
  }
});
