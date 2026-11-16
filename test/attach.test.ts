/**
 * `spool attach`: a picture kept with a thread, told by its bytes, within the limits, on the
 * thread's log, listed by `spool show`, and named in the brief its agent is handed.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { spool } from './helpers.ts';
import { GIF, JPEG, WEBP, png } from './pictures-helpers.ts';

test('attach keeps a picture with its thread, by what is in the file, and says so on the log', () => {
  const s = spool();
  try {
    const t = s.id('task', 'The coins are hard to see at sunset', '-s', 'xs');
    s.write('shots/sunset.png', '');
    fs.writeFileSync(path.join(s.dir, 'shots/sunset.png'), png());
    // A name says nothing: a JPEG called .png is a JPEG, and kept as one.
    fs.writeFileSync(path.join(s.dir, 'shots/really-a-jpeg.png'), JPEG);
    fs.writeFileSync(path.join(s.dir, 'anim.gif'), GIF);
    fs.writeFileSync(path.join(s.dir, 'shot.webp'), WEBP);

    const out = s.sp('attach', t, 'shots/sunset.png', '-m', 'the coins vanish against the sky', '--as', 'Daniel');
    const folder = path.join(s.dir, '.spool', 'runs', t, 'files');
    assert.match(out, new RegExp(`Attached to ${t}:\\n  ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/1\\.png`));
    assert.deepEqual(fs.readFileSync(path.join(folder, '1.png')), png(), 'copied as it was');
    assert.match(s.item(t), /Daniel: attached picture 1\.png: the coins vanish against the sky/);
    // Kept out of git, the way run transcripts are.
    assert.equal(s.read('.spool/runs/.gitignore').split('\n').includes('*'), true);

    s.sp('attach', t, 'shots/really-a-jpeg.png', 'anim.gif', 'shot.webp');
    assert.deepEqual(fs.readdirSync(folder).sort(), ['1.png', '2.jpg', '3.gif', '4.webp']);
    assert.match(s.item(t), /agent: attached pictures 2\.jpg, 3\.gif, 4\.webp$/m, 'one line for the lot, with no caption');
    assert.doesNotMatch(s.item(t), /really-a-jpeg|shots\//, 'nothing of where they came from');

    // Before and after: the side is in the name, and the one who attached it is whoever runs it.
    s.write('after.png', '');
    fs.writeFileSync(path.join(s.dir, 'after.png'), png(10, 10));
    s.exec(['attach', t, 'after.png', '--as', 'after', '-m', 'outlined'], { env: { SPOOL_ACTOR: 'Claude' } });
    assert.ok(fs.existsSync(path.join(folder, '5-after.png')));
    assert.match(s.item(t), /Claude: attached picture 5-after\.png: outlined/);

    // show lists them with their paths; --json too.
    const shown = s.sp('show', t);
    assert.match(shown, /PICTURES\n {2}\S+\/1\.png {2}\(Daniel · “the coins vanish against the sky”\)/);
    assert.match(shown, /\S+\/5-after\.png {2}\(after · Claude · “outlined”\)/);
    const pictures = s.json('show', t).item.pictures;
    assert.deepEqual(pictures.map((p: { name: string }) => p.name), ['1.png', '2.jpg', '3.gif', '4.webp', '5-after.png']);
    assert.deepEqual(pictures[4], { name: '5-after.png', path: path.join(folder, '5-after.png'), as: 'after', by: 'Claude', at: pictures[4].at, caption: 'outlined' });

    // The brief the agent is handed names each by its absolute path, so it can open them.
    s.sp('build', t);
    const brief = s.sp('start', t);
    assert.match(brief, /PICTURES — open each one: they show what is meant/);
    for (const name of ['1.png', '2.jpg', '5-after.png']) assert.ok(brief.includes(`  ${path.join(folder, name)}`), `the brief names ${name}`);
  } finally {
    s.cleanup();
  }
});

test('attach refuses what is not a picture, what is too big, and more than a thread keeps', () => {
  const s = spool();
  try {
    const t = s.id('task', 'A thread', '-s', 'xs');
    s.write('notes.png', 'just words, called a picture');
    s.write('page.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.match(s.fails('attach', t, 'notes.png'), /notes\.png is not a picture Spool keeps\n {2}It takes PNG, JPEG, GIF and WebP, told by what is in the file, not its name/);
    assert.match(s.fails('attach', t, 'page.svg'), /page\.svg is not a picture Spool keeps/);
    assert.match(s.fails('attach', t, 'nowhere.png'), /there is no file nowhere\.png/);
    assert.match(s.fails('attach', t), /which picture\?/);
    assert.match(s.fails('attach'), /which thread\?/);

    // Over 5 MB, in words, before any of it is copied.
    fs.writeFileSync(path.join(s.dir, 'huge.png'), Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]));
    assert.match(s.fails('attach', t, 'huge.png'), /huge\.png is 5\.1 MB: a picture can be 5 MB at most/);

    // One bad file in a few refuses them all: the thread is left as it was.
    fs.writeFileSync(path.join(s.dir, 'good.png'), png());
    s.fails('attach', t, 'good.png', 'notes.png');
    assert.equal(fs.existsSync(path.join(s.dir, '.spool', 'runs', t, 'files', '1.png')), false);
    assert.doesNotMatch(s.item(t), /attached/);

    // Twenty a thread.
    s.sp('attach', t, ...Array.from({ length: 19 }, () => 'good.png'));
    s.sp('attach', t, 'good.png');
    assert.match(s.fails('attach', t, 'good.png'), /has 20 pictures, and a thread keeps 20 at most/);

    // Only a thread keeps them, and not one that was dropped.
    const note = s.id('capture', 'an idea');
    assert.match(s.fails('attach', note, 'good.png'), /is a note|not a task|is not/);
    const gone = s.id('task', 'Gone', '-s', 'xs');
    s.sp('drop', gone, '-m', 'not wanted');
    assert.match(s.fails('attach', gone, 'good.png'), /was dropped/);
  } finally {
    s.cleanup();
  }
});
