// Remove the directories `tsc -p tsconfig.main.json` emits into, before it runs.
//
// tsc only ever adds and overwrites files; it never deletes output whose source
// is gone. When a module `foo.ts` becomes a directory `foo/index.ts`, the old
// `dist/.../foo.js` stays behind, and Node resolves `require('./foo')` to that
// file before the directory, so the app silently runs the old code (#1724).
// tsc rewrites every file it owns on each run anyway, so starting from empty
// costs nothing.
//
// The list mirrors the `include` globs of tsconfig.main.json (rootDir `src`,
// outDir `dist`). Everything else under `dist/` (cli, prompts, renderer,
// build-provenance.json) belongs to other build steps and is left alone. The
// preload bundle also lives in `dist/main/`, which is why `build:main` rebuilds
// it right after tsc.
//
// Usage: node scripts/clean-tsc-output.mjs

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

for (const dir of ['main', 'shared', 'types']) {
	rmSync(join(distDir, dir), { recursive: true, force: true });
}
