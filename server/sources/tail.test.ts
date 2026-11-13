import { appendFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../log';
import { tempDir } from '../test/fixtures';
import { FileTail, MAX_LINE_BYTES } from './tail';

function drain(t: FileTail): string[] {
  const all: string[] = [];
  for (let i = 0; i < 80; i++) {
    const r = t.read();
    all.push(...r.lines);
    if (!r.more) return all;
  }
  throw new Error('read did not finish');
}

describe('FileTail', () => {
  let tmp: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(() => {
    tmp = tempDir();
    file = join(tmp.dir, 'a.jsonl');
  });
  afterEach(() => tmp.cleanup());

  it('reads only complete lines and keeps the partial line for the next cycle', () => {
    writeFileSync(file, '{"a":1}\n{"b":');
    const t = new FileTail(file);
    expect(t.read().lines).toEqual(['{"a":1}']);
    expect(t.read().lines).toEqual([]);
    appendFileSync(file, '2}\n{"c":3}\n');
    expect(t.read().lines).toEqual(['{"b":2}', '{"c":3}']);
  });

  it('does not break multibyte characters split between reads', () => {
    const line = JSON.stringify({ t: 'ação — café ☕' });
    const buf = Buffer.from(`${line}\n`);
    writeFileSync(file, buf.subarray(0, 12));
    const t = new FileTail(file);
    expect(t.read().lines).toEqual([]);
    appendFileSync(file, buf.subarray(12));
    expect(t.read().lines).toEqual([line]);
  });

  it('detects truncation and restarts from the beginning', () => {
    writeFileSync(file, 'one\ntwo\n');
    const t = new FileTail(file);
    expect(t.read().lines).toEqual(['one', 'two']);
    writeFileSync(file, 'x\n');
    const r = t.read();
    expect(r.reset).toBe(true);
    expect(r.lines).toEqual(['x']);
  });

  it('detects a replaced file (rotation) even when larger', () => {
    writeFileSync(file, 'a\n');
    const t = new FileTail(file);
    t.read();
    rmSync(file);
    writeFileSync(file, 'new-1\nnew-2\n');
    const r = t.read();
    expect(r.reset).toBe(true);
    expect(r.lines).toEqual(['new-1', 'new-2']);
  });

  it('does not treat lines appended to the same file as rotation', () => {
    writeFileSync(file, 'a\n');
    const t = new FileTail(file);
    t.read();
    appendFileSync(file, 'b\nc\n');
    const r = t.read();
    expect(r.reset).toBe(false);
    expect(r.lines).toEqual(['b', 'c']);
  });

  describe('rewrite on the same inode', () => {
    /** Waits for the file system clock to move (ext4 records the times in ticks of a few ms). */
    const tick = () => new Promise((ok) => setTimeout(ok, 15));

    it('new content of the same size restarts from the beginning', async () => {
      writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
      const t = new FileTail(file);
      expect(t.read().lines).toEqual(['aaaa', 'bbbb', 'cccc']);
      await tick();
      writeFileSync(file, 'xxxx\nyyyy\nzzzz\n'); // same inode, same size
      const r = t.read();
      expect(r.reset).toBe(true);
      expect(r.lines).toEqual(['xxxx', 'yyyy', 'zzzz']);
    });

    it('larger new content restarts from the beginning', async () => {
      writeFileSync(file, 'one\ntwo\n');
      const t = new FileTail(file);
      t.read();
      await tick();
      writeFileSync(file, 'new-1\nnew-2\nnew-3\n');
      const r = t.read();
      expect(r.reset).toBe(true);
      expect(r.lines).toEqual(['new-1', 'new-2', 'new-3']);
    });

    it('only appending lines (the mtime changes, the beginning does not) is not a swap', async () => {
      writeFileSync(file, 'a\n');
      const t = new FileTail(file);
      t.read();
      await tick();
      appendFileSync(file, 'b\n');
      expect(t.read()).toMatchObject({ reset: false, lines: ['b'] });
      await tick();
      appendFileSync(file, 'c\n');
      expect(t.read()).toMatchObject({ reset: false, lines: ['c'] });
    });

    it('touching the file without changing the content is not a swap', async () => {
      writeFileSync(file, 'a\nb\n');
      const t = new FileTail(file);
      t.read();
      await tick();
      const now = new Date();
      utimesSync(file, now, now);
      expect(t.read()).toMatchObject({ reset: false, lines: [] });
    });
  });

  it('reports a nonexistent file without throwing an error', () => {
    const t = new FileTail(join(tmp.dir, 'does-not-exist.jsonl'));
    expect(t.read()).toMatchObject({ missing: true, lines: [] });
  });

  it('seekTail aligns to the start of the next line', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(3, '0')}`);
    writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    const t = new FileTail(file);
    const start = t.seekTail(25);
    expect(start).toBeGreaterThan(0);
    const got = t.read().lines;
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((l) => /^line-\d{3}$/.test(l))).toBe(true);
    expect(got.at(-1)).toBe('line-049');
  });

  it('seekTail on a small file reads everything', () => {
    writeFileSync(file, 'a\nb\n');
    const t = new FileTail(file);
    expect(t.seekTail(1024)).toBe(0);
    expect(t.read().lines).toEqual(['a', 'b']);
  });

  it('respects the per-read limit and signals that there is more', () => {
    writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
    const t = new FileTail(file, { maxChunk: 6 });
    const r1 = t.read();
    expect(r1.lines).toEqual(['aaaa']);
    expect(r1.more).toBe(true);
    const all = [...r1.lines];
    for (let i = 0; i < 5; i++) all.push(...t.read().lines);
    expect(all).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('discards the partial line that goes over the cap and continues on the next', () => {
    writeFileSync(file, Buffer.alloc(MAX_LINE_BYTES + 64 * 1024, 0x61));
    const t = new FileTail(file, { maxChunk: 256 * 1024 });
    const warn = vi.spyOn(log, 'warnOnce').mockImplementation(() => {});
    try {
      expect(drain(t)).toEqual([]);
      appendFileSync(file, '\n{"ok":1}\n');
      const lines = drain(t);
      // The size comes before the text: a failure does not dump the giant line into the diff.
      expect(lines.map((l) => l.length)).toEqual([8]);
      expect(lines).toEqual(['{"ok":1}']);
      expect(warn).toHaveBeenCalledWith(`oversize-line:${file}`, expect.stringContaining('8 MiB'));
    } finally {
      warn.mockRestore();
    }
  });

  it('delivers a line of the exact size of the cap', () => {
    expect(MAX_LINE_BYTES).toBe(8 * 1024 * 1024);
    writeFileSync(file, Buffer.concat([Buffer.alloc(MAX_LINE_BYTES, 0x62), Buffer.from('\nok\n')]));
    const t = new FileTail(file, { maxChunk: 256 * 1024 });
    const lines = drain(t);
    expect(lines.length).toBe(2);
    expect(lines[0]?.length).toBe(MAX_LINE_BYTES);
    expect(lines[0]?.charCodeAt(0)).toBe(0x62);
    expect(lines[0]?.charCodeAt(MAX_LINE_BYTES - 1)).toBe(0x62);
    expect(lines[1]).toBe('ok');
  });
});
