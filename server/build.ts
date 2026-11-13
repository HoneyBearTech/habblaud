// Identifier of the compiled client build (dist/client): the name of the main bundle, which changes on every
// `npm run build`. Goes in the snapshot so that pages opened before an update notice it and reload themselves.
// And the server's build stamp (dist/build.json: commit and "modified copy"), for Habblaud World.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildInfo } from '../shared/world/protocol';

const BUNDLE = /bundle\/(main-[\w-]+)\.js/;

/** Reads the build id from the compiled index.html (cached by the modification date). */
export function createBuildReader(rootDir: string): () => string | undefined {
  const file = join(rootDir, 'dist', 'client', 'index.html');
  let mtime = -1;
  let id: string | undefined;
  return () => {
    try {
      const m = statSync(file).mtimeMs;
      if (m !== mtime) {
        mtime = m;
        id = BUNDLE.exec(readFileSync(file, 'utf8'))?.[1];
      }
    } catch {
      mtime = -1;
      id = undefined;
    }
    return id;
  };
}

/** What scripts/build-server.mjs writes to dist/build.json (scripts/build-info.mjs). */
export interface BuildStamp extends BuildInfo {
  /** When the build was made (ISO); absent without the file. */
  builtAt?: string;
}

const UNKNOWN: BuildStamp = { commit: 'unknown', dirty: false };

/**
 * Commit of the build in use and whether the copy was modified, from dist/build.json. Goes in the Habblaud World
 * `hello`. Without the file (dev mode with tsx, or an old build) or with it broken: commit "unknown".
 */
export function readBuildInfo(rootDir: string): BuildStamp {
  try {
    const raw = JSON.parse(readFileSync(join(rootDir, 'dist', 'build.json'), 'utf8')) as Record<string, unknown>;
    if (typeof raw.commit !== 'string' || !/^([0-9a-f]{40}([0-9a-f]{24})?|unknown)$/.test(raw.commit) || typeof raw.dirty !== 'boolean') return { ...UNKNOWN };
    const stamp: BuildStamp = { commit: raw.commit, dirty: raw.dirty };
    if (typeof raw.builtAt === 'string' && raw.builtAt.length <= 40) stamp.builtAt = raw.builtAt;
    return stamp;
  } catch {
    return { ...UNKNOWN };
  }
}
