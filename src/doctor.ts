/**
 * `spool doctor`: look at what a run needs and say, for each thing, whether it is there.
 *
 * Most first-run trouble is setup, and it arrives as a thread that failed for a reason buried in an
 * agent's output. This reads the same places the runner, the page and the loop read, in the same
 * order, and changes nothing. A check is fine, wrong (a run will fail or cannot start) or advice
 * (a run works, but something is easier with it). Only wrong ones fail the command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bare, Result } from './commands.ts';
import { SKILL_NAMES, installedIn, userSkillsDir, version } from './builtin.ts';
import { DEFAULT_AGENT } from './loop.ts';
import { builderOf, userConfig } from './context.ts';
import { git, repoRoot } from './git.ts';
import { SPOOL_DIR, findHome, readConfig, skillsDir } from './store.ts';
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
  if (root) add('spool', 'ok', `a spool in ${root}`);
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
