/**
 * Skills: procedures worth keeping.
 *
 * A skill is a folder with a SKILL.md — the open Agent Skills format, so the
 * harness (Claude Code and friends) loads it natively. Spool adds what the
 * format lacks: a ledger. When an agent writes a skill down, a `skill` item
 * records where it came from, who wrote it and how often it gets used, and
 * the user sees it in `spool review` like any other thing done on their
 * behalf. Skills Spool did not write are listed too; they are simply untracked
 * until the first task reports using one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { RETIRED, SKILL_NAMES } from './builtin.ts';
import { quote } from './frontmatter.ts';
import { type Item, type Spool, SpoolError, overlap, splitBody, tokens } from './model.ts';
import { type SkillFile, type Workspace, skillsDir } from './store.ts';

/**
 * Spool's own skills are how it is used, not procedures for a task; they are
 * never suggested for one. Nor are the ones it has retired, where a copy is
 * still lying about. The last is a name 0.1 installed.
 */
export const BUILT_IN = new Set<string>([...SKILL_NAMES, ...Object.keys(RETIRED), 'recorder']);

export function ledgerFor(ws: Workspace, skill: SkillFile): Item | undefined {
  return ws.items.find(
    (i) => i.kind === 'skill' && i.status !== 'dropped' && i.spool === skill.spool && i.title === skill.name,
  );
}

export function fileFor(ws: Workspace, ledger: Item): SkillFile | undefined {
  return ws.skills.find((s) => s.spool === ledger.spool && s.name === ledger.title);
}

/** A project can use its own skills and those of every project above it. */
export function applicable(ws: Workspace, spool: Spool): SkillFile[] {
  return ws.skills.filter((s) => s.spool === spool || spool.root.startsWith(s.spool.root + path.sep));
}

/** Skills whose name or description shares vocabulary with the task. Lexical, cheap, and usually right. */
export function matchSkills(ws: Workspace, task: Item, limit = 3): SkillFile[] {
  const want = tokens(`${task.title} ${splitBody(task.body).main}`);
  return applicable(ws, task.spool)
    .filter((s) => !BUILT_IN.has(s.name))
    .map((skill) => ({
      skill,
      score: 3 * overlap(want, tokens(skill.name)) + overlap(want, tokens(skill.description)),
    }))
    .filter((m) => m.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.skill);
}

export function checkSkillName(name: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new SpoolError(
      `"${name}" is not a valid skill name`,
      'Use lowercase letters, digits and single hyphens, e.g. ship-to-testflight',
    );
  }
}

export function skillPath(spool: Spool, name: string): string {
  return path.join(skillsDir(spool), name);
}

/** Write a new SKILL.md. Returns the skill's directory. */
export function writeSkill(spool: Spool, name: string, description: string, body: string): string {
  const dir = skillPath(spool, name);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: ${quote(description.replace(/\s+/g, ' ').trim())}\n---\n\n${body.trim()}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return dir;
}
