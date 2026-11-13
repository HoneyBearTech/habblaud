import { describe, expect, it } from 'vitest';
import { setLocale } from '../../shared/i18n';
import { FileFetcher, HOST_PRESENCE_MS } from './fetcher';
import { checkFile } from './files';

const ok = (p: string) => ({ path: p, size: 3 });

describe('FileFetcher', () => {
  it('Node: reads straight from disk, with the check', async () => {
    const f = new FileFetcher({ direct: true, check: ok, read: () => Buffer.from('abc') });
    expect(await f.get('/a/x.png')).toEqual({ data: Buffer.from('abc') });
    const denied = new FileFetcher({ direct: true, check: () => ({ error: 'protected file' }) });
    expect(await denied.get('/a/.ssh/x.png')).toEqual({ error: 'protected file', status: 403 });
    // The check's "file not found" is recognized (404, not 403) in English and in Portuguese.
    const missing = () => new FileFetcher({ direct: true, check: checkFile }).get('/does/not/exist.png');
    expect(await missing()).toEqual({ error: 'file not found', status: 404 });
    setLocale('pt-BR');
    try {
      expect(await missing()).toEqual({ error: 'arquivo não encontrado', status: 404 });
    } finally {
      setLocale('en');
    }
  });

  it('Docker: a mounted folder is read here; the rest goes through the helper (poll → ack) and stays in the cache', async () => {
    let now = 1_000;
    const reads: string[] = [];
    const f = new FileFetcher({
      now: () => now,
      check: ok,
      read: (p) => (reads.push(p), Buffer.from('m')),
      mapHostPath: (p) => (p.startsWith('/Users/a/.claude/') ? `/claude${p.slice('/Users/a/.claude'.length)}` : undefined),
    });
    expect(await f.get('/Users/a/.claude/projects/x/t.jpg')).toEqual({ data: Buffer.from('m') });
    expect(reads).toEqual(['/claude/projects/x/t.jpg']);
    expect(await f.get('/tmp/x.png')).toMatchObject({ status: 503 });
    f.poll();
    const pending = f.get('/tmp/x.png');
    const [req] = f.poll();
    expect(req.path).toBe('/tmp/x.png');
    f.ack({ results: [{ id: req.id, ok: true, data: Buffer.from('png').toString('base64') }] });
    expect(await pending).toEqual({ data: Buffer.from('png') });
    now += HOST_PRESENCE_MS + 1;
    expect(await f.get('/tmp/x.png')).toEqual({ data: Buffer.from('png') });
  });

  it('helper refuses: its error reaches the browser', async () => {
    const f = new FileFetcher({ check: ok });
    f.poll();
    const pending = f.get('/tmp/y.png');
    const [req] = f.poll();
    f.ack({ results: [{ id: req.id, ok: false, error: 'protected file' }] });
    expect(await pending).toEqual({ error: 'protected file', status: 404 });
  });

  it('round with wait (?wait=1): the helper stays parked until the page asks for a file, and counts as present', async () => {
    const f = new FileFetcher({ mapHostPath: () => undefined });
    expect(f.hostAvailable()).toBe(false);
    const round = f.pollWait(60_000);
    expect(f.hostAvailable()).toBe(true);
    const got = f.get('/proj/a.png');
    const list = await round;
    expect(list).toEqual([{ id: expect.any(String), path: '/proj/a.png' }]);
    f.ack({ results: [{ id: list[0].id, ok: true, data: Buffer.from('png').toString('base64') }] });
    await expect(got).resolves.toEqual({ data: Buffer.from('png') });
  });
});
