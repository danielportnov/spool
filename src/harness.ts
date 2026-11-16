/**
 * The coding agents Spool installs for, and where each one looks.
 *
 * Spool's skills are plain Agent Skills: a folder per skill with a SKILL.md whose frontmatter is a
 * name and a description. Claude Code reads them from `~/.claude/skills`. Codex and Cursor read the
 * same format from folders of their own, so for them `spool install --for` writes the same stamped
 * copies there, and the rules for an untouched copy and an edited one are the ones Claude Code's
 * copies follow. Where these folders are was read off the harnesses themselves, not guessed:
 *
 * - Codex lists `$CODEX_HOME/skills` (by default `~/.codex/skills`) and a project's `.codex/skills`
 *   among its skills (`codex debug prompt-input`, Codex CLI 0.167).
 * - Cursor's agent loads `~/.cursor/skills` and a project's `.cursor/skills` as its own; it reads
 *   `~/.claude/skills` only when third-party skills are switched on (Cursor 3.24).
 *
 * Gemini CLI could not be checked on the machine this was written on, so Spool writes nothing for
 * it and says how it still works: the AGENTS.md block `spool init` writes, and `spool prime`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ctx } from './context.ts';
import { RETIRED, SKILL_NAMES, installSkills, installedIn, userSkillsDir, version, type Outcome } from './builtin.ts';
import { SpoolError } from './model.ts';
import { SPOOL_DIR, findHome, readConfig, skillsDir } from './store.ts';

export interface Harness {
  name: string;
  label: string;
  /** Where its skills live for this person, seen from every project; absent where Spool writes nothing for it. */
  userDir?: (ctx: Ctx) => string;
  /** Where a project's own skills live for it, to check in for a team. */
  projectDir?: (root: string) => string;
  /** Programs on the PATH, and folders under the home directory, that say it is on this machine. */
  programs: string[];
  folders: (ctx: Ctx) => string[];
  /** The line said after installing: how a person starts the first skill there. */
  next: string;
  /** For a harness with no native install: how it gets Spool's rules instead. */
  fallback?: string[];
}

function home(ctx: Ctx): string {
  return ctx.env.HOME || os.homedir();
}

function codexHome(ctx: Ctx): string {
  return ctx.env.CODEX_HOME || path.join(home(ctx), '.codex');
}

/** Claude Code's project folder: the one the project's config names, `.claude/skills` unless it says otherwise. */
function claudeProjectDir(root: string): string {
  const config = fs.existsSync(path.join(root, SPOOL_DIR, 'config.json')) ? readConfig(root) : { version: 1 };
  return skillsDir({ root, dir: path.join(root, SPOOL_DIR), name: path.basename(root), home: true, config });
}

export const HARNESSES: Harness[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    userDir: userSkillsDir,
    projectDir: claudeProjectDir,
    programs: ['claude'],
    folders: (ctx) => [ctx.env.CLAUDE_CONFIG_DIR || path.join(home(ctx), '.claude')],
    next: 'In your agent:  /spool-init in a project, then /spool-loop',
  },
  {
    name: 'codex',
    label: 'Codex',
    userDir: (ctx) => path.join(codexHome(ctx), 'skills'),
    projectDir: (root) => path.join(root, '.codex', 'skills'),
    programs: ['codex'],
    folders: (ctx) => [codexHome(ctx)],
    next: 'In Codex:  $spool-init in a project, then $spool-loop',
  },
  {
    name: 'cursor',
    label: 'Cursor',
    userDir: (ctx) => path.join(home(ctx), '.cursor', 'skills'),
    projectDir: (root) => path.join(root, '.cursor', 'skills'),
    programs: ['cursor', 'cursor-agent'],
    folders: (ctx) => [path.join(home(ctx), '.cursor')],
    next: "In Cursor's agent:  ask for spool-init in a project, then spool-loop",
  },
  {
    name: 'gemini',
    label: 'Gemini CLI',
    programs: ['gemini'],
    folders: (ctx) => [path.join(home(ctx), '.gemini')],
    next: 'In Gemini CLI:  ask it to follow the Spool block in AGENTS.md',
    fallback: [
      'Nothing is written for it: Spool has not checked the format Gemini CLI loads commands in, so it does not guess one.',
      'It works through the rules instead. spool init puts a Spool block in AGENTS.md, and spool prime prints the worker\'s rules.',
      'Gemini CLI reads GEMINI.md unless told otherwise: have it read AGENTS.md too (context.fileName in ~/.gemini/settings.json).',
    ],
  },
];

/** A harness by name, or a refusal that names the ones there are. */
export function harness(name: string): Harness {
  const found = HARNESSES.find((h) => h.name === name.toLowerCase());
  if (!found) {
    throw new SpoolError(
      `Spool does not install for "${name}"`,
      `Use one of ${HARNESSES.map((h) => h.name).join(', ')}, or all. Any other agent reads the rules from AGENTS.md and spool prime.`,
    );
  }
  return found;
}

function onPath(program: string, env: Record<string, string | undefined>): boolean {
  return (env.PATH ?? '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, program), fs.constants.X_OK);
      return fs.statSync(path.join(dir, program)).isFile();
    } catch {
      return false;
    }
  });
}

/** Whether a harness looks to be on this machine: its program on the PATH, or its folder in the home directory. */
export function present(ctx: Ctx, h: Harness): boolean {
  return h.programs.some((p) => onPath(p, ctx.env)) || h.folders(ctx).some((f) => fs.existsSync(f));
}

/** The harnesses besides Claude Code found on this machine. */
export function others(ctx: Ctx): Harness[] {
  return HARNESSES.filter((h) => h.name !== 'claude' && present(ctx, h));
}

/** Where Spool's skills are installed for a harness, the person's own folder first, then the project's. */
export function installedFor(ctx: Ctx, h: Harness, root?: string): string | undefined {
  const dirs = [h.userDir?.(ctx), root ? h.projectDir?.(root) : undefined];
  return dirs.find((d): d is string => !!d && installedIn(d));
}

/** Whether any harness has the skills, for this person or in this project. */
export function installedAnywhere(ctx: Ctx, root?: string): boolean {
  return HARNESSES.some((h) => installedFor(ctx, h, root));
}

/** What the copies in a skills folder are: some missing, some from an older Spool, or all current. */
export function copies(dir: string): { missing: string[]; old: string[] } {
  const missing = SKILL_NAMES.filter((n) => !fs.existsSync(path.join(dir, n, 'SKILL.md')));
  const old = SKILL_NAMES.filter((n) => {
    try {
      const was = /\n<!-- spool (\S+) · [0-9a-f]{12} ·/.exec(fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8').replace(/\r\n?/g, '\n'))?.[1];
      return was !== undefined && was !== version();
    } catch {
      return false;
    }
  });
  return { missing, old };
}

export interface Installed {
  harness: string;
  dir?: string;
  skills?: { name: string; outcome: Outcome }[];
  fallback?: boolean;
}

/**
 * Install for one harness. `here` is the project's own folder for it; `dir` is any folder, for a
 * harness that has one. A harness with no native install gets nothing written, only its fallback.
 */
export function installFor(ctx: Ctx, h: Harness, opts: { here?: boolean; dir?: string; force?: boolean }): Installed {
  if (!h.userDir) return { harness: h.name, fallback: true };
  let dir = h.userDir(ctx);
  if (opts.dir) dir = path.resolve(ctx.cwd, opts.dir);
  else if (opts.here) dir = h.projectDir!(findHome(ctx.cwd) ?? ctx.cwd);
  return { harness: h.name, dir, skills: installSkills(dir, !!opts.force) };
}

/** What `spool install` prints for one harness. */
export function describe(ctx: Ctx, h: Harness, done: Installed, p: { bold: (s: string) => string; dim: (s: string) => string }): string[] {
  if (done.fallback) return [`${p.bold(h.label)}: no native install.`, ...(h.fallback ?? []).map((l) => `  ${l}`)];
  const at = home(ctx);
  const shown = done.dir!.startsWith(at + path.sep) ? `~${done.dir!.slice(at.length)}` : done.dir!;
  const out = [h.name === 'claude' ? `Spool skills in ${p.bold(shown)}` : `Spool skills for ${h.label} in ${p.bold(shown)}`];
  for (const { name, outcome } of done.skills!) {
    const gone = RETIRED[name];
    const note =
      outcome === 'removed'
        ? `retired: ${gone}`
        : outcome !== 'kept'
          ? ''
          : gone
            ? `retired (${gone}), but edited here, so left alone; --force removes it`
            : 'edited here, so left alone; --force replaces it';
    out.push(`  ${outcome.padEnd(9)}  ${name}${note ? p.dim(`  · ${note}`) : ''}`);
  }
  out.push('', h.next);
  return out;
}
