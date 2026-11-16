/**
 * The skills Spool ships: how people use it.
 *
 * Spool is driven by talking to an agent, and the skills in `skills/` are the
 * whole of that surface, and there are four: one to set a project up, one to
 * steer the spool and the board from a chat, the loop that makes a chat the
 * builder, and one to record what the human says. The CLI is what those skills run.
 *
 * They are ordinary Agent Skills, plain SKILL.md files, so they can be read on
 * GitHub and edited in place. `spool install` copies them to where the harness
 * looks, and stamps each copy with a hash of what it wrote. That is how a
 * later install can tell a copy nobody touched, which it refreshes, from one
 * somebody edited, which it leaves alone.
 *
 * The rules for recording live in the record skill and nowhere else. The
 * rules for working a thread are in no skill: they are one file beside them,
 * `rules/worker.md`, because everyone who builds reads them and a chat that
 * only steers never does. `spool prime` prints both from here, so an agent
 * with no skill support, and one the page starts, is taught the same words.
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
export const SKILL_NAMES = ['spool-init', 'spool', 'spool-loop', 'spool-record'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/**
 * Skills Spool used to ship, and where their job went. `spool install` takes
 * away a copy nobody edited, so a command that no longer exists is not left
 * sitting in the agent's list.
 */
export const RETIRED: Record<string, string> = {
  'spool-blockers': 'ask what needs you: /spool',
  'spool-overview': 'ask where things stand: /spool',
  'spool-help': 'the skills are few now: /spool-init, /spool, /spool-loop and /spool-record',
  'spool-recorder': 'renamed: /spool-record',
  'spool-page': 'ask for the board: /spool opens it, and steers the spool from the chat',
};

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

/** A text from its first `## heading` on: the rules, without the preamble that sets the scene. */
function fromFirstHeading(text: string): string {
  const at = text.indexOf('\n## ');
  return (at < 0 ? text : text.slice(at + 1)).trim();
}

/** A shipped skill's rules: everything from its first `## heading` on. */
export function rules(name: SkillName): string {
  return fromFirstHeading(body(name));
}

/** The worker's rules, as they are in the package: what whoever builds a thread follows, and `spool prime worker` prints. */
export function workerRules(): string {
  return fromFirstHeading(fs.readFileSync(path.join(PACKAGE, 'rules', 'worker.md'), 'utf8').replace(/\r\n?/g, '\n'));
}

/** Everything under one `## heading` of the worker's rules, heading included, up to the next `## `. */
export function section(heading: string): string {
  const lines = workerRules().split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new SpoolError(`the worker's rules have no "${heading}" section`);
  const length = lines.slice(start + 1).findIndex((l) => l.startsWith('## '));
  return lines.slice(start, length < 0 ? undefined : start + 1 + length).join('\n').trim();
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

export type Outcome = 'installed' | 'updated' | 'current' | 'kept' | 'removed';

/**
 * Copy the skills into a skills directory. A copy nobody has edited is brought
 * up to date; one somebody has edited is kept unless `force` says otherwise.
 * A retired skill is removed on the same terms: only a copy Spool wrote and
 * nobody has touched since, or any copy with `force`.
 */
export function installSkills(dir: string, force = false): { name: string; outcome: Outcome }[] {
  const retired = Object.keys(RETIRED).flatMap((name) => {
    const file = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) return [];
    if (!untouched(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')) && !force) return [{ name, outcome: 'kept' as Outcome }];
    fs.rmSync(file);
    if (!fs.readdirSync(path.dirname(file)).length) fs.rmdirSync(path.dirname(file));
    return [{ name, outcome: 'removed' as Outcome }];
  });
  const current = SKILL_NAMES.map((name): { name: string; outcome: Outcome } => {
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
  return [...current, ...retired];
}
