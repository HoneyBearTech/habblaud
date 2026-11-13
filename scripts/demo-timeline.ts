// Gera uma linha do tempo SÓ com dados fictícios para o timelapse (ex.: gravar o GIF do README).
// Roda o simulador do modo demonstração (shared/demo/simulator.ts) offline, com relógio próprio, por
// N horas simuladas, e grava com o mesmo gravador do servidor (server/history/timeline.ts) em
// <pasta>/timeline/AAAA-MM-DD.jsonl. Nenhum dado real entra no arquivo.
//
//   npm run demo:timeline                                   # ontem, das 9h às 19h, em <tmp>/habblaud-demo
//   npm run demo:timeline -- --date 2026-10-07 --start 8:30 --hours 11 --sessions 7
//
// Para assistir: HABBLAUD_DATA_DIR=<pasta> HABBLAUD_TIMELINE=0 npm start (ou npm run dev) e o botão
// Timelapse da barra superior. Ao longo do dia o número de sessões sobe de manhã, cai no almoço, volta
// a subir à tarde e zera no fim (sessionsAt), para o timelapse ter cara de dia de trabalho.
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DemoSimulator } from '../shared/demo/simulator';
import { dayKey, isDayKey, shiftDay } from '../shared/timeline';
import { TIMELINE_DIR, TimelineRecorder } from '../server/history/timeline';

const HOUR = 3_600_000;

const USAGE = `Usage: npm run demo:timeline [-- options]

Generates a timeline with made-up data (the demo mode simulator) for the timelapse.

Options:
  --date YYYY-MM-DD   day recorded (default: yesterday, so it doesn't mix with today's recording)
  --start H[:MM]      start time (default: 9)
  --hours N           simulated hours (default: 10; maximum 24)
  --sessions N        sessions open at the day's peak (default: 6)
  --pace X            simulator pace: 1 = that of the live demo mode (turns of 40 s to 4 min);
                      0.25 = 4× slower, that of a workday (default: 0.25)
  --seed N            seed (default: 1; the same seed generates the same day)
  --data-dir FOLDER   Habblaud data folder (default: <tmp>/habblaud-demo); the file goes in FOLDER/timeline/
  --force             overwrites the day's file, if it exists
  -h, --help          shows this help

To watch: HABBLAUD_DATA_DIR=FOLDER HABBLAUD_TIMELINE=0 npm start and open the Timelapse.`;

export interface DemoTimelineOptions {
  date: string;
  /** Minutos depois da meia-noite. */
  startMin: number;
  hours: number;
  sessions: number;
  pace: number;
  seed: number;
  dataDir: string;
  force: boolean;
  help: boolean;
}

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/demo-timeline.test.ts)
// ---------------------------------------------------------------------------------------------

export function parseArgs(argv: string[], now = Date.now()): DemoTimelineOptions {
  const o: DemoTimelineOptions = {
    date: shiftDay(dayKey(now), -1),
    startMin: 9 * 60,
    hours: 10,
    sessions: 6,
    pace: 0.25,
    seed: 1,
    dataDir: join(tmpdir(), 'habblaud-demo'),
    force: false,
    help: false,
  };
  const num = (flag: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v);
    if (v === undefined || v.trim() === '' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${flag}: expected a number between ${min} and ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--date': {
        const v = next();
        if (!isDayKey(v)) throw new Error('--date: use YYYY-MM-DD');
        o.date = v;
        break;
      }
      case '--start': {
        const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(next() ?? '');
        if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) throw new Error('--start: use H or H:MM (0 to 23:59)');
        o.startMin = Number(m[1]) * 60 + Number(m[2] ?? 0);
        break;
      }
      case '--hours':
        o.hours = num(a, next(), 0.1, 24);
        break;
      case '--sessions':
        o.sessions = Math.round(num(a, next(), 1, 20));
        break;
      case '--pace':
        o.pace = num(a, next(), 0.05, 10);
        break;
      case '--seed':
        o.seed = Math.round(num(a, next(), 0, 2 ** 31));
        break;
      case '--data-dir': {
        const v = next();
        if (!v) throw new Error('--data-dir: give the folder');
        o.dataDir = resolve(v);
        break;
      }
      case '--force':
        o.force = true;
        break;
      case '-h':
      case '--help':
        o.help = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  return o;
}

/** Fração do pico de sessões ao longo do dia (0 = início, 1 = fim): manhã, almoço, tarde e saída. */
const DAY_CURVE: readonly [number, number][] = [
  [0, 0.2],
  [0.08, 0.6],
  [0.2, 1],
  [0.36, 0.85],
  [0.44, 0.35],
  [0.54, 0.55],
  [0.68, 1],
  [0.84, 0.75],
  [0.94, 0.2],
  [1, 0],
];

/** Sessões a manter abertas na fração `p` do dia simulado, com pico `peak`. */
export function sessionsAt(p: number, peak: number): number {
  const x = Math.min(1, Math.max(0, p));
  for (let i = 1; i < DAY_CURVE.length; i++) {
    const [x1, y1] = DAY_CURVE[i];
    if (x > x1) continue;
    const [x0, y0] = DAY_CURVE[i - 1];
    const k = x1 === x0 ? 1 : (x - x0) / (x1 - x0);
    return Math.round(peak * (y0 + (y1 - y0) * k));
  }
  return 0;
}

export interface DemoTimelineResult {
  /** Arquivos gravados (mais de um se o período atravessar a meia-noite). */
  files: string[];
  from: number;
  to: number;
}

/** Arquivos que um período ocupa (um por dia local). */
function filesFor(dir: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let day = dayKey(from); day <= dayKey(to); day = shiftDay(day, 1)) out.push(join(dir, `${day}.jsonl`));
  return out;
}

/** Simula e grava. `stepMs` = passo do relógio simulado (o servidor avança o demo a cada 250 ms). */
export function generateDemoTimeline(o: Omit<DemoTimelineOptions, 'help'>, stepMs = 500): DemoTimelineResult {
  const [y, mo, d] = o.date.split('-').map(Number);
  const from = new Date(y, mo - 1, d, Math.floor(o.startMin / 60), o.startMin % 60).getTime();
  const to = from + o.hours * HOUR;
  const dir = join(o.dataDir, TIMELINE_DIR);
  const files = filesFor(dir, from, to);
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (!o.force) throw new Error(`${f} already exists (use --force to overwrite)`);
    unlinkSync(f);
  }
  let now = from;
  // Começa com uma sessão no máximo (o escritório vai enchendo pelo elevador ao longo da manhã).
  const sim = new DemoSimulator({ seed: o.seed, speed: o.pace, sessions: 1 }, from);
  // Tudo aqui é fictício: todos os agentes saem marcados como demonstração.
  const rec = new TimelineRecorder({ dir, now: () => now, isDemo: () => true, retentionDays: 0 });
  rec.ingest(sim.snapshot(now));
  for (; now <= to; now += stepMs) {
    sim.setSessions(sessionsAt((now - from) / (to - from), o.sessions));
    const r = sim.tick(now);
    if (r.changed) rec.ingest(sim.snapshot(now));
    else rec.tick();
  }
  now = to;
  rec.stop();
  return { files: files.filter((f) => existsSync(f)), from, to };
}

async function main(): Promise<void> {
  let opts: DemoTimelineOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const t0 = Date.now();
  const r = generateDemoTimeline(opts);
  const hhmm = (at: number) => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  console.log(`Made-up timeline for ${opts.date}, ${hhmm(r.from)}–${hhmm(r.to)}, generated in ${((Date.now() - t0) / 1000).toFixed(1)} s:`);
  for (const f of r.files) console.log(`  ${f}`);
  console.log(`\nTo watch:\n  HABBLAUD_DATA_DIR=${opts.dataDir} HABBLAUD_TIMELINE=0 npm start\nand open the Timelapse in the top bar.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
