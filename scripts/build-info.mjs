// Writes dist/build.json with the Habblaud commit and whether the copy was modified (`npm run build:server` calls it).
// server/build.ts reads the file (readBuildInfo), and the Habblaud World `hello` sends {commit, dirty} so the server
// knows whether it is an official release (shared/world/protocol.ts, BuildInfo).
//
// - commit: `git rev-parse HEAD`; without git (folder downloaded as .zip, Docker build, which doesn't take .git) =
//   "unknown".
// - dirty: some TRACKED file modified (`git status --porcelain --untracked-files=no`). Files outside git
//   (.env, node_modules as a symbolic link, drafts) don't count: the build only takes what the tracked code imports.
// - HABBLAUD_BUILD_COMMIT and HABBLAUD_BUILD_DIRTY (1/true) replace reading git (for builds without .git).
//
// Direct use: node scripts/build-info.mjs [file]   (default: dist/build.json, from the current folder)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** {commit, dirty} of the folder `cwd`. */
export function gitBuildInfo(cwd = process.cwd(), env = process.env) {
  const fromEnv = env.HABBLAUD_BUILD_COMMIT?.trim().toLowerCase();
  if (fromEnv) return { commit: COMMIT_RE.test(fromEnv) ? fromEnv : 'unknown', dirty: /^(1|true)$/i.test(env.HABBLAUD_BUILD_DIRTY?.trim() ?? '') };
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  try {
    const commit = git(['rev-parse', 'HEAD']);
    if (!COMMIT_RE.test(commit)) return { commit: 'unknown', dirty: false };
    return { commit, dirty: git(['status', '--porcelain', '--untracked-files=no']).length > 0 };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

/** Writes the file ({commit, dirty, builtAt}) and returns what it wrote. */
export function writeBuildInfo(file, cwd = process.cwd(), now = new Date()) {
  const info = { ...gitBuildInfo(cwd), builtAt: now.toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = writeBuildInfo(resolve(process.argv[2] ?? 'dist/build.json'));
  console.log(JSON.stringify(info));
}
