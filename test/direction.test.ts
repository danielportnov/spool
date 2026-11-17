import assert from 'node:assert/strict';
import { test } from 'node:test';
import { change } from '../src/act.ts';
import { board } from '../src/board.ts';
import { Workspace } from '../src/store.ts';
import { engineCtx } from './claude.ts';
import { Sandbox } from './helpers.ts';

/** A project with a changelog, a sprint being played and a loose backlog. */
function project() {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  s.write('CHANGELOG.md', '# Changelog\n\n## 0.2.0 · 2026-01-01\n\n**Coins you can see:** gold at sunset.\n- Coins are outlined.\n- The menu says what each button does.\n');
  s.sp('sprint', 'Launch', '--goal', 'A build a stranger can finish');
  const menu = s.id('task', 'A menu that says what each button does', '-s', 's', '--sprint', 'Launch');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'm', '--sprint', 'Launch');
  const pause = s.id('task', 'Pause button under the score', '-s', 's', '--sprint', 'Launch');
  s.sp('play', 'Launch');
  const typo = s.id('task', 'Fix the typo on the title screen', '-s', 'xs', '--tag', 'polish');
  const grand = s.id('task', 'A Grand Prix mode', '-s', 'm', '--tag', 'modes');
  const time = s.id('task', 'A time trial mode', '-s', 'm', '--tag', 'modes');
  return { s, menu, coins, pause, typo, grand, time };
}

test('an overview pass hands the agent the whole project, and the rules for what it proposes', () => {
  const { s, coins, grand } = project();
  try {
    const out = s.sp('manage', '--start', '--overview', '--as', 'Mgr');
    assert.match(out, /^SPOOL_RUN=t-\w+$/m);
    assert.match(out, /spool manage --propose goals --edit -/);
    assert.match(out, /spool manage --propose sprint "<name>"/);
    assert.match(out, /spool manage --propose order <sprint> <t-id…>/);
    assert.match(out, /GOALS {2}none set yet/);
    assert.match(out, /0\.2\.0 · 2026-01-01 {2}2 lines\n {4}Coins you can see/);
    assert.match(out, new RegExp(`Launch {2}· running · A build a stranger can finish[\\s\\S]*${coins}`));
    assert.match(out, /in Build now, first built first: t-/);
    assert.match(out, /by size {2}m 2 · xs 1/);
    assert.match(out, /by tag {3}modes 2 · polish 1/);
    assert.ok(out.includes(grand));
    const data = s.json('manage');
    assert.match(data.open.title, /^An overview of the project/);
  } finally {
    s.cleanup();
  }
});

test('an overview proposes goals, a sprint and an order, and a yes on each makes it so', () => {
  const { s, menu, coins, pause, grand, time } = project();
  try {
    const run = /^SPOOL_RUN=(t-\w+)$/m.exec(s.sp('manage', '--start', '--overview', '--as', 'Mgr'))![1]!;
    const goals = '# Goals\n\nFor: a racing game a stranger can finish\n\n- Launch\n- New ways to race';
    assert.equal(s.exec(['manage', '--propose', 'goals', '--edit', '-', '-m', 'Nothing is set, and the backlog points at modes', '--as', 'Mgr'], { stdin: goals }).code, 0);
    s.sp('manage', '--propose', 'sprint', 'New modes', '--goal', 'Two new ways to race', '--why', 'Asked for twice', '--add', grand, time, '-m', 'Both are modes', '--as', 'Mgr');
    s.sp('manage', '--propose', 'order', 'Launch', pause, coins, menu, '-m', 'The pause button is the smallest win', '--as', 'Mgr');
    // Proposed is not done: nothing changed yet.
    assert.match(s.sp('goals'), /No goals yet/);
    assert.doesNotMatch(s.sp('list', '--json'), /New modes/);
    s.sp('manage', '--end', '-m', 'Proposed goals, 1 sprint and an order', '--as', 'Mgr');

    // The board shows each with what it would do, and a yes and a no.
    const ws = Workspace.open(s.dir, () => new Date());
    try {
      const b = board(ws);
      const card = Object.values(b.columns).flat().find((c) => c.id === run)!;
      assert.equal(card.proposals.length, 3);
      assert.match(card.proposals[0]!.text, /^Set the goals to/);
      assert.match(card.proposals[0]!.detail, /New ways to race/);
      assert.match(card.proposals[1]!.text, /^Draft the sprint “New modes”, Two new ways to race, with /);
      assert.match(card.proposals[2]!.detail, new RegExp(`^1\\. ${pause}`));
    } finally {
      ws.close();
    }

    const ctx = engineCtx(s);
    assert.equal(change(ctx, 'proposal', { id: run, n: 1, said: 'yes' }).ok, true);
    assert.match(s.sp('goals'), /For: a racing game a stranger can finish/);
    assert.equal(change(ctx, 'proposal', { id: run, n: 2, said: 'yes' }).ok, true);
    const made = s.json('show', grand).item.sprint;
    assert.ok(made, 'the thread is in the new sprint');
    assert.match(s.sp('show', made), /planned/);
    assert.equal(change(ctx, 'proposal', { id: run, n: 3, said: 'yes' }).ok, true);
    const ready = s.json('overview').projects[0].ready.map((t: { id: string }) => t.id);
    assert.deepEqual(ready.slice(0, 3), [pause, coins, menu]);
    assert.equal(s.json('brief').needsYou.proposals.length, 0, 'nothing waits once each is answered');
  } finally {
    s.cleanup();
  }
});

test('a no leaves things as they are, and a proposal is checked when it is made', () => {
  const { s, menu, coins, typo, grand } = project();
  try {
    const run = /^SPOOL_RUN=(t-\w+)$/m.exec(s.sp('manage', '--start', '--overview', '--as', 'Mgr'))![1]!;
    assert.match(s.fails('manage', '--propose', 'sprint', 'Launch', '--goal', 'x', '--add', grand, '-m', 'why', '--as', 'Mgr'), /already a sprint called/);
    assert.match(s.fails('manage', '--propose', 'sprint', 'Modes', '--add', grand, '-m', 'why', '--as', 'Mgr'), /needs its goal/);
    assert.match(s.fails('manage', '--propose', 'sprint', 'Modes', '--goal', 'x', '--add', menu, '-m', 'why', '--as', 'Mgr'), /not in the backlog/);
    assert.match(s.fails('manage', '--propose', 'order', 'Launch', menu, typo, '-m', 'why', '--as', 'Mgr'), /is not in Launch/);
    assert.match(s.fails('manage', '--propose', 'order', 'Launch', menu, '-m', 'why', '--as', 'Mgr'), /two threads or more/);
    assert.match(s.fails('manage', '--propose', 'goals', '-m', 'why', '--as', 'Mgr'), /goals are missing/);
    s.sp('manage', '--propose', 'order', 'Launch', coins, menu, '-m', 'Coins first', '--as', 'Mgr');
    assert.match(s.fails('manage', '--propose', 'order', 'Launch', menu, coins, '-m', 'again', '--as', 'Mgr'), /already proposed/);
    const before = s.json('overview').projects[0].ready.map((t: { id: string }) => t.id);
    s.sp('manage', '--answer', 'no', '1', '--on', run);
    assert.deepEqual(s.json('overview').projects[0].ready.map((t: { id: string }) => t.id), before);
    assert.match(s.fails('manage', '--start', '--overview', '--takeover', '--as', 'Mgr'), /--overview goes with --start alone/);
  } finally {
    s.cleanup();
  }
});
