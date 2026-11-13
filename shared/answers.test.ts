// Respostas do AskUserQuestion pelo escritório: conferência contra as perguntas (por posição) e o resumo.
import { describe, expect, it } from 'vitest';
import { answerSummary, checkAnswers } from './answers';
import type { AskQuestion } from './types';

// Posições do original: a pergunta 1 era inválida (pulada) e a opção 1 da primeira também.
const QS: AskQuestion[] = [
  { index: 0, header: 'Database', question: 'Which database to use?', options: [{ index: 0, label: 'Postgres' }, { index: 2, label: 'SQLite' }] },
  { index: 2, question: 'Which tests to run before the commit?', multiSelect: true, options: [{ index: 0, label: 'Unit' }, { index: 1, label: 'E2E' }] },
];

describe('checkAnswers', () => {
  it('normalizes: question order, options in ascending order, trimmed text, no empty fields', () => {
    expect(checkAnswers(QS, [{ question: 2, options: [1, 0], other: '  lint  ' }, { question: 0, options: [2], other: '   ' }])).toEqual([
      { question: 0, options: [2] },
      { question: 2, options: [0, 1], other: 'lint' },
    ]);
    // Sem multiSelect, o texto livre vale no lugar de uma opção; com multiSelect, sozinho também.
    expect(checkAnswers(QS, [{ question: 0, other: 'MySQL' }, { question: 2, other: 'none' }])).toEqual([
      { question: 0, other: 'MySQL' },
      { question: 2, other: 'none' },
    ]);
  });

  it('each question exactly once', () => {
    expect(checkAnswers(QS, [{ question: 0, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 0, options: [2] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 1, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 2, options: [0] }, { question: 2, options: [1] }])).toBeUndefined();
    expect(checkAnswers(QS, undefined)).toBeUndefined();
    expect(checkAnswers([], [])).toBeUndefined();
  });

  it('single choice: exactly one option OR the free text', () => {
    const multi = { question: 2, options: [0] };
    expect(checkAnswers(QS, [{ question: 0, options: [0, 2] }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0], other: 'and more' }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0 }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [] }, multi])).toBeUndefined();
  });

  it('multiple: at least one choice; options that the question does not show or repeated ones do not count', () => {
    const single = { question: 0, options: [0] };
    expect(checkAnswers(QS, [single, { question: 2 }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [1] }, { question: 2, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, options: [0, 0] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, options: [5] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, other: 'x'.repeat(2_001) }])).toBeUndefined();
  });
});

describe('answerSummary', () => {
  it('header (or the question) and the chosen labels; free text in quotes and masked', () => {
    expect(answerSummary(QS, [{ question: 0, options: [2] }, { question: 2, options: [0, 1], other: 'you can run them' }])).toBe(
      'Database: SQLite · Which tests to run before the commit?: Unit, E2E, “you can run them”',
    );
    const secret = answerSummary(QS, [{ question: 0, other: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]);
    expect(secret).toMatch(/^Database: “token .+”$/);
    expect(secret).not.toContain('abcdefghijklmnop');
  });
});
