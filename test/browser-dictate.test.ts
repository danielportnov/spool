/**
 * Dictation, in a real browser: 🎙 beside + Add and the reply box fills the box with what is said, by
 * the browser's own speech recognition, and it is saved as anything typed. The browser's recognizer is
 * stood in for here, so the test hears what it is told. Where the browser has none, there is no 🎙.
 * It uses the Chrome already on the machine, and is skipped where there is none.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

// A recognizer that says what the test hands it: hear(words, final) is one result.
function fakeSpeech() {
  const w = globalThis as any;
  w.SpeechRecognition = undefined;
  w.webkitSpeechRecognition = class {
    continuous = false;
    interimResults = false;
    lang = '';
    results: any[] = [];
    onresult: any;
    onend: any;
    onerror: any;
    start() { w.__rec = this; w.__listening = true; }
    stop() { w.__listening = false; this.onend?.(); }
  };
  w.hear = (words: string, final: boolean) => {
    const rec = w.__rec;
    const last = rec.results[rec.results.length - 1];
    if (last && !last.isFinal) rec.results.pop();
    const result = Object.assign([{ transcript: words }], { isFinal: final });
    rec.results.push(result);
    rec.onresult({ resultIndex: rec.results.length - 1, results: rec.results });
  };
}

test('🎙 fills + Add and the reply box with what is said, and where the browser cannot listen there is none', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.addInitScript(fakeSpeech);
  const column = (name: string) => page.locator(`#board [data-column="${name}"]`);
  try {
    await page.goto(url);
    await page.locator('.card').first().waitFor();

    // + Add: press 🎙, speak, and the box holds the words; what is not final yet shows, then settles.
    await column('proposed').locator('button.add').click();
    const box = column('proposed').locator('.adding textarea');
    const mic = column('proposed').locator('.adding .mic');
    await mic.click();
    assert.equal(await page.evaluate('__listening'), true);
    assert.match((await mic.getAttribute('class'))!, /\bon\b/);
    await page.evaluate(`hear('a daily', false)`);
    assert.equal(await box.inputValue(), 'a daily');
    await page.evaluate(`hear('a daily challenge level', true)`);
    await page.evaluate(`hear(' with a leaderboard', true)`);
    assert.equal(await box.inputValue(), 'a daily challenge level with a leaderboard');
    // Pressing it again stops listening; the words stay, and Add files them as usual.
    await mic.click();
    assert.equal(await page.evaluate('__listening'), false);
    await column('proposed').getByRole('button', { name: 'Add', exact: true }).click();
    await until('the thread is filed', () => s.json('list').items.some((i: { title: string }) => /daily challenge level with a leaderboard/i.test(i.title)));

    // The reply box: what is said goes after what was typed.
    await page.locator(`.card[data-id="${jump}"] .title`).click();
    const reply = page.locator('#thread .compose textarea');
    await reply.fill('Looks good.');
    await page.locator('#thread .compose .mic').click();
    await page.evaluate(`hear('ship it', true)`);
    assert.equal(await reply.inputValue(), 'Looks good. ship it');
    assert.equal(await page.locator('#thread .compose button.go').isDisabled(), false, 'dictated words can be sent');
    await reply.press('Enter');
    assert.equal(await page.evaluate('__listening'), false, 'sending stops listening');
    await until('the reply is on the thread', () => s.sp('show', jump).includes('Looks good. ship it'));
    await page.keyboard.press('Escape');

    // A browser that cannot listen shows no 🎙.
    const plain = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await plain.addInitScript(() => { (globalThis as any).SpeechRecognition = undefined; (globalThis as any).webkitSpeechRecognition = undefined; });
    await plain.goto(url);
    await plain.locator('.card').first().waitFor();
    await plain.locator('#board [data-column="proposed"] button.add').click();
    await plain.locator('.adding textarea').waitFor();
    assert.equal(await plain.locator('.mic').count(), 0);
    await plain.close();
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await browser.close();
    await stop();
    s.cleanup();
  }
});
