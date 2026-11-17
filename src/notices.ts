/**
 * What tells the human, and how: the events they picked to hear of, for every project.
 *
 * The human leaves and comes back. The right few notifications replace checking in, and the rest
 * are quiet. They pick the events on the board, or say so in a chat that runs `spool notify`. The
 * pick is the human's, not a project's, so it is kept in their own settings
 * (`~/.config/spool/config.json`, under `notifyOn`) and holds wherever they work.
 *
 * How each is sent depends on who builds. In Chat mode the chat that builds sends it, as one short
 * line through the Claude app (Claude Code's `PushNotification` tool): before it sends one it runs
 * `spool notify check <event>`, which says send or quiet. Headless, the page runs the user's
 * notifier (`notify` in context.ts) for the events picked, and nothing for the rest.
 */

import { type Ctx, saveUserConfig, userConfig } from './context.ts';
import { SpoolError } from './model.ts';

/** Every event that can tell the human, in the order the board and the command list them. */
export const EVENTS = ['started', 'done', 'question', 'sprint', 'empty', 'stuck', 'budget'] as const;
export type NoticeEvent = (typeof EVENTS)[number];

/** What each one is, in a few words. */
export const EVENT_NAMES: Record<NoticeEvent, string> = {
  started: 'A thread starts',
  done: 'A thread is done',
  question: 'A question is asked',
  sprint: 'A sprint is finished',
  empty: 'Build is empty',
  stuck: 'An agent is stuck or refused',
  budget: 'A run stops at its usage target',
};

/**
 * What tells them with nothing said: what always did. A question or a plan to approve, Build empty
 * or everything done, an agent that cannot go on, the usage target reached. Never progress.
 */
export const DEFAULT_ON: readonly NoticeEvent[] = ['question', 'empty', 'stuck', 'budget'];

export interface Notices {
  /** The events that tell them, in the order of EVENTS. */
  on: NoticeEvent[];
  /** Nothing has been picked, so these are the defaults. */
  default: boolean;
  /** The notifier a headless build runs, or empty where none is set. */
  notifier: string;
}

const isEvent = (v: unknown): v is NoticeEvent => typeof v === 'string' && (EVENTS as readonly string[]).includes(v);

/** The events picked, or the defaults where nothing is: anything that is not an event is left out. */
export function noticesOf(ctx: Ctx): Notices {
  const config = userConfig(ctx);
  const picked = Array.isArray(config.notifyOn) ? config.notifyOn.filter(isEvent) : null;
  const on = picked ?? [...DEFAULT_ON];
  return {
    on: EVENTS.filter((e) => on.includes(e)),
    default: picked === null,
    notifier: ctx.env.SPOOL_NOTIFY ?? config.notify ?? '',
  };
}

/** Whether this event tells them. */
export function notifies(ctx: Ctx, event: NoticeEvent): boolean {
  return noticesOf(ctx).on.includes(event);
}

/** The events as typed, `started question` or `started,question`; `all` is every one, `none` none. */
function eventsOf(words: string[]): NoticeEvent[] {
  const out: NoticeEvent[] = [];
  for (const word of words.flatMap((w) => w.split(',')).map((w) => w.trim().toLowerCase()).filter(Boolean)) {
    if (word === 'all') out.push(...EVENTS);
    else if (word === 'none') continue;
    else if (isEvent(word)) out.push(word);
    else throw new SpoolError(`"${word}" is not something that can notify you`, `It is one of: ${EVENTS.join(', ')}. As in: spool notify on started question`);
  }
  return out;
}

function listText(n: Notices): string {
  const width = Math.max(...EVENTS.map((e) => e.length));
  return [
    `Notify on: ${n.on.length ? n.on.join(', ') : 'nothing'}${n.default ? ' (the default)' : ''}. Everything else is quiet.`,
    ...EVENTS.map((e) => `  ${n.on.includes(e) ? '●' : '○'} ${e.padEnd(width)}  ${EVENT_NAMES[e]}`),
    '  In Chat mode the chat that builds sends each as one line, a Claude notification.',
    n.notifier ? `  Headless, the page runs your notifier: ${n.notifier}` : '  Headless, nothing is sent: no notifier is set (notify in ~/.config/spool/config.json).',
  ].join('\n');
}

/**
 * `spool notify`: with nothing after it, what tells them. `on <events>` and `off <events>` change
 * those, `only <events>` sets exactly them, `default` goes back to the defaults, and
 * `check <event>` says whether to send one: what the chat that builds runs before it does.
 */
export function noticesCommand(ctx: Ctx, args: string[]): { text: string; data: Notices & { send?: boolean; event?: NoticeEvent } } {
  const [verb, ...rest] = args.map((a) => a.trim());
  const before = noticesOf(ctx);
  if (!verb) return { text: listText(before), data: before };
  const how = 'spool notify [on | off | only] <events>, spool notify default, or spool notify check <event>';
  if (verb === 'check') {
    if (rest.length !== 1 || !isEvent(rest[0]!.toLowerCase())) throw new SpoolError('which event?', `spool notify check <event>, one of: ${EVENTS.join(', ')}`);
    const event = rest[0]!.toLowerCase() as NoticeEvent;
    const send = before.on.includes(event);
    return {
      text: send ? `Send it: ${EVENT_NAMES[event].toLowerCase()} tells them. One short line.` : `Quiet: ${event} is off. Send nothing for it.`,
      data: { ...before, send, event },
    };
  }
  let next: NoticeEvent[] | null;
  if (verb === 'default') {
    if (rest.length) throw new SpoolError('default takes nothing after it', how);
    next = null;
  } else if (verb === 'on' || verb === 'off' || verb === 'only') {
    const named = eventsOf(rest);
    if (!named.length && verb !== 'only') throw new SpoolError(`which events, ${verb}?`, how);
    next = verb === 'only' ? named : verb === 'on' ? [...before.on, ...named] : before.on.filter((e) => !named.includes(e));
  } else {
    throw new SpoolError(`spool notify cannot ${verb}`, how);
  }
  saveUserConfig(ctx, (config) => {
    // The defaults are what nothing said means, so nothing is kept for them.
    if (next === null) delete config.notifyOn;
    else config.notifyOn = EVENTS.filter((e) => next!.includes(e));
  });
  const after = noticesOf(ctx);
  return { text: listText(after), data: after };
}
