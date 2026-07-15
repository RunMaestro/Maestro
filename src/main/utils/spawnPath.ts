/**
 * Spawn-time PATH builder that merges Maestro's hardcoded expanded PATH with
 * the user's cached login-shell PATH and any caller-supplied extra dirs.
 *
 * Why this exists:
 * Agent detection (`path-prober.ts`) uses `getExpandedEnvWithShell()`, which
 * inherits the user's login-shell PATH. That lets us find binaries installed
 * in non-standard locations (e.g. a custom `~/opt/node/bin` outside nvm/fnm/
 * volta/asdf). But the spawn path historically used only
 * `buildExpandedPath()` from `shared/pathUtils`, which knows the hardcoded
 * version-manager and Homebrew paths but NOT the user's custom shell
 * additions.
 *
 * Result: Maestro could detect an agent it couldn't actually run - the
 * script's shebang (e.g. `#!/usr/bin/env node`) couldn't find `node` in the
 * narrower spawn PATH. See issue #1016 for the codex-exit-127 repro.
 *
 * Precedence (highest first):
 *   1. extraPaths supplied by caller (e.g. dirname of the detected agent)
 *   2. Cached shell PATH (matches what detection saw)
 *   3. buildExpandedPath() defaults (Homebrew, nvm/fnm/volta/..., system bins)
 */

import * as path from 'path';
import { buildExpandedPath } from '../../shared/pathUtils';
import { peekShellPath } from '../runtime/getShellPath';

/**
 * Build a spawn PATH that merges the user's cached shell PATH and any extra
 * dirs into Maestro's expanded PATH. Synchronous - uses the cached shell
 * PATH; returns the bare expanded PATH if no probe has completed.
 */
export function buildSpawnPath(extraPaths?: string[]): string {
	const delimiter = path.delimiter;
	const expanded = buildExpandedPath();
	const expandedParts = expanded.split(delimiter).filter(Boolean);

	const shellPath = peekShellPath();
	const shellParts = shellPath ? shellPath.split(delimiter).filter(Boolean) : [];

	// Only absolute paths are safe to prepend - a "." or other relative dir
	// would let a binary in the spawn cwd shadow system tools.
	const extras = (extraPaths || []).filter((p) => Boolean(p) && path.isAbsolute(p));

	const seen = new Set<string>();
	const result: string[] = [];
	for (const list of [extras, shellParts, expandedParts]) {
		for (const p of list) {
			if (!seen.has(p)) {
				seen.add(p);
				result.push(p);
			}
		}
	}

	return result.join(delimiter);
}
