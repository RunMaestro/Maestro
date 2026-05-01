/**
 * stray-file-detector.ts
 *
 * Reusable module for detecting worktree contamination before a branch merge.
 *
 * The detector runs `git status --porcelain` via an injected `runGit` dep,
 * classifies each dirty line as either "modified" (index or worktree edits to
 * tracked files) or "untracked" (new files the user has not yet staged), then
 * applies an optional allowlist.  Files that match the allowlist are filtered
 * out of the `strays` set — they are still reported in `allowlisted` for
 * observability.
 *
 * The allowlist accepts exact-string paths **or** RegExp instances.  A path is
 * allowlisted when it satisfies at least one entry.
 *
 * ## Design rationale
 *
 * The previous one-shot check in `scripts/precheck-stray-files.mjs` was
 * tightly coupled to `execSync` and process.exit, making it untestable.  This
 * module inverts that by accepting `runGit` as a dep, enabling pure unit tests
 * with no real git invocation.
 *
 * ## Usage
 *
 * ```ts
 * import { assertNoStrayFiles } from './stray-file-detector';
 * import { execFile } from 'child_process';
 * import { promisify } from 'util';
 *
 * const execFileAsync = promisify(execFile);
 *
 * await assertNoStrayFiles({
 *   runGit: (args) => execFileAsync('git', args, { encoding: 'utf8' }),
 *   allowlist: [/^docs\//, 'README.md'],
 * });
 * ```
 *
 * @see scripts/precheck-stray-files.mjs — original one-shot CLI wrapper
 * @see docs/agent-guides/WORKER-HYGIENE.md — contamination patterns + recovery
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal async git runner.  Only `stdout` is required — stderr is ignored by
 * the detector because `git status --porcelain` never writes diagnostics there
 * under normal conditions.
 */
export interface StrayFileDetectorDeps {
	runGit: (args: string[]) => Promise<{ stdout: string }>;
	/**
	 * Files matching any entry here are excluded from `strays` (but listed in
	 * `allowlisted` for observability).  Defaults to `[]` — strict mode.
	 */
	allowlist?: ReadonlyArray<string | RegExp>;
}

/**
 * Detailed classification of every dirty file found in the working tree.
 *
 * - `modified`   — tracked files with staged or unstaged changes (XY codes
 *                  where the first or second column is not '?' or ' ').
 * - `untracked`  — new files not yet known to git (XY code `??`).
 * - `allowlisted`— files that matched the caller's allowlist (removed from
 *                  `strays`).
 * - `strays`     — the actionable set: dirty files that were NOT allowlisted.
 */
export interface StrayFileReport {
	strays: string[];
	modified: string[];
	untracked: string[];
	allowlisted: string[];
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown by `assertNoStrayFiles` when one or more stray files are present.
 *
 * ```ts
 * try {
 *   await assertNoStrayFiles(deps);
 * } catch (err) {
 *   if (err instanceof StrayFilesPresentError) {
 *     console.error('Strays:', err.strays);
 *   }
 * }
 * ```
 */
export class StrayFilesPresentError extends Error {
	readonly strays: string[];

	constructor(strays: string[]) {
		super(
			`Stray files detected in the working tree — merge blocked.\n` +
				`  Files: ${strays.join(', ')}\n` +
				`  Run \`git stash -u\` to recover, then retry.`
		);
		this.name = 'StrayFilesPresentError';
		this.strays = strays;
		// Maintain correct prototype chain across transpilation targets.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Parse a single `git status --porcelain` line and return the file path plus
 * whether the line represents an untracked file.
 *
 * Porcelain v1 format: `XY <path>` (3-char prefix then the path).
 * For renames the format is `XY <old> -> <new>`; we report the destination
 * path only (the "new" side), which is what will appear in the worktree.
 */
function parsePorcelainLine(line: string): { path: string; isUntracked: boolean } | null {
	if (line.length < 4) return null;

	const xy = line.slice(0, 2);
	const rest = line.slice(3); // skip "XY "

	const isUntracked = xy === '??';

	// Rename: "R  old -> new" or "old -> new" in rest
	const arrowIdx = rest.indexOf(' -> ');
	const filePath = arrowIdx !== -1 ? rest.slice(arrowIdx + 4) : rest;

	return { path: filePath.trim(), isUntracked };
}

/**
 * Test whether a file path is covered by at least one allowlist entry.
 */
function isAllowlisted(filePath: string, allowlist: ReadonlyArray<string | RegExp>): boolean {
	for (const entry of allowlist) {
		if (typeof entry === 'string') {
			if (entry === filePath) return true;
		} else {
			if (entry.test(filePath)) return true;
		}
	}
	return false;
}

/**
 * Run `git status --porcelain` and classify dirty files into the four buckets
 * described in `StrayFileReport`.
 *
 * @param deps - Injected dependencies (`runGit`, optional `allowlist`).
 * @returns A `StrayFileReport` — never throws under normal conditions.
 */
export async function detectStrayFiles(deps: StrayFileDetectorDeps): Promise<StrayFileReport> {
	const { runGit, allowlist = [] } = deps;

	const { stdout } = await runGit(['status', '--porcelain']);

	const modified: string[] = [];
	const untracked: string[] = [];
	const allowlisted: string[] = [];
	const strays: string[] = [];

	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trimEnd();
		if (!line) continue;

		const parsed = parsePorcelainLine(line);
		if (!parsed) continue;

		const { path: filePath, isUntracked } = parsed;

		if (isUntracked) {
			untracked.push(filePath);
		} else {
			modified.push(filePath);
		}

		if (isAllowlisted(filePath, allowlist)) {
			allowlisted.push(filePath);
		} else {
			strays.push(filePath);
		}
	}

	return { strays, modified, untracked, allowlisted };
}

/**
 * Convenience wrapper that throws `StrayFilesPresentError` when any strays are
 * found.  Use this at merge gates where contamination must hard-block progress.
 *
 * @param deps - Same deps as `detectStrayFiles`.
 * @throws {StrayFilesPresentError} if `report.strays.length > 0`.
 */
export async function assertNoStrayFiles(deps: StrayFileDetectorDeps): Promise<void> {
	const report = await detectStrayFiles(deps);
	if (report.strays.length > 0) {
		throw new StrayFilesPresentError(report.strays);
	}
}
