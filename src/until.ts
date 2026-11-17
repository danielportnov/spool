/**
 * A time to work: how long the agents build, or until when, alongside the usage target.
 *
 * The user says `spool for 2h` or `spool until 1:00`, in the chat or under Settings on the page.
 * It is a budget like the usage (usage.ts, `headroomOf`): the share of the window gone takes the
 * same headroom steps, so as the end nears the chat that builds starts only threads small enough to
 * finish, lands or hands off what it has in flight, and takes nothing new once the end has passed. It is a soft end, an estimate to finish by: nothing is
 * stopped at it, and an agent that needs a minute or two past it to land cleanly does so.
 *
 * Like the usage target, it is the user's for every project, kept in their own settings
 * (`workUntil` in `~/.config/spool/config.json`): when it was set, and the end.
 */

import { type Ctx, saveUserConfig, userConfig } from './context.ts';
import { SpoolError } from './model.ts';

/** The time budget as kept: the end, and when it was set, so how much of it is gone can be said. */
export interface TimeBudget {
  /** When the agents should be done by, as an ISO time. */
  end: string;
  /** When it was set: the start of the window. */
  from: string;
}

/** Where the time budget stands now, for the commands and the page. */
export interface TimeView extends TimeBudget {
  /** Whole minutes to the end, 0 once it has passed. */
  leftMinutes: number;
  /** How much of the window is gone, 0 to 100. */
  usedPercent: number;
  /** The end has passed: no new thread is taken. */
  passed: boolean;
  /** "time to work until 1:00, 25 min left". */
  why: string;
}

function budgetOf(ctx: Ctx): TimeBudget | null {
  const kept = userConfig(ctx).workUntil;
  if (!kept || typeof kept.end !== 'string' || typeof kept.from !== 'string') return null;
  if (Number.isNaN(Date.parse(kept.end)) || Number.isNaN(Date.parse(kept.from))) return null;
  return { end: kept.end, from: kept.from };
}

/** How much of the window from `from` to `end` is gone at `now`, 0 to 100: the share a headroom reads. */
export function timeUsedPercent(budget: TimeBudget, now: Date): number {
  const from = Date.parse(budget.from);
  const span = Date.parse(budget.end) - from;
  if (span <= 0) return 100;
  return Math.min(100, Math.max(0, ((now.getTime() - from) / span) * 100));
}

/** "1:00", "13:30": the end as a clock shows it, in this machine's time. */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "25 min", "1h 20m". */
export function minutesText(n: number): string {
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The time budget now, or null where none is set. */
export function timeOf(ctx: Ctx): TimeView | null {
  const budget = budgetOf(ctx);
  if (!budget) return null;
  const now = ctx.now();
  const leftMs = Date.parse(budget.end) - now.getTime();
  const passed = leftMs <= 0;
  const leftMinutes = passed ? 0 : Math.ceil(leftMs / 60_000);
  const at = `time to work until ${clockOf(budget.end)}`;
  return {
    ...budget,
    leftMinutes,
    usedPercent: Math.round(timeUsedPercent(budget, now)),
    passed,
    why: passed ? `${at}, and it has passed` : `${at}, ${minutesText(leftMinutes)} left`,
  };
}

/**
 * The end "1:00" says, read on this machine's clock: the next time the clock shows it. Without am or
 * pm, an hour from 1 to 12 is whichever of its two times comes first, so "until 1:00" at ten in the
 * morning is one in the afternoon, and at eleven at night is one in the morning.
 */
export function endOfClock(typed: string, now: Date): Date | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(typed.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const half = m[3]?.toLowerCase().replace(/\./g, '');
  if (min > 59 || h > 23 || (m[2] === undefined && !half)) return null;
  if (half && (h < 1 || h > 12)) return null;
  const hours = half ? [(h % 12) + (half === 'pm' ? 12 : 0)] : h >= 1 && h <= 12 ? [h % 12, (h % 12) + 12] : [h];
  let best: Date | null = null;
  for (const hour of hours) {
    const at = new Date(now);
    at.setHours(hour, min, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    if (!best || at < best) best = at;
  }
  return best;
}

/** A length of time as typed, "2h", "90m", "1h30m", "1.5h", in minutes, or null. */
export function minutesOf(typed: string): number | null {
  const t = typed.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(?:(\d+(?:\.\d+)?)h(?:ours?|rs?)?)?(?:(\d+)m(?:in(?:utes?|s)?)?)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const n = Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
  return n >= 1 && n <= 24 * 60 ? n : null;
}

function save(ctx: Ctx, budget: TimeBudget | null): void {
  saveUserConfig(ctx, (config) => {
    if (budget) config.workUntil = budget;
    else delete config.workUntil;
  });
}

/** What is set, in words, for both commands. */
function timeText(t: TimeView | null): string {
  if (!t) {
    return [
      'No time to work set: the chat that builds goes on as long as Build has work and the usage target allows.',
      '  Set one under Settings on the page, or: spool for 2h, or spool until 1:00',
    ].join('\n');
  }
  const lead = t.passed
    ? `Time to work: until ${clockOf(t.end)}, which has passed. The chat takes no new thread; what is being built lands.`
    : `Time to work: until ${clockOf(t.end)}, ${minutesText(t.leftMinutes)} left. As it nears the chat starts only what it can finish, as near the usage target, and takes nothing new after it.`;
  return [lead, '  A soft end: nothing is stopped at it, and a minute or two past to land cleanly is fine.', '  Take it off: spool until none'].join('\n');
}

export type TimeResult = { text: string; data: { time: TimeView | null } };

/**
 * `spool until <time>|none`: the time to be done by, or none to take it off. With nothing after it,
 * says what is set. `guard` is the lock: it throws where the gate leaves this to the user.
 */
export function untilCommand(ctx: Ctx, typed: string | undefined, guard: () => void): TimeResult {
  if (typed !== undefined) {
    const word = typed.trim().toLowerCase();
    if (word === 'none' || word === 'off') {
      if (budgetOf(ctx)) {
        guard();
        save(ctx, null);
      }
    } else {
      const now = ctx.now();
      const end = endOfClock(typed, now);
      if (!end) {
        // "until 2h" is clear enough to take as a length.
        const n = minutesOf(typed);
        if (n === null) throw new SpoolError(`"${typed}" is not a time of day`, 'Say when to be done by: spool until 1:00, spool until 13:30 or spool until 11pm; for a length, spool for 2h');
        return forCommand(ctx, typed, guard);
      }
      guard();
      save(ctx, { end: end.toISOString(), from: now.toISOString() });
    }
  }
  const t = timeOf(ctx);
  return { text: timeText(t), data: { time: t } };
}

/** `spool for <length>`: work for this long from now, "2h", "90m" or "1h30m". */
export function forCommand(ctx: Ctx, typed: string | undefined, guard: () => void): TimeResult {
  if (typed === undefined) return untilCommand(ctx, undefined, guard);
  const word = typed.trim().toLowerCase();
  if (word === 'none' || word === 'off') return untilCommand(ctx, 'none', guard);
  const n = minutesOf(typed);
  if (n === null) throw new SpoolError(`"${typed}" is not a length of time`, 'Say how long, up to a day: spool for 2h, spool for 90m or spool for 1h30m; for a time of day, spool until 1:00');
  guard();
  const now = ctx.now();
  save(ctx, { end: new Date(now.getTime() + n * 60_000).toISOString(), from: now.toISOString() });
  const t = timeOf(ctx);
  return { text: timeText(t), data: { time: t } };
}

