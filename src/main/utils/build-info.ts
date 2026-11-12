// Resolve the git commit hash the running app was built from, for the main
// process (and, through the CLI WebSocket bridge, `maestro-cli version`).
//
// The renderer gets its hash from a compile-time `__COMMIT_HASH__` define
// (vite.config.mts). Main is plain-tsc compiled with no bundler define, so it
// reads the hash two ways, in priority order:
//   1. dist/main/build-info.json, baked by scripts/gen-build-info.mjs during
//      `build:main`. This is what packaged builds ship (dist/**/* is packaged).
//   2. A live `git rev-parse HEAD` in the app source tree, so a dev run that
//      skipped the codegen step (e.g. `dev:main`) still reports a hash.
// Returns '' when neither is available (should be rare). Cached after first read.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { app } from 'electron';

let cachedCommitHash: string | null = null;

function readFromBakedJson(): string {
	try {
		// __dirname is dist/main/utils at runtime, so the JSON sits one level up.
		const jsonPath = path.join(__dirname, '..', 'build-info.json');
		const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8')) as { commitHash?: unknown };
		if (typeof parsed.commitHash === 'string' && parsed.commitHash.length > 0) {
			return parsed.commitHash;
		}
	} catch {
		// No baked file (dev run) or unreadable - fall through to the git probe.
	}
	return '';
}

function readFromGit(): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: app.getAppPath(),
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.trim()
			.slice(0, 8);
	} catch {
		// Packaged app is not a git checkout, or git is unavailable.
	}
	return '';
}

/**
 * The 8-char commit hash the app was built from, or '' when it can't be
 * determined. Memoized so repeated CLI queries don't re-hit disk / git.
 */
export function getCommitHash(): string {
	if (cachedCommitHash !== null) return cachedCommitHash;
	cachedCommitHash = readFromBakedJson() || readFromGit();
	return cachedCommitHash;
}
