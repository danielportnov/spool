import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox, spool } from './helpers.ts';

/** Three write-ups of one procedure, in the loose way three agents would put it. */
const RELEASES: [string, string][] = [
  ['Release 0.4.0', 'Built, bumped the version in package.json, wrote the changelog and tagged v0.4.0.'],
  ['Cut the 0.5.0 release', 'Bumped the version to 0.5.0, changelog written, build green, tagged v0.5.0.'],
  ['Ship version 0.6.0', 'Ran the build, bumped package.json to version 0.6.0, added the changelog entry and a v0.6.0 tag.'],
];
const FOURTH: [string, string] = ['Get 0.7.0 out', 'Version bumped to 0.7.0, changelog updated, tagged v0.7.0 after a clean build.'];

/** Unrelated work, three of them on one subject: a subject is not a procedure. */
const OTHERS: [string, string][] = [
  ['Make coins readable at sunset', 'Coins have a dark outline now; look at level 3 at dusk.'],
  ['Tighten the jump arc', 'Gravity is up a fifth, so the jump lands sooner. Try the long gap in level 2.'],
  ['The jump feels floaty over long gaps', 'Hang time at the top of the jump is halved.'],
  ['Jump sound plays late', 'The jump sound now starts on the press, not on leaving the ground.'],
  ['Fix the typo on the title screen', 'It says "Press start" again.'],
];

function finish(s: Sandbox, [title, summary]: [string, string], ...more: string[]): string {
  const id = s.id('task', title, '-s', 's');
  s.sp('done', id, '-m', summary, ...more);
  return id;
}

const candidates = (s: Sandbox, ...more: string[]) => s.json('skills', '--suggest', ...more).candidates;

test('the same steps in three finished tasks are found, with the tasks, the terms and the lines to run', () => {
  const s = spool();
  const a = finish(s, RELEASES[0]!);
  finish(s, OTHERS[0]!);
  const b = finish(s, RELEASES[1]!);
  finish(s, OTHERS[1]!);
  assert.equal(s.sp('skills', '--suggest'), 'Nothing keeps recurring: no 3 finished threads share the same steps without a skill.', 'twice is a coincidence');

  // The third time is when it is said: to the agent that just did it, as it finishes.
  const c = s.id('task', RELEASES[2]![0], '-s', 's');
  assert.match(
    s.sp('done', c, '-m', RELEASES[2]![1]),
    new RegExp(`The same steps as ${a}, ${b}, with no skill for them\\. Offer one: spool skills --suggest`),
  );
  const other = s.id('task', OTHERS[2]![0], '-s', 'xs');
  assert.match(s.sp('done', other, '-m', OTHERS[2]![1]), /A procedure worth keeping\?/, 'and only to that agent');

  const add = `spool skill add <name> -d "<what it does and when to use it>" --from ${a},${b},${c} -b - <<'EOF' … EOF`;
  const offer = `spool task "Write down how we <the procedure, in their words> as a skill" --suggested "agents worked these steps out 3 times over; written down, the next one just follows them" --from ${a},${b},${c} --size s -b "<the steps, as far as you know them>"`;
  const out = s.sp('skills', '--suggest');
  assert.match(out, /^WORKED OUT MORE THAN ONCE {2}the same steps in finished threads, and no skill for them\n\n1\. bumped · changelog · tagged · version {2}· in 3 finished threads\n/);
  assert.match(out, new RegExp(` {5}${a} {2}Release 0\\.4\\.0 {2}· Built, bumped the version in package\\.json`));
  assert.match(out, new RegExp(` {5}${b} {2}Cut the 0\\.5\\.0 release {2}· Bumped the version to 0\\.5\\.0`));
  assert.match(out, new RegExp(` {5}${c} {2}Ship version 0\\.6\\.0 {2}· Ran the build`));
  assert.ok(out.includes(`\n   offer it       ${offer}\n   on their yes   ${add}\n`), 'the exact lines to run');
  assert.match(out, /read the threads first[\s\S]*Offer it, then spool drop it with the reason/);
  assert.doesNotMatch(out, /coins|jump/i, 'unrelated work is not part of it');

  // The same thing as data.
  assert.deepEqual(s.json('skills', '--suggest'), {
    candidates: [
      {
        project: 'demo',
        terms: ['bumped', 'changelog', 'tagged', 'version'],
        tasks: [
          { id: a, title: 'Release 0.4.0', summary: RELEASES[0]![1], project: 'demo' },
          { id: b, title: 'Cut the 0.5.0 release', summary: RELEASES[1]![1], project: 'demo' },
          { id: c, title: 'Ship version 0.6.0', summary: RELEASES[2]![1], project: 'demo' },
        ],
        offer,
        add,
      },
    ],
    needs: { tasks: 3, terms: 4 },
  });
  // Plain `spool skills` is what it was: the skills that exist.
  assert.equal(s.sp('skills'), 'No skills yet. Agents add them with: spool skill add');
  assert.match(s.sp('help', 'skills'), /^spool skills \[--suggest \[-P <project>\]\]/);
  s.cleanup();
});

test('a handful of unrelated finished tasks suggests nothing, even where they share a subject', () => {
  const s = spool();
  for (const other of OTHERS) finish(s, other);
  finish(s, RELEASES[0]!);
  finish(s, RELEASES[1]!);
  assert.equal(s.sp('skills', '--suggest'), 'Nothing keeps recurring: no 3 finished threads share the same steps without a skill.');
  assert.deepEqual(candidates(s), []);

  // Work that is open, on hold or dropped has shown nothing yet, and an audit or a plan is not a procedure to keep.
  const open = s.id('task', RELEASES[2]![0]);
  assert.deepEqual(candidates(s), []);
  s.sp('drop', open);
  for (const [title, summary] of RELEASES) {
    const audit = s.id('audit', title);
    assert.equal(s.exec(['done', audit, '-m', summary, '--report', '-'], { stdin: summary }).code, 0);
  }
  assert.deepEqual(candidates(s), []);
  s.cleanup();
});

test('a task that reported a skill is no evidence that one is missing', () => {
  const s = spool();
  s.write('.claude/skills/cut-a-release/SKILL.md', '---\nname: cut-a-release\ndescription: Build, bump the version, write the changelog, tag.\n---\n');
  const a = finish(s, RELEASES[0]!);
  const b = finish(s, RELEASES[1]!);
  const c = s.id('task', RELEASES[2]![0]);
  assert.match(s.sp('done', c, '-m', RELEASES[2]![1], '--skill', 'cut-a-release'), /A procedure worth keeping\?/, 'no nudge for work that followed a skill');
  assert.deepEqual(candidates(s), [], 'two without a skill are not three');

  // Only the tasks that worked it out themselves are counted.
  const d = s.id('task', FOURTH[0]);
  assert.deepEqual(s.json('done', d, '-m', FOURTH[1]).repeats, [a, b]);
  assert.deepEqual(candidates(s)[0].tasks.map((t: { id: string }) => t.id), [a, b, d]);
  s.cleanup();
});

test('once a skill is written from its tasks, the procedure is not suggested again', () => {
  const s = spool();
  const [a, b, c] = RELEASES.map((r) => finish(s, r));
  assert.equal(candidates(s).length, 1);

  const skill = s.id('skill', 'add', 'cut-a-release', '-d', 'Build, bump the version, write the changelog and tag. Use when asked to release.', '--from', `${a},${b},${c}`, '-b', '1. Build.\n2. Bump.\n3. Tag.');
  assert.deepEqual(candidates(s), []);
  assert.match(s.sp('review'), new RegExp(`NEW SKILLS[\\s\\S]*cut-a-release {2}· by agent from ${a}, ${b}, ${c}`));

  // A later release that forgot to say it used the skill does not bring the suggestion back…
  const d = s.id('task', FOURTH[0]);
  assert.doesNotMatch(s.sp('done', d, '-m', FOURTH[1]), /The same steps as/);
  assert.deepEqual(candidates(s), []);
  // …and nor does the human dropping the skill: that was a no.
  s.sp('drop', skill, '-m', 'we release by hand');
  assert.deepEqual(candidates(s), []);
  s.cleanup();
});

test('a skill written from just one of the tasks settles it too', () => {
  const s = spool();
  const [a] = RELEASES.map((r) => finish(s, r));
  s.sp('skill', 'add', 'cut-a-release', '-d', 'Build, bump, tag.', '--from', a!, '-b', 'steps');
  assert.deepEqual(candidates(s), []);
  s.cleanup();
});

test('offered to the human, it is a row in their list to say yes or no to, and a no is remembered', () => {
  const s = spool();
  const [a, b, c] = RELEASES.map((r) => finish(s, r));
  s.sp('task', 'Tighten the jump arc', '-s', 's');

  // An ordinary idea that follows from one of them is not the offer.
  s.sp('task', 'Publish the changelog on the site', '-s', 's', '--suggested', 'people ask what changed', '--from', c!);
  assert.equal(candidates(s).length, 1);

  // The agent runs the line it was given, with the name and the steps filled in.
  const { offer } = candidates(s)[0];
  const why = /--suggested "([^"]+)"/.exec(offer)![1]!;
  const from = /--from (\S+)/.exec(offer)![1]!;
  assert.equal(from, `${a},${b},${c}`);
  const idea = s.id('task', 'Write down how we cut a release as a skill', '--suggested', why, '--from', from, '--size', 's', '-b', 'Build, bump the version, write the changelog, tag.');

  const table = s.sp('overview', '--table');
  assert.match(table, /^\*\*🧶 demo\*\* · 1 thread in build · 2 AI suggested · 3 done\n/);
  assert.ok(
    table.includes('| **Write down how we cut a release as a skill** | Small | Normal | ✨ AI suggested: agents worked these steps out 3 times over; written down, the next one just follows them. Say yes and it joins the order. |'),
    table,
  );
  assert.match(s.sp('overview'), /✨ AI SUGGESTED {2}2\n[\s\S]*🧵 Write down how we cut a release as a skill {2}· “agents worked these steps out 3 times over/);
  assert.deepEqual(candidates(s), [], 'while it waits for an answer it is not raised again');

  // Yes: it joins the order, and its brief names the tasks the steps are to be read from.
  s.sp('release', idea);
  const brief = s.sp('start', idea);
  assert.match(brief, new RegExp(`CAME FROM\\n {2}${a} {2}Release 0\\.4\\.0 — Built, bumped the version`));
  assert.match(brief, new RegExp(`CAME FROM\\n {2}${c} {2}Ship version 0\\.6\\.0`));
  assert.deepEqual(candidates(s), []);

  // No: the thread is dropped, and the procedure is never offered again, however often it recurs.
  s.sp('drop', idea, '-m', 'no, releases are mine');
  assert.deepEqual(candidates(s), []);
  const d = s.id('task', FOURTH[0]);
  assert.doesNotMatch(s.sp('done', d, '-m', FOURTH[1]), /The same steps as/);
  assert.deepEqual(candidates(s), []);
  s.cleanup();
});

test('what counts is how the work was done: the agent’s notes, not the request or the queue’s own log', () => {
  const s = spool();
  // Three tasks named and summed up differently, whose notes show the same steps.
  const steps = ['exported the sprites from the atlas, then repacked the atlas and bumped the cache key', 'atlas repacked after the sprites export; cache key bumped', 'Sprites exported, atlas repacked, cache key bumped by hand'];
  const made = [['New enemy art', 'The slime has three frames now.'], ['Winter tiles', 'Snow on every roof.'], ['Bigger coins', 'Coins are a third larger.']].map(([title, summary], i) => {
    const id = s.id('task', title!, '-s', 's');
    s.sp('start', id);
    s.sp('log', id, steps[i]!);
    s.sp('done', id, '-m', summary!);
    return id;
  });
  const [found] = candidates(s);
  assert.deepEqual(found.tasks.map((t: { id: string }) => t.id), made);
  for (const term of ['atlas', 'sprites', 'cache', 'key']) assert.ok(found.terms.includes(term), `${term} is shared`);
  s.cleanup();

  // Three tasks cut from one piece of feedback share its words, and the reason they were parked. Neither is a step.
  const t = spool();
  const note = t.id('capture', 'the garden screen needs watering, weeding and harvest timers before the autumn update');
  const cut = ['Watering', 'Weeding', 'Harvest'].map((title) => t.id('task', title, '--from', note, '-s', 's'));
  t.sp('hold', ...cut, '-m', 'wait for the autumn update art from the garden team');
  t.sp('release', ...cut);
  cut.forEach((id, i) => t.sp('done', id, '-m', ['Cans refill at the well.', 'Weeds grow back in two days.', 'Crops ripen on a timer.'][i]!));
  assert.deepEqual(candidates(t), []);

  // Nor is pointing at the same items: ids are names, not words for what was done.
  for (const [title, summary] of [['Shop palette', 'The shop is teal.'], ['Menu palette', 'Amber menus.'], ['Map palette', 'Slate for the map.']]) {
    const id = t.id('task', title!, '-s', 'xs');
    t.sp('log', id, 'follows d-k3pq and d-9xzr, as in t-m2ab');
    t.sp('done', id, '-m', summary!);
  }
  assert.deepEqual(candidates(t), []);
  t.cleanup();
});

test('words the whole project uses stop telling of a procedure', () => {
  const s = spool();
  const editor: [string, string][] = [
    ['Level editor: snap to grid', 'Tiles snap to the grid in the level editor.'],
    ['Level editor: show the grid', 'The level editor draws its grid, and tiles still snap.'],
    ['Level editor: grid size', 'Grid size is a setting; snap follows it in the level editor.'],
  ];
  for (const e of editor) finish(s, e);
  assert.deepEqual(candidates(s)[0].terms.sort(), ['editor', 'grid', 'level', 'snap']);

  // Four more tasks about levels and the editor: now those two words are the project talking, and two are left.
  for (const what of ['undo', 'copy and paste', 'a minimap', 'autosave']) finish(s, [`Level editor: ${what}`, `The level editor has ${what}.`]);
  assert.deepEqual(candidates(s), []);
  s.cleanup();
});

test('in a workspace a procedure belongs to the project that holds every task it was seen in', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  const hop = s.cd('games/sky_hop');
  const dash = s.cd('games/dash');
  hop.sp('init');
  dash.sp('init');
  const a = finish(hop, RELEASES[0]!);
  const b = finish(dash, RELEASES[1]!);
  const c = finish(hop, RELEASES[2]!);

  // Seen across two games, it is the studio's: a skill there reaches both.
  const [found] = candidates(s);
  assert.equal(found.project, 'studio');
  assert.ok(found.add.includes(`--from ${a},${b},${c} -P studio `) && found.offer.includes(`--from ${a},${b},${c} -P studio `));
  assert.match(s.sp('skills', '--suggest'), /· in 3 finished threads · studio\n/);

  // Asked about one game, only that game and what is below it are compared.
  assert.deepEqual(candidates(s, '-P', 'sky_hop'), []);
  const d = finish(hop, FOURTH);
  const [mine] = candidates(s, '-P', 'sky_hop');
  assert.equal(mine.project, 'games/sky_hop');
  assert.ok(mine.add.includes(`--from ${a},${c},${d} -b`), 'filed beside the tasks it came from, so no project is named');
  s.cleanup();
});
