/**
 * The Roadmap view, driven in a real browser: the goals and the sprints in order, Play on a planned
 * one, a row that opens its ticket, and a drag that moves a thread between sprints. Skipped where
 * there is no Chrome. SPOOL_SHOTS=<folder> leaves a picture of it there, light and dark, wide and narrow.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { openChrome, startPage, until } from './helpers.ts';
import { roadmapSandbox } from './roadmap-sandbox.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test('the roadmap shows the goals and the sprints in order, plays one, opens a ticket and moves a thread', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const r = roadmapSandbox();
  const { s } = r;
  const show = (id: string) => s.json('show', id).item;
  const page = await startPage(s);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const problems: string[] = [];
  tab.on('pageerror', (error) => problems.push(String(error)));
  tab.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const roadmap = tab.locator('#roadmap');
  const lane = (id: string) => roadmap.locator(`.lane[data-sprint="${id}"]`);
  const row = (title: string) => roadmap.locator('.rrow', { hasText: title });

  try {
    await tab.goto(`${page.url}?view=board`);
    await tab.locator('#board .col').first().waitFor();

    // g then r goes to the Roadmap, and the keys sheet says so.
    await tab.keyboard.press('g');
    await tab.keyboard.press('r');
    await roadmap.locator('.lane').first().waitFor();
    assert.equal(await tab.locator('.tab.on').innerText(), 'Roadmap');
    await tab.keyboard.press('?');
    await tab.locator('#layer').getByText('Go to the Roadmap').waitFor();
    await tab.keyboard.press('Escape');

    // The goals first, then the sprints: reached, playing, planned, and the threads in no sprint last.
    assert.match(await roadmap.locator('.rgoals').innerText(), /a platformer that feels good on a phone\nControls that feel tight · A world worth exploring/);
    assert.deepEqual(await roadmap.locator('.lane').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-sprint') ?? 'loose')), [r.polish, r.worlds, r.later, 'loose']);
    assert.match(await lane(r.polish).innerText(), /Polish\n[\s\S]*Reached (Dec 31|Jan 1) · 2 threads/, 'when it was reached, in his own time');
    const playing = await lane(r.worlds).innerText();
    assert.match(playing, /I want a second world that feels like night/, 'his words, quoted');
    assert.match(playing, /Goal A second world[\s\S]*Done when you can play world 2 to the end/);
    assert.match(playing, /1 of 3 done/);
    assert.deepEqual(await lane(r.worlds).locator('.rrow .state').allTextContents(), ['Done', 'In build', 'In backlog']);
    assert.match(await lane(r.later).innerText(), /A reason to come back\n2 threads · S M/);
    assert.match(await roadmap.locator('.lane.loose').innerText(), /1 thread in the backlog/);
    await shot(tab, 'roadmap-1-wide');
    await tab.emulateMedia({ colorScheme: 'dark' });
    await shot(tab, 'roadmap-2-wide-dark');
    await tab.emulateMedia({ colorScheme: 'light' });

    // A thread row opens its ticket.
    await row('Draw the world 2 map').click();
    await tab.locator('#thread h2', { hasText: 'Draw the world 2 map' }).waitFor();
    await tab.keyboard.press('Escape');
    await tab.locator('#thread').waitFor({ state: 'hidden' });

    // Dragged onto another sprint, a thread moves there; onto In no sprint, it leaves its sprint.
    await row('A daily challenge level').dragTo(lane(r.worlds));
    await until('the thread is in the sprint being played', () => show(r.daily).sprint === r.worlds);
    await lane(r.worlds).locator('.rrow', { hasText: 'A daily challenge level' }).waitFor();
    await row('A shop between worlds').dragTo(roadmap.locator('.lane.loose'));
    await until('the thread is in no sprint', () => !show(r.shop).sprint);
    await roadmap.locator('.lane.loose', { hasText: '2 threads in the backlog' }).waitFor();

    // Play on a planned sprint is the Backlog view's play: it runs, and what is in it moves to build.
    await lane(r.later).getByRole('button', { name: '▶ Play sprint' }).click();
    await until('the sprint is running', () => show(r.later).status === 'running');
    assert.equal(show(r.later).status, 'running');
    await lane(r.later).locator('.state', { hasText: 'Playing' }).waitFor();

    // The count of threads in no sprint opens the Backlog view.
    await roadmap.locator('.lane.loose').getByRole('button').click();
    await tab.locator('#backlog').waitFor();
    assert.equal(await tab.locator('.tab.on').innerText(), 'Backlog');
    await tab.getByRole('button', { name: 'Roadmap', exact: true }).click();


    // At a phone's width the lanes are a stack, the full width, and nothing scrolls sideways.
    await tab.setViewportSize({ width: 390, height: 844 });
    await roadmap.locator('.lane').first().waitFor();
    const widths = await roadmap.locator('.lane').evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().width)));
    assert.equal(new Set(widths).size, 1, 'every lane is the full width');
    assert.ok(await tab.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'nothing scrolls sideways');
    await shot(tab, 'roadmap-3-390');
    await tab.emulateMedia({ colorScheme: 'dark' });
    await shot(tab, 'roadmap-4-390-dark');
    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    await browser.close();
    await page.stop();
    s.cleanup();
  }
});
