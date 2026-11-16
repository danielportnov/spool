/**
 * The page's server and pictures: one GET that serves a thread's picture by its thread and its name,
 * checked against what is on disk, and the one POST that takes a picture's bytes and runs
 * `spool attach` on them.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { test } from 'node:test';
import { spool, startPage } from './helpers.ts';
import { JPEG, png } from './pictures-helpers.ts';

/** A GET with the Host header said outright, which fetch will not let a test choose. */
function get(port: number, where: string, host = `127.0.0.1:${port}`): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: where, headers: { host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

test('the page serves a thread its own pictures, and nothing else, and takes one pasted', async () => {
  const s = spool();
  const a = s.id('task', 'The coins at sunset', '-s', 'xs');
  const b = s.id('task', 'Another thread', '-s', 'xs');
  fs.writeFileSync(path.join(s.dir, 'shot.png'), png());
  fs.writeFileSync(path.join(s.dir, 'photo.jpg'), JPEG);
  s.sp('attach', a, 'shot.png', 'photo.jpg');
  const page = await startPage(s);
  try {
    const at = (id: string, name: string) => `/api/picture?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
    // Its own, with the type its bytes say.
    let got = await get(page.port, at(a, '1.png'));
    assert.equal(got.status, 200);
    assert.equal(got.type, 'image/png');
    assert.deepEqual(got.body, png());
    assert.equal((await get(page.port, at(a, '2.jpg'))).type, 'image/jpeg');

    // A name that is not this thread's, or not a name Spool gives, or a way out of the folder: nothing.
    for (const [id, name] of [
      [b, '1.png'],
      [a, '3.png'],
      [a, '../../items/' + a + '.md'],
      [a, '..%2F1.png'],
      [a, '1.png/..'],
      ['..', 'runs/' + a + '/files/1.png'],
      [`../runs/${a}`, '1.png'],
      [a, ''],
      [a, '.gitignore'],
    ]) {
      got = await get(page.port, at(id!, name!));
      assert.equal(got.status, 404, `${id} ${name}`);
    }
    // A raw path the client made up is never looked at: no listing either.
    assert.equal((await get(page.port, `/api/picture/../../.spool/runs/${a}/files/1.png`)).status, 404);
    assert.equal((await get(page.port, `/.spool/runs/${a}/files/`)).status, 404);
    // And the host check every request gets.
    assert.equal((await get(page.port, at(a, '1.png'), 'evil.example:80')).status, 403);

    // Pasted on the page: the bytes, the thread in the query, the token as every POST needs it.
    const send = (id: string, body: Buffer, token = page.token) =>
      fetch(`${page.url}api/attach?id=${id}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-spool-token': token }, body });
    assert.equal((await send(b, png(), 'nope')).status, 403);
    let res = await send(b, png(20, 20));
    assert.deepEqual(await res.json(), { ok: true, text: '' });
    assert.ok(fs.existsSync(path.join(s.dir, '.spool', 'runs', b, 'files', '1.png')));
    assert.match(s.item(b), /human: attached picture 1\.png$/m);
    // What is not a picture is refused in words; so is one too big, before it is all read.
    res = await send(b, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { text: string }).text, /^That is not a picture Spool keeps/);
    res = await send(b, Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { text: string }).text, /too big: keep it under 5 MB/);
    res = await send('t-nothere', png());
    assert.equal(res.status, 400);

    // The board carries each thread's pictures, and the reply's pictures under its words.
    const board = (await (await fetch(`${page.url}api/board`)).json()) as { columns: Record<string, { id: string; thread: { pictures: { name: string }[]; feed: { kind: string; pictures?: string[] }[] } }[]> };
    const card = Object.values(board.columns).flat().find((c) => c.id === a)!;
    assert.deepEqual(card.thread.pictures.map((p) => p.name), ['1.png', '2.jpg']);
    assert.deepEqual(card.thread.feed.filter((p) => p.pictures).map((p) => [p.kind, p.pictures]), [['picture', ['1.png', '2.jpg']]]);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
