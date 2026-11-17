import type { Command } from './commands.ts';
import { SpoolError } from './model.ts';
import { type QueueEntry, QUEUE_ITEM, associatedCommand, queueEntry, queueHistory, undoQueue } from './queue-journal.ts';
import { offError } from './store.ts';

const PROJECT = { project: { type: 'string', short: 'P' } } as const;
const FILES = ['config', 'policy', 'goals'];

function shown({ hash: _hash, beforeMode: _mode, ...entry }: QueueEntry): Omit<QueueEntry, 'hash' | 'beforeMode'> {
  return entry;
}

function changes(entry: Pick<QueueEntry, 'target' | 'before' | 'after'>): string[] {
  if (entry.before === null || entry.after === null) return [];
  const lines = (text: string) => {
    // An item's automatic timestamp is already printed on the entry.
    const parts = QUEUE_ITEM.test(entry.target) ? text.split('\n---\n') : [];
    if (parts.length > 1) parts[0] = parts[0]!.replace(/^updated: .*\n?/m, '');
    return (parts.length > 1 ? parts.join('\n---\n') : text).trimEnd().split('\n');
  };
  const before = lines(entry.before);
  const after = lines(entry.after);
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return [
    ...before.slice(start, endBefore).map((line) => `    - ${line}`),
    ...after.slice(start, endAfter).map((line) => `    + ${line}`),
  ];
}

export const HISTORY: Command = {
  name: 'history',
  group: 'see',
  usage: 'history <id|policy|config|goals> [-P <project>]',
  summary: 'Show the queue writes on an item or a project file, with their entry ids',
  options: PROJECT,
  refusedWhenOff: false,
  run({ ws, args, opts, p }) {
    if (args.length !== 1) throw new SpoolError('which item or project file?', 'spool history <id|policy|config|goals>');
    const ref = args[0]!.trim().toLowerCase();
    const project = typeof opts.project === 'string' ? ws.project(opts.project) : undefined;
    const exact = QUEUE_ITEM.test(ref) ? ws.find(ref) : undefined;
    const item = exact ?? (FILES.includes(ref) || QUEUE_ITEM.test(ref) ? undefined : ws.get(ref));
    const target = item?.id ?? ref;
    const targets = target.startsWith('t-') ? [target, `report-${target}`] : [target];
    const spools = project ? [project] : item ? [item.spool] : FILES.includes(target) ? [ws.home] : ws.spools;
    const entries = spools.flatMap((spool) => queueHistory(spool, targets).map((entry) => ({
      ...shown(entry), project: spool.name, hint: associatedCommand(spool, entry),
    })));
    if (!entries.length) return { text: `No queue writes recorded for ${target}.`, data: { target, entries } };
    const text = entries.flatMap((entry) => {
      const action = entry.undoOf ? `undid ${entry.undoOf}` : entry.before === null ? 'created' : entry.after === null ? 'removed' : 'changed';
      return [
        `${p.bold(entry.id)}  ${entry.at}  ${entry.actor} · ${entry.command} · ${action} ${entry.target}`,
        ...changes(entry),
        ...(entry.hint ? [p.dim(`    ${entry.hint}`)] : []),
      ];
    }).join('\n');
    return { text, data: { target, entries } };
  },
};

export const UNDO: Command = {
  name: 'undo',
  group: 'you',
  usage: 'undo <entry>',
  summary: 'Restore the queue file before a history entry, if it is still as that entry left it',
  human: true,
  write: true,
  refusedWhenOff: false,
  run({ ws, args, ctx, p }) {
    if (args.length !== 1) throw new SpoolError('which history entry?', 'spool undo <entry>');
    const id = args[0]!;
    for (const spool of ws.spools) {
      const entry = queueEntry(spool, id);
      if (!entry) continue;
      const hint = associatedCommand(spool, entry);
      if (hint) throw new SpoolError(`${id} has effects outside this queue file`, hint);
      if (ws.home.config.disabled) throw offError(ws.home.name);
      if (entry.target === 'config' && spool.config.gate === 'locked' && !ctx.tty && !ctx.human) {
        throw new SpoolError(`${spool.name}'s gate is locked`, 'The human can undo this config change at their terminal.');
      }
      if (entry.before === null && QUEUE_ITEM.test(entry.target)) {
        const links = ws.items.filter((item) => item.id !== entry.target &&
          (item.needs.includes(entry.target) || item.from.includes(entry.target) || item.sprint === entry.target));
        if (links.length) throw new SpoolError(`${entry.target} is used by ${links.map((item) => item.id).join(', ')}`);
      }
      const undo = undoQueue(spool, entry, ws.writer, ws.now());
      return {
        text: `${p.bold(id)} undone. ${entry.target} ${entry.before === null ? 'was removed' : 'was restored'}.\n  History entry ${undo.id}`,
        data: { undone: id, entry: shown(undo), project: spool.name },
      };
    }
    throw new SpoolError(`no history entry "${id}"`, 'Find an entry with spool history <id>');
  },
};
