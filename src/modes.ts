/**
 * Modes: a named preset over the switches that already exist.
 *
 * A mode is only settings. Picking one flips the switches it names (AFK, take-over, a time to work,
 * the usage target, the lean, threads at once, caveman, what notifies) through the very writers
 * behind `spool afk`, `spool takeover`, `spool until`, `spool target`, `spool builder`,
 * `spool settings` and `spool notify`, so nothing new is there for an agent to obey. Where the gate
 * is locked, the same lock holds: a mode that switches AFK or take-over on is the user's.
 *
 * What a mode set, and what was there before it, are kept in the user's own settings (`mode` in
 * `~/.config/spool/config.json`), so `spool mode` can say which is on, and "changed" once a switch
 * was moved by hand, and `spool mode off` can put back what was there.
 *
 * Other parts add to this: each built-in mode is a row of PRESETS, and a switch a mode can move is
 * a row of SWITCHES. A preset names only the switches it moves; the rest are left as they are.
 */

import type { Call, Result } from './commands.ts';
import { type Ctx, afkOf, cavemanOf, parallelOf, saveUserConfig, userConfig } from './context.ts';
import { LEANS } from './agent.ts';
import { builderCommand } from './builder.ts';
import { type Spool, SpoolError } from './model.ts';
import { DEFAULT_ON, EVENTS, noticesCommand, noticesOf } from './notices.ts';
import { leanAt, rosterOf } from './roster.ts';
import { settingsCommand } from './settings.ts';
import { takeOverOf, takeoverCommand } from './takeover.ts';
import { clockOf, timeOf, untilCommand } from './until.ts';
import { type Figures, LIMITS, figuresText, targetCommand, targetOf } from './usage.ts';

/** A value a switch holds, as kept in the mode's record. */
export type Value = boolean | number | string | null | string[] | { [key: string]: number | string };

/** What a mode is applied with: the command's call, the project it is for, and the lock. */
export interface ModeEnv {
  call: Call;
  spool: Spool;
  /** Throws where the project's gate leaves this verb to the user. */
  guard: (verb: string) => void;
}

/** One switch a mode can move. */
export interface Switch {
  key: string;
  /** Its name in a line: "AFK", "Take-over". */
  label: string;
  /** What it holds now, for this project. */
  read: (ctx: Ctx, root: string) => Value;
  /** Set it, through the writer its own command uses. */
  write: (env: ModeEnv, value: Value) => void;
  /** The value in a word or two. */
  shown: (value: Value) => string;
  /** The verb the lock is asked about, moving from `was` to `to`; null where anyone may. */
  locks: (was: Value, to: Value) => string | null;
}

const onOff = (v: Value): string => (v ? 'on' : 'off');
const same = (a: Value, b: Value): boolean => JSON.stringify(a) === JSON.stringify(b);

export const SWITCHES: readonly Switch[] = [
  {
    key: 'afk',
    label: 'AFK',
    read: (ctx) => afkOf(ctx),
    // `spool afk` has no function of its own to call: it is this one line, under the same lock.
    write: ({ call }, v) => void saveUserConfig(call.ctx, (c) => { if (v) c.afk = true; else delete c.afk; }),
    shown: onOff,
    locks: (_, to) => (to ? 'afk on' : null),
  },
  {
    key: 'takeover',
    label: 'Take-over',
    read: (ctx, root) => takeOverOf(ctx, root),
    write: (env, v) => void takeoverCommand({ ...env.call, args: [v ? 'on' : 'off'] }, env.spool, () => env.guard('takeover on')),
    shown: onOff,
    locks: (_, to) => (to ? 'takeover on' : null),
  },
  {
    key: 'caveman',
    label: 'Caveman',
    read: (ctx) => cavemanOf(ctx),
    // As `spool caveman` does, anyone's.
    write: ({ call }, v) => void settingsCommand(call.ctx, ['caveman', v ? 'on' : 'off'], () => {}),
    shown: onOff,
    locks: () => null,
  },
  {
    key: 'time',
    label: 'Time to work',
    read: (ctx) => timeOf(ctx)?.end ?? null,
    // A preset says it as typed ("8:00", "2h", "none"); what was kept is the end it had, put back as its clock.
    write: (env, v) => {
      let typed = typeof v === 'string' ? v : 'none';
      if (/^\d{4}-\d\d-\d\dT/.test(typed)) typed = Date.parse(typed) > env.call.ctx.now().getTime() ? clockOf(typed) : 'none';
      untilCommand(env.call.ctx, typed, () => env.guard('until'));
    },
    shown: (v) => (typeof v === 'string' ? (/^\d{4}-/.test(v) ? `until ${clockOf(v)}` : v) : 'none'),
    locks: () => 'until',
  },
  {
    key: 'target',
    label: 'Usage target',
    read: (ctx) => ({ ...targetOf(ctx) }),
    write: (env, v) => {
      const figures = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Figures;
      const typed = Object.fromEntries(LIMITS.map((l) => [l, figures[l] === undefined ? 'none' : String(figures[l])]));
      targetCommand(env.call.ctx, typed, () => env.guard('target'));
    },
    shown: (v) => figuresText((v ?? {}) as Figures) || 'none',
    locks: () => 'target',
  },
  {
    key: 'atOnce',
    label: 'Threads at once',
    read: (ctx) => parallelOf(ctx),
    write: (env, v) => void builderCommand(env.call.ctx, env.call.ws, env.spool, { atOnce: String(v) }, env.call.actor, () => env.guard('builder')),
    shown: (v) => String(v),
    locks: () => 'builder',
  },
  {
    key: 'lean',
    label: 'Lean',
    // Each agent on the roster has its own: a preset gives one for all, what was kept is each one's.
    read: (ctx, root) => Object.fromEntries(rosterOf(ctx, root).map((e) => [e.name, leanAt(e)])),
    write: (env, v) => {
      for (const e of rosterOf(env.call.ctx, env.spool.root)) {
        const lean = typeof v === 'string' ? v : (v as Record<string, string> | null)?.[e.name];
        if (!lean || !(LEANS as readonly string[]).includes(lean)) continue;
        builderCommand(env.call.ctx, env.call.ws, env.spool, { agent: e.name, lean }, env.call.actor, () => env.guard('builder'));
      }
    },
    shown: (v) => (typeof v === 'string' ? v : [...new Set(Object.values((v ?? {}) as Record<string, string>))].join(', ') || 'balanced'),
    locks: () => 'builder',
  },
  {
    key: 'notify',
    label: 'Notifications',
    read: (ctx) => noticesOf(ctx).on,
    write: ({ call }, v) => {
      const on = Array.isArray(v) ? v : [];
      const isDefault = EVENTS.every((e) => on.includes(e) === DEFAULT_ON.includes(e));
      noticesCommand(call.ctx, isDefault ? ['default'] : ['only', ...on]);
    },
    shown: (v) => (Array.isArray(v) && v.length ? v.join(', ') : 'nothing'),
    locks: () => null,
  },
];

export function switchBy(key: string): Switch {
  const s = SWITCHES.find((w) => w.key === key);
  if (!s) throw new Error(`no switch ${key}`);
  return s;
}

/** A built-in mode: its name, who it is for, and the switches it moves. */
export interface Preset {
  /** As typed: `spool mode hands-on`. */
  name: string;
  /** As shown: "Hands-on". */
  label: string;
  /** Who it is for, in a line. */
  for: string;
  /** Each switch it moves, by key, and to what. */
  sets: Record<string, Value>;
}

/** The modes there are. Each other mode's own part adds its row here. */
export const PRESETS: Preset[] = [
  {
    name: 'hands-on',
    label: 'Hands-on',
    for: 'For when you are at the keyboard: you decide, agents ask',
    sets: { afk: false, takeover: false, notify: [...DEFAULT_ON] },
  },
];

/** The mode on with nothing said. */
export const DEFAULT_MODE = 'hands-on';

const plain = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function presetBy(name: string): Preset | undefined {
  return PRESETS.find((p) => plain(p.name) === plain(name) || plain(p.label) === plain(name));
}

/** What is kept of the mode that is on. */
export interface ModeRecord {
  name: string;
  label: string;
  /** The project it was picked in: take-over and the lean are a project's. */
  root: string;
  at: string;
  /** What it set, each switch as it read once set. */
  set: Record<string, Value>;
  /** What each of those was before the first mode, for `spool mode off`. */
  before: Record<string, Value>;
}

function recordOf(ctx: Ctx): ModeRecord | null {
  const kept = userConfig(ctx).mode;
  if (!kept || typeof kept !== 'object' || typeof kept.name !== 'string' || typeof kept.root !== 'string') return null;
  if (!kept.set || typeof kept.set !== 'object' || !kept.before || typeof kept.before !== 'object') return null;
  return kept as ModeRecord;
}

function saveRecord(ctx: Ctx, record: ModeRecord | null): void {
  saveUserConfig(ctx, (c) => {
    if (record) c.mode = record;
    else delete c.mode;
  });
}

/** Where the modes stand: which is on, and what was moved by hand since. */
export interface ModeState {
  /** The mode on, or null for the user's own settings. */
  name: string | null;
  /** "Hands-on", "Overnight, changed", "your own settings". */
  label: string;
  /** The labels of the switches moved by hand since the mode was picked. */
  changed: string[];
  /** Nothing was picked: Hands-on is on because the switches are as it sets them. */
  default: boolean;
}

/** The switches that read otherwise than `want`, for this project. */
function differing(ctx: Ctx, root: string, want: Record<string, Value>): Switch[] {
  return Object.entries(want).flatMap(([key, value]) => {
    const s = SWITCHES.find((w) => w.key === key);
    return s && !same(s.read(ctx, root), value) ? [s] : [];
  });
}

/** Which mode is on in this project, and whether a switch was moved by hand since. */
export function currentMode(ctx: Ctx, root: string): ModeState {
  const record = recordOf(ctx);
  if (record) {
    const changed = differing(ctx, record.root, record.set).map((s) => s.label);
    return { name: record.name, label: changed.length ? `${record.label}, changed` : record.label, changed, default: false };
  }
  const fallback = presetBy(DEFAULT_MODE)!;
  if (!differing(ctx, root, fallback.sets).length) return { name: fallback.name, label: fallback.label, changed: [], default: true };
  return { name: null, label: 'your own settings', changed: [], default: false };
}

/** One switch a command moved: from, to. */
export interface Moved {
  key: string;
  label: string;
  from: string;
  to: string;
}

/** Move the switches to these values: the lock first, for all of them, so a refusal moves none. */
function move(env: ModeEnv, want: Record<string, Value>): Moved[] {
  const { ctx } = env.call;
  const root = env.spool.root;
  const moving = Object.entries(want).flatMap(([key, to]) => {
    const s = switchBy(key);
    const was = s.read(ctx, root);
    return same(was, to) ? [] : [{ s, was, to }];
  });
  for (const { s, was, to } of moving) {
    const verb = s.locks(was, to);
    if (verb) env.guard(verb);
  }
  for (const { s, to } of moving) s.write(env, to);
  return moving.map(({ s, was }) => ({ key: s.key, label: s.label, from: s.shown(was), to: s.shown(s.read(ctx, root)) }));
}

export interface ModeResult {
  mode: ModeState;
  moved: Moved[];
}

/**
 * Put a mode on: move its switches, and keep what it set and what was there before. Picked over
 * another mode still as it set things, the first one's "before" is kept, so off goes all the way back.
 */
export function applyMode(env: ModeEnv, name: string): ModeResult {
  const preset = presetBy(name);
  if (!preset) throw new SpoolError(`"${name}" is not a mode`, `One of: ${PRESETS.map((p) => p.name).join(', ')}, or off`);
  const { ctx } = env.call;
  const root = env.spool.root;
  const record = recordOf(ctx);
  const untouched = record && record.root === root && !differing(ctx, root, record.set).length ? record : null;
  const before: Record<string, Value> = { ...(untouched?.before ?? {}) };
  for (const key of Object.keys(preset.sets)) if (!(key in before)) before[key] = switchBy(key).read(ctx, root);
  const moved = move(env, preset.sets);
  const set: Record<string, Value> = {};
  for (const key of new Set([...Object.keys(untouched?.set ?? {}), ...Object.keys(preset.sets)])) set[key] = switchBy(key).read(ctx, root);
  saveRecord(ctx, { name: preset.name, label: preset.label, root, at: ctx.now().toISOString(), set, before });
  return { mode: currentMode(ctx, root), moved };
}

/** `spool mode off`: put back what was there before the mode, and keep no mode. */
export function modeOff(env: ModeEnv): ModeResult & { was: string | null } {
  const { ctx } = env.call;
  const record = recordOf(ctx);
  if (!record) return { mode: currentMode(ctx, env.spool.root), moved: [], was: null };
  const moved = move({ ...env, spool: env.spool.root === record.root ? env.spool : { ...env.spool, root: record.root } }, record.before);
  saveRecord(ctx, null);
  return { mode: currentMode(ctx, env.spool.root), moved, was: record.label };
}

function movedText(moved: Moved[]): string[] {
  return moved.map((m) => `  ${m.label}: ${m.from} → ${m.to}`);
}

function stateText(ctx: Ctx, root: string, state: ModeState): string {
  const preset = state.name ? presetBy(state.name) : undefined;
  const lead = state.name
    ? `Mode: ${state.label}${state.default ? ' (the default)' : ''}.${preset ? ` ${preset.for}.` : ''}`
    : 'Mode: your own settings. No mode is on, and the switches are not as Hands-on sets them.';
  const sets = preset ? Object.entries(preset.sets).map(([key, v]) => {
    const s = switchBy(key);
    const now = s.read(ctx, root);
    return `  ${s.label}: ${s.shown(v)}${state.changed.includes(s.label) ? `, now ${s.shown(now)} (changed by hand)` : ''}`;
  }) : [];
  return [lead, ...(sets.length ? ['It sets:', ...sets] : []), `Modes: ${PRESETS.map((p) => p.name).join(', ')}. Pick one: spool mode <name>; put back what was before: spool mode off`].join('\n');
}

/** `spool mode`: with a name, put that mode on; `off`, put back what was before; with nothing, say which is on. */
export function modeCommand(env: ModeEnv, args: string[]): Result {
  const { ctx } = env.call;
  const root = env.spool.root;
  if (args.length > 1) throw new SpoolError('one mode at a time', 'spool mode hands-on, spool mode off, or spool mode to see which is on');
  const word = args[0]?.trim();
  if (!word) {
    const mode = currentMode(ctx, root);
    return { text: stateText(ctx, root, mode), data: { mode, modes: PRESETS } };
  }
  if (plain(word) === 'off') {
    const { mode, moved, was } = modeOff(env);
    const text = !was
      ? `No mode is on, so nothing to put back. Mode: ${mode.label}.`
      : [`${was} is off. ${moved.length ? 'Put back:' : 'Nothing to put back: the switches were already as before.'}`, ...movedText(moved), `Mode: ${mode.label}.`].join('\n');
    return { text, data: { mode, moved, was } };
  }
  const { mode, moved } = applyMode(env, word);
  const head = moved.length ? `${mode.label} is on. Changed:` : `${mode.label} is on. Nothing to change: the switches were already as it sets them.`;
  return { text: [head, ...movedText(moved), '  Put back what was before: spool mode off'].join('\n'), data: { mode, moved } };
}
