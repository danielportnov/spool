import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

const GOALS = `# Goals

For: A platformer a stranger can pick up and finish in an evening

- A first level nobody gets stuck on
- Runs at 60 fps on a five-year-old phone
`;

test('init leaves a goals page to fill in, and until it is filled nothing reads as a goal', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    assert.match(s.read('.spool/goals.md'), /^# Goals[\s\S]*For: \(what this project is for, in one line\)/);
    const empty = s.json('goals');
    assert.equal(empty.set, false);
    assert.match(s.sp('goals'), /No goals yet in skyhop\. Ask what it is for and where it is heading, then: spool goals --edit -/);
    assert.doesNotMatch(s.sp('prime'), /GOALS/);
    assert.match(s.sp('overview', '--table'), /^\*\*🧶 skyhop\*\*/, 'the list leads with nothing while the page is blank');
  } finally {
    s.cleanup();
  }
});

test('the goals are kept on his word, handed to every agent above the policy, and lead the list', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    const edited = s.exec(['goals', '--edit', '-'], { stdin: GOALS });
    assert.equal(edited.code, 0, edited.err);
    assert.equal(s.read('.spool/goals.md'), GOALS);
    const data = s.json('goals');
    assert.equal(data.for, 'A platformer a stranger can pick up and finish in an evening');
    assert.deepEqual(data.towards, ['A first level nobody gets stuck on', 'Runs at 60 fps on a five-year-old phone']);
    assert.match(s.sp('goals'), /^# Goals\n\nFor: A platformer/);

    const prime = s.sp('prime');
    assert.match(prime, /GOALS \(\.spool\/goals\.md\)\n\n# Goals\n\nFor: A platformer[\s\S]*POLICY \(\.spool\/policy\.md\)/);
    assert.match(s.sp('prime', 'worker', '--context'), /^GOALS[\s\S]*POLICY/);

    s.sp('task', 'Round the menu corners', '-s', 'xs', '-b', 'Why: it looks finished');
    assert.deepEqual(s.sp('overview', '--table').split('\n').slice(0, 4), [
      '🎯 **A platformer a stranger can pick up and finish in an evening**',
      'Heading towards: A first level nobody gets stuck on · Runs at 60 fps on a five-year-old phone',
      '',
      '**🧶 skyhop** · 0 threads in build · 1 proposed · 0 done',
    ]);
  } finally {
    s.cleanup();
  }
});

test('a sprint says which goal it serves, and check asks for one once there are goals', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    s.sp('sprint', 'Polish', '--goal', 'Everything looks finished');
    assert.doesNotMatch(s.sp('check'), /names no goal/, 'no goals yet, so nothing to name');
    s.exec(['goals', '--edit', '-'], { stdin: GOALS });
    assert.match(s.sp('check'), /warn {3}r-\w+ \(Polish\) names no goal it serves: spool sprint "Polish" --serves/);

    assert.match(s.sp('sprint', 'Polish', '--serves', 'a first level nobody gets stuck on'), /^Sprint Polish: serves\./);
    assert.doesNotMatch(s.sp('check'), /names no goal/);
    assert.match(s.sp('overview', '--table'), /🏁 \*\*Polish\*\* · planned · 0 of 0 done · serves a first level nobody gets stuck on — Everything looks finished/);
    assert.match(s.sp('list', '-k', 'sprint'), /Polish {2}· planned · 0 of 0 done · serves a first level nobody gets stuck on/);
    assert.equal(s.json('list', '-k', 'sprint').items[0].serves, 'a first level nobody gets stuck on');
  } finally {
    s.cleanup();
  }
});
