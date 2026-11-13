// ALTCHA: proof of work that the Habblaud World server asks for at sign-up and when sending e-mails (in place of a
// captcha). The server sends {algorithm, challenge, salt, maxnumber, signature}; the requester finds the number n
// (0..maxnumber) with SHA-256(salt + n) = challenge and returns, in base64, the JSON {algorithm, challenge, number,
// salt, signature, took} (the ALTCHA widget format). The local Habblaud server solves it, by brute force, with no
// dependencies.
//
// The search runs in batches, yielding to the event loop between them: the office keeps responding meanwhile.
import { createHash } from 'node:crypto';
import type { AltchaChallenge } from '../../shared/world/protocol';

/** Cap accepted for `maxnumber` (above it the challenge is refused instead of freezing the computer for minutes). */
export const ALTCHA_MAX_NUMBER = 10_000_000;
/** Attempts per batch between two yields to the event loop. */
const BATCH = 5_000;

/** Validates the challenge that came from the world server; undefined if anything is out of format. */
export function parseAltchaChallenge(raw: unknown, maxNumber = ALTCHA_MAX_NUMBER): AltchaChallenge | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.algorithm !== 'SHA-256') return undefined;
  if (typeof v.challenge !== 'string' || !/^[0-9a-f]{64}$/i.test(v.challenge)) return undefined;
  if (typeof v.salt !== 'string' || !v.salt || v.salt.length > 512) return undefined;
  if (typeof v.signature !== 'string' || !v.signature || v.signature.length > 512) return undefined;
  if (!Number.isInteger(v.maxnumber) || (v.maxnumber as number) < 1 || (v.maxnumber as number) > maxNumber) return undefined;
  return { algorithm: 'SHA-256', challenge: v.challenge.toLowerCase(), salt: v.salt, maxnumber: v.maxnumber as number, signature: v.signature };
}

export function altchaHash(salt: string, n: number): string {
  return createHash('sha256').update(salt + n).digest('hex');
}

export interface AltchaSolution {
  number: number;
  /** How long the search took (ms). */
  took: number;
}

/**
 * Finds the challenge's number. Returns undefined if no n up to `maxnumber` works (invalid challenge). Stops with
 * `signal` (throws the abort reason).
 */
export async function solveAltcha(
  ch: AltchaChallenge,
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<AltchaSolution | undefined> {
  const now = opts.now ?? Date.now;
  const start = now();
  for (let n = 0; n <= ch.maxnumber; n++) {
    if (altchaHash(ch.salt, n) === ch.challenge) return { number: n, took: Math.max(0, now() - start) };
    if (n % BATCH === BATCH - 1) {
      await new Promise<void>((ok) => setImmediate(ok));
      opts.signal?.throwIfAborted();
    }
  }
  return undefined;
}

/** The solution in the sign-up `altcha` field format: base64 of {algorithm, challenge, number, salt, signature, took}. */
export function encodeAltchaPayload(ch: AltchaChallenge, sol: AltchaSolution): string {
  const payload = { algorithm: ch.algorithm, challenge: ch.challenge, number: sol.number, salt: ch.salt, signature: ch.signature, took: sol.took };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
