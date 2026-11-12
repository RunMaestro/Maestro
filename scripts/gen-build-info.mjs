// Emit dist/main/build-info.json with the commit hash the app was built from.
//
// The main process is compiled with plain `tsc` (no bundler `define`), so unlike
// the renderer it can't get a compile-time `__COMMIT_HASH__`. This tiny post-build
// step bakes the hash into a JSON that main reads at runtime (see
// src/main/utils/build-info.ts), which is what `maestro-cli version` returns.
//
// Packaged builds include dist/**/* (see package.json build.files), so this JSON
// ships inside the app and the CLI can report the exact HEAD even when the running
// app is not a git checkout.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function resolveCommitHash() {
	// Honor an explicit override first (CI builds from a tarball / shallow checkout).
	if (process.env.VITE_COMMIT_HASH) {
		return process.env.VITE_COMMIT_HASH.trim().slice(0, 8);
	}
	try {
		return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim().slice(0, 8);
	} catch {
		return '';
	}
}

const outDir = path.join(repoRoot, 'dist', 'main');
mkdirSync(outDir, { recursive: true });
const commitHash = resolveCommitHash();
writeFileSync(path.join(outDir, 'build-info.json'), `${JSON.stringify({ commitHash }, null, 2)}\n`);
console.log(`[gen-build-info] wrote dist/main/build-info.json (commitHash="${commitHash}")`);
