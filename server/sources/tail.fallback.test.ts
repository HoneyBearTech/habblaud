// FileTail com um stat que não ajuda: o Linux sem statx (WSL1, seccomp antigo), em que o Node devolve o ctime como
// birthtime, e um sistema de arquivos que reaproveita o inode de um arquivo apagado (ext4). O node:fs é trocado só
// neste arquivo, para simular os dois em qualquer sistema.
import { appendFileSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/fixtures';
import { FileTail } from './tail';

const sim = vi.hoisted(() => ({ birthIsCtime: false, sameIno: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const fake = (st: Stats): Stats => {
    if (sim.birthIsCtime) st.birthtimeMs = st.ctimeMs;
    if (sim.sameIno) st.ino = 1;
    return st;
  };
  return { ...fs, fstatSync: (fd: number) => fake(fs.fstatSync(fd)), statSync: (path: string) => fake(fs.statSync(path)) };
});

/** Espera o relógio do sistema de arquivos andar (o ext4 grava os tempos em ticks de alguns ms). */
const tick = () => new Promise((ok) => setTimeout(ok, 15));

describe('FileTail with a stat that does not help', () => {
  let tmp: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(() => {
    tmp = tempDir();
    file = join(tmp.dir, 'a.jsonl');
  });
  afterEach(() => {
    sim.birthIsCtime = false;
    sim.sameIno = false;
    tmp.cleanup();
  });

  it('Linux without statx (birthtime = ctime): appended lines do not count as a swap', async () => {
    sim.birthIsCtime = true;
    writeFileSync(file, '{"a":1}\n');
    const t = new FileTail(file);
    t.seekTail(1024);
    expect(t.read().lines).toEqual(['{"a":1}']);
    for (const n of [2, 3]) {
      await tick();
      appendFileSync(file, `{"a":${n}}\n`);
      expect(t.read()).toMatchObject({ reset: false, lines: [`{"a":${n}}`] });
    }
  });

  it('reused inode: the swap shows up through the beginning of the file, with or without a real birthtime', async () => {
    sim.sameIno = true;
    // No NTFS, o arquivo recriado com o mesmo nome em menos de 15 s herda o birthtime do apagado ("tunneling"): com o
    // inode simulado igual, o FileTail não tem por onde notar a troca. Lá o inode não se repete (o id do arquivo muda),
    // então só a variante com birthtime = ctime vale.
    for (const birthIsCtime of process.platform === 'win32' ? [true] : [false, true]) {
      sim.birthIsCtime = birthIsCtime;
      writeFileSync(file, 'old-1\n');
      const t = new FileTail(file);
      t.read();
      await tick();
      rmSync(file);
      writeFileSync(file, 'new-1\nnew-2\n');
      expect(t.read()).toMatchObject({ reset: true, lines: ['new-1', 'new-2'] });
    }
  });
});
