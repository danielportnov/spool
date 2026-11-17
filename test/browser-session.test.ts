/**
 * The agent's session on its ticket, in a real browser: while a thread is built, a panel like a
 * small terminal shows the model that runs, how long it has gone, and its stream as it comes;
 * once it is finished, the same run is there to replay, folded. A thread built where the page
 * cannot hear its agent says so, and shows what it writes on the thread instead.
 *
 * Set SPOOL_SHOTS to a folder for pictures of it.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { claude } from './claude.ts';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const line = (e: unknown): string => JSON.stringify(e);
const says = (text: string): string => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: 'SESSION' });
const calls = (name: string, input: unknown): string => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] }, session_id: 'SESSION' });
const fails = (text: string): string => line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: text }] }, session_id: 'SESSION' });

test('a thread being built shows its model and its stream live; finished, its run is there folded', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  t.after(() => browser.close());

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  s.sp('edit', jump, '--model', 'opus', '--effort', 'high');
  const fake = claude(
    s,
    [
      'hear',
      'say work',
      // It goes on talking while it waits for what the user says next.
      '( i=1; while [ $i -le 400 ]; do sleep 0.3; printf \'%s\\n\' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Trying a gravity of 0.$i\\"}]}}"; i=$((i+1)); done ) &',
      'talk=$!',
      'while hear; do',
      '  case "$heard" in',
      '    *finish*) kill $talk; spool done "$SPOOL_TASK" -m "The jump arc is tighter" > /dev/null; say end; exit 0;;',
      '  esac',
      'done',
    ].join('\n'),
    {
      work: [
        line({ type: 'system', subtype: 'init', session_id: 'SESSION', model: 'claude-opus-5-5' }),
        says('Reading the jump code first.'),
        calls('Read', { file_path: 'src/player/jump.ts' }),
        calls('Bash', { command: 'npm test -- jump' }),
        fails('1 test failed: the apex is 12px too high'),
        says('The apex is too high: gravity is up from 28 to 34.'),
        ...Array.from({ length: 24 }, (_, i) => calls('Edit', { file_path: `src/player/arc-${i}.ts` })),
      ],
      end: [line({ type: 'result', subtype: 'success', num_turns: 7, duration_ms: 90_000, result: 'Tightened the arc.', session_id: 'SESSION' })],
    },
  );
  const { url, stop } = await startPage(s, '--run', '--agent', fake.agent);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const ticket = page.locator('#thread');
  try {
    await page.goto(`${url}#${jump}`);
    s.sp('build', jump);
    const panel = ticket.locator('.livepost .term');
    await panel.waitFor();
    await until('the stream has come', async () => /arc-23/.test(await ticket.locator('.livelog').innerText()));
    await shot(page, 'session-live');

    // Which model is running, as Spool chose it and as the session itself says, and for how long.
    const head = panel.locator('.termhead');
    assert.match(await head.innerText(), /opus · high/);
    assert.match(await head.innerText(), /claude-opus-5-5/);
    assert.match(await ticket.locator('.livepost .byline').innerText(), /working for \d+s/);
    // The stream, a line each: what it says, the tools it calls, and what failed, told apart.
    const log = ticket.locator('.livelog');
    assert.equal(await log.locator('.ln.l-said', { hasText: 'Reading the jump code first.' }).count(), 1);
    assert.equal(await log.locator('.ln.l-tool', { hasText: '→ Read: src/player/jump.ts' }).count(), 1);
    assert.equal(await log.locator('.ln.l-err', { hasText: '1 test failed' }).count(), 1);
    // It follows what comes, and holds still when scrolled up.
    const atFoot = (): Promise<boolean> => log.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight < 8);
    const count = (): Promise<number> => log.locator('.ln').count();
    const grows = async (): Promise<void> => {
      const was = await count();
      await until('a new line arrives', async () => (await count()) > was);
    };
    await until('it runs past its box', () => log.evaluate((n) => n.scrollHeight > n.clientHeight + 50));
    await grows();
    assert.ok(await atFoot(), 'it follows the newest line');
    await log.evaluate((n) => { n.scrollTop = 30; });
    await grows();
    await grows();
    assert.equal(await log.evaluate((n) => n.scrollTop), 30, 'scrolled up, it holds still');
    await log.evaluate((n) => { n.scrollTop = n.scrollHeight; });

    // Told to finish, it does; the ticket keeps its run, folded, to replay.
    await ticket.getByPlaceholder('Post your reply').fill('Looks good, finish it');
    await ticket.getByRole('button', { name: 'Reply' }).click();
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done', { timeout: 30_000 });
    const replay = ticket.locator('details.runlog');
    await replay.waitFor();
    assert.equal(await replay.getAttribute('open'), null, 'folded');
    assert.match(await replay.locator('summary').innerText(), /opus · high/);
    await replay.locator('summary').click();
    await until('the run is read back', async () => (await replay.locator('.ln.l-tool', { hasText: 'Read: src/player/jump.ts' }).count()) === 1);
    assert.equal(await replay.locator('.ln.l-end', { hasText: 'finished · 7 turns' }).count(), 1);
    await replay.scrollIntoViewIfNeeded();
    await shot(page, 'session-done');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await stop();
    s.cleanup();
  }
});

test('a thread built by a chat says its stream stays there, and shows its log lines and model', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  t.after(() => browser.close());

  // On the real clock: a claim from the Sandbox's own new year would long since have gone quiet.
  const s = new Sandbox(undefined, undefined, { now: Date.now() - 10 * 60_000 });
  s.sp('init', '--name', 'skyhop', '--gate');
  s.sp('builder', 'chat');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  s.sp('build', jump);
  s.sp('start', jump, '--model', 'sonnet', '--as', 'Claude Sonnet 5');
  s.sp('log', jump, 'The apex is 12px too high; trying a stronger gravity.', '--as', 'Claude Sonnet 5');
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const ticket = page.locator('#thread');
  try {
    await page.goto(`${url}#${jump}`);
    const panel = ticket.locator('.livepost .term');
    await panel.waitFor();
    assert.match(await panel.locator('.termhead').innerText(), /sonnet/);
    assert.match(await panel.locator('.termwhy').innerText(), /chat/i);
    assert.equal(await panel.locator('.ln', { hasText: 'The apex is 12px too high' }).count(), 1);
    // A line it writes shows up without a reload.
    s.sp('log', jump, 'Gravity is up from 28 to 34.', '--as', 'Claude Sonnet 5');
    await until('the new line shows', async () => (await panel.locator('.ln', { hasText: 'Gravity is up from 28 to 34.' }).count()) === 1);
    await shot(page, 'session-chat');
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await stop();
    s.cleanup();
  }
});
