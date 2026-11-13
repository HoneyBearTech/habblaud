// Timelapse routes (timeline recorded by history/timeline.ts):
//   GET /api/timeline/days    -> {recording, days: [{day, bytes, from, to}]} (from the most recent to the oldest)
//   GET /api/timeline/:dia    -> the day's file (JSONL, format in shared/timeline.ts), with gzip if accepted
// Same exposure as /api/snapshot (activity summaries): it works with any bind, without the terminal's local
// lock. The day is only accepted in the AAAA-MM-DD format of a valid date: the file's path never carries
// text coming from the URL (no "..", slashes or strange bytes).
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import { listTimelineDays, timelineFile } from '../history/timeline';
import { sendJson } from './app';
import { tr } from '../../shared/i18n';

const DAYS_PATH = '/api/timeline/days';
const DAY_ROUTE = /^\/api\/timeline\/([^/]+)$/;

export interface TimelineRoutesOptions {
  /** Folder of the files (<dataDir>/timeline). */
  dir: string;
  /** The server is recording (HABBLAUD_TIMELINE did not turn it off). */
  recording: boolean;
}

/** Returns a handler that handles /api/timeline/* and answers false for the rest. */
export function createTimelineHandler(opts: TimelineRoutesOptions): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  return (req, res, url) => {
    const path = url.pathname;
    if (path !== '/api/timeline' && !path.startsWith('/api/timeline/')) return false;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: tr('method not allowed') });
      return true;
    }
    if (path === DAYS_PATH) {
      sendJson(res, 200, { recording: opts.recording, days: listTimelineDays(opts.dir) });
      return true;
    }
    const m = DAY_ROUTE.exec(path);
    let day = '';
    try {
      day = m ? decodeURIComponent(m[1]) : '';
    } catch {
      day = '';
    }
    const file = timelineFile(opts.dir, day);
    if (!file) {
      sendJson(res, 400, { error: tr('invalid day: use YYYY-MM-DD') });
      return true;
    }
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error(tr('not a file'));
      size = st.size;
    } catch {
      sendJson(res, 404, { error: tr('nothing recorded on this day') });
      return true;
    }
    sendDay(req, res, file, size, method === 'HEAD');
    return true;
  };
}

/** Streams the file up to the size seen now (the rest, still being written, is left for the next time). */
function sendDay(req: IncomingMessage, res: ServerResponse, file: string, size: number, head: boolean): void {
  const gzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    Vary: 'Accept-Encoding',
  };
  if (gzip) headers['Content-Encoding'] = 'gzip';
  else headers['Content-Length'] = size;
  res.writeHead(200, headers);
  if (head || size === 0) {
    if (gzip && !head) createGzip().end().pipe(res);
    else res.end();
    return;
  }
  const src = createReadStream(file, { start: 0, end: size - 1 });
  const done = (err: NodeJS.ErrnoException | null) => {
    if (err && !res.writableEnded) res.destroy();
  };
  if (gzip) pipeline(src, createGzip(), res, done);
  else pipeline(src, res, done);
}
