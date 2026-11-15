import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { Sandbox } from './helpers.ts';

test('init lays down the store, the policy, the skills and a pointer for agents', () => {
  const s = new Sandbox();
  const out = s.sp('init', '--name', 'demo', '--about', 'A demo project');
  assert.match(out, /Spool is set up in demo\./);
  assert.deepEqual(JSON.parse(s.read('.spool/config.json')), { version: 1, name: 'demo', about: 'A demo project' });
  assert.match(s.read('.spool/policy.md'), /## Go ahead and assume[\s\S]*## Ask first[\s\S]*## Never/);
  assert.equal(s.read('.spool/.gitignore'), '.lock\n*.tmp\n');

  // Both skills are valid Agent Skills that hand off to the CLI.
  for (const [name, command] of [['spool', 'spool prime'], ['recorder', 'spool prime recorder']] as const) {
    const skill = parseFrontmatter(s.read(`.claude/skills/${name}/SKILL.md`));
    assert.equal(skill.data.get('name'), name);
    assert.ok(String(skill.data.get('description')).length > 80);
    assert.ok(skill.body.includes(command));
  }
  assert.match(s.read('AGENTS.md'), /<!-- spool:start -->[\s\S]*spool prime[\s\S]*<!-- spool:end -->/);
  s.cleanup();
});

test('init is safe to run again and never clobbers what is there', () => {
  const s = new Sandbox();
  s.write('CLAUDE.md', '# My project\n\nMy own rules.\n');
  s.sp('init');
  assert.equal(s.exists('AGENTS.md'), false, 'an existing CLAUDE.md is used instead of adding a file');
  const first = s.read('CLAUDE.md');
  assert.ok(first.startsWith('# My project\n\nMy own rules.\n\n<!-- spool:start -->'));

  // Edits to the policy and the skill are kept; the block is not duplicated.
  s.write('.spool/policy.md', 'My policy.');
  s.write('.claude/skills/spool/SKILL.md', 'customised');
  s.write('CLAUDE.md', `${first}\nMore of my rules.\n`);
  const again = s.sp('init');
  assert.match(again, /already has a spool/);
  assert.doesNotMatch(again, /wrote/);
  assert.equal(s.read('.spool/policy.md'), 'My policy.');
  assert.equal(s.read('.claude/skills/spool/SKILL.md'), 'customised');
  assert.equal(s.read('CLAUDE.md').match(/spool:start/g)!.length, 1);
  assert.ok(s.read('CLAUDE.md').endsWith('More of my rules.\n'));

  // --force refreshes the skills from the installed version, and only those.
  s.sp('init', '--force');
  assert.match(s.read('.claude/skills/spool/SKILL.md'), /^---\nname: spool/);
  assert.equal(s.read('.spool/policy.md'), 'My policy.');
  s.cleanup();
});

test('init can leave the skills and the agents file alone', () => {
  const s = new Sandbox();
  s.sp('init', '--no-skills', '--no-agents-file');
  assert.equal(s.exists('.claude'), false);
  assert.equal(s.exists('AGENTS.md'), false);
  assert.ok(s.exists('.spool/config.json'));
  s.cleanup();
});
