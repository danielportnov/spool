/**
 * Pictures in a real browser: pasted into the reply box, quick add and + Add, shown under the box
 * and taken off again, sent, drawn in the conversation, opened full size and closed.
 *
 * It uses the Chrome already on the machine, like test/browser.test.ts, and is skipped where there
 * is none. Set SPOOL_SHOTS to a folder for pictures of it, light and dark.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Locator, type Page } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';
import { png } from './pictures-helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Paste a picture into a box, as the clipboard hands one over: a paste event carrying the file. */
async function paste(box: Locator, bytes: Buffer, name = 'shot.png'): Promise<void> {
  await box.evaluate((node, [base64, file]) => {
    // In the browser: the suite is compiled without the DOM's types, so its classes are reached by name.
    const dom = globalThis as unknown as Record<string, new (...a: unknown[]) => any>;
    const raw = Uint8Array.from(atob(base64!), (c) => c.charCodeAt(0));
    const data = new dom.DataTransfer!();
    data.items.add(new File([raw], file!, { type: 'image/png' }));
    node.dispatchEvent(new dom.ClipboardEvent!('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [bytes.toString('base64'), name]);
}

test('a picture pasted into a reply shows under the words and opens full size; quick add and + Add take one too', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  t.after(() => browser.close());

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const ticket = page.locator('#thread');
  try {
    await page.goto(url);

    await page.locator(`#board .card[data-id="${coins}"] .title`).click();
    await ticket.locator('.key', { hasText: coins }).waitFor();
    const box = ticket.getByPlaceholder('Post your reply');
    const send = ticket.getByRole('button', { name: 'Reply' });
    assert.ok(await send.isDisabled(), 'nothing to send yet');

    // Pasted, it waits under the box as a thumbnail; a second is taken off again before sending.
    await paste(box, png(160, 100, [40, 120, 200]));
    await paste(box, png(90, 90, [230, 200, 40]), 'other.png');
    const tray = ticket.locator('.compose .tray .pending');
    await until('both wait under the box', async () => (await tray.count()) === 2);
    assert.ok(await send.isEnabled(), 'a picture alone can be sent');
    await shot(page, 'pictures-reply-tray');
    await tray.nth(1).getByRole('button', { name: 'Take this picture off' }).click();
    await until('one is left', async () => (await tray.count()) === 1);

    // Sent with the words, it is kept with the thread and shown under them.
    await box.click();
    await page.keyboard.type('See how the coins vanish here.');
    await page.keyboard.press('Enter');
    await until('the picture is on record', () => /human: attached picture 1\.png$/m.test(s.item(coins)));
    assert.equal(fs.readdirSync(path.join(s.root, '.spool', 'runs', coins, 'files')).join(), '1.png');
    const post = ticket.locator('.post', { hasText: 'See how the coins vanish here.' });
    const thumb = post.locator('.pictures button.picture img');
    await thumb.waitFor();
    await until('the thumbnail is drawn', () => thumb.evaluate((img) => {
      const drawn = img as unknown as { complete: boolean; naturalWidth: number };
      return drawn.complete && drawn.naturalWidth === 160;
    }));
    assert.equal(await tray.count(), 0, 'the tray is empty again');
    await shot(page, 'pictures-reply-sent');

    // A click opens it full size over the ticket; Esc closes it, and the ticket stays open.
    await thumb.click();
    const big = page.locator('#picture');
    await big.locator('img').waitFor();
    assert.match(await big.locator('.about').innerText(), /^You · now\s*✕$/);
    await shot(page, 'pictures-full-size');
    await page.keyboard.press('Escape');
    await big.waitFor({ state: 'detached' });
    assert.ok(await ticket.isVisible(), 'Esc closed the picture, not the ticket');
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });


    // Quick add: pasted into its box, attached to the thread once it exists.
    await page.keyboard.press('c');
    const quick = page.locator('#layer textarea');
    await quick.waitFor();
    await paste(quick, png(120, 80));
    await page.locator('#layer .tray .pending').waitFor();
    await page.keyboard.type('The sky is too bright on level 3');
    await page.keyboard.press('Enter');
    const added = await until('the new thread has its picture', () => {
      const found = s.json('list').items?.find((i: { title: string }) => i.title === 'The sky is too bright on level 3');
      return found && /human: attached picture 1\.png$/m.test(s.item(found.id)) && found.id;
    });
    assert.ok(fs.existsSync(path.join(s.root, '.spool', 'runs', added, 'files', '1.png')));

    // + Add under a column does the same.
    await page.locator('#board .col').first().getByRole('button', { name: '+ Add' }).click();
    const adding = page.locator('#board .adding textarea');
    await paste(adding, png(120, 80));
    await page.locator('#board .adding .tray .pending').waitFor();
    await adding.click();
    await page.keyboard.type('Clouds over the coins');
    await page.keyboard.press('Enter');
    await until('the + Add thread has its picture', () => {
      const found = s.json('list').items?.find((i: { title: string }) => i.title === 'Clouds over the coins');
      return found && /human: attached picture 1\.png$/m.test(s.item(found.id));
    });

    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    await stop();
    s.cleanup();
  }
});
