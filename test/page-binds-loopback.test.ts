/** The page listens on this machine's own address, 127.0.0.1, and on nothing else. */

import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import { test } from 'node:test';
import { Sandbox, startPage } from './helpers.ts';

/** Does a connection to this address and port get through? */
function reaches(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });
}

test('the page listens on 127.0.0.1 only, never on another address of the machine', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'loopback');
  const page = await startPage(s);
  try {
    assert.equal(new URL(page.url).hostname, '127.0.0.1', 'it says it is at 127.0.0.1');
    assert.equal(await reaches('127.0.0.1', page.port), true, 'it answers on 127.0.0.1');
    // Every other address this machine has (its LAN address, 0.0.0.0's reach), plus IPv6 loopback and another IPv4 loopback.
    const others = Object.values(os.networkInterfaces())
      .flat()
      .filter((a): a is os.NetworkInterfaceInfo => !!a && a.address !== '127.0.0.1')
      .map((a) => a.address.replace(/%.*$/, ''));
    for (const host of new Set([...others, '::1', '127.0.0.2'])) {
      assert.equal(await reaches(host, page.port), false, `it must not answer on ${host}`);
    }
  } finally {
    await page.stop();
  }
});
