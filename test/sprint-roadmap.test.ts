/**
 * The data behind the Roadmap view: the board's goals, and each sprint with what it is for, when it
 * was started and reached, and the version it became.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board } from '../src/board.ts';
import { Workspace } from '../src/store.ts';
import { roadmapSandbox } from './roadmap-sandbox.ts';

test('the board carries the goals, and each sprint with what it is for and when it started and was reached', () => {
  const r = roadmapSandbox();
  const ws = Workspace.open(r.s.dir, () => new Date());
  try {
    const b = board(ws);
    assert.deepEqual(b.goals, { for: 'a platformer that feels good on a phone', towards: ['Controls that feel tight', 'A world worth exploring'] });
    const [polish, worlds, daily] = b.sprints;
    // Every field the board had is still there, as it was; the new ones sit beside them.
    assert.deepEqual(Object.keys(polish!), ['id', 'name', 'status', 'goal', 'why', 'doneWhen', 'serves', 'vision', 'version', 'started', 'reached', 'total', 'done', 'waiting']);
    assert.deepEqual(
      b.sprints.map((x) => [x.id, x.status, x.total, x.done, x.waiting]),
      [
        [r.polish, 'done', 2, 2, 0],
        [r.worlds, 'running', 3, 1, 1],
        [r.later, 'planned', 2, 0, 2],
      ],
    );
    assert.equal(polish!.serves, 'Controls that feel tight');
    assert.match(polish!.started, /^2026-01-01T\d\d:\d\d:00Z$/);
    assert.ok(polish!.reached > polish!.started, 'reached after it was started');
    assert.equal(worlds!.vision, 'I want a second world that feels like night');
    assert.deepEqual([worlds!.reached, daily!.started, daily!.reached], ['', '', ''], 'not reached, and not started');
    r.s.sp('edit', r.polish, '--version', '0.13.0');
    const again = Workspace.open(r.s.dir, () => new Date());
    try {
      assert.equal(board(again).sprints[0]!.version, '0.13.0', 'the version it became');
    } finally {
      again.close();
    }
  } finally {
    ws.close();
    r.s.cleanup();
  }
});

test('the board says no goals where none are set', () => {
  const r = roadmapSandbox();
  r.s.sp('goals', '--edit', '# Goals\n\nFor: (what this project is for, in one line)');
  const ws = Workspace.open(r.s.dir, () => new Date());
  try {
    assert.equal(board(ws).goals, null);
  } finally {
    ws.close();
    r.s.cleanup();
  }
});
