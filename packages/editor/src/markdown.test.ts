import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { BLOCK_TYPES, isBlockType } from './blocks.ts';
import { CALLOUT_VARIANTS } from './callout.ts';
import { fromMarkdown, toMarkdown, type FromMarkdownOptions } from './markdown.ts';
import { ensureBlockIds as ensureIds, getEditorSchema, validateDoc } from './schema.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

type Marks = JSONContent['marks'];
const text = (value: string, marks?: Marks): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const p = (...content: (JSONContent | string)[]): JSONContent => ({
  type: 'paragraph',
  content: content.map((c) => (typeof c === 'string' ? text(c) : c)),
});
const li = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const link = (href: string) => ({ type: 'link', attrs: { href } });

/** Our own Markdown (round-trips, evals): honour origin markers and accept every mention. */
const TRUSTED: FromMarkdownOptions = { trustMarkers: true, mentions: { resolve: (id) => id } };

/** Schema-normalised JSON (defaults filled, adjacent text merged) without ids / origins. */
function normalize(json: JSONContent, keep: { origin?: boolean; ids?: boolean } = {}): JSONContent {
  const full = getEditorSchema().nodeFromJSON(json).toJSON() as JSONContent;
  const strip = (node: JSONContent): JSONContent => {
    const next: JSONContent = { ...node };
    if (isBlockType(node.type) && node.attrs) {
      const { id, origin, ...rest } = node.attrs;
      next.attrs = { ...rest, ...(keep.ids ? { id } : {}), ...(keep.origin ? { origin } : {}) };
    }
    if (node.content) next.content = node.content.map(strip);
    return next;
  };
  return strip(full);
}

function expectValid(json: JSONContent) {
  expect(validateDoc(json)).toEqual({ ok: true });
}

/** JSON → MD → JSON keeps structure (ids aside). */
function expectJsonRoundTrip(json: JSONContent) {
  const md = toMarkdown(json, { mentionIds: true });
  const back = fromMarkdown(md, TRUSTED);
  expectValid(back);
  expect(normalize(back), md).toEqual(normalize(json));
  // …and the Markdown is a fixed point.
  expect(toMarkdown(back, { mentionIds: true })).toBe(md);
}

/** Seeded PRNG (mulberry32) so property failures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  const chance = (probability: number) => next() < probability;
  return { int, pick, chance };
}

// ---------------------------------------------------------------------------------------------
// Fixtures

/** One of every block and mark in the 3.1 schema. */
function everyBlockDoc(): JSONContent {
  return doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
    { type: 'heading', attrs: { level: 2 }, content: [text('Section')] },
    { type: 'heading', attrs: { level: 3 }, content: [text('Sub')] },
    p(
      text('bold', [{ type: 'bold' }]),
      ' ',
      text('it', [{ type: 'italic' }]),
      ' ',
      text('strike', [{ type: 'strike' }]),
      ' ',
      text('code', [{ type: 'code' }]),
      ' ',
      text('hl', [{ type: 'highlight' }]),
      ' ',
      text('link', [link('https://example.com')]),
      { type: 'hardBreak' },
      { type: 'mention', attrs: { id: 'u_1', label: 'Priya' } },
    ),
    {
      type: 'bulletList',
      content: [li(p('one')), li(p('two'), { type: 'bulletList', content: [li(p('nested'))] })],
    },
    { type: 'orderedList', attrs: { start: 3 }, content: [li(p('third')), li(p('fourth'))] },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [p('done')] },
        { type: 'taskItem', attrs: { checked: false }, content: [p('todo')] },
      ],
    },
    { type: 'blockquote', content: [p('quoted'), p('second')] },
    {
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [text('const x = 1;\nconsole.log(x);')],
    },
    { type: 'horizontalRule' },
    ...CALLOUT_VARIANTS.map((variant) => ({
      type: 'callout',
      attrs: { emoji: '⚠️', variant },
      content: [p(`careful ${variant}`)],
    })),
  );
}

const EVERY_BLOCK_MARKDOWN = `# Title

## Section

### Sub

**bold** *it* ~~strike~~ \`code\` ==hl== [link](https://example.com)\\
[@Priya](mention:u_1)

- one
- two
  - nested

3. third
4. fourth

- [x] done
- [ ] todo

> quoted
>
> second

\`\`\`ts
const x = 1;
console.log(x);
\`\`\`

---

> [!neutral] ⚠️
> careful neutral

> [!info] ⚠️
> careful info

> [!success] ⚠️
> careful success

> [!warning] ⚠️
> careful warning

> [!danger] ⚠️
> careful danger`;

/** Trickier structures: nesting, escaping, adjacent lists, empty blocks, code fences. */
const FIXTURE_DOCS: Record<string, JSONContent> = {
  everyBlock: everyBlockDoc(),
  escaping: doc(
    p('# not a heading'),
    p('- not a list, + neither, 1. nor this, 2) or this'),
    p('> not a quote'),
    p('*stars* _under_ snake_case `ticks` [brackets](x) <tag> &amp; ~~tilde~~ ==eq== a=b x='),
    p('back\\slash | pipe ! bang [!note] # hash'),
    p('[ ] not a task'),
    { type: 'heading', attrs: { level: 2 }, content: [text('Ends with #')] },
    p('---'),
    p('==='),
    p('1986. A great year'),
  ),
  marks: doc(
    p(
      text('bold ', [{ type: 'bold' }]),
      text('bold italic', [{ type: 'bold' }, { type: 'italic' }]),
      text(' plain '),
      text('linked bold', [link('https://example.com/a'), { type: 'bold' }]),
      text(' and ', [link('https://example.com/a')]),
      text('code', [{ type: 'code' }]),
      text(' '),
      text('hl strike', [{ type: 'highlight' }, { type: 'strike' }]),
    ),
    p(text('in', []), text('tra', [{ type: 'bold' }]), text('word')),
    p(text('a `b` c', [{ type: 'code' }]), ' ', text('``', [{ type: 'code' }])),
    p(
      text('paren', [link('https://example.com/a_(b)')]),
      ' ',
      text('mailto', [link('mailto:a@b.co')]),
    ),
    p(
      'line one',
      { type: 'hardBreak' },
      text('line two', [{ type: 'bold' }]),
      { type: 'hardBreak' },
      '- three',
    ),
  ),
  lists: doc(
    { type: 'bulletList', content: [li(p('a'))] },
    { type: 'bulletList', content: [li(p('separate list'))] },
    {
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: false }, content: [p('task')] }],
    },
    { type: 'bulletList', content: [li(p('after tasks'))] },
    { type: 'orderedList', attrs: { start: 1 }, content: [li(p('one'))] },
    { type: 'orderedList', attrs: { start: 1 }, content: [li(p('separate ordered'))] },
    {
      type: 'orderedList',
      attrs: { start: 9 },
      content: [
        li(p('nine'), { type: 'orderedList', attrs: { start: 5 }, content: [li(p('five'))] }),
        li(p('ten'), p('second paragraph'), { type: 'codeBlock', content: [text('code')] }),
        li(p('eleven'), {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [p('deep'), { type: 'bulletList', content: [li(p('deeper'))] }],
            },
          ],
        }),
      ],
    },
    {
      type: 'bulletList',
      content: [li(p(), { type: 'bulletList', content: [li(p('empty first line'))] })],
    },
  ),
  containers: doc(
    {
      type: 'blockquote',
      content: [
        p('outer'),
        { type: 'blockquote', content: [p('inner')] },
        { type: 'bulletList', content: [li(p('in quote'))] },
      ],
    },
    {
      type: 'callout',
      attrs: { emoji: '👩🏽‍💻', variant: 'info' },
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [text('Heading in callout')] },
        { type: 'codeBlock', attrs: { language: 'py' }, content: [text('print("```")\n')] },
        {
          type: 'callout',
          attrs: { emoji: '💡', variant: 'neutral' },
          content: [p('nested callout')],
        },
      ],
    },
    {
      type: 'callout',
      attrs: { emoji: '🔥', variant: 'danger' },
      content: [{ type: 'bulletList', content: [li(p('list first'))] }],
    },
    { type: 'blockquote', content: [p('adjacent quote')] },
    { type: 'codeBlock', content: [] },
    { type: 'codeBlock', attrs: { language: 'md' }, content: [text('    indented\n\n\ttab')] },
    { type: 'heading', attrs: { level: 2 }, content: [] },
    { type: 'horizontalRule' },
    { type: 'horizontalRule' },
  ),
};

// ---------------------------------------------------------------------------------------------

describe('toMarkdown', () => {
  it('runs in Node without a DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('renders every block and mark', () => {
    expect(toMarkdown(everyBlockDoc(), { mentionIds: true })).toBe(EVERY_BLOCK_MARKDOWN);
  });

  it('renders mentions as @Name by default', () => {
    const json = doc(
      p('ask ', { type: 'mention', attrs: { id: 'u_1', label: 'Priya' } }, ' about it'),
    );
    expect(toMarkdown(json)).toBe('ask @Priya about it');
    expect(toMarkdown(json, { mentionIds: true })).toBe('ask [@Priya](mention:u_1) about it');
  });

  it('marks AI blocks with includeOrigin and block ids with blockIds', () => {
    const json = doc(
      { type: 'heading', attrs: { level: 2, id: 'h1', origin: 'ai' }, content: [text('Summary')] },
      { ...p('mine'), attrs: { id: 'p1', origin: 'me' } },
      { ...p('theirs'), attrs: { id: 'p2', origin: 'ai' } },
      {
        type: 'bulletList',
        attrs: { id: 'l1', origin: 'ai' },
        content: [
          {
            ...li({ ...p('item'), attrs: { id: 'p3', origin: 'ai' } }),
            attrs: { id: 'i1', origin: 'ai' },
          },
        ],
      },
      { type: 'codeBlock', attrs: { id: 'c1', origin: 'ai' }, content: [text('x')] },
      { type: 'horizontalRule', attrs: { id: 'r1', origin: 'me' } },
    );
    expect(toMarkdown(json, { includeOrigin: true })).toBe(
      '## Summary <!-- ai -->\n\nmine\n\ntheirs <!-- ai -->\n\n- item <!-- ai -->\n\n<!-- ai -->\n```\nx\n```\n\n---',
    );
    expect(toMarkdown(json, { blockIds: true })).toBe(
      '## Summary <!-- id=h1 -->\n\nmine <!-- id=p1 -->\n\ntheirs <!-- id=p2 -->\n\n- item <!-- id=p3 -->\n\n<!-- id=c1 -->\n```\nx\n```\n\n<!-- id=r1 -->\n---',
    );
    expect(toMarkdown(json, { includeOrigin: true, blockIds: true })).toContain(
      'theirs <!-- ai id=p2 -->',
    );
    expect(toMarkdown(json)).not.toContain('<!--');
  });

  it('drops empty paragraphs and trailing hard breaks', () => {
    expect(toMarkdown(doc(p('a'), p(), p('b', { type: 'hardBreak' })))).toBe('a\n\nb');
    expect(toMarkdown(doc(p()))).toBe('');
  });

  it('keeps emphasis delimiters off whitespace', () => {
    expect(toMarkdown(doc(p('a', text(' bold ', [{ type: 'bold' }]), 'b')))).toBe('a **bold** b');
    expect(toMarkdown(doc(p('a', text(' ', [{ type: 'bold' }]), 'b')))).toBe('a b');
  });
});

describe('fromMarkdown', () => {
  it('returns a valid doc with fresh block ids and origin me', () => {
    const json = fromMarkdown(EVERY_BLOCK_MARKDOWN);
    expectValid(json);
    const visit = (node: JSONContent) => {
      if (isBlockType(node.type)) {
        expect(node.attrs?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(node.attrs?.origin).toBe('me');
      }
      node.content?.forEach(visit);
    };
    visit(json);
  });

  it('stamps every block with the origin option', () => {
    const json = fromMarkdown('# T\n\n- a\n- b\n\n> [!tip]\n> x', { origin: 'ai' });
    const origins: unknown[] = [];
    const visit = (node: JSONContent) => {
      if (isBlockType(node.type)) origins.push(node.attrs?.origin);
      node.content?.forEach(visit);
    };
    visit(json);
    expect(origins.length).toBeGreaterThan(5);
    expect(new Set(origins)).toEqual(new Set(['ai']));
  });

  it('reads origin / id markers', () => {
    const md =
      'mine\n\ntheirs <!-- ai id=p2 -->\n\n- item <!-- ai -->\n\n<!-- ai id=c1 -->\n```\nx\n```';
    const json = fromMarkdown(md, { ...TRUSTED, preserveIds: true });
    expectValid(json);
    const [mine, theirs, list, code] = json.content!;
    expect(mine!.attrs).toMatchObject({ origin: 'me' });
    expect(theirs!.attrs).toMatchObject({ origin: 'ai', id: 'p2' });
    expect(theirs!.content).toEqual([{ type: 'text', text: 'theirs' }]);
    // A container is AI when all its blocks are.
    expect(list!.attrs).toMatchObject({ origin: 'ai' });
    expect(list!.content![0]!.attrs).toMatchObject({ origin: 'ai' });
    expect(code!.attrs).toMatchObject({ origin: 'ai', id: 'c1' });
    // Without preserveIds, ids are fresh.
    expect(fromMarkdown(md).content![1]!.attrs?.id).not.toBe('p2');
    // Duplicate ids are replaced.
    const dup = fromMarkdown('a <!-- id=x -->\n\nb <!-- id=x -->', {
      ...TRUSTED,
      preserveIds: true,
    });
    expect(dup.content![0]!.attrs?.id).toBe('x');
    expect(dup.content![1]!.attrs?.id).not.toBe('x');
  });

  it('keeps unknown comments and HTML as literal text', () => {
    const json = fromMarkdown('a <!-- note --> b <span>x</span>\n\n<div>\nraw\n</div>');
    expectValid(json);
    expect(json.content![0]!.content).toEqual([
      { type: 'text', text: 'a <!-- note --> b <span>x</span>' },
    ]);
    expect(json.content![1]!.content).toEqual([
      { type: 'text', text: '<div>' },
      { type: 'hardBreak' },
      { type: 'text', text: 'raw' },
      { type: 'hardBreak' },
      { type: 'text', text: '</div>' },
    ]);
  });

  it('parses GitHub alerts and Obsidian callouts', () => {
    const json = fromMarkdown(
      '> [!WARNING]\n> Careful\n\n> [!tip] 🚀\n> Go\n\n> [!faq] A title\n> body\n\n> [!note]',
    );
    expectValid(json);
    expect(json.content!.map((n) => [n.type, n.attrs?.variant, n.attrs?.emoji])).toEqual([
      ['callout', 'warning', '💡'],
      ['callout', 'success', '🚀'],
      ['callout', 'neutral', '💡'],
      ['callout', 'neutral', '💡'],
    ]);
    expect(normalize(json.content![2]!.content![0]!)).toEqual(normalize(p('A title body')));
  });

  it('splits mixed task / plain lists', () => {
    const json = fromMarkdown('- [ ] a\n- [X] b\n- c\n- [ ] d');
    expect(json.content!.map((n) => [n.type, n.content!.length])).toEqual([
      ['taskList', 2],
      ['bulletList', 1],
      ['taskList', 1],
    ]);
    expect(json.content![0]!.content![1]!.attrs?.checked).toBe(true);
  });

  it('turns tables into text', () => {
    const json = fromMarkdown('| a | b |\n|:-|-:|\n| **1** | 2 |');
    expect(toMarkdown(json)).toBe(
      '\\| a \\| b \\|\\\n\\| :-- \\| --: \\|\\\n\\| \\*\\*1\\*\\* \\| 2 \\|',
    );
  });

  it('drops disallowed links but keeps their text', () => {
    const json = fromMarkdown(
      '[x](javascript:alert(1)) [y](<java\nscript:alert(1)>) [z](data:text/html,hi)',
    );
    expectValid(json);
    const marks = JSON.stringify(json);
    expect(marks).not.toContain('"link"');
  });

  it('never throws and always returns a valid doc', () => {
    for (const md of [
      '',
      '\n\n',
      '   ',
      '-',
      '1.',
      '>',
      '```',
      '<!-- ai -->',
      '[!note]',
      '- [ ]',
      '#',
    ]) {
      const json = fromMarkdown(md);
      expectValid(json);
    }
    expect(normalize(fromMarkdown(''))).toEqual(normalize(doc(p())));
  });

  it('clamps heading levels and normalises lists / setext / indented code', () => {
    const json = fromMarkdown('#### Four\n\nSetext\n======\n\n    indented\n\n+ plus');
    expect(normalize(json)).toEqual(
      normalize(
        doc(
          { type: 'heading', attrs: { level: 3 }, content: [text('Four')] },
          { type: 'heading', attrs: { level: 1 }, content: [text('Setext')] },
          { type: 'codeBlock', content: [text('indented')] },
          { type: 'bulletList', content: [li(p('plus'))] },
        ),
      ),
    );
  });
});

describe('JSON → Markdown → JSON', () => {
  for (const [name, json] of Object.entries(FIXTURE_DOCS)) {
    it(`preserves structure: ${name}`, () => {
      expectValid(json);
      expectJsonRoundTrip(json);
    });
  }

  it('covers every block type and mark in the fixtures', () => {
    const nodes = new Set<string>();
    const marks = new Set<string>();
    const visit = (node: JSONContent) => {
      nodes.add(node.type!);
      node.marks?.forEach((mark) => marks.add(mark.type));
      node.content?.forEach(visit);
    };
    Object.values(FIXTURE_DOCS).forEach(visit);
    const schema = getEditorSchema();
    expect([...nodes].sort()).toEqual(Object.keys(schema.nodes).sort());
    expect([...marks].sort()).toEqual(Object.keys(schema.marks).sort());
    for (const type of BLOCK_TYPES) expect(nodes).toContain(type);
  });

  it('preserves origins and ids with includeOrigin + blockIds + preserveIds', () => {
    const json = fromMarkdown(toMarkdown(FIXTURE_DOCS.everyBlock!, { mentionIds: true }), TRUSTED);
    // Mark a few leaf blocks as AI.
    const leaves: JSONContent[] = [];
    const visit = (node: JSONContent) => {
      if (['paragraph', 'heading', 'codeBlock', 'horizontalRule'].includes(node.type!))
        leaves.push(node);
      node.content?.forEach(visit);
    };
    visit(json);
    leaves.forEach((leaf, index) => {
      if (index % 2) leaf.attrs = { ...leaf.attrs, origin: 'ai' };
    });
    const options = { includeOrigin: true, blockIds: true, mentionIds: true };
    const back = fromMarkdown(toMarkdown(json, options), { ...TRUSTED, preserveIds: true });
    const backLeaves: JSONContent[] = [];
    const visitBack = (node: JSONContent) => {
      if (['paragraph', 'heading', 'codeBlock', 'horizontalRule'].includes(node.type!))
        backLeaves.push(node);
      node.content?.forEach(visitBack);
    };
    visitBack(back);
    expect(backLeaves.map((n) => [n.attrs?.id, n.attrs?.origin])).toEqual(
      leaves.map((n) => [n.attrs?.id, n.attrs?.origin]),
    );
    expect(normalize(back)).toEqual(normalize(json));
  });
});

/** Canonical Markdown: MD → JSON → MD is the identity. */
const CANONICAL_MARKDOWN = [
  EVERY_BLOCK_MARKDOWN,
  'Plain paragraph with `code`, **bold**, *italic*, ~~strike~~ and ==highlight==.',
  '- [ ] open\n- [x] done\n  - nested bullet\n\n* separate list',
  '1. one\n2. two\n\n1) separate',
  '> quote\n>\n> > nested\n>\n> - list',
  '```js\nconst a = `b`;\n```\n\n````md\n```\ninner\n```\n````',
  '\\| a \\| b \\|\\\n\\| --- \\| --- \\|\\\n\\| 1 \\| 2 \\|',
  '[link](https://example.com "Title") and [spaced](<https://example.com/a b>)',
  'a\\\nb\\\n\\- c',
  '## Notes <!-- ai -->\n\nMine.\n\nTheirs. <!-- ai -->',
];

/** Arbitrary CommonMark/GFM: one pass normalises, the second is stable. */
const GENERAL_MARKDOWN = [
  'Setext\n===\n\nSub\n---',
  '* star\n+ plus\n\n1) paren',
  '__bold__ _em_ ***both*** <https://auto.link> foo@bar.com',
  '[ref][1]\n\n[1]: https://example.com',
  '&copy; &amp; &#35; \\* \\_',
  '<div>\n*html*\n</div>\n\ntext <b>inline</b>',
  'hard  \nbreak with spaces\nand soft\nbreaks',
  '- loose\n\n- list\n\n  with paragraphs',
  '    indented code\n\n```\nunclosed fence',
  '![alt](https://example.com/a.png) ![](https://example.com/b.png)',
  '> [!IMPORTANT]\n> GitHub alert\n\n> [!example] Obsidian title\n> body',
  '| a | b |\n| - | :-: |\n| `x` | [y](https://y.z) |\n\npara',
  '#### h4\n\n###### h6 ###',
  'Line with trailing #\n\n# Heading #',
  '- [ ]\n- [x]\n- [ ] \n-',
  '1. a\n1. b\n1. c\n\n7. seven',
  '**a *b* c** ~~*x*~~ ==**y**== `**z**`',
  '[**bold link**](https://x.y) **[link in bold](https://x.y)**',
  'Mentions: [@Ann](mention:u%201) @plain',
  '---\n***\n___',
  '- a\n  > quote in list\n  ```\n  code in list\n  ```',
  'tab\tseparated\ttext',
  '<!-- ai -->\n\n<!-- id=x -->\n- a\n\ntrailing <!-- me id=y -->',
];

describe('Markdown → JSON → Markdown', () => {
  for (const md of CANONICAL_MARKDOWN) {
    it(`is the identity for ${JSON.stringify(md.slice(0, 40))}`, () => {
      const json = fromMarkdown(md, TRUSTED);
      expectValid(json);
      expect(toMarkdown(json, { mentionIds: true, includeOrigin: true })).toBe(md);
    });
  }

  for (const md of GENERAL_MARKDOWN) {
    it(`is stable for ${JSON.stringify(md.slice(0, 40))}`, () => {
      const first = fromMarkdown(md, TRUSTED);
      expectValid(first);
      const md1 = toMarkdown(first, { mentionIds: true, includeOrigin: true });
      const second = fromMarkdown(md1, TRUSTED);
      expect(normalize(second, { origin: true }), md1).toEqual(normalize(first, { origin: true }));
      expect(toMarkdown(second, { mentionIds: true, includeOrigin: true })).toBe(md1);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Property-style: random documents from the schema

const WORDS = [
  'alpha',
  'beta',
  'Gamma',
  'delta42',
  'x',
  'ünïcode',
  '日本',
  'naïve',
  'snake_case',
  'a=b',
];
const SPECIALS = '\\`*_[]<>~=&#+-!|.()@:;"\'';
const LANGUAGES = [null, 'ts', 'python', 'c++'];
const EMOJIS = ['💡', '⚠️', '🔥', '👩🏽‍💻', '✅'];
const HREFS = [
  'https://example.com',
  'https://example.com/a_(b)?q=1&r=2#h',
  'mailto:a@b.co',
  '/relative/path',
  '#anchor',
];
/** Labels / ids / titles full of Markdown syntax that must survive exactly. */
const TRICKY_LABELS = ['Priya', 'Ann Lee', 'Bob', 'Eve](mention:x)', 'a*b_c `d`', '[x]', '# Rae'];
const TRICKY_IDS = ['user-1', "a)b(c*!'~ d", 'x](javascript:alert(1))', '%41', 'ü/ö?#'];
const TRICKY_TITLES = [undefined, 'Title', 'say "hi" \\ there', '(paren) [brackets]'];
/** Line breaks that must never become Markdown structure, and hrefs that must never be written. */
const BREAKS = ['\n', '\r', '\r\n', '\n\n', '\u2028', '\u2029', '\r\r'];
const INJECTIONS = ['# Injected', '- [x] done', '> quote', '| --- | --- |', '```', '---', '1. one'];
const UNSAFE_HREFS = [
  'javascript:alert(1)',
  '//evil.com/x',
  '\\\\evil.com',
  'vbscript:x',
  'data:text/html,x',
];

interface RandomDocOptions {
  /** Random `origin: ai` on leaf blocks. */
  origins?: boolean;
  /** Let differently-marked runs touch without whitespace between them. */
  adjacent?: boolean;
  /** Line breaks + block syntax in text, labels and titles; unsafe hrefs (injection attempts). */
  hostile?: boolean;
}

function randomDoc(seed: number, options: RandomDocOptions = {}): JSONContent {
  const r = rng(seed);
  const origin = () => (options.origins && r.chance(0.4) ? 'ai' : 'me');

  const words = (count: number) => Array.from({ length: count }, () => r.pick(WORDS)).join(' ');
  const specialText = () =>
    Array.from({ length: r.int(1, 12) }, () =>
      r.chance(0.5) ? r.pick([...SPECIALS]) : r.pick(['a', 'b', ' ', '1', 'é']),
    ).join('');
  /** Always contains a letter, so it can't collapse to nothing. */
  const hostileText = () =>
    `x${r.pick(BREAKS)}${r.pick(INJECTIONS)}${r.pick(BREAKS)}${r.pick(INJECTIONS)} y`;

  /** Inline content: segments separated by a space or hard break unless `adjacent`. */
  const inline = (allowBreaks: boolean): JSONContent[] => {
    const out: JSONContent[] = [];
    const segments = r.int(1, 5);
    for (let s = 0; s < segments; s++) {
      if (s > 0 && allowBreaks && r.chance(0.15)) out.push({ type: 'hardBreak' });
      else if (s > 0 && (!options.adjacent || r.chance(0.5))) out.push(text(' '));
      const kind = r.int(0, 9);
      if (kind === 0) {
        out.push({
          type: 'mention',
          attrs: {
            id: r.pick(TRICKY_IDS),
            label: options.hostile && r.chance(0.5) ? hostileText() : r.pick(TRICKY_LABELS),
          },
        });
      } else if (kind === 1) {
        out.push(text(r.pick(['x', 'a b', 'f(`y`)', '``', ' z ']), [{ type: 'code' }]));
      } else if (kind === 2) {
        // Plain text full of Markdown syntax: must come back verbatim.
        const value = options.hostile && r.chance(0.5) ? hostileText() : specialText().trim();
        out.push(text(value || 'z'));
      } else {
        const marks: NonNullable<Marks> = [];
        if (r.chance(0.35)) marks.push({ type: 'bold' });
        if (r.chance(0.35)) marks.push({ type: 'italic' });
        if (r.chance(0.2)) marks.push({ type: 'strike' });
        if (r.chance(0.2)) marks.push({ type: 'highlight' });
        if (r.chance(0.2)) {
          const href = options.hostile && r.chance(0.5) ? r.pick(UNSAFE_HREFS) : r.pick(HREFS);
          const title = options.hostile && r.chance(0.5) ? hostileText() : r.pick(TRICKY_TITLES);
          marks.push({ type: 'link', attrs: { href, ...(title ? { title } : {}) } });
        }
        // Marked text that starts / ends with punctuation exercises the flanking rules.
        const value = r.chance(0.7) ? words(r.int(1, 3)) : specialText().trim() || 'z';
        out.push(text(value, marks.length ? marks : undefined));
      }
    }
    return out;
  };

  const leaf = (attrs: Record<string, unknown>, node: JSONContent): JSONContent => ({
    ...node,
    attrs: { ...node.attrs, ...attrs, origin: origin() },
  });
  /** Containers are AI exactly when all their blocks are (what fromMarkdown derives). */
  const container = (node: JSONContent): JSONContent => ({
    ...node,
    attrs: {
      ...node.attrs,
      origin: node.content!.every((child) => child.attrs?.origin === 'ai') ? 'ai' : 'me',
    },
  });

  const paragraph = () => leaf({}, { type: 'paragraph', content: inline(true) });
  const item = (type: 'listItem' | 'taskItem', depth: number): JSONContent => {
    const content = [
      paragraph(),
      ...(depth < 3 && r.chance(0.3) ? blocks(depth + 1, r.int(1, 2)) : []),
    ];
    return container({
      type,
      ...(type === 'taskItem' ? { attrs: { checked: r.chance(0.5) } } : {}),
      content,
    });
  };
  const block = (depth: number): JSONContent => {
    const kinds = depth < 3 ? 10 : 4;
    switch (r.int(0, kinds - 1)) {
      case 0:
      case 1:
        return paragraph();
      case 2:
        return leaf({}, { type: 'heading', attrs: { level: r.int(1, 3) }, content: inline(false) });
      case 3: {
        if (r.chance(0.3)) return leaf({}, { type: 'horizontalRule' });
        const code = Array.from({ length: r.int(0, 3) }, () =>
          r.pick(['x = 1', '  indented', '```', '', '# not heading', '\ttab']),
        ).join('\n');
        return leaf(
          {},
          {
            type: 'codeBlock',
            attrs: { language: r.pick(LANGUAGES) },
            content: code ? [text(code)] : [],
          },
        );
      }
      case 4:
        return container({ type: 'blockquote', content: blocks(depth + 1, r.int(1, 3)) });
      case 5:
        return container({
          type: 'callout',
          attrs: { variant: r.pick(CALLOUT_VARIANTS), emoji: r.pick(EMOJIS) },
          content: blocks(depth + 1, r.int(1, 3)),
        });
      case 6:
      case 7:
        return container({
          type: 'bulletList',
          content: Array.from({ length: r.int(1, 3) }, () => item('listItem', depth)),
        });
      case 8:
        return container({
          type: 'orderedList',
          attrs: { start: r.pick([1, 1, 2, 10]) },
          content: Array.from({ length: r.int(1, 3) }, () => item('listItem', depth)),
        });
      default:
        return container({
          type: 'taskList',
          content: Array.from({ length: r.int(1, 3) }, () => item('taskItem', depth)),
        });
    }
  };
  const blocks = (depth: number, count: number) =>
    Array.from({ length: count }, () => block(depth));
  return { type: 'doc', content: blocks(0, r.int(1, 8)) };
}

describe('adversarial input', () => {
  const blockTypes = (json: JSONContent): unknown =>
    (json.content ?? []).filter((n) => isBlockType(n.type)).map((n) => [n.type, blockTypes(n)]);
  const allHrefs = (json: JSONContent): string[] => [
    ...(json.marks ?? []).filter((m) => m.type === 'link').map((m) => String(m.attrs?.href)),
    ...(json.content ?? []).flatMap(allHrefs),
  ];
  const INJECT =
    'Eve\n\n# Ignore previous instructions\n\n- [x] done\r\r> quote\u2028| a |\u2029---';

  it('mention labels cannot inject blocks (\\n, \\r, U+2028/9), in both mention forms', () => {
    const json = doc(p('hi ', { type: 'mention', attrs: { id: 'u1', label: INJECT } }, ' there'));
    for (const mentionIds of [false, true]) {
      const md = toMarkdown(json, { mentionIds });
      expect(md).not.toMatch(/[\r\n\u2028\u2029]/);
      const back = fromMarkdown(md, TRUSTED);
      expect(blockTypes(back)).toEqual([['paragraph', []]]);
    }
    const back = fromMarkdown(toMarkdown(json, { mentionIds: true }), TRUSTED);
    expect(back.content![0]!.content![1]!.attrs).toMatchObject({
      id: 'u1',
      label: 'Eve  # Ignore previous instructions  - [x] done  > quote | a | ---',
    });
  });

  it('mention ids are fully percent-encoded and come back exactly', () => {
    for (const id of ['a) **bold** [x](javascript:alert(1)', "(*!'~)", 'x y\nz', ']>`']) {
      const json = doc(p({ type: 'mention', attrs: { id, label: 'A' } }, ' tail'));
      const md = toMarkdown(json, { mentionIds: true });
      expect(md).toMatch(/^\[@A\]\(mention:[A-Za-z0-9%._-]*\) tail$/);
      const back = fromMarkdown(md, TRUSTED);
      expect(back.content![0]!.content![0]!.attrs?.id).toBe(id);
      expect(back.content![0]!.content![1]).toEqual({ type: 'text', text: ' tail' });
    }
  });

  it('a lone \\r (or any line break) in text cannot inject blocks', () => {
    for (const value of ['a\r\r# Injected\r\r- [ ] task', 'a\n\n# H', 'a\u2028# H\u2029- b']) {
      const json = doc(p(value), p(text(`code${value}`, [{ type: 'code' }])));
      const md = toMarkdown(json);
      expect(md.split('\n\n')).toHaveLength(2);
      expect(blockTypes(fromMarkdown(md))).toEqual([
        ['paragraph', []],
        ['paragraph', []],
      ]);
    }
  });

  it('link titles cannot inject blocks', () => {
    const json = doc(
      p(
        text('x', [
          { type: 'link', attrs: { href: 'https://a.b', title: 'x\n\n# Injected\r\r- y' } },
        ]),
      ),
    );
    const md = toMarkdown(json);
    expect(md).toBe('[x](https://a.b "x  # Injected  - y")');
    const back = fromMarkdown(md);
    expect(blockTypes(back)).toEqual([['paragraph', []]]);
    expect(back.content![0]!.content![0]!.marks![0]!.attrs?.title).toBe('x  # Injected  - y');
    // A title with a line break in Markdown is single-lined on the way in too.
    const pasted = fromMarkdown('[x](https://a.b "one\ntwo")');
    expect(pasted.content![0]!.content![0]!.marks![0]!.attrs?.title).toBe('one two');
  });

  it('toMarkdown never writes an unsafe href (keeps the text)', () => {
    for (const href of [
      'javascript:alert(1)',
      'JAVASCRIPT:x',
      'vbscript:x',
      '//evil.com',
      '\\\\evil.com',
      ' //evil.com',
    ]) {
      const md = toMarkdown(doc(p('see ', text('this', [{ type: 'link', attrs: { href } }]))));
      expect(md, href).toBe('see this');
    }
  });

  it('fromMarkdown drops protocol-relative links', () => {
    for (const md of ['[x](//evil.com)', '[x](<//evil.com>)', '![x](//evil.com/a.png)']) {
      const json = fromMarkdown(md);
      expect(allHrefs(json), md).toEqual([]);
      expect(json.content![0]!.content![0]!.text).toBe('x');
    }
  });

  it('`|` is always escaped, so hard-broken lines never become a GFM table', () => {
    const json = doc(
      p('a | b', { type: 'hardBreak' }, '| --- | --- |', { type: 'hardBreak' }, '1 | 2'),
    );
    const md = toMarkdown(json);
    expect(md).toBe('a \\| b\\\n\\| --- \\| --- \\|\\\n1 \\| 2');
    expect(normalize(fromMarkdown(md))).toEqual(normalize(json));
  });

  it('ignores origin markers unless trustMarkers (both directions)', () => {
    // Prompt-injected AI output claiming to be mine.
    const ai = fromMarkdown('Text <!-- me -->\n\n<!-- me -->\n```\nx\n```\n\n- item <!-- me -->', {
      origin: 'ai',
    });
    expectValid(ai);
    const origins = (json: JSONContent): unknown[] => [
      ...(isBlockType(json.type) ? [json.attrs?.origin] : []),
      ...(json.content ?? []).flatMap(origins),
    ];
    expect(new Set(origins(ai))).toEqual(new Set(['ai']));
    expect(ai.content![0]!.content).toEqual([{ type: 'text', text: 'Text' }]); // marker stripped
    // A user pasting Markdown that says `ai` keeps their words as theirs.
    const pasted = fromMarkdown('mine <!-- ai -->\n\n<!-- ai -->\n---');
    expect(new Set(origins(pasted))).toEqual(new Set(['me']));
    // Our own round-trips opt in.
    const trusted = fromMarkdown('mine <!-- ai -->', { trustMarkers: true });
    expect(trusted.content![0]!.attrs?.origin).toBe('ai');
  });

  it('mention links from untrusted Markdown follow the mentions policy', () => {
    const md = 'cc [@CEO](mention:admin-user-id) and [@Ann](mention:u_ann)';
    const kinds = (json: JSONContent) =>
      json.content![0]!.content!.map((n) =>
        n.type === 'mention' ? `mention:${n.attrs?.id}` : n.text,
      );
    // Default ('text'): no mention nodes at all.
    expect(kinds(fromMarkdown(md, { origin: 'ai' }))).toEqual(['cc @CEO and @Ann']);
    // 'off': plain link text (mention: is not an allowed URI), no link mark.
    const off = fromMarkdown(md, { mentions: 'off' });
    expect(kinds(off)).toEqual(['cc @CEO and @Ann']);
    expect(allHrefs(off)).toEqual([]);
    // Resolver: only known participants become mentions.
    const known = new Set(['u_ann']);
    const resolved = fromMarkdown(md, {
      mentions: { resolve: (id) => (known.has(id) ? id : null) },
    });
    expectValid(resolved);
    expect(kinds(resolved)).toEqual(['cc @CEO and ', 'mention:u_ann']);
  });

  it('property: hostile docs keep their block structure and never carry unsafe hrefs (500 docs)', () => {
    for (let seed = 20_000; seed < 20_500; seed++) {
      const json = randomDoc(seed, { hostile: true });
      for (const mentionIds of [false, true]) {
        const md = toMarkdown(json, { mentionIds });
        const back = fromMarkdown(md, TRUSTED);
        expect(validateDoc(back)).toEqual({ ok: true });
        expect(blockTypes(back), `seed ${seed}\n${md}`).toEqual(blockTypes(json));
        expect(
          allHrefs(back).every((href) => HREFS.includes(href)),
          `seed ${seed}`,
        ).toBe(true);
        const md2 = toMarkdown(back, { mentionIds });
        expect(toMarkdown(fromMarkdown(md2, TRUSTED), { mentionIds }), `seed ${seed}`).toBe(md2);
      }
    }
  });
});

describe('property: random schema documents', () => {
  const leafIds = (node: JSONContent): unknown[] => [
    ...(['paragraph', 'heading', 'codeBlock', 'horizontalRule'].includes(node.type!)
      ? [node.attrs?.id]
      : []),
    ...(node.content ?? []).flatMap(leafIds),
  ];

  it('JSON → MD → JSON preserves structure (1000 random docs)', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const json = randomDoc(seed);
      expect(validateDoc(json), `seed ${seed}`).toEqual({ ok: true });
      const md = toMarkdown(json, { mentionIds: true });
      const back = fromMarkdown(md, TRUSTED);
      expect(validateDoc(back)).toEqual({ ok: true });
      expect(normalize(back), `seed ${seed}\n${md}`).toEqual(normalize(json));
      expect(toMarkdown(back, { mentionIds: true }), `seed ${seed}`).toBe(md);
    }
  });

  it('origins and leaf ids survive includeOrigin + blockIds + preserveIds (300 random docs)', () => {
    for (let seed = 5000; seed < 5300; seed++) {
      const json = ensureIds(randomDoc(seed, { origins: true }));
      const md = toMarkdown(json, { mentionIds: true, includeOrigin: true, blockIds: true });
      const back = fromMarkdown(md, { ...TRUSTED, preserveIds: true });
      expect(normalize(back, { origin: true }), `seed ${seed}\n${md}`).toEqual(
        normalize(json, { origin: true }),
      );
      expect(leafIds(back)).toEqual(leafIds(json));
    }
  });

  it('touching marks: always valid and stable after one pass; structure kept for ≥99% (1000 random docs)', () => {
    // Differently-marked runs with no space between them hit CommonMark's delimiter "flanking"
    // rules; toMarkdown works around them (character references, `_` after a closing `*`), but
    // a few pathological combinations still move a mark boundary. See Design notes.
    let changed = 0;
    for (let seed = 10_000; seed < 11_000; seed++) {
      const json = randomDoc(seed, { adjacent: true });
      const md = toMarkdown(json, { mentionIds: true });
      const back = fromMarkdown(md, TRUSTED);
      expect(validateDoc(back)).toEqual({ ok: true });
      if (JSON.stringify(normalize(back)) !== JSON.stringify(normalize(json))) changed++;
      const md2 = toMarkdown(back, { mentionIds: true });
      expect(toMarkdown(fromMarkdown(md2, TRUSTED), { mentionIds: true }), `seed ${seed}`).toBe(
        md2,
      );
    }
    expect(changed).toBeLessThanOrEqual(10);
  });
});

describe('property: random Markdown soup', () => {
  const PIECES = [
    'a',
    'word',
    ' ',
    ' ',
    '\n',
    '\n\n',
    '  ',
    '\t',
    '*',
    '**',
    '_',
    '__',
    '`',
    '```',
    '~~',
    '==',
    '[',
    ']',
    '(',
    ')',
    '<',
    '>',
    '> ',
    '#',
    '# ',
    '-',
    '- ',
    '+ ',
    '1. ',
    '2) ',
    '- [ ] ',
    '[x] ',
    '[!note] ',
    '!',
    '&amp;',
    '&',
    '|',
    '---',
    '\\',
    '<!-- ai -->',
    '<!-- x -->',
    '<b>',
    '[l](https://x.y)',
    '[@A](mention:a)',
    '    ',
    'é',
    '💡',
  ];

  it('always parses to a valid doc that serialises stably (2000 samples)', () => {
    const r = rng(42);
    for (let n = 0; n < 2000; n++) {
      const md = Array.from({ length: r.int(1, 30) }, () => r.pick(PIECES)).join('');
      const first = fromMarkdown(md, TRUSTED);
      expect(validateDoc(first), JSON.stringify(md)).toEqual({ ok: true });
      const md1 = toMarkdown(first, { mentionIds: true, includeOrigin: true });
      // The JSON may still move whitespace out of a mark (see Design notes); the Markdown is fixed.
      const second = fromMarkdown(md1, TRUSTED);
      expect(validateDoc(second)).toEqual({ ok: true });
      const md2 = toMarkdown(second, { mentionIds: true, includeOrigin: true });
      expect(md2, `${JSON.stringify(md)} → ${JSON.stringify(md1)}`).toBe(md1);
    }
  });
});
