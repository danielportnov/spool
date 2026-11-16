import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox, startPage } from './helpers.ts';

test('a reply too long for the page is refused in words, and the page answers the next request', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const page = await startPage(s);
  try {
    const token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(page.url)).text())![1]!;
    const post = (body: unknown) =>
      fetch(`${page.url}api/note`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
    const refused = await post({ text: 'x'.repeat(70_000) });
    assert.equal(refused.status, 413);
    assert.deepEqual(await refused.json(), { ok: false, text: 'That is too long to send: keep it under 60,000 characters.' });
    assert.equal((await post({ text: 'a short one' })).status, 200, 'the server answers the next request');
  } finally {
    await page.stop();
    s.cleanup();
  }
});
