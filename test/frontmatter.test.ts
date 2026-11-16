import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { type Item, type Spool, deserialize, serialize } from '../src/model.ts';

const SPOOL: Spool = { root: '/x', dir: '/x/.spool', name: 'x', home: true, config: { version: 1 } };

function task(fields: Partial<Item>): Item {
  return {
    id: 't-test',
    kind: 'task',
    title: 'A task',
    status: 'open',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    needs: [],
    from: [],
    options: [],
    steps: [],
    commits: [],
    skills: [],
    tags: [],
    body: '',
    extra: [],
    spool: SPOOL,
    ...fields,
  };
}

test('titles that YAML would mangle survive a round trip as strings', () => {
  const titles = [
    'no',
    'true',
    '2024',
    '3.14',
    'null',
    'fix: the thing',
    'ends with colon:',
    '# not a comment',
    'trailing #hash is fine',
    'has a #comment in it',
    '- leading dash',
    '"quoted" and \'single\'',
    '[brackets], {braces} & commas, all at once',
    'émoji ✓ and unicode — fine',
    '  padded  ',
    'tab\there',
    '> block marker',
    '@mention and *star',
  ];
  for (const title of titles) {
    const back = deserialize(serialize(task({ title })), SPOOL);
    assert.equal(back.title, title, `title ${JSON.stringify(title)}`);
  }
});

test('lists, numbers and bodies round-trip', () => {
  const item = task({
    kind: 'decision',
    status: 'assumed',
    id: 'd-test',
    priority: 0,
    needs: ['d-aaaa', 't-bbbb'],
    options: ['Keep it, mostly', 'Replace: "all" of it', '3'],
    recommend: 2,
    choice: 'Replace: "all" of it',
    commits: ['0123456789abcdef0123456789abcdef01234567'],
    body: 'First line.\n\n## Log\n- 2026-01-01 00:00Z agent: started',
  });
  const back = deserialize(serialize(item), SPOOL);
  assert.deepEqual(back.needs, item.needs);
  assert.deepEqual(back.options, item.options);
  assert.equal(back.recommend, 2);
  assert.equal(back.priority, 0);
  assert.equal(back.choice, item.choice);
  assert.deepEqual(back.commits, item.commits);
  assert.equal(back.body, item.body);
});

test('reads what a person or an editor might write', () => {
  const text = [
    '---',
    'id: t-hand',
    'kind: task',
    "title: 'It''s hand-edited'",
    'status: open',
    'created: 2026-01-01T00:00:00Z',
    'needs:',
    '  - d-aaaa',
    '  - d-bbbb',
    'from: [n-cccc, "n-dddd"]',
    'cssclasses:',
    '  - idea',
    '  - art',
    'aliases: [one, two]',
    '---',
    '',
    'Body here.',
  ].join('\r\n');
  const item = deserialize(text, SPOOL);
  assert.equal(item.title, "It's hand-edited");
  assert.deepEqual(item.needs, ['d-aaaa', 'd-bbbb']);
  assert.deepEqual(item.from, ['n-cccc', 'n-dddd']);
  assert.equal(item.updated, item.created);
  assert.equal(item.body, 'Body here.');

  // Fields Spool does not own are written back exactly as they were.
  const rewritten = serialize(item);
  assert.match(rewritten, /^cssclasses:\n {2}- idea\n {2}- art$/m);
  assert.match(rewritten, /^aliases: \[one, two\]$/m);
});

test('block scalars, as SKILL.md descriptions use them', () => {
  const folded = parseFrontmatter('---\nname: x\ndescription: >-\n  Make art with Codex.\n  Use for icons.\n\n  Second paragraph.\nlicense: MIT\n---\nbody');
  assert.equal(folded.data.get('description'), 'Make art with Codex. Use for icons.\nSecond paragraph.');
  assert.equal(folded.data.get('license'), 'MIT');

  const literal = parseFrontmatter('---\ndescription: |\n  line one\n  line two\n---\n');
  assert.equal(literal.data.get('description'), 'line one\nline two');

  const plain = parseFrontmatter('---\ndescription: starts here\n  and continues here\nmetadata:\n  author: someone\n  version: "1.0"\n---\n');
  assert.equal(plain.data.get('description'), 'starts here and continues here');
  assert.equal(plain.data.get('metadata'), 'author: someone version: "1.0"');
});

test('text without frontmatter is all body', () => {
  const none = parseFrontmatter('# Just markdown\n\n---\n\nnot frontmatter');
  assert.equal(none.found, false);
  assert.equal(none.data.size, 0);
  const unclosed = parseFrontmatter('---\nid: x\nno end');
  assert.equal(unclosed.found, false);
});

test('a file that breaks the schema says how', () => {
  const base = '---\nid: t-x\nkind: task\ntitle: T\ncreated: 2026-01-01T00:00:00Z\n';
  assert.throws(() => deserialize(`${base}status: blocked\n---\n`, SPOOL), /cannot be "blocked"/);
  assert.throws(() => deserialize(`${base}status: open\npriority: high\n---\n`, SPOOL), /priority must be a whole number/);
  assert.throws(() => deserialize('---\nid: t-x\nkind: epic\ntitle: T\nstatus: open\ncreated: x\n---\n', SPOOL), /unknown kind/);
  assert.throws(() => deserialize('---\nid: t-x\nkind: task\nstatus: open\ncreated: x\n---\n', SPOOL), /missing title/);
  assert.throws(() => deserialize('no frontmatter', SPOOL), /no frontmatter/);
});
