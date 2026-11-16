/**
 * The data behind a sprint's review: what `/api/review` gives for a reached sprint and one being
 * played, and "Approve the sprint" as the command it runs, for that sprint and nothing else.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPage } from './helpers.ts';
import { roadmapSandbox } from './roadmap-sandbox.ts';

test('a sprint review lists each thread with its result, steps and calls, and Approve the sprint approves just those', async () => {
  const r = roadmapSandbox();
  const page = await startPage(r.s);
  const review = async (id: string) => {
    const res = await fetch(`${page.url}api/review?id=${id}`);
    assert.equal(res.status, 200);
    return (await res.json()) as any;
  };
  const post = (action: string, body: unknown) =>
    fetch(`${page.url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) });
  try {
    const polish = await review(r.polish);
    assert.deepEqual([polish.sprint.name, polish.sprint.status, polish.sprint.goal, polish.sprint.doneWhen], ['Polish', 'done', 'Everything looks finished', 'nothing looks placeholder']);
    assert.deepEqual([polish.total, polish.done, polish.files], [2, 2, 3], 'three files changed in all, each counted once');
    assert.ok(polish.took > 0);
    assert.deepEqual(
      polish.threads.map((t: any) => [t.id, t.state, t.summary, t.steps, t.files, t.complete]),
      [
        [r.jump, 'done', 'The jump is snappier, for real', ['Open level 1', 'Jump the first gap: you land on it'], 1, false],
        [r.coins, 'done', 'Coins have a dark rim', ['Play level 3 at sunset'], 2, false],
      ],
    );
    assert.deepEqual(polish.threads[1].calls, [
      { id: r.call, title: 'Outline the coins, or turn them teal?', choice: 'Outline them', why: 'teal clashes with water', by: 'agent', status: 'assumed', instead: '' },
    ]);
    assert.deepEqual(polish.undone.map((u: any) => [u.id, u.what]), [[r.jump, 'reverted 1 commit(s): still floaty']]);
    assert.deepEqual(polish.toApprove, { threads: [r.coins, r.jump], calls: [r.call] });

    // The sprint being played, so far: what is finished, and what is not yet.
    const worlds = await review(r.worlds);
    assert.deepEqual(worlds.threads.map((t: any) => [t.id, t.state]), [[r.map, 'done'], [r.boss, 'ready'], [r.shop, 'proposed']]);
    assert.deepEqual(worlds.toApprove, { threads: [r.map], calls: [] });
    assert.equal((await fetch(`${page.url}api/review?id=nope`)).status, 400);

    // Approve the sprint: its finished threads complete, its calls accepted, and nothing outside it.
    const other = r.s.id('task', 'A mute button');
    r.s.sp('build', other);
    r.s.sp('start', other);
    r.s.sp('done', other, '-m', 'Mute is in settings');
    const elsewhere = r.s.json('assume', 'Where does mute live?', '--chose', 'Settings', '--for', other).decision.id;
    const approved = await post('approve-sprint', { id: r.polish });
    assert.equal(approved.status, 200);
    const show = (id: string) => r.s.json('show', id).item;
    assert.ok(show(r.jump).reviewed && show(r.coins).reviewed, 'its threads are complete');
    assert.equal(show(r.call).status, 'decided', 'its call is accepted');
    assert.ok(!show(r.map).reviewed && !show(other).reviewed, 'threads in no other sprint are touched');
    assert.equal(show(elsewhere).status, 'assumed');
    assert.deepEqual((await review(r.polish)).toApprove, { threads: [], calls: [] });
    assert.equal(((await (await post('approve-sprint', { id: r.polish })).json()) as { text: string }).text, 'Nothing in it left to approve.');
    assert.equal((await post('approve-sprint', { id: 'polish' })).status, 400);
    assert.equal(show(r.polish).version ?? '', '', 'the page cuts no version');
  } finally {
    await page.stop();
    r.s.cleanup();
  }
});
