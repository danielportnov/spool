/**
 * `spool disable` and `spool enable`: Spool switched off in a project, and on again.
 *
 * Spool is one tool among others, and a project need not go through it. Switched off, a project's
 * queue is kept as it was, but nothing sends an agent to it: the Spool block comes out of its
 * CLAUDE.md and AGENTS.md (a file that held nothing else goes with it), its commands refuse and say
 * how to turn it back on, a page up for it starts no new work, and the folder above it leaves it
 * out. Switched on again, the block goes back in the files it came out of, and nowhere else.
 *
 * `--all` switches every spool in this folder and below it: one word for a folder of projects.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Bare, Command, Result } from './commands.ts';
import { pageUp } from './detach.ts';
import { type Config, SpoolError } from './model.ts';
import { AGENT_FILES, upsertBlock, withoutBlock } from './prime.ts';
import { writeQueue } from './queue-journal.ts';
import { SPOOL_DIR, findHome, readConfig, spoolsUnder, withSpoolLock, worktreeOwner } from './store.ts';

interface Switched {
  root: string;
  name: string;
  /** Whether this run changed it: false where it was already as asked. */
  changed: boolean;
  /** The files the block was taken out of, or put back in. */
  files: string[];
  /** Of those, the ones that held nothing but the block, and so went, or came back. */
  whole: string[];
  /** Where a page is still up for it. */
  page?: string;
}

function writeConfig(call: Bare, root: string, config: Config, command: 'disable' | 'enable'): void {
  writeQueue(path.join(root, SPOOL_DIR), 'config', `${JSON.stringify(config, null, 2)}\n`, { actor: call.actor, command }, call.ctx.now());
}

/** The spools to switch: the one this folder is in, or with `--all`, every one in it and below it. */
function targets(call: Bare): string[] {
  if (call.args.length) throw new SpoolError(`a folder is not named this way: ${call.args.join(' ')}`, 'Point it at one with -C <folder>');
  const from = worktreeOwner(call.ctx.cwd) ?? call.ctx.cwd;
  if (!call.opts.all) {
    const root = findHome(from);
    if (!root) throw new SpoolError('no .spool/ here or in any parent directory', 'Nothing to switch. --all switches every spool below this folder.');
    return [root];
  }
  const found = spoolsUnder(from);
  if (!found.length) throw new SpoolError('no spool in this folder or below it', 'Nothing to switch.');
  return found;
}

function switchOff(call: Bare, root: string): Switched {
  const config = readConfig(root);
  const files: string[] = [];
  const whole: string[] = [];
  for (const name of AGENT_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = withoutBlock(before);
    if (after === before) continue;
    if (after.trim()) fs.writeFileSync(file, after);
    else {
      fs.rmSync(file);
      whole.push(name);
    }
    files.push(name);
  }
  const was = config.disabled;
  if (!was || files.length) {
    const block = [...new Set([...(was?.block ?? []), ...files])];
    writeConfig(call, root, { ...config, disabled: { since: was?.since ?? call.ctx.now().toISOString(), block } }, 'disable');
  }
  return { root, name: config.name || path.basename(root), changed: !was || !!files.length, files, whole, page: pageUp(call.ctx, root)?.url };
}

function switchOn(call: Bare, root: string): Switched {
  const config = readConfig(root);
  const name = config.name || path.basename(root);
  const { disabled, ...on } = config;
  if (!disabled) return { root, name, changed: false, files: [], whole: [] };
  const files: string[] = [];
  const whole: string[] = [];
  // The names come from a project's own file, so only the two Spool writes are taken from it.
  for (const want of disabled.block ?? []) {
    if (!AGENT_FILES.includes(want)) continue;
    const file = path.join(root, want);
    const there = fs.existsSync(file);
    const before = there ? fs.readFileSync(file, 'utf8') : '';
    const after = upsertBlock(before);
    if (after === before) continue;
    fs.writeFileSync(file, after);
    files.push(want);
    if (!there) whole.push(want);
  }
  writeConfig(call, root, on, 'enable');
  return { root, name, changed: true, files, whole };
}

function both(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/** What was done to one project's agent files, in a few words. */
function offLine(s: Switched): string {
  if (!s.changed) return 'was already off';
  const kept = s.files.filter((f) => !s.whole.includes(f));
  const said = [
    ...(kept.length ? [`took the Spool block out of ${both(kept)}`] : []),
    ...(s.whole.length ? [`took out ${both(s.whole)}, which held only the Spool block`] : []),
  ];
  return said.length ? said.join('; ') : 'had no Spool block to take out';
}

function onLine(s: Switched): string {
  if (!s.changed) return 'was already on';
  const kept = s.files.filter((f) => !s.whole.includes(f));
  const said = [...(kept.length ? [`put the Spool block back in ${both(kept)}`] : []), ...(s.whole.length ? [`put ${both(s.whole)} back, with the Spool block in it`] : [])];
  return said.length ? said.join('; ') : 'had no Spool block taken out, so none was put back';
}

function report(call: Bare, done: Switched[], off: boolean): Result {
  const { p } = call;
  const here = path.resolve(call.ctx.cwd);
  const shown = (s: Switched): string => (s.root === here || !s.root.startsWith(here + path.sep) ? s.name : path.relative(here, s.root).split(path.sep).join('/'));
  const line = off ? offLine : onLine;
  const state = off ? 'off' : 'on';
  const changed = done.filter((s) => s.changed).length;
  const out: string[] = [];
  if (done.length === 1) {
    const [s] = done as [Switched];
    out.push(s.changed ? `Spool is ${state} in ${p.bold(s.name)}${off ? '' : ' again'}.` : `Spool is already ${state} in ${p.bold(s.name)}.`);
    if (s.changed) out.push(`  ${line(s).replace(/^./, (c) => c.toUpperCase())}.`);
  } else {
    const already = done.length - changed;
    out.push(`Spool is ${state} in ${done.length} projects${already ? ` (${already} already ${already > 1 ? 'were' : 'was'})` : ''}.`);
    const width = Math.max(...done.map((s) => shown(s).length));
    for (const s of done) out.push(`  ${shown(s).padEnd(width)}  ${p.dim(line(s))}`);
  }
  if (off) {
    for (const s of done.filter((s) => s.page)) {
      const at = path.relative(here, s.root);
      out.push(`A Spool page is still up for ${shown(s)} at ${s.page}. It starts no new work while Spool is off; spool page --stop${at ? ` -C ${at}` : ''} ends it.`);
    }
    if (changed) {
      const many = done.length > 1;
      out.push(`${many ? 'Their queues are kept as they were' : 'The queue is kept as it was'}. ${p.dim(`spool enable${call.opts.all ? ' --all' : ''} turns ${many ? 'them' : 'it'} back on.`)}`);
    }
  }
  const data = done.map(({ root, name, changed, files, whole }) => ({ root, name, on: !off, changed, files, whole }));
  return { text: out.join('\n'), data: done.length === 1 && !call.opts.all ? data[0] : { projects: data } };
}

export const DISABLE: Command = {
  name: 'disable',
  group: 'setup',
  usage: 'disable [--all]',
  summary: "Switch Spool off in this project: agents are not sent to it and its commands refuse, its queue kept as it was; --all does every spool in this folder and below",
  human: true,
  options: { all: { type: 'boolean' } },
  bare: (call) => report(call, targets(call).map((root) => withSpoolLock(path.join(root, SPOOL_DIR), () => switchOff(call, root))), true),
};

export const ENABLE: Command = {
  name: 'enable',
  group: 'setup',
  usage: 'enable [--all]',
  summary: 'Switch Spool back on where spool disable switched it off, putting the agents\' pointer back; --all does every spool in this folder and below',
  human: true,
  options: { all: { type: 'boolean' } },
  bare: (call) => report(call, targets(call).map((root) => withSpoolLock(path.join(root, SPOOL_DIR), () => switchOn(call, root))), false),
};
