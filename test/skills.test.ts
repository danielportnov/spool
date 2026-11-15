import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { Sandbox, spool } from './helpers.ts';

const STEPS = '# Ship to TestFlight\n\n1. Bump the build number.\n2. Archive.\n3. Upload, then wait for processing.\n';

test('an agent writes a procedure down and the human sees it', () => {
  const s = spool();
  const task = s.id('task', 'Get the beta out');
  const result = s.exec(
    ['skill', 'add', 'ship-to-testflight', '-d', 'Build and upload a TestFlight beta: use when asked to ship, release or upload a build.', '--from', task, '-b', '-', '--json'],
    { stdin: STEPS },
  );
  assert.equal(result.code, 0, result.err);
  const ledger = JSON.parse(result.out).skill;

  // The file is a plain Agent Skill any harness can load.
  const file = parseFrontmatter(s.read('.claude/skills/ship-to-testflight/SKILL.md'));
  assert.equal(file.data.get('name'), 'ship-to-testflight');
  assert.match(String(file.data.get('description')), /^Build and upload a TestFlight beta: use when/);
  assert.equal(file.body.trim(), STEPS.trim());

  // The ledger knows where it came from, and review shows it until acknowledged.
  assert.deepEqual(ledger.from, [task]);
  assert.equal(ledger.by, 'agent');
  assert.match(s.sp('review'), /NEW SKILLS[\s\S]*ship-to-testflight {2}· by agent from/);
  assert.match(s.sp('skills'), /ship-to-testflight[\s\S]*used 0× · new/);
  s.sp('approve', ledger.id);
  assert.doesNotMatch(s.sp('skills'), /· new/);
  assert.equal(s.sp('review'), 'Nothing is waiting on you.');

  assert.match(s.fails('skill', 'add', 'ship-to-testflight', '-d', 'x', '-b', 'y'), /already tracked/);
  s.cleanup();
});

test('skill names and inputs are checked', () => {
  const s = spool();
  assert.match(s.fails('skill', 'add', 'Bad Name', '-d', 'x', '-b', 'y'), /not a valid skill name/);
  assert.match(s.fails('skill', 'add', 'no-body', '-d', 'x'), /needs a description and its steps/);
  assert.match(s.fails('skill', 'add', 'long', '-d', 'x'.repeat(1025), '-b', 'y'), /over 1024 characters/);
  assert.match(s.fails('skill', 'remove', 'x'), /usage: spool skill add/);
  assert.equal(s.sp('skills'), 'No skills yet. Agents add them with: spool skill add', 'the two built-ins are not listed');
  s.cleanup();
});

test('skills written by hand are listed, adopted on request, and tracked once used', () => {
  const s = spool();
  s.write('.claude/skills/codex/SKILL.md', '---\nname: codex\ndescription: >\n  Make art with Codex. Use for icons,\n  illustrations and logos.\n---\n\n# Codex\n');
  s.write('.agents/skills/lint/SKILL.md', '---\nname: lint\ndescription: Run the linters.\n---\n');
  s.write('.claude/skills/not-a-skill/README.md', 'no SKILL.md here');

  const listed = s.json('skills').skills;
  assert.deepEqual(listed.map((k: { name: string }) => k.name).sort(), ['codex', 'lint']);
  assert.equal(listed.find((k: { name: string }) => k.name === 'codex').description, 'Make art with Codex. Use for icons, illustrations and logos.');
  assert.match(s.sp('skills'), /codex[\s\S]*untracked · \.claude\/skills\/codex/);

  // Reporting a use brings a hand-written skill onto the ledger, already reviewed.
  const task = s.id('task', 'Draw the app icon');
  assert.match(s.fails('done', task, '-m', 'x', '--skill', 'nope'), /no skill "nope"[\s\S]*Known here:.*codex/);
  s.sp('done', task, '-m', 'Icon drawn', '--skill', 'codex');
  const again = s.id('task', 'Draw the logo');
  s.sp('done', again, '-m', 'Logo drawn', '--skill', 'codex');
  const codex = s.json('skills').skills.find((k: { name: string }) => k.name === 'codex');
  assert.equal(codex.uses, 2);
  assert.equal(codex.reviewed, true);
  assert.deepEqual(s.json('show', task).item.skills, ['codex']);
  assert.ok(s.sp('graph').includes('-.->|uses|'));

  // Adopting one an agent wrote itself puts it in front of the human.
  const adopted = s.json('skill', 'add', 'lint').skill;
  assert.equal(adopted.path, '.agents/skills/lint');
  assert.match(s.sp('review'), /NEW SKILLS[\s\S]*lint/);
  s.cleanup();
});

test('a task’s brief suggests the skills that fit it', () => {
  const s = spool();
  s.write('.claude/skills/tune-jump-physics/SKILL.md', '---\nname: tune-jump-physics\ndescription: Tune gravity and jump feel. Use when feedback says floaty, heavy or snappy.\n---\n');
  s.write('.claude/skills/ship-to-testflight/SKILL.md', '---\nname: ship-to-testflight\ndescription: Upload a beta build.\n---\n');
  const jump = s.id('task', 'The jump feels floaty over long gaps');
  const text = s.sp('next', '--claim');
  assert.ok(text.startsWith(jump));
  assert.match(text, /SKILLS THAT MAY HELP\n {2}tune-jump-physics — Tune gravity and jump feel[\s\S]*\.claude\/skills\/tune-jump-physics\/SKILL\.md/);
  assert.doesNotMatch(text, /ship-to-testflight/);
  assert.doesNotMatch(text, /recorder —|spool —/, 'Spool’s own skills are never suggested');
  s.cleanup();
});

test('skills belong to a project, and reach down into the projects below it', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  const game = s.cd('games/runner');
  game.sp('init');
  s.write('.claude/skills/make-art/SKILL.md', '---\nname: make-art\ndescription: Paint icons and logos for any project.\n---\n');
  game.write('.claude/skills/build-unity/SKILL.md', '---\nname: build-unity\ndescription: Build the Unity player.\n---\n');

  const skills = s.json('skills').skills;
  assert.deepEqual(
    skills.map((k: { name: string; project: string }) => `${k.project}:${k.name}`).sort(),
    ['games/runner:build-unity', 'studio:make-art'],
  );

  // The game can use the studio's skill, and the brief points up the tree to it.
  const task = game.id('task', 'Paint a new icon for the runner');
  assert.match(s.sp('next'), /make-art — Paint icons[\s\S]*\.\.\/\.\.\/\.claude\/skills\/make-art\/SKILL\.md/);
  s.sp('done', task, '-m', 'Icon painted', '--skill', 'make-art');
  assert.equal(s.json('skills').skills.find((k: { name: string }) => k.name === 'make-art').uses, 1);

  // But not the other way round.
  const top = s.id('task', 'Top-level task');
  assert.match(s.fails('done', top, '-m', 'x', '--skill', 'build-unity'), /no skill "build-unity" for studio/);

  // A skill extracted from a task lands in that task's project.
  const extracted = s.exec(['skill', 'add', 'tune-levels', '-d', 'Tune level generation.', '--from', task, '-b', 'steps'], {});
  assert.equal(extracted.code, 0, extracted.err);
  assert.ok(game.exists('.claude/skills/tune-levels/SKILL.md'));
  s.cleanup();
});

test('dropping a skill removes it from disk and from the ledger', () => {
  const s = spool();
  const id = s.id('skill', 'add', 'bad-idea', '-d', 'A procedure nobody wanted.', '-b', 'steps');
  assert.ok(s.exists('.claude/skills/bad-idea/SKILL.md'));
  assert.match(s.sp('drop', id, '-m', 'not useful'), /removed \.claude\/skills\/bad-idea\//);
  assert.equal(s.exists('.claude/skills/bad-idea'), false);
  assert.equal(s.sp('skills'), 'No skills yet. Agents add them with: spool skill add');
  s.cleanup();
});

test('a configured skills directory is honoured, and may not leave the project', () => {
  const s = spool();
  s.write('.spool/config.json', JSON.stringify({ version: 1, name: 'demo', skillsDir: '.agents/skills' }));
  s.sp('skill', 'add', 'here', '-d', 'Lands where the config says.', '-b', 'steps');
  assert.ok(s.exists('.agents/skills/here/SKILL.md'));

  s.write('.spool/config.json', JSON.stringify({ version: 1, name: 'demo', skillsDir: '../../elsewhere' }));
  assert.match(s.fails('skill', 'add', 'escape', '-d', 'x', '-b', 'y'), /points outside the project/);
  s.cleanup();
});
