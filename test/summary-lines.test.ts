/**
 * A done message keeps its line breaks: a list in it stays a list where it is shown whole, and
 * the places that show one line show its first.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spool } from './helpers.ts';

const SUMMARY = 'The tip is split two ways:\n- tip.js strips the cents\n- a test covers it';

test('the summary is kept with its line breaks, and shown whole or by its first line', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Split the tip');
    s.sp('start', t);
    s.sp('done', t, '-m', `${SUMMARY.replace('split two', 'split   two')}  \r\n`, '--steps', 'Open the app');

    // On disk and in --json, as written.
    assert.equal(s.json('show', t).item.summary, SUMMARY);
    // The log line stays one line.
    assert.match(s.item(t), /agent: done: The tip is split two ways: - tip\.js strips the cents - a test covers it\n/);

    // spool show: whole, each line indented.
    assert.match(s.sp('show', t), /\n {2}The tip is split two ways:\n {2}- tip\.js strips the cents\n {2}- a test covers it\n/);

    // The brief: worth a look (a large thread is) shows it whole, also shipped its first line.
    const large = s.id('task', 'Round the total', '-s', 'l');
    s.sp('start', large);
    s.sp('done', large, '-m', 'The total is rounded:\n- up to the cent\n- shown on the receipt');
    const brief = s.sp('brief');
    assert.match(brief, /WORTH A LOOK[\s\S]*Round the total[^\n]*\n {5}The total is rounded:\n {5}- up to the cent\n {5}- shown on the receipt\n/);
    assert.match(brief, /ALSO SHIPPED[\s\S]*Split the tip — The tip is split two ways:\s+·/);
    assert.doesNotMatch(brief, /ways: - tip|rounded: - up/);
  } finally {
    s.cleanup();
  }
});
