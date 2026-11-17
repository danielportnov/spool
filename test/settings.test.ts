import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

test('spool settings lists every setting kept in the config, and sets one by its name', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    const all = s.json('settings');
    assert.deepEqual(all, { caveman: false, 'quick-reply': true, 'quiet-minutes': 10, 'stop-minutes': 0, rebuild: true, headless: false });
    assert.match(s.sp('settings'), /quick-reply\s+on\s+Where nobody builds a thread/);

    assert.match(s.sp('settings', 'quick-reply', 'off'), /^quick-reply: off\./);
    s.sp('settings', 'quiet-minutes', '15');
    s.sp('settings', 'rebuild', 'off');
    s.sp('settings', 'headless', 'on');
    s.sp('settings', 'caveman', 'on');
    assert.deepEqual(s.json('settings'), { caveman: true, 'quick-reply': false, 'quiet-minutes': 15, 'stop-minutes': 0, rebuild: false, headless: true });
    // The same caveman as spool caveman.
    assert.equal(s.json('caveman').caveman, true);

    assert.match(s.fails('settings', 'nonsense', 'on'), /"nonsense" is not a setting/);
    assert.match(s.fails('settings', 'rebuild', 'maybe'), /rebuild is on or off/);
    assert.match(s.fails('settings', 'quiet-minutes', 'soon'), /whole number of minutes/);
  } finally {
    s.cleanup();
  }
});
