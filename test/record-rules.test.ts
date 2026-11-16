import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upsertBlock } from '../src/prime.ts';
import { Sandbox } from './helpers.ts';

test('every set of rules says what is recorded and what is only done', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'demo');
    const rules = {
      'the AGENTS block': upsertBlock(''),
      'the worker prime': s.sp('prime'),
      'the recorder prime': s.sp('prime', 'recorder'),
    };
    for (const [where, wrapped] of Object.entries(rules)) {
      const text = wrapped.replace(/\s+/g, ' ');
      assert.match(text, /idea, a wish, feedback or a bug/, `${where} says what is recorded`);
      assert.match(text, /instruction to you about the work[\s\S]*is done, not recorded/, `${where} says an instruction is not`);
      assert.match(text, /Not sure whether it is an idea or an instruction\? Record nothing and act/, `${where} says what to do when unsure`);
    }
  } finally {
    s.cleanup();
  }
});
