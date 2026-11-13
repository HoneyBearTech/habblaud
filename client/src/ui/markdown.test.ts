import { describe, expect, it } from 'vitest';
import { tokenizeBlocks, tokenizeInline, type MdBlock } from './markdown';

describe('tokenizeBlocks', () => {
  it('splits paragraphs on a blank line and preserves the line breaks inside them', () => {
    expect(tokenizeBlocks('First line\nsecond line\n\nAnother paragraph')).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'First line\nsecond line' },
      { type: 'paragraph', text: 'Another paragraph' },
    ]);
  });

  it('recognizes code blocks with a language, without interpreting markdown inside', () => {
    const src = 'See:\n\n```ts\nconst a = **b**;\n# not a heading\n```\nend';
    expect(tokenizeBlocks(src)).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'See:' },
      { type: 'code', lang: 'ts', text: 'const a = **b**;\n# not a heading' },
      { type: 'paragraph', text: 'end' },
    ]);
  });

  it('code block with no closing goes to the end (response cut off)', () => {
    expect(tokenizeBlocks('```\nline 1\nline 2')).toEqual<MdBlock[]>([{ type: 'code', lang: '', text: 'line 1\nline 2' }]);
  });

  it('closes only with the same fence (``` does not close ~~~)', () => {
    expect(tokenizeBlocks('~~~\na\n```\nb\n~~~')).toEqual<MdBlock[]>([{ type: 'code', lang: '', text: 'a\n```\nb' }]);
  });

  it('headings of 1 to 6 levels (and # without a space is not a heading)', () => {
    expect(tokenizeBlocks('# One\n### Three ###\n#hashtag')).toEqual<MdBlock[]>([
      { type: 'heading', level: 1, text: 'One' },
      { type: 'heading', level: 3, text: 'Three' },
      { type: 'paragraph', text: '#hashtag' },
    ]);
  });

  it('bulleted, numbered and nested lists', () => {
    const blocks = tokenizeBlocks('Files:\n- a.ts\n  - b.ts\n- c.ts\n\n1. one\n2. two');
    expect(blocks).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Files:' },
      {
        type: 'list',
        ordered: false,
        items: [
          { depth: 0, marker: '-', ordered: false, text: 'a.ts' },
          { depth: 1, marker: '-', ordered: false, text: 'b.ts' },
          { depth: 0, marker: '-', ordered: false, text: 'c.ts' },
        ],
      },
      {
        type: 'list',
        ordered: true,
        items: [
          { depth: 0, marker: '1.', ordered: true, text: 'one' },
          { depth: 0, marker: '2.', ordered: true, text: 'two' },
        ],
      },
    ]);
  });

  it('loose list (blank lines between items) is still the same list; indented line continues the item', () => {
    const blocks = tokenizeBlocks('- one\n\n- two\n  continuation\n\nend');
    expect(blocks[0]).toEqual({
      type: 'list',
      ordered: false,
      items: [
        { depth: 0, marker: '-', ordered: false, text: 'one' },
        { depth: 0, marker: '-', ordered: false, text: 'two\ncontinuation' },
      ],
    });
    expect(blocks[1]).toEqual({ type: 'paragraph', text: 'end' });
  });

  it('number in the middle of a paragraph does not become a list (only "1." interrupts)', () => {
    expect(tokenizeBlocks('In\n2024. it was like this')).toEqual<MdBlock[]>([{ type: 'paragraph', text: 'In\n2024. it was like this' }]);
  });

  it('quote and horizontal rule', () => {
    expect(tokenizeBlocks('> tip\n> continues\n\n---\n\ntext')).toEqual<MdBlock[]>([
      { type: 'quote', text: 'tip\ncontinues' },
      { type: 'rule' },
      { type: 'paragraph', text: 'text' },
    ]);
  });

  it('tables stay as preformatted text (original lines)', () => {
    const table = '| File | Lines |\n|---|---:|\n| a.ts | 10 |';
    expect(tokenizeBlocks(`Summary:\n${table}\n\nend`)).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Summary:' },
      { type: 'table', text: table },
      { type: 'paragraph', text: 'end' },
    ]);
  });

  it('stray bar in a paragraph does not become a table', () => {
    expect(tokenizeBlocks('use a | b to filter')).toEqual<MdBlock[]>([{ type: 'paragraph', text: 'use a | b to filter' }]);
  });

  it('normalizes \\r\\n', () => {
    expect(tokenizeBlocks('a\r\nb\r\n\r\nc')).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'a\nb' },
      { type: 'paragraph', text: 'c' },
    ]);
  });
});

describe('tokenizeInline', () => {
  it('plain text becomes a single span', () => {
    expect(tokenizeInline('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('inline code (without interpreting what is inside)', () => {
    expect(tokenizeInline('run `npm **test**` now')).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'npm **test**' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('code with double backticks can contain a backtick', () => {
    expect(tokenizeInline('``a ` b``')).toEqual([{ type: 'code', text: 'a ` b' }]);
  });

  it('unpaired backtick stays as text', () => {
    expect(tokenizeInline('a ` loose')).toEqual([{ type: 'text', text: 'a ` loose' }]);
  });

  it('bold and italic, including nested', () => {
    expect(tokenizeInline('**strong** and *light*')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'strong' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'light' }] },
    ]);
    expect(tokenizeInline('**a *b* c**')).toEqual([
      {
        type: 'strong',
        children: [{ type: 'text', text: 'a ' }, { type: 'em', children: [{ type: 'text', text: 'b' }] }, { type: 'text', text: ' c' }],
      },
    ]);
  });

  it('asterisk with a space (arithmetic) and underscore inside a word do not format', () => {
    expect(tokenizeInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
    expect(tokenizeInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }]);
    expect(tokenizeInline('_ênfase_')).toEqual([{ type: 'em', children: [{ type: 'text', text: 'ênfase' }] }]);
  });

  it('links become text with the address apart', () => {
    expect(tokenizeInline('see [the doc](https://exemplo.com/x "title") here')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'the doc', href: 'https://exemplo.com/x' },
      { type: 'text', text: ' here' },
    ]);
    expect(tokenizeInline('[no link] and [x](with space)')).toEqual([{ type: 'text', text: '[no link] and [x](with space)' }]);
  });

  it('backslash escapes', () => {
    expect(tokenizeInline('\\*not\\* italic')).toEqual([{ type: 'text', text: '*not* italic' }]);
  });

  it('HTML in the transcript is only text (whoever builds it uses textContent)', () => {
    expect(tokenizeInline('<img src=x onerror=alert(1)>')).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});
