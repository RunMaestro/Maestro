/**
 * fork-only-guard.ts
 *
 * Planning-pipeline-specific wrapper around the shared `fork-only-github`
 * guard.  Any pipeline operation that is about to push, open a PR, or
 * comment on a remote MUST call `assertForkOnlyOperation` before proceeding.
 *
 * ## Two calling conventions
 *
 * 1. **Slug form** — caller already has an `owner/repo` string (e.g. from a
 *    config value or a GitHub API response):
 *    ```ts
 *    assertForkOnlyOperation({ repo: 'HumpfTech/Maestro' });
 *    ```
 *
 * 2. **gh-args form** — caller is about to invoke the `gh` CLI and can pass
 *    the raw args array.  The guard scans for the `-R` / `--repo` flag and
 *    validates its value.  If the flag is absent the guard throws because
 *    we cannot prove the invocation targets the fork:
 *    ```ts
 *    assertForkOnlyOperation({ ghArgs: ['pr', 'create', '-R', 'HumpfTech/Maestro', ...] });
 *    ```
 *
 * ## Allowlist convention in audit script
 *
 * Source lines that contain `// fork-only-audit:allow` are excluded from the
 * static `gh` invocation audit (see `scripts/audit-gh-fork-only.mjs`).  That
 * annotation DOES NOT bypass this runtime guard — both checks are independent.
 *
 * @see src/shared/fork-only-github.ts  — canonical constants + error class
 * @see scripts/audit-gh-fork-only.mjs — static `gh` invocation scanner
 * @see GitHub issue #255
 */

import {
	assertForkRepository,
	ForkOnlyViolationError,
	FORK_GITHUB_REPOSITORY,
} from '../../../shared/fork-only-github';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Arguments for `assertForkOnlyOperation`.
 *
 * At least one of `repo` or `ghArgs` MUST be provided; passing neither is a
 * programming error and will throw.
 */
export interface ForkOnlyGuardArgs {
	/**
	 * An `owner/repo` slug to validate directly.
	 * If provided, the slug is passed to `assertForkRepository`.
	 */
	repo?: string;
	/**
	 * The raw argument array that will be passed to the `gh` CLI binary.
	 * The guard scans for the `-R` / `--repo` flag and validates its value.
	 * A missing flag is treated as a violation because the target repo cannot
	 * be determined statically without it.
	 */
	ghArgs?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Guard implementation
// ---------------------------------------------------------------------------

/**
 * Assert that the planned operation targets `HumpfTech/Maestro`.
 *
 * Accepts two forms — see module docblock for examples.
 *
 * @throws {ForkOnlyViolationError} if the repo slug is not
 *   `HumpfTech/Maestro`, if `ghArgs` lacks `-R` / `--repo`, or if the flag
 *   value is not the fork.
 * @throws {Error} if neither `repo` nor `ghArgs` is provided (programming
 *   error — caller must specify at least one).
 */
export function assertForkOnlyOperation(args: ForkOnlyGuardArgs): void {
	const { repo, ghArgs } = args;

	if (repo === undefined && ghArgs === undefined) {
		throw new Error(
			'assertForkOnlyOperation: caller must supply at least one of `repo` or `ghArgs`'
		);
	}

	// Validate the explicit repo slug when provided.
	if (repo !== undefined) {
		assertForkRepository(repo);
	}

	// Validate the gh CLI args when provided.
	if (ghArgs !== undefined) {
		validateGhArgs(ghArgs);
	}
}

/**
 * Scan a `gh` CLI argument array for a `-R` / `--repo` flag and validate the
 * target repository.
 *
 * @throws {ForkOnlyViolationError} if the flag is absent, has no value, or
 *   its value is not `HumpfTech/Maestro`.
 */
function validateGhArgs(ghArgs: ReadonlyArray<string>): void {
	const repoFlagIndex = ghArgs.findIndex((arg) => arg === '-R' || arg === '--repo');

	if (repoFlagIndex === -1 || ghArgs[repoFlagIndex + 1] === undefined) {
		// No -R flag (or flag without a subsequent value) — cannot prove the
		// invocation targets the fork, so reject loudly.
		const err = new ForkOnlyViolationError('(missing)', '(missing)');
		// Override with a more actionable message.
		Object.defineProperty(err, 'message', {
			value:
				`gh invocation missing -R ${FORK_GITHUB_REPOSITORY}: cannot prove fork-only target. ` +
				`Add -R ${FORK_GITHUB_REPOSITORY} to every gh write invocation, or annotate ` +
				`with // fork-only-audit:allow if the line is intentionally un-guarded.`,
			writable: true,
			configurable: true,
		});
		throw err;
	}

	// The flag is present — validate its value.
	assertForkRepository(ghArgs[repoFlagIndex + 1]);
}

// ---------------------------------------------------------------------------
// Non-throwing boolean wrapper
// ---------------------------------------------------------------------------

/**
 * Non-throwing convenience wrapper around `assertForkOnlyOperation`.
 *
 * Returns `true` only when the operation passes all fork-only checks.
 * Returns `false` for any violation or programming error.
 *
 * Prefer `assertForkOnlyOperation` at actual guard call sites so violations
 * are never silently swallowed.  Use this function only for conditional logic
 * (e.g. feature-flag checks, dashboard status indicators).
 */
export function isForkOnlyOperation(args: ForkOnlyGuardArgs): boolean {
	try {
		assertForkOnlyOperation(args);
		return true;
	} catch {
		return false;
	}
}
