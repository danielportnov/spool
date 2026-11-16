import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { SKILL_NAMES, shipped } from '../src/builtin.ts';
import { Sandbox } from './helpers.ts';

/** A sandbox whose home directory has the folders of the harnesses named, as if they were installed. */
function machine(...harnesses: string[]): Sandbox {
  const s = new Sandbox();
  for (const h of harnesses) fs.mkdirSync(path.join(s.root, '.home', `.${h}`), { recursive: true });
  return s;
}

const home = (s: Sandbox, ...parts: string[]): string => path.join(s.root, '.home', ...parts);

test('install --for codex and --for cursor write the same skills, stamped, where each one looks', () => {
  const s = machine('codex', 'cursor');
  const codex = s.sp('install', '--for', 'codex');
  assert.match(codex, /^Spool skills for Codex in ~\/\.codex\/skills\n {2}installed {2}spool-init\n[\s\S]*\n\nIn Codex: {2}\$spool-init in a project, then \$spool-loop$/);
  const cursor = s.sp('install', '--for', 'cursor');
  assert.match(cursor, /^Spool skills for Cursor in ~\/\.cursor\/skills\n {2}installed {2}spool-init/);
  for (const dir of [home(s, '.codex', 'skills'), home(s, '.cursor', 'skills')]) {
    for (const name of SKILL_NAMES) {
      const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
      // The same SKILL.md: its name and description are what these harnesses read.
      assert.ok(text.startsWith(shipped(name).trimEnd()), `${dir}/${name} is the shipped skill`);
      assert.match(text, /\n<!-- spool \d+\.\d+\.\d+ · [0-9a-f]{12} · written by `spool install`/);
    }
  }
  assert.equal(fs.existsSync(home(s, '.claude', 'skills')), false, 'Claude Code is not touched unless asked');
  s.cleanup();
});

test('CODEX_HOME moves where the Codex copies go', () => {
  const s = machine();
  const elsewhere = path.join(s.root, 'codex-home');
  const out = s.exec(['install', '--for', 'codex'], { env: { CODEX_HOME: elsewhere } });
  assert.equal(out.code, 0);
  assert.ok(fs.existsSync(path.join(elsewhere, 'skills', 'spool-loop', 'SKILL.md')));
  s.cleanup();
});

test('an untouched copy is brought up to date, an edited one is kept unless --force', () => {
  const s = machine('codex');
  s.sp('install', '--for', 'codex');
  assert.match(s.sp('install', '--for', 'codex'), /current {4}spool-loop/);
  const loop = home(s, '.codex', 'skills', 'spool-loop', 'SKILL.md');
  fs.writeFileSync(loop, `${fs.readFileSync(loop, 'utf8')}\nMy own line.\n`);
  // An older Spool's untouched copy of another skill.
  const record = home(s, '.codex', 'skills', 'spool-record', 'SKILL.md');
  const older = 'an older text\n';
  fs.writeFileSync(record, `${older}\n<!-- spool 0.0.1 · ${createHash('sha256').update(older).digest('hex').slice(0, 12)} · written by \`spool install\` -->\n`);
  const again = s.sp('install', '--for', 'codex');
  assert.match(again, /kept {7}spool-loop {2}· edited here, so left alone; --force replaces it/);
  assert.match(again, /updated {4}spool-record/);
  assert.match(fs.readFileSync(loop, 'utf8'), /My own line\./);
  assert.match(s.sp('install', '--for', 'codex', '--force'), /updated {4}spool-loop/);
  assert.doesNotMatch(fs.readFileSync(loop, 'utf8'), /My own line\./);
  s.cleanup();
});

test('--here puts them in the project, in the folder that harness reads there', () => {
  const s = machine();
  s.sp('init', '--name', 'demo');
  assert.match(s.sp('install', '--for', 'codex', '--here'), /Spool skills for Codex in .*\/\.codex\/skills\n {2}installed/);
  assert.match(s.sp('install', '--for', 'cursor', '--here'), /Spool skills for Cursor in .*\/\.cursor\/skills\n {2}installed/);
  assert.ok(s.exists('.codex/skills/spool-loop/SKILL.md'));
  assert.ok(s.exists('.cursor/skills/spool-init/SKILL.md'));
  assert.equal(fs.existsSync(home(s, '.codex')), false, 'nothing in the home directory');
  assert.doesNotMatch(s.sp('init', '--refresh'), /not installed/, 'skills for any harness count');
  s.cleanup();
});

test('gemini gets nothing written, and is told how it works instead', () => {
  const s = machine('gemini');
  const out = s.sp('install', '--for', 'gemini');
  assert.match(out, /^Gemini CLI: no native install\.\n {2}Nothing is written for it/);
  assert.match(out, /AGENTS\.md[\s\S]*spool prime/);
  assert.deepEqual(fs.readdirSync(home(s, '.gemini')), [], 'its folder is left as it was');
  s.cleanup();
});

test('an unknown harness is refused in words', () => {
  const s = machine();
  const err = s.fails('install', '--for', 'vim');
  assert.match(err, /Spool does not install for "vim"/);
  assert.match(err, /claude, codex, cursor, gemini, or all/);
  assert.match(s.fails('install', '--for', 'all', '--dir', 'x'), /--dir names one folder/);
  s.cleanup();
});

test('plain install still means Claude Code, and names the other harnesses it found', () => {
  const s = machine('codex', 'gemini');
  const out = s.sp('install');
  assert.match(out, /^Spool skills in ~\/\.claude\/skills\n/);
  assert.match(out, /\n\nAlso on this machine:\n {2}Codex {9}spool install --for codex\n {2}Gemini CLI {4}spool install --for gemini$/);
  assert.equal(fs.existsSync(home(s, '.codex', 'skills')), false, 'only named, not installed');
  const bare = machine();
  assert.doesNotMatch(bare.sp('install'), /Also on this machine/);
  s.cleanup();
  bare.cleanup();
});

test('--for all installs for Claude Code and every harness found, and skips the rest', () => {
  const s = machine('cursor');
  const out = s.sp('install', '--for', 'all');
  assert.match(out, /^Spool skills in ~\/\.claude\/skills\n[\s\S]*\n\nSpool skills for Cursor in ~\/\.cursor\/skills\n/);
  assert.match(out, /Not found on this machine: Codex, Gemini CLI\. --for <name> installs for one anyway\.$/);
  assert.ok(fs.existsSync(home(s, '.claude', 'skills', 'spool-loop', 'SKILL.md')));
  assert.ok(fs.existsSync(home(s, '.cursor', 'skills', 'spool-loop', 'SKILL.md')));
  assert.equal(fs.existsSync(home(s, '.codex')), false, 'no folder made for an agent that is not here');
  const data = s.json('install', '--for', 'all');
  assert.deepEqual(data.harnesses.map((h: { harness: string }) => h.harness), ['claude', 'cursor']);
  s.cleanup();
});

test('doctor reports each harness found, and whether Spool is installed for it', () => {
  const s = machine('codex', 'cursor', 'gemini');
  s.sp('init', '--name', 'demo');
  const checks = (): Record<string, { status: string; label: string; fix?: string[] }> =>
    Object.fromEntries((JSON.parse(s.exec(['doctor', '--json']).out).checks as { id: string }[]).map((f) => [f.id, f])) as never;
  let found = checks();
  assert.equal(found['harness-codex']!.status, 'advice');
  assert.match(found['harness-codex']!.label, /Codex is here, but the Spool skills are not installed for it/);
  assert.deepEqual(found['harness-codex']!.fix, ['spool install --for codex']);
  assert.equal(found['harness-gemini']!.status, 'advice');
  assert.equal(found['harness-claude'], undefined, 'Claude Code has its own check');

  s.sp('install', '--for', 'codex');
  s.sp('install', '--for', 'cursor', '--here');
  fs.writeFileSync(home(s, '.gemini', 'settings.json'), '{ "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }\n');
  found = checks();
  assert.equal(found['harness-codex']!.status, 'ok');
  assert.match(found['harness-codex']!.label, /installed for Codex and match/);
  assert.equal(found['harness-cursor']!.status, 'ok', 'a project install counts');
  assert.equal(found['harness-gemini']!.status, 'ok');

  fs.rmSync(home(s, '.codex', 'skills', 'spool-page'), { recursive: true });
  assert.match(checks()['harness-codex']!.label, /lack spool-page/);

  const none = machine();
  none.sp('init', '--name', 'demo');
  const ids = (JSON.parse(none.exec(['doctor', '--json']).out).checks as { id: string }[]).map((f) => f.id);
  assert.equal(ids.some((id) => id.startsWith('harness-')), false, 'a harness not on the machine is not mentioned');
  s.cleanup();
  none.cleanup();
});
