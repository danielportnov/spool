import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage } from './helpers.ts';

test('original human and AI messages open the conversation', async (t) => {
  let browser: Browser;
  try { browser = await openChrome(); } catch { t.skip('no Chrome on this machine to drive'); return; }
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const note = s.id('capture', 'Please make the coins brighter');
  const human = s.id('task', 'Brighter coins', '--from', note, '-b', 'What: Change the coins');
  s.sp('log', human, 'I will brighten them', '--as', 'Codex GPT-6.1 Terra');
  const ai = s.id('task', 'Add a pause button', '--suggested', 'A pause button makes breaks easier', '--as', 'Claude Opus 5.5', '-b', 'What: Add a button');
  s.sp('build', ai);
  s.sp('start', ai, '--as', 'Codex GPT-6.1 Terra');
  s.sp('log', ai, 'I can add it', '--as', 'Claude Opus 5.5');
  const { url, stop } = await startPage(s);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    for (const [id, name] of [[human, 'human'], [ai, 'ai']]) {
      await page.locator(`#board .card[data-id="${id}"] .title`).click();
      await page.locator('#thread .feed').waitFor();
      const posts = page.locator('#thread .feed .post');
      const expected = name === 'human' ? 'Please make the coins brighter' : 'A pause button makes breaks easier';
      assert.equal(await posts.first().locator('pre').innerText(), expected);
      assert.match(await posts.first().locator('.byline').innerText(), name === 'human' ? /You/ : /Claude[\s\S]*Opus 5\.5/);
      assert.equal(await page.locator('#thread .feed').getByText(expected, { exact: true }).count(), 1);
      assert.equal(await page.getByText('About this thread').count(), 0);
      assert.equal(await page.locator('#thread .feed').getByText(name === 'human' ? 'I will brighten them' : 'I can add it').count(), 1);
      if (process.env.SPOOL_SHOTS) await page.screenshot({ path: path.join(process.env.SPOOL_SHOTS, `${name}.png`) });
      await page.keyboard.press('Escape');
      await page.locator('#thread').waitFor({ state: 'hidden' });
    }
  } finally { await stop(); await browser.close(); s.cleanup(); }
});
