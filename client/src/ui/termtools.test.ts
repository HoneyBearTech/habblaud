import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { TerminalLog, type TerminalItem } from './terminal';
import {
  copyTextOf,
  finalAnswerKeys,
  findMatches,
  foldQuery,
  foldText,
  globalIndex,
  itemVisible,
  refAt,
  searchCounter,
  stepMatch,
  type TerminalFilter,
} from './termtools';

const user = (id: string, text = 'hi'): TerminalEntry => ({ kind: 'user', id, at: 1, text });
const say = (id: string, text = 'done'): TerminalEntry => ({ kind: 'assistant', id, at: 2, text });
const tool = (id: string, extra: Partial<Extract<TerminalEntry, { kind: 'tool' }>> = {}): TerminalEntry => ({ kind: 'tool', id, at: 3, tool: 'Bash', title: 'Bash(npm test)', ...extra });
const result = (id: string, toolUseId: string, text = 'ok'): TerminalEntry => ({ kind: 'result', id, at: 4, toolUseId, text });
const think = (id: string): TerminalEntry => ({ kind: 'thinking', id, at: 5, text: 'hmm' });
const sys = (id: string): TerminalEntry => ({ kind: 'system', id, at: 6, text: 'Context compacted', detail: 'summary' });

/** Items in screen order, as the panel sees them (tools already with their result). */
function items(...entries: TerminalEntry[]): TerminalItem[] {
  const log = new TerminalLog();
  log.push(entries);
  return [...log.values()];
}

/** The text that a range [a, b) of the original marks. */
const cut = (text: string, query: string) => findMatches(text, foldQuery(query)).map(([a, b]) => text.slice(a, b));

describe('search: matches', () => {
  it('ignoring case and accents, in both directions', () => {
    expect(cut('Ação e ACAO e acao', 'ação')).toEqual(['Ação', 'ACAO', 'acao']);
    expect(cut('Configuração do São João', 'sao joao')).toEqual(['São João']);
    expect(cut('npm test && NPM TEST', 'npm test')).toEqual(['npm test', 'NPM TEST']);
  });

  it('positions in the original even with accents and emojis before the excerpt', () => {
    const text = '🙂 é preciso rodar os TESTES';
    const [[a, b]] = findMatches(text, foldQuery('testes'));
    expect(text.slice(a, b)).toBe('TESTES');
    // A decomposed accent (e + U+0301) also matches and is highlighted whole.
    expect(cut('café pronto', 'café')).toEqual(['café']);
  });

  it('no overlap, empty term or only spaces does not search', () => {
    expect(cut('aaaa', 'aa')).toEqual(['aa', 'aa']);
    expect(findMatches('anything at all', foldQuery('   '))).toEqual([]);
    expect(findMatches('', foldQuery('x'))).toEqual([]);
    expect(foldQuery('  Olá ')).toBe('  ola ');
  });

  it('foldText: ASCII without a map; with accents, a position map', () => {
    expect(foldText('ABC')).toEqual({ text: 'abc' });
    const f = foldText('Ãb');
    expect(f.text).toBe('ab');
    expect(f.starts).toEqual([0, 1]);
    expect(f.ends).toEqual([1, 2]);
  });
});

describe('search: navigation', () => {
  const counts: [string, number][] = [
    ['user:u1', 2],
    ['assistant:a1', 0],
    ['tool:t1', 3],
  ];

  it('stepMatch wraps around and starts from the first (or from the last, going backward)', () => {
    expect(stepMatch(-1, 5, 1)).toBe(0);
    expect(stepMatch(-1, 5, -1)).toBe(4);
    expect(stepMatch(4, 5, 1)).toBe(0);
    expect(stepMatch(0, 5, -1)).toBe(4);
    expect(stepMatch(2, 5, 1)).toBe(3);
    expect(stepMatch(7, 5, 1)).toBe(0);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });

  it('globalIndex and refAt convert between "3/17" and (line, highlight)', () => {
    expect(globalIndex(counts, { key: 'user:u1', index: 1 })).toBe(1);
    expect(globalIndex(counts, { key: 'tool:t1', index: 0 })).toBe(2);
    expect(globalIndex(counts, { key: 'tool:t1', index: 5 })).toBe(-1);
    expect(globalIndex(counts, { key: 'gone', index: 0 })).toBe(-1);
    expect(globalIndex(counts, null)).toBe(-1);
    expect(refAt(counts, 0)).toEqual({ key: 'user:u1', index: 0 });
    expect(refAt(counts, 4)).toEqual({ key: 'tool:t1', index: 2 });
    expect(refAt(counts, 5)).toBeNull();
    expect(refAt(counts, -1)).toBeNull();
    // Round trip: the next one after the last goes back to the first.
    const total = 5;
    expect(refAt(counts, stepMatch(globalIndex(counts, { key: 'tool:t1', index: 2 }), total, 1))).toEqual({ key: 'user:u1', index: 0 });
  });

  it('"3/17" counter (no current one: "0/17")', () => {
    expect(searchCounter(2, 17)).toBe('3/17');
    expect(searchCounter(-1, 17)).toBe('0/17');
    expect(searchCounter(0, 0)).toBe('0/0');
  });
});

describe('filter', () => {
  it('final responses: the text with no tool after it until the next prompt (or the end)', () => {
    const list = items(user('u1'), say('a1', 'I will read.'), tool('t1'), result('r1', 't1'), say('a2', 'Done.'), sys('s1'), user('u2'), say('a3', 'Looking…'), tool('t2'), say('a4', 'The end.'));
    expect([...finalAnswerKeys(list)]).toEqual(['assistant:a2', 'assistant:a4']);
    // Still working: the last text can stop being final when a tool arrives.
    expect([...finalAnswerKeys(items(user('u1'), say('a1')))]).toEqual(['assistant:a1']);
    expect([...finalAnswerKeys(items(user('u1'), say('a1'), tool('t1')))]).toEqual([]);
  });

  it('All / Prompts only / No tools', () => {
    const list = items(user('u1'), think('th1'), say('a1', 'I will run it.'), tool('t1'), result('r1', 't1'), result('r9', 'other'), say('a2', 'Passed.'), sys('s1'));
    const finals = finalAnswerKeys(list);
    const visible = (f: TerminalFilter) => list.filter((i) => itemVisible(i, f, finals)).map((i) => i.key);
    expect(visible('all')).toEqual(list.map((i) => i.key));
    expect(visible('prompts')).toEqual(['user:u1', 'assistant:a2']);
    expect(visible('noTools')).toEqual(['user:u1', 'thinking:th1', 'assistant:a1', 'assistant:a2', 'system:s1']);
  });
});

describe('copy', () => {
  it('prompt, response, command (or the title, without arguments), result and events', () => {
    expect(copyTextOf(user('u1', 'Fix the cart\n\n'))).toBe('Fix the cart');
    expect(copyTextOf(say('a1', '**Ready**: done.'))).toBe('**Ready**: done.');
    expect(copyTextOf(tool('t1', { input: 'npm run build && npm test\n', inputKind: 'command' }))).toBe('npm run build && npm test');
    expect(copyTextOf(tool('t2', { title: 'Read(server/index.ts)', input: '  ' }))).toBe('Read(server/index.ts)');
    expect(copyTextOf(result('r1', 't1', 'line 1\nline 2\n'))).toBe('line 1\nline 2');
    expect(copyTextOf(sys('s1'))).toBe('Context compacted\nsummary');
    expect(copyTextOf({ kind: 'thinking', id: 'x', at: 0 })).toBe('');
  });
});
