// Delivery files: what can be shown in the office. Only files the agent itself delivered (the server only asks for
// paths that are in a delivery) and, even then, only viewable types (image, PDF, video, page, text) and never
// something that looks like a secret (.ssh, .env, keys, credentials...). The reader is the server (Node mode, or a
// folder mounted in Docker) or the host helper (scripts/codex-bridge.ts), which checks everything again before
// reading.
// Pure Node with no dependencies: it is also imported by the host helper (via tsx).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DeliveryAttachmentKind } from '../../shared/types';
import { tr } from '../../shared/i18n';

export const DELIVERY_FILE_MAX_BYTES = 25 * 1024 * 1024;

const TYPES: Readonly<Record<string, { kind: DeliveryAttachmentKind; type: string }>> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  pdf: { kind: 'pdf', type: 'application/pdf' },
  mp4: { kind: 'video', type: 'video/mp4' },
  mov: { kind: 'video', type: 'video/quicktime' },
  webm: { kind: 'video', type: 'video/webm' },
  html: { kind: 'page', type: 'text/html; charset=utf-8' },
  htm: { kind: 'page', type: 'text/html; charset=utf-8' },
  md: { kind: 'text', type: 'text/plain; charset=utf-8' },
  txt: { kind: 'text', type: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', type: 'text/plain; charset=utf-8' },
  log: { kind: 'text', type: 'text/plain; charset=utf-8' },
  xlsx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  docx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  zip: { kind: 'file', type: 'application/zip' },
};

/** Folders and names that never leave, even if an agent "delivers" them (e.g. text injected into a transcript). */
const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.config\/gh|\.config\/gcloud|Keychains|\.habblaud\/remote-tls)(\/|$)/i;
const SECRET_NAMES = /(^|\/)(\.env[^/]*|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|[^/]*(secret|credential|password|senha|token)[^/]*)$/i;

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Viewing type and Content-Type, or undefined if the extension is not viewable. */
export function fileType(path: string): { kind: DeliveryAttachmentKind; type: string } | undefined {
  return TYPES[extensionOf(path)];
}

/** Reason NOT to show the path (looking only at the text), or undefined. */
export function pathProblem(path: string): string | undefined {
  if (!path || path.includes('\0') || !path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(path)) return tr('invalid path');
  if (!fileType(path)) return tr("file type that can't be shown here");
  if (SECRET_DIRS.test(path) || SECRET_NAMES.test(path)) return tr('protected file');
  return undefined;
}

/** Checks on disk (links resolved, size, regular file). Returns the real path or the reason. */
export function checkFile(
  path: string,
  fs: { realpath(p: string): string; stat(p: string): { isFile(): boolean; size: number } } = { realpath: realpathSync, stat: statSync },
): { path: string; size: number } | { error: string } {
  const bad = pathProblem(path);
  if (bad) return { error: bad };
  let real: string;
  let st: { isFile(): boolean; size: number };
  try {
    real = fs.realpath(path);
    st = fs.stat(real);
  } catch {
    return { error: tr('file not found') };
  }
  const realBad = pathProblem(real);
  if (realBad) return { error: realBad };
  if (!st.isFile()) return { error: tr('not a file') };
  if (st.size > DELIVERY_FILE_MAX_BYTES) return { error: tr('file too large to view here') };
  return { path: real, size: st.size };
}

/** Temp folders where agents keep drafts and screenshots (the system one and the usual ones on macOS and Linux). */
export function tempRoots(): string[] {
  const out = new Set<string>(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']);
  try {
    out.add(realpathSync(tmpdir()));
  } catch {
    out.add(tmpdir());
  }
  return [...out];
}

/**
 * The file (real path) is in a folder the host helper can read: a project folder that some Claude Code account
 * knows (it, or one above it, has <account>/projects/<encoded folder>) or one of the `roots` (temporary folders,
 * Habblaud attachments). This way a request coming from the container does not reach the rest of the computer.
 */
export function insideKnownFolder(
  path: string,
  opts: { accountDirs: readonly string[]; roots: readonly string[]; exists?: (p: string) => boolean },
): boolean {
  if (opts.roots.some((r) => r && path.startsWith(`${r.replace(/\/+$/, '')}/`))) return true;
  const exists = opts.exists ?? existsSync;
  // Same encoding as sources/watcher.ts (encodeCwd): every non-alphanumeric character becomes "-".
  for (let dir = dirname(path); dir.split('/').filter(Boolean).length >= 2; dir = dirname(dir)) {
    const encoded = dir.replace(/[^a-zA-Z0-9]/g, '-');
    if (opts.accountDirs.some((acc) => exists(join(acc, 'projects', encoded)))) return true;
  }
  return false;
}
