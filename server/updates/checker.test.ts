import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { compareVersions, MANUAL_GAP_MS, parseGithubRepo, parseVersion, UpdateChecker, type UpdateCheckerOptions } from './checker';

setQuiet(true);

const REPO = 'marmottajr/habblaud';
const RELEASE = {
  tag_name: 'v0.3.0',
  html_url: 'https://github.com/marmottajr/habblaud/releases/tag/v0.3.0',
  published_at: '2026-10-08T12:00:00Z',
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Fake fetch: answers the `replies` queue in order and keeps the calls. */
function fakeFetch(replies: (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const next = replies.shift();
    if (!next) throw new Error('no response prepared');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

const checkers: UpdateChecker[] = [];
function make(opts: Partial<UpdateCheckerOptions> & Pick<UpdateCheckerOptions, 'fetch'>): UpdateChecker {
  const c = new UpdateChecker({ current: '0.2.0', repo: REPO, enabled: true, file: null, ...opts });
  checkers.push(c);
  return c;
}

afterEach(() => {
  for (const c of checkers.splice(0)) c.stop();
});

describe('versions', () => {
  it('reads x.y.z with or without "v" and with pre-release', () => {
    expect(parseVersion('v1.2.3')).toEqual({ nums: [1, 2, 3], pre: undefined });
    expect(parseVersion('0.10.0-beta.1')).toEqual({ nums: [0, 10, 0], pre: 'beta.1' });
    expect(parseVersion('release-2026')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
  });

  it('compares like semver', () => {
    expect(compareVersions('0.10.0', '0.2.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('junk', '1.0.0')).toBe(0);
  });
});

describe('parseGithubRepo', () => {
  it('accepts the forms of the repository field', () => {
    expect(parseGithubRepo('marmottajr/habblaud')).toBe(REPO);
    expect(parseGithubRepo('github:marmottajr/habblaud')).toBe(REPO);
    expect(parseGithubRepo('https://github.com/marmottajr/habblaud')).toBe(REPO);
    expect(parseGithubRepo({ type: 'git', url: 'git+https://github.com/marmottajr/habblaud.git' })).toBe(REPO);
    expect(parseGithubRepo('git@github.com:marmottajr/habblaud.git')).toBe(REPO);
    expect(parseGithubRepo('git+ssh://git@github.com/marmottajr/habblaud.git')).toBe(REPO);
  });

  it('refuses what is not a GitHub repository', () => {
    expect(parseGithubRepo('https://gitlab.com/a/b')).toBeUndefined();
    expect(parseGithubRepo('a/..')).toBeUndefined();
    expect(parseGithubRepo('a/b/c')).toBeUndefined();
    expect(parseGithubRepo(undefined)).toBeUndefined();
    expect(parseGithubRepo({ url: 42 })).toBeUndefined();
  });
});

describe('UpdateChecker', () => {
  it('newer release: available, link and date; notifies about the change', async () => {
    const f = fakeFetch([json(RELEASE, { headers: { ETag: 'W/"abc"' } })]);
    let changes = 0;
    const c = make({ fetch: f.fetch, now: () => 1_000, onChange: () => changes++ });
    expect(c.status()).toMatchObject({ state: 'pending', available: false });
    const s = await c.check();
    expect(f.calls[0].url).toBe(`https://api.github.com/repos/${REPO}/releases/latest`);
    expect(f.calls[0].headers['User-Agent']).toBe('habblaud/0.2.0');
    expect(s).toEqual({
      state: 'ok',
      repo: REPO,
      checkedAt: 1_000,
      latest: '0.3.0',
      url: RELEASE.html_url,
      publishedAt: Date.parse(RELEASE.published_at),
      available: true,
      error: undefined,
    });
    expect(changes).toBe(1);
  });

  it('304 with ETag keeps the known release and only renews the date', async () => {
    const f = fakeFetch([json(RELEASE, { headers: { ETag: 'W/"abc"' } }), new Response(null, { status: 304 })]);
    let t = 1_000;
    const c = make({ fetch: f.fetch, now: () => t });
    await c.check();
    t = 2_000;
    const s = await c.check();
    expect(f.calls[1].headers['If-None-Match']).toBe('W/"abc"');
    expect(s).toMatchObject({ state: 'ok', latest: '0.3.0', checkedAt: 2_000, available: true });
  });

  it('same version (or older) is not news', async () => {
    const c = make({ fetch: fakeFetch([json({ ...RELEASE, tag_name: 'v0.2.0' })]).fetch });
    expect(await c.check()).toMatchObject({ state: 'ok', latest: '0.2.0', available: false });
  });

  it('404: no release published', async () => {
    const c = make({ fetch: fakeFetch([new Response('{}', { status: 404 })]).fetch, now: () => 5 });
    expect(await c.check()).toMatchObject({ state: 'ok', checkedAt: 5, latest: undefined, available: false });
  });

  it('non-standard tag is ignored', async () => {
    const c = make({ fetch: fakeFetch([json({ ...RELEASE, tag_name: 'nightly' })]).fetch });
    expect(await c.check()).toMatchObject({ state: 'ok', latest: undefined, url: undefined, available: false });
  });

  it('link that is not from the repository becomes the releases page', async () => {
    const c = make({ fetch: fakeFetch([json({ ...RELEASE, html_url: 'javascript:alert(1)' })]).fetch });
    expect((await c.check()).url).toBe(`https://github.com/${REPO}/releases/latest`);
  });

  it('failures: GitHub limit, no network and timeout (the last known release still counts)', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const f = fakeFetch([json(RELEASE), new Response('{}', { status: 403 }), new TypeError('fetch failed'), timeout, new Response('', { status: 502 })]);
    const c = make({ fetch: f.fetch });
    await c.check();
    const limits = await c.check();
    expect(limits).toMatchObject({ state: 'error', latest: '0.3.0', available: true });
    expect(limits.error).toMatch(/rate limit/);
    expect((await c.check()).error).toBe('no connection to GitHub');
    expect((await c.check()).error).toBe("GitHub didn't respond in time");
    expect((await c.check()).error).toBe('GitHub responded 502');
  });

  it('off: does not query anything', async () => {
    const f = fakeFetch([json(RELEASE)]);
    const off = make({ fetch: f.fetch, enabled: false });
    expect(await off.check()).toEqual({ state: 'off', repo: REPO, available: false });
    const noRepo = make({ fetch: f.fetch, repo: undefined });
    expect((await noRepo.check()).state).toBe('off');
    expect(f.calls).toHaveLength(0);
  });

  it('"Check now" several times in a row: at most one query every 30 s', async () => {
    const f = fakeFetch([json(RELEASE), json(RELEASE)]);
    let t = 10_000;
    const c = make({ fetch: f.fetch, now: () => t });
    await c.check({ manual: true });
    t += MANUAL_GAP_MS - 1;
    await c.check({ manual: true });
    expect(f.calls).toHaveLength(1);
    t += 1;
    await c.check({ manual: true });
    expect(f.calls).toHaveLength(2);
  });

  it('simultaneous queries become just one', async () => {
    const f = fakeFetch([json(RELEASE)]);
    const c = make({ fetch: f.fetch });
    const [a, b] = await Promise.all([c.check(), c.check()]);
    expect(a).toEqual(b);
    expect(f.calls).toHaveLength(1);
  });

  it('stores the result and reloads it on startup (from another repository, ignores it)', async () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'sub', 'updates.json');
      const c = make({ fetch: fakeFetch([json(RELEASE, { headers: { ETag: '"e1"' } })]).fetch, file, now: () => 42 });
      await c.check();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ repo: REPO, checkedAt: 42, etag: '"e1"', latest: '0.3.0' });

      const again = make({ fetch: fakeFetch([]).fetch, file });
      again.load();
      expect(again.status()).toMatchObject({ state: 'ok', checkedAt: 42, latest: '0.3.0', available: true });

      const fork = make({ fetch: fakeFetch([]).fetch, file, repo: 'other/person' });
      fork.load();
      expect(fork.status()).toMatchObject({ state: 'pending', latest: undefined });
    } finally {
      tmp.cleanup();
    }
  });
});
