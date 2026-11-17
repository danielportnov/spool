import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { COMMANDS, type Command } from '../src/commands.ts';

// A newcomer follows the docs to the letter: every `spool <command>` they name must be a real one,
// and every flag written after it must be one that command takes.

const ROOT = path.join(import.meta.dirname, '..');
const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
/** Flags every command takes, and the ones `spool` alone takes. */
const GLOBAL = ['--json', '-C', '--as', '--help', '-h', '--plain', '--run', '--version'];

/** The code in a markdown file: fenced blocks and inline code spans. */
function code(text: string): string[] {
  const out: string[] = [];
  const rest = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_, body: string) => { out.push(...body.split('\n')); return ''; });
  for (const m of rest.matchAll(/(`+)([^`]+?)\1/g)) out.push(m[2]!);
  return out.filter((s) => s.trim());
}

/** Each `spool <word> …` in a piece of code, up to the end of that command. */
function calls(snippet: string): { verb: string; words: string[] }[] {
  return [...snippet.matchAll(/(?:^|[\s;&|(`$])spool\s+([a-z][a-z-]*)([^;&|#\n]*)/g)].map((m) => ({ verb: m[1]!, words: m[2]!.trim().split(/\s+/) }));
}

test('every spool command the docs name is a real command, with flags it takes', () => {
  const known = new Map(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => [n, c] as const)));
  /** The flags a command takes: its options, long and short, and any its usage line names. */
  const takes = (c: Command, flag: string): boolean => c.usage.includes(flag)
    || Object.entries(c.options ?? {}).some(([long, o]) => flag === `--${long}` || (!!o.short && flag === `-${o.short}`));
  const wrong: string[] = [];
  for (const doc of DOCS) {
    for (const snippet of code(fs.readFileSync(path.join(ROOT, doc), 'utf8'))) {
      for (const { verb, words } of calls(snippet)) {
        if (verb === 'help') continue;
        const c = known.get(verb);
        if (!c) { wrong.push(`${doc}: spool ${verb} is not a command`); continue; }
        for (const w of words) {
          const flag = /^(--?[a-zA-Z][\w-]*)/.exec(w)?.[1];
          if (flag && !GLOBAL.includes(flag) && !takes(c, flag)) wrong.push(`${doc}: spool ${verb} takes no ${flag}`);
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test('the check finds a command that does not exist', () => {
  assert.deepEqual(calls('spool frobnicate --now').map((c) => c.verb), ['frobnicate']);
  assert.ok(!COMMANDS.some((c) => c.name === 'frobnicate'));
  assert.deepEqual(code('Run `spool status`, then:\n```bash\nspool page -d\n```\n').sort(), ['spool page -d', 'spool status'].sort());
});
