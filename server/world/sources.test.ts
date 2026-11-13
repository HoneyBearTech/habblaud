// The files that the Habblaud World server keeps as an exact copy (protocol.ts and city.ts, with the SHA-256 checked
// there) import nothing and do not use Node or DOM: copied byte for byte, they compile on the other side. It is here
// (and not next to them, in shared/) because it needs to read the disk.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'world', file), 'utf8');

describe('files copied to the world server', () => {
  for (const file of ['protocol.ts', 'city.ts']) {
    it(`${file}: no imports, no Node or DOM, with the notice at the top`, () => {
      const src = read(file);
      expect(src).not.toMatch(/^\s*import\s/m);
      expect(src).not.toMatch(/\brequire\(|\bprocess\.|\bwindow\.|\bdocument\./);
      expect(src.startsWith('// AVISO')).toBe(true);
    });
  }
});
