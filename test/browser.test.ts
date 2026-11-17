/**
 * The page, driven the way a person drives it: a real browser, a real mouse.
 *
 * The other page tests talk to the server; this one clicks, drags and types.
 * It uses the Chrome already on the machine (through playwright-core, which
 * brings no browser of its own) and is skipped where there is none.
 *
 * Set SPOOL_SHOTS to a folder and it leaves a picture of each view there, for
 * a look at how the page actually renders.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Locator, type Page } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('the page, clicked, dragged and typed on in a real browser', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('package.json', JSON.stringify({ name: 'skyhop', version: '1.4.2' }));
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const pause = s.id('task', 'Pause button under the score', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const state = (id: string): string => s.json('show', id).item.state;

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const column = (key: string): Locator => page.locator(`#board [data-column="${key}"]`);
  const card = (key: string, title: string): Locator => column(key).locator('.card', { hasText: title });
  // A real mouse drag of a card to a column. On a slow runner (CI's macOS on Node 24, once) a drag
  // was lost: the card never left its column, though every other drag in the run landed. Chrome
  // drops a drag whose card is redrawn in the moment it starts, and a person would simply drag
  // again; so does this, at most three times. A board that never takes the drop still fails.
  const drag = async (title: string, from: string, to: string): Promise<void> => {
    for (let tries = 0; tries < 3; tries++) {
      if (await card(to, title).count()) return;
      await card(from, title).dragTo(column(to));
      try {
        await card(to, title).waitFor({ timeout: 10_000 });
        return;
      } catch {
        // Not there yet: look again, and drag again if it is still where it was.
      }
    }
    await card(to, title).waitFor();
  };

  try {
    await page.goto(url);
    await column('proposed').waitFor();

    // What is on screen: the project and its version, four columns, the two views.
    assert.equal(await page.title(), '(1) skyhop');
    assert.deepEqual([await page.locator('#project').innerText(), await page.locator('#where').innerText()], ['skyhop', 'v1.4.2']);
    assert.deepEqual((await page.locator('#board .col h2').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim()), [
      '🟠 BACKLOG 2',
      '🟢 BUILD 1',
      '🔵 BUILDING 0',
      '✅ DONE 0',
    ]);
    await shot(page, '1-board');

    // Who builds, left of the Agents switch: Headless until Chat is picked. With a chat building, the switch says who is listening.
    const picks = page.locator('#builder button');
    const agents = page.locator('#runner');
    assert.deepEqual(await picks.allInnerTexts(), ['Headless', 'Chat']);
    assert.deepEqual([await picks.nth(0).getAttribute('aria-pressed'), await agents.innerText()], ['true', 'Agents: off']);
    const [picksBox, agentsBox] = [(await page.locator('#builder').boundingBox())!, (await agents.boundingBox())!];
    assert.ok(picksBox.x + picksBox.width <= agentsBox.x, 'the picks sit to the left of the Agents switch');
    await picks.nth(1).click();
    await page.locator('#builder button.on', { hasText: 'Chat' }).waitFor();
    assert.equal(await agents.innerText(), 'Agents: off');
    assert.match((await agents.getAttribute('title'))!, /No Claude Code chat is watching this spool/);
    await shot(page, '1b-chat-builds');
    // Headless is off for now: greyed, it does nothing when clicked, and the chat stays the builder.
    assert.equal(await picks.nth(0).getAttribute('aria-disabled'), 'true');
    assert.match((await picks.nth(0).getAttribute('title'))!, /Not offered\. Switch on Offer Headless in Settings to pick it, or: spool builder headless/);
    await picks.nth(0).click({ force: true });
    assert.equal(await picks.nth(1).getAttribute('aria-pressed'), 'true');
    assert.equal(await picks.nth(0).getAttribute('aria-pressed'), 'false');
    // The command still switches it, and the board follows.
    s.sp('builder', 'headless');
    await page.locator('#builder button.on', { hasText: 'Headless' }).waitFor();
    assert.equal(await picks.nth(0).getAttribute('aria-disabled'), 'true');
    assert.match((await agents.getAttribute('title'))!, /Click to have this page build what is in Build/);

    // ▶ Build moves a thread to Build.
    await card('proposed', 'Tighten the jump arc').getByRole('button', { name: '▶ Build' }).click();
    await card('build', 'Tighten the jump arc').waitFor();
    assert.equal(state(jump), 'ready');

    // Dragging, with the mouse: back to the backlog, and into Build again.
    await drag('Tighten the jump arc', 'build', 'proposed');
    assert.equal(state(jump), 'proposed', 'dragged back to the backlog');
    await drag('Tighten the jump arc', 'proposed', 'build');
    assert.equal(state(jump), 'ready', 'dragged into build');

    // + Add: typed, Enter, and the card is there without waiting on anything.
    await column('proposed').locator('button.add').click();
    await page.keyboard.type('A daily challenge level');
    const typed = Date.now();
    await page.keyboard.press('Enter');
    await card('proposed', 'A daily challenge level').waitFor();
    assert.ok(Date.now() - typed < 1500, 'what was added shows at once');
    const daily = s.json('list').items.find((i: { title: string }) => i.title === 'A daily challenge level').id;

    // A page left open while its server restarted has an old token. Adding still works, and nothing typed is lost.
    await page.evaluate('token = "left-over-from-before-a-restart"');
    await column('build').locator('button.add').click();
    await page.keyboard.type('Fix the typo on the title screen');
    await page.keyboard.press('Enter');
    await card('build', 'Fix the typo on the title screen').waitFor();
    const typo = s.json('list').items.find((i: { title: string }) => i.title === 'Fix the typo on the title screen').id;
    assert.equal(state(typo), 'ready', 'added under Build, it is in build');
    s.sp('propose', typo);
    await card('proposed', 'Fix the typo on the title screen').waitFor();

    // A question is asked on its thread, and nowhere else: its card says a call is wanted, its ticket asks it.
    const asking = card('build', 'Make coins readable at sunset');
    assert.equal(await asking.locator('.flag').innerText(), 'Needs a call from you');
    assert.equal(await page.getByText('Outline the coins, or turn them teal?').count(), 0, 'nothing on the board asks it, the brief included');
    await asking.locator('.title').click();
    await page.locator('#thread .post', { hasText: 'Outline the coins, or turn them teal?' }).getByRole('button', { name: 'Outline' }).click();
    await until('the answer is on record', () => s.json('review').questions.length === 0);
    await page.keyboard.press('Escape');
    await asking.locator('.flag').waitFor({ state: 'detached' });

    // The ticket: opened from a card, its fields changed, a reply posted, closed with Escape.
    await card('build', 'Tighten the jump arc').locator('.title').click();
    const ticket = page.locator('#thread');
    await ticket.waitFor();
    await ticket.locator('.field', { hasText: 'Priority' }).locator('select').selectOption('0');
    await until('the priority is saved', () => s.json('show', jump).item.priority === 0);
    // Its type is picked here too: research finds out and reports, and builds nothing.
    await ticket.locator('.field', { hasText: 'Type' }).locator('select').selectOption('research');
    await until('it is research', () => /^type: research$/m.test(s.item(jump)));
    await ticket.locator('.field', { hasText: 'Type' }).locator('select').selectOption('change');
    await until('it is a change again', () => !/^type:/m.test(s.item(jump)));
    await ticket.getByPlaceholder('Add a tag').fill('Feel');
    await ticket.getByPlaceholder('Add a tag').press('Enter');
    await ticket.locator('.side .chip', { hasText: '#feel' }).waitFor();
    await ticket.locator('h2').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('A snappier jump');
    await page.keyboard.press('Enter');
    await until('the new name is saved', () => s.json('show', jump).item.title === 'A snappier jump');
    await ticket.getByPlaceholder('Post your reply').fill('snappy, not heavy');
    await ticket.getByRole('button', { name: 'Reply' }).click();
    await ticket.locator('.post', { hasText: 'snappy, not heavy' }).waitFor();
    assert.match(s.item(jump), /> snappy, not heavy\n> — \[\[n-/);
    await shot(page, '2-ticket');
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });

    // The Backlog view takes the board's place: it is on screen, at the top, and the board is not.
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    const backlog = page.locator('#backlog');
    await backlog.waitFor();
    assert.equal(await page.locator('#board').isVisible(), false, 'the board is gone while the backlog is up');
    assert.ok((await backlog.boundingBox())!.y < 200, 'the backlog is at the top of the page, not below the board');

    // A sprint: made, filled by dragging a row into it, and played.
    await backlog.getByRole('button', { name: '+ Create sprint' }).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Polish');
    await page.keyboard.press('Enter');
    const sprint = backlog.locator('.group', { hasText: 'Polish' });
    await sprint.waitFor();
    await sprint.getByText('+ Say what this sprint is for').click();
    await sprint.getByPlaceholder('Goal: what this sprint is for').fill('Everything feels tight');
    await sprint.getByPlaceholder('Why: why now').fill('the beta opens on Friday');
    await sprint.getByRole('button', { name: 'Save' }).click();
    await sprint.locator('.about', { hasText: 'Everything feels tight' }).waitFor();
    assert.match(s.json('show', s.json('list', '-k', 'sprint').items[0].id).item.body, /^Goal: Everything feels tight\nWhy: the beta opens on Friday/);
    await backlog.locator('.row', { hasText: 'A daily challenge level' }).dragTo(sprint);
    await sprint.locator('.row', { hasText: 'A daily challenge level' }).waitFor();
    assert.ok(s.json('show', daily).item.sprint, 'dragged into the sprint');
    await shot(page, '3-backlog');
    await sprint.getByRole('button', { name: '▶ Play sprint' }).click();
    await until('playing the sprint moved its thread to build', () => state(daily) === 'ready');
    await sprint.locator('.ghead .state', { hasText: 'running' }).waitFor();

    // Back on the board: a pill for the sprint narrows it, and the search narrows it too.
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await column('build').waitFor();
    assert.equal(await backlog.isVisible(), false);
    await page.locator('#quick .pill', { hasText: 'Polish' }).click();
    assert.deepEqual(await page.locator('#board .card .title').allInnerTexts(), ['A daily challenge level']);
    await page.locator('#quick .pill', { hasText: 'All' }).click();
    await page.keyboard.press('/');
    await page.keyboard.type('coins');
    assert.deepEqual(await page.locator('#board .card .title').allInnerTexts(), ['Make coins readable at sunset']);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#board .card').count(), 5);

    // Each column sorts and filters by itself, and remembers it.
    const titles = (key: string): Promise<string[]> => column(key).locator('.card .title').allInnerTexts();
    assert.deepEqual(await titles('proposed'), ['Pause button under the score', 'Fix the typo on the title screen']);
    await column('proposed').getByLabel('Sort this column').selectOption('title');
    assert.deepEqual(await titles('proposed'), ['Fix the typo on the title screen', 'Pause button under the score']);
    await column('build').getByLabel('Filter this column').selectOption({ label: '#feel' });
    assert.deepEqual(await titles('build'), ['A snappier jump']);
    assert.match(await column('build').locator('h2').innerText(), /1 OF 3/i);
    assert.deepEqual(await titles('proposed'), ['Fix the typo on the title screen', 'Pause button under the score'], 'the other columns are left alone');
    await page.reload();
    await column('build').waitFor();
    assert.deepEqual(await titles('build'), ['A snappier jump'], 'the choice is remembered');
    await column('build').getByLabel('Filter this column').selectOption('');
    await column('proposed').getByLabel('Sort this column').selectOption('');
    assert.equal((await titles('build')).length, 3);

    // "Add to Build" at the foot of the backlog moves what is shown there, and only that: it knows the filters.
    const extra = s.id('task', 'Brighter sky on level 3', '-s', 's', '--tag', 'art');
    s.sp('task', 'Sunset palette for level 4', '-s', 's', '--tag', 'art');
    await card('proposed', 'Sunset palette for level 4').waitFor();
    assert.equal(await column('proposed').locator('.card').count(), 4);
    assert.equal(await column('proposed').locator('.addall').innerText(), '▶ Add all 4 shown to Build');
    await column('proposed').getByLabel('Filter this column').selectOption({ label: '#art' });
    await page.keyboard.press('/');
    await page.keyboard.type('sky');
    assert.deepEqual(await titles('proposed'), ['Brighter sky on level 3']);
    await column('proposed').locator('.addall', { hasText: '▶ Add 1 to Build' }).click();
    assert.equal(state(extra), 'proposed', 'the first press only arms it');
    await column('proposed').getByRole('button', { name: 'Yes, move 1 to Build' }).click();
    await until('what was shown is in build', () => state(extra) === 'ready');
    await page.keyboard.press('/');
    await page.keyboard.press('Escape');
    await column('proposed').getByLabel('Filter this column').selectOption('');
    await card('proposed', 'Pause button under the score').waitFor();
    assert.deepEqual([state(pause), state(typo)], ['proposed', 'proposed'], 'what the filters hid was left where it was');
    s.sp('propose', extra);
    await card('proposed', 'Brighter sky on level 3').waitFor();

    // Finished work: who built it is on the card, a tick approves one, and one button approves the rest.
    for (const [id, summary] of [[coins, 'Coins are outlined'], [jump, 'The jump snaps'], [daily, 'A new level every day']] as const) {
      s.sp('start', id, '--as', 'Claude Fable 5.2');
      s.sp('done', id, '-m', summary, '--as', 'Claude Fable 5.2');
    }
    await column('done').locator('.card').nth(2).waitFor();
    assert.equal(await column('done').locator('.card .avatar.claude svg').count(), 3, 'Claude is shown by its mark');
    await card('done', 'Make coins readable at sunset').locator('.tick').click();
    await until('one thread is marked complete', () => !!s.json('show', coins).item.reviewed);
    await column('done').getByRole('button', { name: '✓ Mark all 2 as complete' }).click();
    await until('the rest are marked complete', () => !!s.json('show', jump).item.reviewed && !!s.json('show', daily).item.reviewed);
    await column('done').getByText('Nothing left to check.').waitFor();
    await column('done').locator('.history').click();
    assert.equal(await column('done').locator('.card.past').count(), 3, 'kept as history, a click away');
    await shot(page, '4-done');

    // What waits on him lives on its thread: a question on its ticket alone, a call on its card and ticket.
    // A call about no thread, and a note nobody filed, is in a strip at the top of the backlog; a question never is.
    assert.deepEqual(await page.locator('.tab').allInnerTexts(), ['Board', 'Backlog', 'Roadmap'], 'three views, and no Needs you');
    s.sp('ask', 'Pause on the left, or the right?', '--option', 'Left', '--option', 'Right', '--recommend', '2', '--for', pause);
    s.sp('assume', 'Which font for the score?', '--chose', 'The pixel font', '--why', 'it matches the title screen', '--for', pause);
    s.sp('assume', 'How loud is the coin sound?', '--chose', 'Half volume', '--why', 'it plays often');
    const loose = s.id('capture', 'the menu music loops too soon');
    await card('proposed', 'Pause button under the score').locator('.title').click();
    await ticket.locator('.post', { hasText: 'Pause on the left, or the right?' }).getByRole('button', { name: 'Right' }).click();
    await until('the question is answered', () => s.json('review').questions.length === 0);
    await page.keyboard.press('Escape');
    // A question asked on no thread has no thread to be on, so the page shows it nowhere.
    s.sp('ask', 'Should the coin sound loop?', '--option', 'Yes', '--option', 'No');
    const waits = card('proposed', 'Pause button under the score').locator('.chip', { hasText: '🧾 1 to look at' });
    await waits.click();
    const call = ticket.locator('.post', { hasText: 'Decided: The pixel font' });
    await call.getByText('Which font for the score?').waitFor();
    await call.getByText('Why: it matches the title screen').waitFor();
    await shot(page, '5-call-on-its-thread');
    await call.getByRole('button', { name: 'Fine' }).click();
    await until('the call on the thread is accepted', () => s.json('review').assumptions.length === 1);
    await call.getByText('✓ Fine by you').waitFor();
    await page.keyboard.press('Escape');
    await waits.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    const strip = backlog.locator('.group.waiting');
    const loud = strip.locator('.need', { hasText: 'How loud is the coin sound?' });
    await loud.waitFor();
    await until('the page has heard of the question', async () => (await page.evaluate('current.needs.questions.length')) === 1);
    assert.equal(await page.getByText('Should the coin sound loop?').count(), 0, 'the strip has no question in it');
    await shot(page, '6-waiting-strip');
    await loud.getByPlaceholder('No: say what you want instead').fill('quieter, a quarter');
    await loud.getByRole('button', { name: 'Overrule' }).click();
    await until('the other is overruled, and the rework is filed', () => s.json('review').assumptions.length === 0 && s.sp('list').includes('Rework'));
    await strip.locator('.need', { hasText: 'the menu music loops too soon' }).getByRole('button', { name: 'Make it a thread' }).click();
    await until('the note is a thread', () => s.json('show', loose).item.status === 'filed');
    await strip.waitFor({ state: 'detached' });

    assert.equal(state(pause), 'proposed', 'what was never moved to build was never built');
    // One refusal is expected: the request sent with the left-over token, before the page fetched a new one.
    assert.deepEqual(problems, ['Failed to load resource: the server responded with a status of 403 (Forbidden)'], 'the page logged no other errors');
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
