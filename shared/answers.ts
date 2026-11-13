// Answers to the AskUserQuestion questions from the office (`answer` decision of POST /api/permissions/:id/decision):
// the check against the request's questions and the summary for the timeline. Pure code, used by the server
// (server/permissions/registry.ts), by the demo simulator and by the page (answer card).
import { maskSecrets, truncate } from './activity';
import type { AskQuestion, PermissionAnswer } from './types';
import { tr } from './i18n';

/** Longest free text ("Other") accepted in an answer. */
export const ANSWER_OTHER_MAX = 2_000;
/** Tool for the questions to the user. */
export const ASK_TOOL = 'AskUserQuestion';

const SUMMARY_MAX = 300;

/**
 * Checks the answers against the request's questions and returns them normalized (in question order, options in
 * ascending order, free text trimmed, no empty fields). undefined = they don't fit: a question with no answer or
 * answered twice, a question or option the request doesn't have, without multiSelect anything other than exactly
 * one option OR the free text, with multiSelect no choice at all.
 */
export function checkAnswers(questions: readonly AskQuestion[], answers: readonly PermissionAnswer[] | undefined): PermissionAnswer[] | undefined {
  if (!questions.length || !Array.isArray(answers) || answers.length !== questions.length) return undefined;
  const byQuestion = new Map<number, PermissionAnswer>();
  for (const a of answers) {
    if (!a || typeof a !== 'object' || byQuestion.has(a.question)) return undefined;
    byQuestion.set(a.question, a);
  }
  const out: PermissionAnswer[] = [];
  for (const q of questions) {
    const a = byQuestion.get(q.index);
    if (!a) return undefined;
    const raw = Array.isArray(a.options) ? a.options : [];
    const options = [...new Set(raw)].sort((x, y) => x - y);
    if (options.length !== raw.length || options.some((i) => !q.options.some((o) => o.index === i))) return undefined;
    const other = typeof a.other === 'string' ? a.other.trim() : '';
    if (other.length > ANSWER_OTHER_MAX) return undefined;
    const picks = options.length + (other ? 1 : 0);
    if (q.multiSelect ? picks < 1 : picks !== 1) return undefined;
    out.push({ question: q.index, ...(options.length ? { options } : {}), ...(other ? { other } : {}) });
  }
  return out;
}

/**
 * Short summary of the choices for the timeline, with the already masked texts of the questions (the free text is
 * masked here): "Database: Redis · Tests: Unit, E2E".
 */
export function answerSummary(questions: readonly AskQuestion[], answers: readonly PermissionAnswer[]): string {
  const parts = answers.flatMap((a) => {
    const q = questions.find((x) => x.index === a.question);
    if (!q) return [];
    const labels = (a.options ?? []).map((i) => q.options.find((o) => o.index === i)?.label ?? tr('option {0}', [i + 1]));
    if (a.other) labels.push(`“${truncate(maskSecrets(a.other.slice(0, ANSWER_OTHER_MAX)), 80)}”`);
    return [`${q.header ?? truncate(q.question, 40)}: ${labels.join(', ')}`];
  });
  return truncate(parts.join(' · '), SUMMARY_MAX);
}
