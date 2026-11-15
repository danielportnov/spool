/**
 * The skills Spool ships: how people use it.
 *
 * Spool is driven by talking to an agent, and the skills in `skills/` are the
 * whole of that surface: one to set a project up, the loop that works it, one
 * to record, one to clear what is waiting on the human, one to see it all, and
 * one that lists the rest. The CLI is what those skills run.
 *
 * They are ordinary Agent Skills, plain SKILL.md files, so they can be read on
 * GitHub and edited in place. `spool install` copies them to where the harness
 * looks, and stamps each copy with a hash of what it wrote. That is how a
 * later install can tell a copy nobody touched, which it refreshes, from one
 * somebody edited, which it leaves alone.
 *
 * The rules for working a task and for recording live in those files and
 * nowhere else. `spool prime` and the unattended loop read them from here, so
 * an agent with no skill support is taught exactly what the skills teach.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './context.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { SpoolError } from './model.ts';

/** In the order someone meets them. */
export const SKILL_NAMES = [
  'spool-help',
  'spool-init',
  'spool-loop',
  'spool-recorder',
  'spool-blockers',
  'spool-overview',
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

export function version(): string {
  return (JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')) as { version: string }).version;
}

/** A shipped skill, exactly as it is in the package. */
export function shipped(name: SkillName): string {
  return fs.readFileSync(path.join(PACKAGE, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n?/g, '\n');
}

/** A shipped skill without its frontmatter. */
function body(name: SkillName): string {
  return parseFrontmatter(shipped(name)).body.trim();
}

/** Everything under one `## heading` of a shipped skill, heading included, up to the next `## `. */
export function section(name: SkillName, heading: string): string {
  const lines = body(name).split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new SpoolError(`the ${name} skill has no "${heading}" section`);
  const length = lines.slice(start + 1).findIndex((l) => l.startsWith('## '));
  return lines.slice(start, length < 0 ? undefined : start + 1 + length).join('\n').trim();
}

/** A shipped skill from its first `## heading` on: the rules, without the preamble that sets the scene. */
export function rules(name: SkillName): string {
  const text = body(name);
  const at = text.indexOf('\n## ');
  return (at < 0 ? text : text.slice(at + 1)).trim();
}

// ---------------------------------------------------------------- installing

const STAMP = /\n<!-- spool \S+ · ([0-9a-f]{12}) ·[^\n]*-->\s*$/;

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function stamped(text: string): string {
  const content = `${text.trimEnd()}\n`;
  return `${content}\n<!-- spool ${version()} · ${digest(content)} · written by \`spool install\`; run it again after upgrading. Edit freely: edited copies are kept. -->\n`;
}

/** The hash of the content Spool wrote, if the file is still exactly that. */
function untouched(text: string): string | null {
  const m = STAMP.exec(text);
  return m && digest(text.slice(0, m.index)) === m[1] ? m[1]! : null;
}

/** Where a person's own skills live: every project on the machine sees them. */
export function userSkillsDir(ctx: Ctx): string {
  return path.join(ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.env.HOME || os.homedir(), '.claude'), 'skills');
}

export function installedIn(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'spool-loop', 'SKILL.md'));
}

export type Outcome = 'installed' | 'updated' | 'current' | 'kept';

/**
 * Copy the skills into a skills directory. A copy nobody has edited is brought
 * up to date; one somebody has edited is kept unless `force` says otherwise.
 */
export function installSkills(dir: string, force = false): { name: SkillName; outcome: Outcome }[] {
  return SKILL_NAMES.map((name) => {
    const file = path.join(dir, name, 'SKILL.md');
    const fresh = stamped(shipped(name));
    let outcome: Outcome = 'installed';
    if (fs.existsSync(file)) {
      const was = untouched(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'));
      if (was && was === untouched(fresh)) return { name, outcome: 'current' };
      if (!was && !force) return { name, outcome: 'kept' };
      outcome = 'updated';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh);
    return { name, outcome };
  });
}
