/**
 * Codex's own usage, read from its session logs.
 *
 * Codex runs on the human's ChatGPT plan, whose limits are its own: a 5-hour window and a weekly
 * one, apart from Claude's. With each turn Codex writes the plan's rate limits into the session it
 * is in (`$CODEX_HOME/sessions/<year>/<month>/<day>/rollout-*.jsonl`): an event whose payload has
 * `rate_limits`, with a `primary` and a `secondary` window, each the percent used, the window's
 * length in minutes and when it resets. Spool reads only those figures and the time of the line,
 * the newest there is, and never anything else in the log: the rest is the human's conversation.
 *
 * The shorter window (300 minutes on the plans seen) is the 5-hour limit, the longer (10080) the
 * weekly one. A window that has reset since the line was written is at 0 again.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx } from './context.ts';

/** What Codex's newest session says of its plan: the percent of each limit used, and when. */
export interface CodexLimits {
  used: { weekly?: number; fiveHour?: number };
  /** When Codex wrote it: the time of the log line. */
  at: string;
  /** Each window's length in minutes, as the plan has them. */
  windows: { weekly?: number; fiveHour?: number };
}

/** Where Codex keeps its sessions: `$CODEX_HOME/sessions`, `~/.codex/sessions` by default. Empty where there is no home. */
export function codexSessionsDir(ctx: Ctx): string {
  const home = ctx.env.CODEX_HOME || (ctx.env.HOME ? path.join(ctx.env.HOME, '.codex') : '');
  return home ? path.join(home, 'sessions') : '';
}

/** The session logs under the folder, newest written first. */
function sessionFiles(dir: string): Array<{ file: string; mtimeMs: number; size: number }> {
  const out: Array<{ file: string; mtimeMs: number; size: number }> = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // Gone since it was listed.
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

type Window = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };

const isPercent = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/** One log line's limits, or null where the line carries none. Only the usage figures are looked at. */
function limitsOf(line: string, now: Date): CodexLimits | null {
  if (!line.includes('"rate_limits"')) return null;
  let o: { timestamp?: unknown; payload?: { rate_limits?: { limit_id?: unknown; primary?: Window | null; secondary?: Window | null } | null } };
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const r = o?.payload?.rate_limits;
  if (!r || typeof r !== 'object' || typeof o.timestamp !== 'string' || Number.isNaN(Date.parse(o.timestamp))) return null;
  // Codex's own limit; another one a model may have alongside it is not the plan's.
  if (r.limit_id !== undefined && r.limit_id !== null && r.limit_id !== 'codex') return null;
  const windows = [r.primary, r.secondary]
    .filter((w): w is Window => !!w && typeof w === 'object' && isPercent(w.used_percent) && typeof w.window_minutes === 'number' && w.window_minutes > 0)
    .map((w) => {
      const resets = typeof w.resets_at === 'number' ? w.resets_at * 1000 : Number.NaN;
      // Reset since the line was written: none of the new window is used yet, as far as anyone knows.
      return { minutes: w.window_minutes as number, used: resets <= now.getTime() ? 0 : (w.used_percent as number) };
    })
    .sort((a, b) => a.minutes - b.minutes);
  if (!windows.length) return null;
  const out: CodexLimits = { used: {}, at: new Date(o.timestamp).toISOString(), windows: {} };
  // Two windows: the shorter is the 5-hour, the longer the weekly. One: by its length, a day or less is the 5-hour.
  const pairs: Array<['fiveHour' | 'weekly', { minutes: number; used: number }]> =
    windows.length >= 2 ? [['fiveHour', windows[0]!], ['weekly', windows[windows.length - 1]!]] : [[windows[0]!.minutes <= 1440 ? 'fiveHour' : 'weekly', windows[0]!]];
  for (const [limit, w] of pairs) {
    out.used[limit] = w.used;
    out.windows[limit] = w.minutes;
  }
  return out;
}

/** The last line with limits in a file, read from its end, a piece at a time. */
function lastLimitsIn(file: string, size: number, now: Date): CodexLimits | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const CHUNK = 256 * 1024;
    let end = size;
    let carry = '';
    // Enough to pass a long stretch of turns with none, not so much a huge log is read whole.
    for (let read = 0; end > 0 && read < 16 * 1024 * 1024; ) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      read += buf.length;
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      // The first piece may be the end of a line that starts in the piece before.
      carry = start > 0 ? lines.shift()! : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = limitsOf(lines[i]!, now);
        if (found) return found;
      }
      end = start;
    }
    return carry ? limitsOf(carry, now) : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Kept per file as it was, so a board drawn every few seconds does not read the same log again. */
const seen = new Map<string, { mtimeMs: number; size: number; limits: CodexLimits | null; at: number }>();

/**
 * Codex's plan usage from its newest session that has any, or null where there is none to read:
 * no Codex here, or it is signed in with an API key, which has no plan limits.
 */
export function codexLimits(ctx: Ctx): CodexLimits | null {
  const dir = codexSessionsDir(ctx);
  if (!dir) return null;
  const now = ctx.now();
  // The newest few: a session just opened may not have had a turn yet.
  for (const f of sessionFiles(dir).slice(0, 5)) {
    const kept = seen.get(f.file);
    // A reset changes the figures without the file changing, so a kept one is good for a minute.
    const limits =
      kept && kept.mtimeMs === f.mtimeMs && kept.size === f.size && now.getTime() - kept.at < 60_000 && now.getTime() >= kept.at
        ? kept.limits
        : lastLimitsIn(f.file, f.size, now);
    seen.set(f.file, { mtimeMs: f.mtimeMs, size: f.size, limits, at: now.getTime() });
    if (limits) return limits;
  }
  return null;
}
