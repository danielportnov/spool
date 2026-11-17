/**
 * Pictures in a real browser: pasted into the reply box, quick add and + Add, shown under the box
 * and taken off again, sent, drawn in the conversation, opened full size and closed; and a finished
 * thread's before and after side by side under its result.
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

test('a picture pasted into a reply shows under the words, opens full size, and the finished thread shows its before and after', async (t) => {
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
  // A finished thread with its proof: the agent took a before and an after.
  const pause = s.id('task', 'Pause button under the score', '-s', 'l');
  fs.writeFileSync(path.join(s.root, 'before.png'), png(320, 200, [200, 80, 60]));
  fs.writeFileSync(path.join(s.root, 'after.png'), png(320, 200, [60, 160, 90]));
  s.sp('build', pause);
  s.sp('start', pause, '--as', 'Claude Fable 5.2');
  s.exec(['attach', pause, 'before.png', '--as', 'before', '-m', 'no way to pause'], { env: { SPOOL_ACTOR: 'Claude Fable 5.2' } });
  s.exec(['attach', pause, 'after.png', '--as', 'after', '-m', 'the button, under the score'], { env: { SPOOL_ACTOR: 'Claude Fable 5.2' } });
  s.sp('done', pause, '-m', 'A pause button under the score; it pauses the music too.', '--as', 'Claude Fable 5.2');

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
    // The brief marks a finished thread worth a look that has pictures.
    await page.locator('#brief .card', { hasText: 'Pause button under the score' }).locator('.picmark', { hasText: 'has pictures' }).waitFor();

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
    await tray.nth(1).getByRole('button', { name: 'Take it off' }).click();
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

    // The finished thread: its before and after side by side under the result.
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });
    await page.locator(`#board .card[data-id="${pause}"] .title`).click();
    await ticket.locator('.key', { hasText: pause }).waitFor();
    const proof = ticket.locator('.post', { hasText: '✓ Shipped' }).locator('.proof.pair figure');
    await until('both are shown', async () => (await proof.count()) === 2);
    assert.deepEqual(await proof.locator('figcaption').allInnerTexts(), ['Before · no way to pause', 'After · the button, under the score']);
    assert.equal(await ticket.locator('.feed .pictures').count(), 0, 'and not again where they were attached');
    const [left, right] = [await proof.nth(0).boundingBox(), await proof.nth(1).boundingBox()];
    assert.ok(left && right && Math.abs(left.y - right.y) < 2 && right.x > left.x + left.width, 'side by side');
    await shot(page, 'pictures-before-after');
    if (SHOTS) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, 'dark-pictures-before-after');
      await proof.nth(1).locator('button.picture').click();
      await page.locator('#picture img').waitFor();
      await shot(page, 'dark-pictures-full-size');
      await page.keyboard.press('Escape');
      await page.emulateMedia({ colorScheme: 'light' });
    }
    // On a narrow screen, one above the other.
    await page.setViewportSize({ width: 420, height: 860 });
    await until('stacked', async () => {
      const [a, b] = [await proof.nth(0).boundingBox(), await proof.nth(1).boundingBox()];
      return !!a && !!b && b.y >= a.y + a.height;
    });
    await shot(page, 'pictures-before-after-narrow');
    await page.setViewportSize({ width: 1280, height: 860 });
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

test('a file picked with the 📎 button or dropped on the thread goes with the reply, and shows as a link', async (t) => {
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
  const save = s.id('task', 'Saved games will not load', '-s', 's');
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
    await page.locator(`#board .card[data-id="${save}"] .title`).click();
    await ticket.locator('.key', { hasText: save }).waitFor();
    const box = ticket.getByPlaceholder('Post your reply');
    const tray = ticket.locator('.compose .tray .pending');

    // A screenshot pasted, a PDF picked with the button.
    await paste(box, png(200, 120, [40, 120, 200]));
    const chooser = page.waitForEvent('filechooser');
    await ticket.getByRole('button', { name: 'Add a picture or a file' }).click();
    await (await chooser).setFiles({ name: 'Save Format.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    // A log dropped anywhere on the thread, here on its title.
    await ticket.locator('h2').evaluate((node) => {
      const dom = globalThis as unknown as Record<string, new (...a: unknown[]) => any>;
      const data = new dom.DataTransfer!();
      data.items.add(new File(['TypeError: save is undefined'], 'crash.log', { type: 'text/plain' }));
      node.dispatchEvent(new dom.DragEvent!('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await until('all three wait under the box', async () => (await tray.count()) === 3);
    assert.deepEqual(await ticket.locator('.compose .tray .pending.file').allInnerTexts(), ['📄 Save Format.pdf\n✕', '📄 crash.log\n✕']);
    // What a thread does not keep is refused before it is sent.
    await ticket.locator('h2').evaluate((node) => {
      const dom = globalThis as unknown as Record<string, new (...a: unknown[]) => any>;
      const data = new dom.DataTransfer!();
      data.items.add(new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' }));
      node.dispatchEvent(new dom.DragEvent!('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await page.locator('#said', { hasText: 'Only a picture' }).waitFor();
    assert.equal(await tray.count(), 3);
    await shot(page, 'files-reply-tray');

    await box.click();
    await page.keyboard.type('It breaks on this save. The log and the format are here.');
    await page.keyboard.press('Enter');
    await until('all three are on record', () => fs.existsSync(path.join(s.root, '.spool', 'runs', save, 'files', '3.crash.log')));
    assert.deepEqual(fs.readdirSync(path.join(s.root, '.spool', 'runs', save, 'files')).sort(), ['1.png', '2.save-format.pdf', '3.crash.log']);
    const post = ticket.locator('.post', { hasText: 'It breaks on this save.' });
    await post.locator('a.file', { hasText: 'crash.log' }).waitFor();
    assert.deepEqual(await post.locator('a.file').allInnerTexts(), ['📄 save-format.pdf', '📄 crash.log']);
    assert.equal(await post.locator('button.picture').count(), 1, 'the screenshot is shown, not linked');
    const href = await post.locator('a.file', { hasText: 'crash.log' }).getAttribute('href');
    const served = await page.evaluate(async (where) => {
      const res = await fetch(where!);
      return [res.headers.get('content-type'), await res.text()];
    }, href);
    assert.deepEqual(served, ['text/plain; charset=utf-8', 'TypeError: save is undefined']);
    assert.match(s.sp('start', save), /FILES — read each one: they were added for this\n {2}\S+\/2\.save-format\.pdf {2}\(human\)\n {2}\S+\/3\.crash\.log/);
    await shot(page, 'files-reply-sent');
    if (SHOTS) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, 'dark-files-reply-sent');
    }
    assert.deepEqual(problems.filter((p) => !/the server responded with a status of 400/.test(p)), [], 'the page logged no errors');
  } finally {
    await stop();
    s.cleanup();
  }
});
