/**
 * `spool doctor`: look at what a run needs and say, for each thing, whether it is there.
 *
 * Most first-run trouble is setup, and it arrives as a thread that failed for a reason buried in an
 * agent's output. This reads the same places the runner, the page and the loop read, in the same
 * order, and changes nothing. A check is fine, wrong (a run will fail or cannot start) or advice
 * (a run works, but something is easier with it). Only wrong ones fail the command.
 *
 * It also names what an upgrade leaves behind: a skill Spool has retired, still where an agent
 * finds it, and a Spool block in the project's agents file that is not the one this version writes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bare, Result } from './commands.ts';
import { SKILL_NAMES, installedIn, retiredIn, userSkillsDir, version } from './builtin.ts';
import { HARNESSES, copies, installedFor, others } from './harness.ts';
import { DEFAULT_AGENT } from './loop.ts';
import { builderOf, userConfig } from './context.ts';
import { git, repoRoot } from './git.ts';
import { blockIn } from './prime.ts';
import { SPOOL_DIR, Workspace, findHome, isOff, readConfig, skillsDir } from './store.ts';
import { strayFixes, strayLines, straysOf } from './strays.ts';
import { watched } from './watch.ts';

export interface Finding {
  id: string;
  status: 'ok' | 'advice' | 'wrong';
  /** What it is, in a few words. */
  label: string;
  /** The exact command or config line that fixes it, one string per line. */
  fix?: string[];
}

const MARK = { ok: '✓', advice: '!', wrong: '✗' } as const;

/** What `claude -p` needs said to it before it may edit files and commit; the same line README.md gives. */
const AGENT_LINE = `{ "agent": "claude -p --permission-mode acceptEdits --allowedTools 'Bash(spool *)' 'Bash(git *)' Edit Write Read" }`;
const PERMISSION_FLAGS = /(^|\s)(--permission-mode|--allowedTools|--allowed-tools|--dangerously-skip-permissions|--permission-prompt-tool)(\s|=|$)/;

/** The program a shell command starts first, past any `NAME=value` words; undefined where it is not a plain name or path. */
function programOf(command: string): string | undefined {
  const word = command.trim().split(/\s+/).find((w) => !/^\w+=/.test(w));
  return word && /^[\w./~@+-]+$/.test(word) ? word : undefined;
}

function runnable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a program would be found: a path is looked at where it points, a bare name along the PATH. */
function onPath(program: string, cwd: string, env: Record<string, string | undefined>): boolean {
  if (program.includes('/')) {
    return runnable(path.resolve(cwd, program.startsWith('~/') ? path.join(env.HOME ?? '', program.slice(2)) : program));
  }
  return (env.PATH ?? '').split(path.delimiter).some((dir) => dir && runnable(path.join(dir, program)));
}

/** The oldest Node `engines` allows, where it says so in the plain `>=20` way. */
function nodeWanted(): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { engines?: { node?: string } };
    return /^>=\s*(\d+(\.\d+){0,2})$/.exec(pkg.engines?.node ?? '')?.[1];
  } catch {
    return undefined;
  }
}

function atLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]!;
  }
  return true;
}

/** The version a skill copy was stamped with by `spool install`; undefined for one with no stamp (edited by hand). */
function stampedVersion(file: string): string | undefined {
  try {
    return /\n<!-- spool (\S+) · [0-9a-f]{12} ·/.exec(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'))?.[1];
  } catch {
    return undefined;
  }
}

export function diagnose({ ctx }: Bare): Finding[] {
  const out: Finding[] = [];
  const add = (id: string, status: Finding['status'], label: string, fix?: string[]): void => void out.push({ id, status, label, fix });
  const config = userConfig(ctx);

  // The project: where its files are, and whether git can undo and show what changed.
  const root = findHome(ctx.cwd);
  const off = root ? isOff(root) : false;
  if (root && off) add('spool', 'advice', `a spool in ${root}, switched off: agents are not sent to it and its commands refuse`, ['spool enable']);
  else if (root) add('spool', 'ok', `a spool in ${root}`);
  else add('spool', 'wrong', 'no spool here', ['spool init']);
  const base = root ?? ctx.cwd;
  if (!repoRoot(base)) {
    add('git', 'wrong', 'not a git repository: undo and "what changed" need one', ['git init && git add -A && git commit -m "First commit"']);
  } else if (!git(base, ['rev-parse', '--verify', '-q', 'HEAD']).ok) {
    add('git', 'wrong', 'a git repository with no commit yet: undo and "what changed" need one', ['git add -A && git commit -m "First commit"']);
  } else {
    add('git', 'ok', 'a git repository with commits');
  }

  let project: ReturnType<typeof readConfig> | undefined;
  if (root) {
    try {
      project = readConfig(root);
    } catch {
      add('gate', 'wrong', `${path.join(SPOOL_DIR, 'config.json')} cannot be read`, ['spool check']);
    }
    if (project?.gate === 'locked') add('gate', 'ok', 'the build gate is locked: only you move work to Build, on the page or in your own terminal');
    else if (project?.gate) add('gate', 'ok', 'the build gate is on: new work waits until you move it to Build');
    else if (project) add('gate', 'advice', 'the build gate is off: new threads go straight to Build, for any agent to take', ['spool init --gate']);

    // Work that landed on no thread: nothing undoes it or says why it is there.
    let ws: Workspace | undefined;
    try {
      ws = Workspace.open(root);
    } catch {
      ws = undefined;
    }
    const strays = ws ? straysOf(ws, ws.home) : null;
    if (strays && (strays.commits.length || strays.untracked.length)) {
      const [head, ...rest] = strayLines(strays);
      add('strays', 'advice', [head, ...rest.map((l) => `  ${l}`)].join('\n'), strayFixes(strays));
    } else if (strays) {
      add('strays', 'ok', `every commit since the first on a thread is on one${strays.versions ? `, but for ${strays.versions === 1 ? 'a version commit' : `${strays.versions} version commits`}, which are on none by design` : ''}`);
    }

    if (config.checks?.[root]) add('check', 'ok', `a check runs before a change is done: ${config.checks[root]}`);
    else add('check', 'advice', 'no check: a change is done when the agent says so', ['spool checks "npm test"']);
  }

  // The agent, found the way the page's runner and `spool loop` find it.
  const set = ctx.env.SPOOL_AGENT ? 'SPOOL_AGENT' : config.agent ? 'agent in ~/.config/spool/config.json' : 'the default';
  const agent = ctx.env.SPOOL_AGENT || config.agent || DEFAULT_AGENT;
  const program = programOf(agent);
  if (program && !onPath(program, ctx.cwd, ctx.env)) {
    const fix =
      set === 'the default'
        ? ['Install Claude Code (README.md, step 1), or name another agent in ~/.config/spool/config.json:', '{ "agent": "<your agent command>" }']
        : [`Install ${path.basename(program)}, or change ${set}`];
    add('agent', 'wrong', `the agent command starts ${program}, which is not on the PATH (${agent})`, fix);
  } else if (path.basename(program ?? '') === 'claude' && !PERMISSION_FLAGS.test(agent)) {
    add('agent', 'wrong', `the agent is ${agent}: it can read but not edit files or commit, so every thread ends with nothing done`, [
      'Put this in ~/.config/spool/config.json:',
      AGENT_LINE,
    ]);
  } else {
    add('agent', 'ok', `the agent command is ${agent} (${set})`);
  }

  // Who builds: the page starts the agent itself, or a chat running the loop does.
  if (root) {
    if (builderOf(ctx, root) !== 'chat') add('builder', 'ok', 'the page builds here, starting the agent itself (Headless)');
    else if (watched(root)) add('builder', 'ok', 'a chat builds here, and a spool watch is up');
    else add('builder', 'advice', 'a chat builds here, but no spool watch is up: nothing in Build will start', ['Run /spool-loop in a Claude Code chat in this project, or pick Headless on the page.']);
  }

  const notifier = ctx.env.SPOOL_NOTIFY ?? config.notify;
  if (notifier) add('notify', 'ok', `a notifier: ${notifier}`);
  else add('notify', 'advice', 'no notifier: nothing tells you when a thread needs you', ['{ "notify": "<a command; SPOOL_TITLE has what to say>" }  in ~/.config/spool/config.json']);

  // The skills, wherever the harness would find them.
  const dirs = [userSkillsDir(ctx)];
  if (root && project) dirs.push(skillsDir({ root, dir: path.join(root, SPOOL_DIR), name: path.basename(root), home: true, config: project }));
  const dir = dirs.find(installedIn);
  if (!dir) {
    add('skills', 'advice', 'the Spool skills are not installed for your agent', ['spool install']);
  } else {
    const missing = SKILL_NAMES.filter((n) => !fs.existsSync(path.join(dir, n, 'SKILL.md')));
    const old = SKILL_NAMES.filter((n) => {
      const was = stampedVersion(path.join(dir, n, 'SKILL.md'));
      return was !== undefined && was !== version();
    });
    if (missing.length) add('skills', 'advice', `the Spool skills in ${dir} lack ${missing.join(', ')}`, ['spool install']);
    else if (old.length) add('skills', 'advice', `the Spool skills in ${dir} are from an older version than ${version()}`, ['spool install']);
    else add('skills', 'ok', `the Spool skills are installed and match ${version()}`);
  }

  // Every other agent found on this machine, and whether Spool is installed for it.
  for (const h of others(ctx)) {
    const id = `harness-${h.name}`;
    if (h.fallback) {
      const settings = path.join(ctx.env.HOME ?? '', '.gemini', 'settings.json');
      const reads = fs.existsSync(settings) && fs.readFileSync(settings, 'utf8').includes('AGENTS.md');
      if (reads) add(id, 'ok', `${h.label} is here: it reads the Spool block in AGENTS.md, and spool prime has the rules`);
      else add(id, 'advice', `${h.label} is here: Spool has no native install for it, and it reads GEMINI.md, not AGENTS.md`, ['Have it read AGENTS.md too: context.fileName in ~/.gemini/settings.json']);
      continue;
    }
    const at = installedFor(ctx, h, root && project ? root : undefined);
    const fix = [`spool install --for ${h.name}`];
    if (!at) {
      add(id, 'advice', `${h.label} is here, but the Spool skills are not installed for it`, fix);
      continue;
    }
    const { missing, old } = copies(at);
    if (missing.length) add(id, 'advice', `the Spool skills for ${h.label} in ${at} lack ${missing.join(', ')}`, fix);
    else if (old.length) add(id, 'advice', `the Spool skills for ${h.label} in ${at} are from an older version than ${version()}`, fix);
    else add(id, 'ok', `the Spool skills are installed for ${h.label} and match ${version()}`);
  }

  // A skill Spool no longer ships, still where an agent finds it: its command is in the agent's list, and does what it did.
  for (const h of HARNESSES) {
    const places: [string | undefined, string][] = [
      [h.userDir?.(ctx), ''],
      [root && project ? h.projectDir?.(root) : undefined, ' --here'],
    ];
    for (const [at, here] of places) {
      const found = at ? retiredIn(at) : [];
      if (!at || !found.length) continue;
      const names = found.map((f) => `${f.name}${f.edited ? ' (edited there, so spool install leaves it)' : ''}`);
      // An untouched copy is taken away by the install; an edited one is theirs, so the fix names that folder and no other.
      const folder = (name: string): string => (/^[\w./~@+-]+$/.test(path.join(at, name)) ? path.join(at, name) : `"${path.join(at, name)}"`);
      add(`retired-${h.name}${here ? '-here' : ''}`, 'advice', `${found.length > 1 ? 'retired Spool skills are' : 'a retired Spool skill is'} still installed for ${h.label} in ${at}: ${names.join(', ')}`, [
        ...(found.some((f) => !f.edited) ? [`spool install${h.name === 'claude' ? '' : ` --for ${h.name}`}${here}`] : []),
        ...found.filter((f) => f.edited).map((f) => `rm -r ${folder(f.name)}`),
      ]);
    }
  }

  // The pointer every agent reads first. One an older Spool wrote may name a skill that is gone. Switched off, there is none.
  if (root && !off) {
    const blocks = ['CLAUDE.md', 'AGENTS.md']
      .filter((name) => fs.existsSync(path.join(root, name)))
      .map((name) => ({ name, block: blockIn(fs.readFileSync(path.join(root, name), 'utf8')) }));
    const other = blocks.filter((b) => b.block === 'other').map((b) => b.name);
    const current = blocks.filter((b) => b.block === 'current').map((b) => b.name);
    if (other.length) {
      add('block', 'advice', `the Spool block in ${other.join(' and ')} is not the one this version writes: it is from an older Spool, or was edited`, ['spool init --refresh']);
    } else if (current.length) {
      add('block', 'ok', `${current.join(' and ')} ${current.length > 1 ? 'have' : 'has'} the Spool block this version writes`);
    }
  }

  const want = nodeWanted();
  if (want && !atLeast(process.versions.node, want)) add('node', 'wrong', `Node ${process.versions.node} is older than the ${want} Spool needs`, ['Get Node.js from nodejs.org']);
  else add('node', 'ok', `Node ${process.versions.node}`);

  return out;
}

/** `spool doctor`: say what is fine and what is not, and change nothing. */
export function doctor(call: Bare): Result {
  const found = diagnose(call);
  const { p } = call;
  const paint = { ok: p.green, advice: p.yellow, wrong: p.red };
  const wrong = found.filter((f) => f.status === 'wrong').length;
  const advice = found.filter((f) => f.status === 'advice').length;
  const lines = found.flatMap((f) => [`${paint[f.status](MARK[f.status])} ${f.label}`, ...(f.fix ?? []).map((l) => `    ${p.dim(l)}`)]);
  const last = wrong
    ? `${wrong} wrong${advice ? `, ${advice} only advice` : ''}. Nothing was changed.`
    : advice
      ? `Nothing a run needs is missing; ${advice} only advice.`
      : 'Everything a run needs is there.';
  return {
    text: [...lines, '', last].join('\n'),
    data: { ok: !wrong, wrong, advice, checks: found },
    code: wrong ? 1 : 0,
  };
}
