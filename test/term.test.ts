import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENTER, LEAVE, cut, fit, keys, openTerm, plain, tail, width, wrap } from '../src/term.ts';
import { Keyboard, Process, Screen } from './term-standin.ts';

test('text is measured as a terminal shows it, never by its length', () => {
  assert.equal(width('Tighter jump'), 12);
  assert.equal(width('→ Read: src/player/jump.ts'), 26);
  // Wide letters take two columns each.
  assert.equal(width('一時停止'), 8);
  assert.equal(width('한글'), 4);
  assert.equal(width('ｆｕｌｌ'), 8);
  // A mark that sits on a letter takes none, however it is written.
  assert.equal(width('café'), 4);
  assert.equal(width('café'), 4);
  // An emoji is two, whether it is one code point, several joined, or a letter made into a picture.
  assert.equal(width('🧶'), 2);
  assert.equal(width('👩‍💻'), 2);
  assert.equal(width('👍🏽'), 2);
  assert.equal(width('🇯🇵'), 2);
  assert.equal(width('❤️'), 2);
  assert.equal(width('a🧶b'), 4);
  // What would move the cursor or colour the screen is not there at all.
  assert.equal(width('\x1b[31mred\x1b[0m'), 3);
  assert.equal(plain('one\ttwo\r\nthree\x07\x1b]0;title\x07'), 'one two three');
  assert.equal(plain('\x1b[2J\x1b[Hgone'), 'gone');
});

test('text is cut, padded and wrapped by its width', () => {
  assert.equal(cut('Tighter jump', 12), 'Tighter jump');
  assert.equal(cut('Tighter jump', 8), 'Tighter…');
  assert.equal(cut('Tighter jump', 1), '…');
  assert.equal(cut('Tighter jump', 0), '');
  // A wide letter that would straddle the edge is left out whole.
  assert.equal(cut('一時停止メニュー', 7), '一時停…');
  assert.equal(width(cut('一時停止メニュー', 6)), 5);
  assert.equal(cut('a👩‍💻b👩‍💻c', 5), 'a👩‍💻b…');
  assert.equal(fit('ab', 5), 'ab   ');
  assert.equal(fit('一時停止', 5), '一時…');
  assert.equal(fit('一時停止', 4), '一… ', 'cut short of a wide letter, the column left over is a space');
  assert.equal(width(fit('一時停止メニュー', 9)), 9);
  assert.equal(tail('add a thread about coins', 11), 'about coins');
  assert.equal(tail('一時停止', 5), '停止');

  assert.deepEqual(wrap('The small platform is 3px too far now.', 16), ['The small', 'platform is 3px', 'too far now.']);
  assert.deepEqual(wrap('', 10), ['']);
  // A word longer than a line is broken where it must be, and a wide one never over the edge.
  assert.deepEqual(wrap('src/a/very/long/path.ts ok', 8), ['src/a/ve', 'ry/long/', 'path.ts', 'ok']);
  assert.deepEqual(wrap('一時停止メニュー', 5), ['一時', '停止', 'メニ', 'ュー']);
  for (const line of wrap('Pause menu 一時停止メニュー and 👩‍💻 more words than fit', 9)) assert.ok(width(line) <= 9, line);
});

test('raw input is read into keys', () => {
  assert.deepEqual(keys('jk'), ['j', 'k']);
  assert.deepEqual(keys('\x1b[A\x1b[B\x1bOA\x1bOB'), ['up', 'down', 'up', 'down']);
  assert.deepEqual(keys('\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~'), ['pageup', 'pagedown', 'home', 'end', 'home', 'end']);
  assert.deepEqual(keys('\r\t\x7f\x1b\x03'), ['enter', 'tab', 'backspace', 'esc', 'ctrl-c']);
  assert.deepEqual(keys('1?/ é一'), ['1', '?', '/', ' ', 'é', '一']);
  // A sequence with no name here is no key, and does not spill its letters.
  assert.deepEqual(keys('\x1b[15~a'), ['a']);
  // Pasted text is one key: its line breaks are not Enter, and its letters are not commands.
  assert.deepEqual(keys('\x1b[200~stop\nall\x1b[201~q'), ['paste:stop\nall', 'q']);
});

/** A terminal that is only objects, and what was done to it. */
function standIn(): { input: Keyboard; output: Screen; proc: Process } {
  return { input: new Keyboard(), output: new Screen(), proc: new Process() };
}

test('the terminal is taken over, drawn on line by line, and given back', () => {
  const { input, output, proc } = standIn();
  const heard: string[] = [];
  let resized = 0;
  const term = openTerm({ input, output }, { key: (k) => heard.push(k), resize: () => resized++ }, proc);
  assert.equal(output.written, ENTER, 'the other screen, no cursor, no wrapping');
  assert.equal(input.raw, true);
  assert.deepEqual(term.size(), { cols: 80, rows: 24 });

  input.type('j\x1b[B');
  assert.deepEqual(heard, ['j', 'down']);

  output.written = '';
  term.draw(['one', 'two']);
  assert.equal(output.written, '\x1b[1;1Hone\x1b[0m\x1b[K\x1b[2;1Htwo\x1b[0m\x1b[K');
  // Only the line that changed is written again.
  output.written = '';
  term.draw(['one', 'TWO']);
  assert.equal(output.written, '\x1b[2;1HTWO\x1b[0m\x1b[K');
  // After a resize everything is drawn afresh.
  output.written = '';
  output.resize(100, 30);
  assert.equal(resized, 1);
  assert.deepEqual(term.size(), { cols: 100, rows: 30 });
  term.draw(['one', 'TWO']);
  assert.match(output.written, /^\x1b\[2J\x1b\[1;1Hone/);

  output.written = '';
  term.close();
  assert.equal(output.written, LEAVE, 'the cursor, the wrapping and the first screen are back');
  assert.equal(input.raw, false);
  assert.equal(input.paused, true);
  // Closing again, or drawing after, does nothing: no second set of codes on the user's screen.
  term.close();
  term.draw(['late']);
  assert.equal(output.written, LEAVE);
  input.type('j');
  assert.deepEqual(heard, ['j', 'down'], 'no key is heard after it is closed');
  for (const event of ['exit', 'uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(proc.listenerCount(event), 0, event);
});

test('the terminal is given back on every way out: a thrown error, a rejection, a signal, the process ending', () => {
  // A key's handler throws.
  let a = standIn();
  let crashed: unknown;
  openTerm({ input: a.input, output: a.output }, { key: () => { throw new Error('boom'); }, resize: () => {}, crash: (error) => (crashed = error) }, a.proc);
  a.input.type('x');
  assert.ok(a.output.written.endsWith(LEAVE), 'restored before anything is said');
  assert.equal(a.input.raw, false);
  assert.equal((crashed as Error).message, 'boom');
  assert.equal(a.proc.exited, 1);

  // Something throws elsewhere in the process, now or in a promise.
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    a = standIn();
    crashed = undefined;
    openTerm({ input: a.input, output: a.output }, { key: () => {}, resize: () => {}, crash: (error) => (crashed = error) }, a.proc);
    a.proc.emit(event, new Error(event));
    assert.ok(a.output.written.endsWith(LEAVE), event);
    assert.equal(a.input.raw, false, event);
    assert.equal((crashed as Error).message, event);
    assert.equal(a.proc.exited, 1, event);
  }

  // The process is told to stop, from outside: Ctrl-C itself arrives as a key while the terminal is raw.
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    a = standIn();
    openTerm({ input: a.input, output: a.output }, { key: () => {}, resize: () => {} }, a.proc);
    a.proc.emit(signal);
    assert.ok(a.output.written.endsWith(LEAVE), signal);
    assert.equal(a.input.raw, false, signal);
    assert.equal(a.proc.exited, code, signal);
  }

  // The process ends for a reason of its own.
  a = standIn();
  openTerm({ input: a.input, output: a.output }, { key: () => {}, resize: () => {} }, a.proc);
  a.proc.emit('exit', 0);
  assert.ok(a.output.written.endsWith(LEAVE));
  assert.equal(a.input.raw, false);

  // A terminal whose window has gone cannot be written to, and that is not an error on the way out.
  a = standIn();
  const term = openTerm({ input: a.input, output: a.output }, { key: () => {}, resize: () => {} }, a.proc);
  a.output.write = () => {
    throw new Error('EIO');
  };
  term.close();
  assert.equal(a.input.raw, false);
});
