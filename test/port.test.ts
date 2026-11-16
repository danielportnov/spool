import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { test } from 'node:test';
import { CLI, Sandbox, WAIT_MS } from './helpers.ts';

test('the page exits with the error when the port it was given is taken', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  // A port the system hands out, held for as long as the test runs.
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = (holder.address() as net.AddressInfo).port;
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '--port', String(port), '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`still running: ${err}`)), WAIT_MS);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.notEqual(code, 0);
    assert.match(err, /the page could not start/);
  } finally {
    child.kill();
    holder.close();
    s.cleanup();
  }
});
