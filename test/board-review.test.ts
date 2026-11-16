/** The board's needs and counts come from one reading of the review, and say what they did when it was read twice. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox, startPage } from './helpers.ts';

test('the board carries the questions waiting and the counts beside them, from the same review', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const coins = s.id('task', 'Make coins readable at sunset');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const question = s.json('review').questions[0].id;
  s.sp('capture', 'add a mute button to settings');
  const page = await startPage(s);
  try {
    const b = (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
    assert.deepEqual(b.needs.questions.map((q: any) => [q.id, q.title, q.options, q.recommend, q.threads]), [[question, 'Outline the coins, or turn them teal?', ['Outline', 'Teal'], 1, [coins]]]);
    assert.deepEqual(b.needs.plans, []);
    assert.deepEqual(b.needs.notes.map((n: any) => n.text), ['add a mute button to settings']);
    assert.deepEqual(b.also, { assumptions: 0, skills: 0, inbox: 1 });
  } finally {
    await page.stop();
    s.cleanup();
  }
});
