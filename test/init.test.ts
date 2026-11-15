import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SKILL_NAMES, shipped } from '../src/builtin.ts';
import { COMMANDS } from '../src/commands.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { Sandbox } from './helpers.ts';

test('init lays down the store, the policy and a pointer for agents', () => {
  const s = new Sandbox();
  const out = s.sp('init', '--name', 'demo', '--about', 'A demo project');
  assert.match(out, /Spool is set up in demo\./);
  assert.deepEqual(JSON.parse(s.read('.spool/config.json')), { version: 1, name: 'demo', about: 'A demo project' });
  assert.match(s.read('.spool/policy.md'), /## Go ahead and assume[\s\S]*## Ask first[\s\S]*## Never/);
  assert.match(s.read('.spool/.gitignore'), /^# Spool's queue is working state for agents[\s\S]*\n\.lock\n\*\.tmp\n\*\n$/);
  assert.match(out, /The queue stays on this machine: git ignores \.spool\/\./);

  // The pointer sends any agent to the skills, and one with no skills to the CLI's copy of the rules.
  assert.match(s.read('AGENTS.md'), /<!-- spool:start -->[\s\S]*\/spool-help[\s\S]*spool prime[\s\S]*<!-- spool:end -->/);

  // What comes next is said to an agent, not typed here. The skills are per machine, not per project.
  assert.match(out, /skills are not installed for your agent yet[\s\S]*spool install/);
  assert.match(out, /Next, in your agent[\s\S]*\/spool-loop {7}the loop: it checks in with you now and every three hours[\s\S]*\/spool-recorder/);
  assert.equal(s.exists('.claude'), false);
  s.cleanup();
});

test('init run again by accident changes nothing, and says so', () => {
  const s = new Sandbox();
  s.write('CLAUDE.md', '# My project\n\nMy own rules.\n');
  s.sp('init', '--name', 'demo');
  assert.equal(s.exists('AGENTS.md'), false, 'an existing CLAUDE.md is used instead of adding a file');
  const first = s.read('CLAUDE.md');
  assert.ok(first.startsWith('# My project\n\nMy own rules.\n\n<!-- spool:start -->'));

  // Someone has since changed the policy, dropped the pointer and lost a file.
  s.write('.spool/policy.md', 'My policy.');
  s.write('CLAUDE.md', '# My project\n');
  s.sp('task', 'Something queued');
  const again = s.exec(['init', '--name', 'other']);
  assert.equal(again.code, 0);
  assert.match(again.out, /^Spool is already set up in demo\. Nothing was changed\.\n {2}see where it stands: spool overview$/);
  assert.equal(s.read('CLAUDE.md'), '# My project\n');
  assert.equal(s.read('.spool/policy.md'), 'My policy.');
  assert.equal(JSON.parse(s.read('.spool/config.json')).name, 'demo');
  assert.deepEqual(s.json('init'), { root: s.root, created: false, wrote: [] });
  assert.match(s.sp('status'), /Something queued/);

  // --refresh is the deliberate version: the pointer comes back, once, and what is yours is kept.
  s.write('CLAUDE.md', `${first}\nMore of my rules.\n`);
  assert.match(s.sp('init', '--refresh'), /^demo: already up to date\./);
  s.write('CLAUDE.md', '# My project\n');
  assert.match(s.sp('init', '--refresh'), /^demo: refreshed\.\n {2}wrote CLAUDE\.md/);
  assert.equal(s.read('CLAUDE.md').match(/spool:start/g)!.length, 1);
  assert.equal(s.read('.spool/policy.md'), 'My policy.');
  s.cleanup();
});

test('the queue is ignored by git unless someone chooses to share it', () => {
  const s = new Sandbox();
  s.gitInit();
  s.write('game.js', 'let gravity = 9.8;\n');
  s.sp('init', '--name', 'demo');
  s.sp('capture', 'the jump feels floaty');
  s.sp('task', 'Tighten the jump arc');
  const untracked = () => s.git('status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.slice(3)).filter(Boolean).sort();

  // By default nothing under .spool/ can be committed, even by `git add -A`: not the notes, not the config.
  assert.deepEqual(untracked(), ['AGENTS.md', 'game.js']);
  s.git('add', '-A');
  assert.equal(s.git('ls-files', '.spool'), '');

  // Sharing is deliberate, and sticks: a later refresh does not hide the queue again.
  const shared = s.sp('init', '--share');
  assert.match(shared, /The queue is kept in git with the rest of the project/);
  assert.equal(s.read('.spool/.gitignore'), '.lock\n*.tmp\n');
  assert.ok(untracked().some((f) => f.startsWith('.spool/items/n-')), 'now the queue shows up');
  assert.ok(untracked().includes('.spool/config.json'));
  s.sp('init', '--refresh');
  assert.equal(s.read('.spool/.gitignore'), '.lock\n*.tmp\n');
  assert.equal(s.json('init', '--refresh').shared, true);

  // Or chosen from the start.
  const team = new Sandbox();
  assert.match(team.sp('init', '--share'), /Spool is set up in[\s\S]*The queue is kept in git/);
  assert.equal(team.read('.spool/.gitignore'), '.lock\n*.tmp\n');
  team.cleanup();
  s.cleanup();
});

test('init takes a folder inside this one, named the way you would say it', () => {
  const s = new Sandbox();
  s.write('games/sky_hop/README.md', '# Sky Hop\n');
  s.write('apps/tidy-up/README.md', '# Tidy Up\n');
  s.write('apps/tidy-up/TidyUp/App.swift', '// a folder of the same name inside: the outer one is the project');
  s.write('apps/tools/README.md', '');
  s.write('games/tools/README.md', '');
  s.write('node_modules/sky-hop/index.js', '');

  // By name, however it is spelled or spoken; by path; and from a parent that has no spool at all.
  assert.match(s.sp('init', 'sky', 'hop'), /^Spool is set up in sky_hop {2}· games\/sky_hop\./);
  assert.ok(s.exists('games/sky_hop/.spool/config.json'));
  assert.ok(s.exists('games/sky_hop/AGENTS.md'));
  assert.equal(s.exists('.spool'), false, 'the folder you ran it from is left alone');
  assert.match(s.sp('init', 'tidyup', '--name', 'Tidy Up'), /^Spool is set up in Tidy Up {2}· apps\/tidy-up\./);
  assert.match(s.sp('init', 'apps/tools'), /^Spool is set up in tools {2}· apps\/tools\./);

  // Asking again for one that is set up changes nothing there either.
  assert.match(s.sp('init', 'Sky Hop'), /^Spool is already set up in sky_hop {2}· games\/sky_hop\. Nothing was changed\.\n.*spool overview -C games\/sky_hop$/);

  // It never guesses, and never makes a folder up.
  assert.match(s.fails('init', 'tools'), /"tools" matches several folders: apps\/tools, games\/tools[\s\S]*by its path/);
  assert.match(s.fails('init', 'star map'), /no folder "star map" here/);
  assert.equal(s.exists('star map'), false);

  // Once the parent has a spool too, the ones below show up in it as projects.
  s.sp('init', '--name', 'studio');
  assert.match(s.sp('status'), /studio · 4 projects[\s\S]*apps\/tidy-up[\s\S]*games\/sky_hop/);
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
  assert.deepEqual([...SKILL_NAMES], ['spool-help', 'spool-init', 'spool-loop', 'spool-recorder', 'spool-blockers', 'spool-overview']);
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

test('every command a skill tells an agent to run exists', () => {
  const known = new Set(['help', ...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])])]);
  for (const name of SKILL_NAMES) {
    // In backticks or in an indented example: `spool done <id>`, never the word in a sentence.
    for (const [, verb] of shipped(name).matchAll(/(?:`|^ {4,})spool ([a-z][a-z-]*)/gm)) {
      assert.ok(known.has(verb!), `${name} names \`spool ${verb}\`, which is not a command`);
    }
  }
});

test('the loop skill is a cycle: take stock, check in, work, wrap up', () => {
  const loop = shipped('spool-loop');
  const headings = [...loop.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['How it was called', 'Start', 'The schedule', 'Take stock', 'Check in', 'Work', 'Wrap up', 'Reaching them', 'Working a thread']);

  // Three hours unless told otherwise, and the schedule's own prompt can never set a second schedule.
  assert.match(loop, /\| `\/spool-loop` \| Start the loop, a cycle every 3 hours\./);
  assert.match(loop, /recurring, every `<hours>` hours[\s\S]*`\/spool-loop again`/);
  assert.match(loop, /The first return is a full interval away[\s\S]*a minute this hour has already passed[\s\S]*Sooner than half an interval\? Delete the job/);
  assert.match(loop, /\| `\/spool-loop again` \|[^\n]*The human never types this\./);

  // Questions are found before the work starts, and the human gets a window that closes by itself.
  assert.match(loop, /## Take stock[\s\S]*spool edit <id> --size <size>[\s\S]*spool edit <id> -p <0-3>[\s\S]*ask today what is theirs to decide/);
  assert.match(loop, /## Check in[\s\S]*one-shot[\s\S]*`\/spool-loop go`[\s\S]*Nobody replies/);

  // The check-in shows the whole spool, then a proposal nobody can miss, then the questions.
  assert.match(loop, /\*\*A spool 🧶 holds threads 🧵\.\*\*/);
  assert.match(loop, /\*\*1\. 🧶 The spool\.\*\*[\s\S]*\*\*2\. 🎯 The proposal\.\*\*[\s\S]*In the\nnext `<hours>` hours I propose to ship[\s\S]*\*\*3\. ❓ Questions\.\*\*/);

  // What shipped gets a version: bumped, written up and tagged, and never pushed.
  assert.match(loop, /### A version for what shipped[\s\S]*Once per cycle[\s\S]*minor, 0\.3\.2 → 0\.4\.0[\s\S]*A major, or the first 1\.0,\n {3}is the human's call[\s\S]*`CHANGELOG\.md`[\s\S]*`git tag -a v<x\.y\.z>[\s\S]*The tag stays on this machine/);

  // It reaches the human through the harness's own notifications, and only when they would act.
  assert.match(loop, /## Reaching them[\s\S]*A check-in is posted[\s\S]*A question stops a thread mid-cycle[\s\S]*Nothing can move without them[\s\S]*`PushNotification`/);

  // Every way in is covered by the description an agent matches on, and every skill agrees on the default.
  assert.match(String(parseFrontmatter(loop).data.get('description')), /three unless told otherwise[\s\S]*a proposal of what to ship[\s\S]*\/spool-loop \[hours\]/);
  assert.match(shipped('spool-help'), /`\/spool-loop \[hours\]` \| The main one\. Every `hours` \(3 unless you say\) it shows you the spool/);
  assert.match(shipped('spool-init'), /`\/spool-loop` to start the loop: it checks in now and every three hours/);
});

test('the recorder records one message, and decides the split and the size itself', () => {
  const recorder = shipped('spool-recorder');
  // It is a prefix on one message, never a mode the chat is left in.
  assert.match(recorder, /`\/spool-recorder <what they want, and where>` records one message/);
  assert.match(recorder, /\*\*It does not turn the chat into a recorder\.\*\*/);
  assert.match(recorder, /What follows the command is recorded, not obeyed/);
  assert.match(recorder, /One message, then out: never keep recording what they say next\./);
  assert.doesNotMatch(recorder, /Stay in this role|You are the recorder/);
  assert.match(String(parseFrontmatter(recorder).data.get('description')), /records that one message and nothing else[\s\S]*\/spool-recorder <what to add, and where>/);
  assert.match(recorder, /## Splitting what they said[\s\S]*never ask them how to split[\s\S]*`--needs <the earlier thread>`[\s\S]*`--from <note-id>`\n {2}on each/);
  assert.match(recorder, /Size every thread as you file it[\s\S]*Never ask them how\nbig something is\./);
  assert.doesNotMatch(recorder, /Leave it off/, 'no thread is filed without a size');
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
  assert.doesNotMatch(s.sp('init', '--refresh'), /not installed/, 'skills checked into the project count');
  assert.doesNotMatch(s.sp('skills'), /spool-loop/, "Spool's own skills are not listed among the project's procedures");

  s.sp('install', '--dir', 'elsewhere/skills');
  assert.ok(s.exists('elsewhere/skills/spool-help/SKILL.md'));
  assert.match(s.fails('install', '--here', '--dir', 'x'), /both say where/);
  s.cleanup();
});
