// Fictional GitHub events of demo mode: from time to time someone opens or merges a PR,
// publishes a release or sees the CI fail (and then pass), so the rooms' party and alarm show up
// in the screenshots with no real data.
import type { GitHubEvent } from '../github';
import { tr } from '../i18n';

const WORKFLOWS = ['CI', 'build-test', tr('Tests'), tr('Lint and types'), 'Deploy'];

/**
 * Draws an event. `alarm` = the room already has the CI red: most of the time, the next
 * event is the fix (CI green). `pr` = number of the next fictional PR.
 */
export function demoGitHubEvent(rng: () => number, opts: { branch?: string; alarm: boolean; pr: number }): GitHubEvent {
  const branch = opts.branch ?? 'main';
  const workflow = WORKFLOWS[Math.floor(rng() * WORKFLOWS.length)];
  if (opts.alarm && rng() < 0.75) return { kind: 'ci_passed', branch, workflow };
  const r = rng();
  if (r < 0.32) return { kind: 'pr_opened', number: opts.pr };
  if (r < 0.58) return { kind: 'pr_merged', number: Math.max(1, opts.pr - 1 - Math.floor(rng() * 3)) };
  if (r < 0.84) return { kind: 'ci_failed', branch, workflow };
  if (r < 0.92) return { kind: 'ci_passed', branch, workflow };
  return { kind: 'release', tag: `v${1 + Math.floor(rng() * 3)}.${Math.floor(rng() * 10)}.${Math.floor(rng() * 10)}` };
}
