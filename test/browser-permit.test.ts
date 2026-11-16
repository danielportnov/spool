/**
 * An agent's permission question, answered on the page, in a real browser: on the Building card
 * with three buttons, and on the ticket, where a no can say why.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { claude, recorded } from './claude.ts';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('an agent’s question is answered from its card, and from its ticket with a reason', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  s.sp('edit', jump, '--model', 'opus', '--effort', 'high');
  // The stand-in asks to run a command that makes a file, as Claude did, and asks again each time it is refused and told to carry on.
  const run = recorded('allow-for-the-run').filter((r) => r.dir === '<');
  const at = run.findIndex((r) => r.event?.type === 'control_request');
  const fake = claude(
    s,
    [
      'hear',
      'say asks',
      'while hear; do',
      '  case "$heard" in',
      '    *\'"behavior":"allow"\'*) spool done "$SPOOL_TASK" -m "finished" > /dev/null; say rest;;',
      '    *\'"behavior":"deny"\'*) say refused;;',
      '    *\'"type":"user"\'*) say asks;;',
      '  esac',
      'done',
    ].join('\n'),
    {
      asks: run.slice(0, at + 1).map((r) => r.line),
      rest: run.slice(at + 1).filter((r) => r.event?.type !== 'system').map((r) => r.line),
      refused: recorded('permission').filter((r) => r.dir === '<' && r.event?.type === 'result').map((r) => r.line),
    },
  );
  const { url, stop } = await startPage(s, '--run', '--agent', fake.agent);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const card = page.locator(`#board [data-column="building"] .card[data-id="${jump}"]`);
  const ticket = page.locator('#thread');

  try {
    await page.goto(url);
    s.sp('build', jump);

    // The card of the thread being built carries the question, and the three answers.
    await card.locator('.q').waitFor();
    assert.equal(await card.locator('.q > div').innerText(), '🔐 May it run Bash: touch k1.txt? Create file k1.txt.');
    assert.deepEqual(await card.locator('.q button').allInnerTexts(), ['Allow once', 'Allow for this run', 'No']);
    assert.equal(await card.locator('.q button', { hasText: 'Allow for this run' }).getAttribute('title'), 'It is not asked again in this run: Bash: touch k1.txt, files in /work/skyhop, every file edit');
    await shot(page, 'permit-card');

    // On its ticket, a no can say why: the agent is told, and the thread's log keeps it.
    await card.locator('.title').click();
    const question = ticket.locator('.livepost .q');
    await question.waitFor();
    await shot(page, 'permit-ticket');
    await question.locator('.say input').fill('not in this folder');
    await question.getByRole('button', { name: 'No, because' }).click();
    await until('the agent is told no, and why', () => fake.heard(1)[1]?.response?.response?.message === 'The human refused this, and said: not in this folder');
    await until('the log says who refused what', () => /page: refused by the human: Bash: touch k1\.txt\. They said: not in this folder/.test(s.item(jump)));
    await until('the question is gone', async () => (await ticket.locator('.livepost .q').count()) === 0);

    // They reply, as on any thread; the agent hears it, tries again, and this time is let.
    await ticket.locator('textarea[placeholder="Post your reply"]').fill('make it in the build folder');
    await ticket.getByRole('button', { name: 'Reply' }).click();
    await page.keyboard.press('Escape');
    await card.locator('.q').waitFor();
    await card.getByRole('button', { name: 'Allow once' }).click();
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    assert.match(s.item(jump), /page: allowed once by the human: Bash: touch k1\.txt/);

    await page.emulateMedia({ colorScheme: 'dark' });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await stop();
    await browser.close();
    s.cleanup();
  }
});
