// Terminal tools: search in the conversation (matches that ignore case and accents,
// navigation with a "3/17" counter), the "All / Prompts only / No tools" filter and the text copied from each entry.
// The model functions are pure and tested in ui/termtools.test.ts. Highlighting the results swaps text nodes
// for spans created with createElement/textContent: no transcript text goes through innerHTML.
import type { TerminalEntry } from '../../../shared/types';
import type { TerminalItem } from './terminal';
import { tr } from '../../../shared/i18n';

// ---------------------------------------------------------------- filter

export type TerminalFilter = 'all' | 'prompts' | 'noTools';

export const TERMINAL_FILTERS: readonly [TerminalFilter, string, string][] = [
  ['all', tr('Everything'), tr('The whole conversation')],
  ['prompts', tr('Prompts only'), tr("Only your prompts and the agent's final replies")],
  ['noTools', tr('No tools'), tr('Hides tools and their results')],
];

/**
 * Final replies of each turn: the agent's texts with no tool after them until the next prompt
 * (or the end of the conversation). The intermediate texts ("I'll read the file.") are left out.
 */
export function finalAnswerKeys(items: Iterable<TerminalItem>): Set<string> {
  const finals = new Set<string>();
  let pending: string[] = [];
  for (const item of items) {
    if (item.type !== 'entry') {
      // Tool (or stray result) after the text: it was only an intermediate step.
      pending = [];
      continue;
    }
    const kind = item.entry.kind;
    if (kind === 'assistant') pending.push(item.key);
    else if (kind === 'user') {
      for (const k of pending) finals.add(k);
      pending = [];
    }
  }
  for (const k of pending) finals.add(k);
  return finals;
}

/** Does the item show with the filter? (`finals` = finalAnswerKeys, used only by "Prompts only".) */
export function itemVisible(item: TerminalItem, filter: TerminalFilter, finals: ReadonlySet<string>): boolean {
  if (filter === 'all') return true;
  if (item.type !== 'entry') return false;
  if (filter === 'noTools') return true;
  return item.entry.kind === 'user' || (item.entry.kind === 'assistant' && finals.has(item.key));
}

// ---------------------------------------------------------------- search

/** Text "folded" for the search (lowercase, no accents) and where each of its characters came from in the original. */
export interface FoldedText {
  text: string;
  /** Start and end (in the original) of the character that produced each position of `text`; absent = identity (ASCII). */
  starts?: number[];
  ends?: number[];
}

const ASCII = /^[\x00-\x7f]*$/;
const COMBINING = /[̀-ͯ]/g;

/** Lowercase and without accents ("Ação" -> "acao"), keeping the original positions for the highlight. */
export function foldText(s: string): FoldedText {
  if (ASCII.test(s)) return { text: s.toLowerCase() };
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(COMBINING, '').toLowerCase();
    // Loose accent (e + U+0301): it is gone from the folded text, but the highlight of the previous letter includes it.
    if (!f && ends.length) ends[ends.length - 1] = i + ch.length;
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    text += f;
    i += ch.length;
  }
  return { text, starts, ends };
}

/** Only the folded text, without the position map (to quickly discard what doesn't have the term). */
function foldPlain(s: string): string {
  return ASCII.test(s) ? s.toLowerCase() : s.normalize('NFD').replace(COMBINING, '').toLowerCase();
}

/** Search term already folded; only spaces = no search (''). */
export function foldQuery(query: string): string {
  return query.trim() ? foldText(query).text : '';
}

/** Ranges [start, end) of the original that match the term (already folded by foldQuery), with no overlap. */
export function findMatches(text: string, folded: string): [number, number][] {
  if (!folded || !text) return [];
  const f = foldText(text);
  const out: [number, number][] = [];
  for (let i = f.text.indexOf(folded); i !== -1; i = f.text.indexOf(folded, i + folded.length)) {
    const end = i + folded.length;
    out.push(f.starts ? [f.starts[i], f.ends![end - 1]] : [i, end]);
  }
  return out;
}

/** Next (dir = 1) or previous (-1) result, wrapping around; with no current result (-1), starts at the first or last. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}

/** Position of the current result in a list of [line key, no. of results] (in screen order); -1 if it isn't there. */
export function globalIndex(counts: readonly (readonly [string, number])[], ref: { key: string; index: number } | null): number {
  if (!ref) return -1;
  let base = 0;
  for (const [key, n] of counts) {
    if (key === ref.key) return ref.index < n ? base + ref.index : -1;
    base += n;
  }
  return -1;
}

/** The result number `index` (0 = first) in the same list. */
export function refAt(counts: readonly (readonly [string, number])[], index: number): { key: string; index: number } | null {
  if (index < 0) return null;
  let rest = index;
  for (const [key, n] of counts) {
    if (rest < n) return { key, index: rest };
    rest -= n;
  }
  return null;
}

/** Search counter: "3/17"; with no current result, "0/17". */
export function searchCounter(index: number, total: number): string {
  return `${index >= 0 && index < total ? index + 1 : 0}/${total}`;
}

// ---------------------------------------------------------------- copy

/** What an entry's copy button puts on the clipboard (the command, in the case of a tool). */
export function copyTextOf(e: TerminalEntry): string {
  switch (e.kind) {
    case 'tool':
      return e.input?.trim() ? e.input.replace(/\s+$/, '') : e.title;
    case 'thinking':
      return e.text ?? '';
    case 'system':
      return e.detail?.trim() ? `${e.text}\n${e.detail.replace(/\s+$/, '')}` : e.text;
    default:
      return e.text.replace(/\s+$/, '');
  }
}

// ---------------------------------------------------------------- highlight (DOM)

export const HIT_CLASS = 'ui-term__hit';

/** Elements that aren't part of the conversation: buttons, decorative marks and labels (e.g. "Thinking…", "$", "⎿"). */
function isChrome(el: Element): boolean {
  return el.tagName === 'BUTTON' || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-chrome') || el.classList.contains('ui-md__lang');
}

/** Undoes the highlights (`hits`) of a line, joining the text nodes again. */
export function clearHits(hits: readonly HTMLElement[]): void {
  const parents = new Set<Node>();
  for (const span of hits) {
    const parent = span.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(span.textContent ?? ''), span);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

/**
 * Highlights in `root` the ranges that match the term (already folded) and returns the spans in document order. Only
 * looks at text nodes of the conversation (including those of collapsed blocks, which stay hidden in the DOM); a range
 * that crosses two elements (e.g. **bo**ld) doesn't match.
 */
export function highlightHits(root: HTMLElement, folded: string): HTMLElement[] {
  if (!folded || !foldPlain(root.textContent ?? '').includes(folded)) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : isChrome(n as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const out: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.data;
    const ranges = findMatches(text, folded);
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const [a, b] of ranges) {
      if (a > last) frag.append(text.slice(last, a));
      const span = document.createElement('span');
      span.className = HIT_CLASS;
      span.textContent = text.slice(a, b);
      frag.append(span);
      out.push(span);
      last = b;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return out;
}
