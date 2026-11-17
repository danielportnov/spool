import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox, spool, startPage } from './helpers.ts';

// The sandbox's clock starts here, a minute on with each command.
const START = Date.parse('2026-01-01T00:00:00Z');
const minutes = (n: number) => new Date(START + n * 60_000).toISOString();
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A session line as Codex writes its plan's limits, at that time. */
function limitsLine(at: string, fiveHour: number, weekly: number, resets = { fiveHour: minutes(300), weekly: minutes(7 * 1440) }): string {
  return JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1200 } },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: fiveHour, window_minutes: 300, resets_at: epoch(resets.fiveHour) },
        secondary: { used_percent: weekly, window_minutes: 10080, resets_at: epoch(resets.weekly) },
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: 'plus',
      },
    },
  });
}
/** A line of the conversation itself, which Spool must never repeat. */
const talk = (at: string) => JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'message', content: [{ type: 'input_text', text: 'PRIVATE words of the human' }] } });

/** Write a Codex session log in the sandbox's own home, never the real one. */
function session(s: Sandbox, name: string, lines: string[], mtime?: string): string {
  const dir = path.join(s.root, '.home', '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

test("Codex's usage is read from its own session log: its target holds it, and Claude's reading is left alone", () => {
  const s = spool();
  try {
    s.gitInit();
    s.write('.gitignore', '.home/\n');
    s.commitAll('start');
    s.sp('builder', 'chat');
    for (const agent of ['Claude', 'Codex']) s.sp('builder', '--agent', agent, '--at-once', '3');
    for (let i = 1; i <= 3; i++) s.sp('build', s.id('task', `Thread ${i}`));
    s.sp('target', '--weekly', '80');
    s.sp('target', '--agent', 'Codex', '--weekly', '50');

    // No Codex here: --from-codex says it cannot read it, and how else to report.
    assert.match(s.fails('usage', '--from-codex', '--as', 'Codex GPT-6.1 Sol'), /Codex's usage cannot be read here[\s\S]*--cannot-read/);

    // An older session, and the newest: its last line with limits is the one taken.
    session(s, 'old', [limitsLine(minutes(-600), 5, 10)], minutes(-600));
    session(s, 'new', [limitsLine(minutes(0), 20, 40), talk(minutes(1)), limitsLine(minutes(10), 30, 55), talk(minutes(11))]);

    // Codex never reported: its target holds it from the log alone, and Claude builds on.
    assert.match(s.fails('next', '--claim', '--as', 'Codex GPT-6.1 Sol'), /Codex's usage target is reached, weekly 55% of 50%/);
    assert.match(s.sp('usage', '--weekly', '20', '--as', 'Claude Opus 5.5'), /^Keep building: weekly 20% of 80%\./);
    assert.match(s.sp('next', '--claim', '--as', 'Claude Opus 5.5'), /^t-/);

    // Reported as Codex's: the shorter window is the 5-hour, the longer the weekly.
    const said = s.sp('usage', '--from-codex', '--as', 'Codex GPT-6.1 Sol');
    assert.match(said, /^Read from Codex's session log, written \S+ ago: weekly 55%, 5-hour 30%\.\nStop: Codex's usage target is reached, weekly 55% of 50%/);
    assert.doesNotMatch(said, /PRIVATE/);
    const kept = JSON.parse(fs.readFileSync(path.join(s.root, '.home', '.config', 'spool', 'usage.json'), 'utf8'));
    assert.deepEqual(kept.agents.Codex, { used: { weekly: 55, fiveHour: 30 }, at: minutes(10), by: 'Codex GPT-6.1 Sol' }, 'as old as the line it was read from');
    assert.doesNotMatch(JSON.stringify(kept), /PRIVATE|plus|1200/, 'nothing but the figures is kept');
    assert.deepEqual(s.json('usage', '--as', 'Claude').read.used, { weekly: 20 });

    // Raised, Codex takes the next.
    s.sp('target', '--agent', 'Codex', '--weekly', '90');
    assert.match(s.sp('next', '--claim', '--as', 'Codex GPT-6.1 Sol'), /^t-/);

    // A window that has reset since the line was written is at 0 again; read for Codex by another, it is still Codex's.
    session(s, 'new', [limitsLine(minutes(20), 97, 58, { fiveHour: minutes(21), weekly: minutes(7 * 1440) })]);
    const read = s.json('usage', '--from-codex', '--as', 'Claude Opus 5.5');
    assert.deepEqual([read.agent, read.read.used, read.read.by], ['Codex', { weekly: 58, fiveHour: 0 }, 'Codex, from its session log']);

    // Hours on, the log is old: said so, and it refuses nothing.
    s.sp('target', '--agent', 'Codex', '--weekly', '50');
    s.advance(6);
    assert.match(s.sp('usage', '--from-codex', '--as', 'Codex'), /Codex's session log was last written \S+ ago, so this is not taken as its usage now/);
    assert.match(s.sp('next', '--claim', '--as', 'Codex GPT-6.1 Sol'), /^t-/);

    // Figures typed with it are refused: it reads its own.
    assert.match(s.fails('usage', '--from-codex', '--weekly', '3', '--as', 'Codex'), /--from-codex reads the figures itself/);
  } finally {
    s.cleanup();
  }
});

test("the board's meter shows Codex's own plan from its log beside Claude's", async () => {
  const s = spool();
  s.sp('builder', 'chat');
  s.sp('builder', '--agent', 'Codex', '--at-once', '1');
  // The page runs on the real clock: a line written just now, its windows resetting later.
  const now = Date.now();
  const at = (h: number) => new Date(now + h * 3600_000).toISOString();
  session(s, 'now', [limitsLine(at(0), 12, 34, { fiveHour: at(3), weekly: at(100) })]);
  const page = await startPage(s);
  try {
    s.sp('usage', '--weekly', '62', '--as', 'Claude Opus 5.5');
    const b: any = await (await fetch(`${page.url}api/board`)).json();
    const by = Object.fromEntries(b.runner.agents.map((a: any) => [a.name, a.usage]));
    assert.deepEqual(by.Claude.read.used, { weekly: 62 });
    assert.deepEqual([by.Codex.read.used, by.Codex.read.by], [{ weekly: 34, fiveHour: 12 }, 'Codex, from its session log']);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
