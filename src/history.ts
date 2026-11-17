import type { Command } from './commands.ts';
import { SpoolError, deserialize, type Spool } from './model.ts';
import { type QueueEntry, QUEUE_ITEM, associatedCommand, queueEntry, queueHistory, undoQueue } from './queue-journal.ts';
import { offError, readConfig } from './store.ts';

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
  return diff(lines(entry.before), lines(entry.after));
}

/** The lines taken out and put in, in file order, around what both copies share. */
function diff(before: string[], after: string[]): string[] {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const out = (line: string, sign: '-' | '+') => `    ${sign} ${line}`;
  // A long rewrite is shown whole rather than matched line by line.
  if (a.length * b.length > 250_000) return [...a.map((line) => out(line, '-')), ...b.map((line) => out(line, '+'))];
  // The longest run of lines both share, so an edit near the top and a log line at the foot show as two changes.
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!)) {
      lines.push(out(a[i++]!, '-'));
    } else {
      lines.push(out(b[j++]!, '+'));
    }
  }
  return lines;
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

/** A history entry cannot bring a thread back into Build past a locked gate. */
function restoresBuild(spool: Spool, entry: QueueEntry): boolean {
  if (!entry.target.startsWith('t-')) return false;
  const inBuild = (text: string | null): boolean => {
    if (text === null) return false;
    const item = deserialize(text, spool);
    return item.status === 'open' && !item.hold && !item.archived;
  };
  return inBuild(entry.before) && !inBuild(entry.after);
}

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
      // Workspace discovery can precede another command changing the config; enforce the live gate under the lock.
      const config = readConfig(spool.root);
      if (config.disabled) throw offError(spool.name);
      if (spool !== ws.home && readConfig(ws.home.root).disabled) throw offError(ws.home.name);
      if (config.gate === 'locked' && !ctx.tty && !ctx.human &&
        (entry.target === 'config' || restoresBuild(spool, entry))) {
        throw new SpoolError(
          `spool undo is the human's alone in ${spool.name}: its gate is locked`,
          'The human can undo this entry at their terminal.',
        );
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
