import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SKILL_NAMES, shipped } from '../src/builtin.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { Sandbox } from './helpers.ts';

test('init lays down the store, the policy and a pointer for agents', () => {
  const s = new Sandbox();
  const out = s.sp('init', '--name', 'demo', '--about', 'A demo project');
  assert.match(out, /Spool is set up in demo\./);
  assert.deepEqual(JSON.parse(s.read('.spool/config.json')), { version: 1, name: 'demo', about: 'A demo project' });
  assert.match(s.read('.spool/policy.md'), /## Go ahead and assume[\s\S]*## Ask first[\s\S]*## Never/);
  assert.equal(s.read('.spool/.gitignore'), '.lock\n*.tmp\n');

  // The pointer sends any agent to the skills, and one with no skills to the CLI's copy of the rules.
  assert.match(s.read('AGENTS.md'), /<!-- spool:start -->[\s\S]*\/spool-help[\s\S]*spool prime[\s\S]*<!-- spool:end -->/);

  // What comes next is said to an agent, not typed here. The skills are per machine, not per project.
  assert.match(out, /skills are not installed for your agent yet[\s\S]*spool install/);
  assert.match(out, /Next, in your agent[\s\S]*\/spool-recorder[\s\S]*\/spool-loop 2[\s\S]*\/spool-blockers/);
  assert.equal(s.exists('.claude'), false);
  s.cleanup();
});

test('init is safe to run again and never clobbers what is there', () => {
  const s = new Sandbox();
  s.write('CLAUDE.md', '# My project\n\nMy own rules.\n');
  s.sp('init');
  assert.equal(s.exists('AGENTS.md'), false, 'an existing CLAUDE.md is used instead of adding a file');
  const first = s.read('CLAUDE.md');
  assert.ok(first.startsWith('# My project\n\nMy own rules.\n\n<!-- spool:start -->'));

  // Edits to the policy are kept; the block is not duplicated.
  s.write('.spool/policy.md', 'My policy.');
  s.write('CLAUDE.md', `${first}\nMore of my rules.\n`);
  s.sp('install');
  const again = s.sp('init');
  assert.match(again, /already has a spool/);
  assert.doesNotMatch(again, /wrote|not installed/);
  assert.equal(s.read('.spool/policy.md'), 'My policy.');
  assert.equal(s.read('CLAUDE.md').match(/spool:start/g)!.length, 1);
  assert.ok(s.read('CLAUDE.md').endsWith('More of my rules.\n'));
  s.cleanup();
});

test('init can leave the agents file alone', () => {
  const s = new Sandbox();
  s.sp('init', '--no-agents-file');
  assert.equal(s.exists('AGENTS.md'), false);
  assert.ok(s.exists('.spool/config.json'));
  s.cleanup();
});

test('the shipped skills are valid Agent Skills, and few', () => {
  assert.deepEqual([...SKILL_NAMES], ['spool-help', 'spool-init', 'spool-recorder', 'spool-loop', 'spool-blockers', 'spool-overview']);
  for (const name of SKILL_NAMES) {
    const skill = parseFrontmatter(shipped(name));
    assert.equal(skill.data.get('name'), name);
    const description = String(skill.data.get('description'));
    assert.ok(description.length > 80 && description.length <= 1024, `${name}: a description an agent can match on`);
    assert.ok(description.includes(`/${name}`), `${name}: says how it is invoked`);
    assert.ok(skill.body.includes('`spool'), `${name}: tells the agent which command to run`);
  }
  // The help skill lists every skill a person uses.
  for (const name of SKILL_NAMES) assert.ok(shipped('spool-help').includes(`\`/${name}`) || name === 'spool-help');
});

test('install puts the skills where the agent finds them, and keeps the ones you edited', () => {
  const s = new Sandbox();
  const out = s.sp('install');
  assert.match(out, /Spool skills in ~\/\.claude\/skills\n {2}installed {2}spool-help[\s\S]*installed {2}spool-overview[\s\S]*\/spool-help/);
  for (const name of SKILL_NAMES) {
    const text = s.read(`.home/.claude/skills/${name}/SKILL.md`);
    assert.ok(text.startsWith(shipped(name).trimEnd()), 'the shipped skill, word for word');
    assert.match(text, /\n<!-- spool \d+\.\d+\.\d+ · [0-9a-f]{12} · written by `spool install`/);
    assert.equal(parseFrontmatter(text).data.get('name'), name);
  }
  assert.doesNotMatch(s.sp('install'), /installed|updated|kept/, 'nothing to do the second time');
  assert.match(s.sp('install'), /current {4}spool-loop/);

  // An edited skill is yours: it is left alone until you say otherwise.
  const loop = '.home/.claude/skills/spool-loop/SKILL.md';
  s.write(loop, s.read(loop).replace('# Spool loop', '# Spool loop, my way'));
  assert.match(s.sp('install'), /kept {7}spool-loop {2}· edited here[\s\S]*current {4}spool-blockers/);
  assert.match(s.read(loop), /my way/);
  assert.match(s.sp('install', '--force'), /updated {4}spool-loop/);
  assert.doesNotMatch(s.read(loop), /my way/);

  // An untouched copy from an older version is brought up to date.
  const help = '.home/.claude/skills/spool-help/SKILL.md';
  const older = 'An older skill.\n';
  const hash = createHash('sha256').update(older).digest('hex').slice(0, 12);
  s.write(help, `${older}\n<!-- spool 0.0.1 · ${hash} · written by \`spool install\` -->\n`);
  assert.match(s.sp('install'), /updated {4}spool-help/);
  assert.match(s.read(help), /^---\nname: spool-help/);
  s.cleanup();
});

test('install can target a project, or any skills directory', () => {
  const s = new Sandbox();
  s.sp('init');
  assert.match(s.sp('install', '--here'), /Spool skills in .*\.claude\/skills\n {2}installed/);
  assert.ok(s.exists('.claude/skills/spool-loop/SKILL.md'));
  assert.equal(s.exists('.home/.claude'), false);
  assert.doesNotMatch(s.sp('init'), /not installed/, 'skills checked into the project count');
  assert.doesNotMatch(s.sp('skills'), /spool-loop/, "Spool's own skills are not listed among the project's procedures");

  s.sp('install', '--dir', 'elsewhere/skills');
  assert.ok(s.exists('elsewhere/skills/spool-help/SKILL.md'));
  assert.match(s.fails('install', '--here', '--dir', 'x'), /both say where/);
  s.cleanup();
});
