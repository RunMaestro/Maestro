/**
 * fork-only-guard.ts
 *
 * Planning-pipeline-specific guard that prevents pipeline operations (push,
 * PR creation, comments) from accidentally targeting a protected upstream
 * repository.
 *
 * The protected upstream is user-configurable via the `deliveryPlannerGithub`
 * key in the settings store (`upstream` field).  When no upstream is
 * configured the guard becomes a no-op — the protection is opt-in, not
 * hard-wired to any specific organization.
 *
 * ## Two calling conventions
 *
 * 1. **Slug form** — caller already has an `owner/repo` string (e.g. from a
 *    config value or a GitHub API response):
 *    ```ts
 *    assertForkOnlyOperation({ repo: 'your-org/your-repo' }, settingsStore);
 *    ```
 *
 * 2. **gh-args form** — caller is about to invoke the `gh` CLI and can pass
 *    the raw args array.  The guard scans for the `-R` / `--repo` flag and
 *    validates its value.  If the flag is absent and an upstream is configured,
 *    the guard throws because we cannot prove the invocation targets the fork:
 *    ```ts
 *    assertForkOnlyOperation({ ghArgs: ['pr', 'create', '-R', 'your-org/your-repo', ...] }, settingsStore);
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

import { ForkOnlyViolationError } from '../../../shared/fork-only-github';
import type { SettingsStoreInterface } from '../../stores/types';

// ---------------------------------------------------------------------------
// Config lookup
// ---------------------------------------------------------------------------

/**
 * Returns the user-configured protected upstream slug (e.g. `'RunMaestro/Maestro'`),
 * or `null` when the user has not set one.
 *
 * When `null` is returned the fork-only guard becomes a no-op: there is no
 * upstream to protect against.
 */
export function getProtectedUpstreamRepo(settingsStore: SettingsStoreInterface): string | null {
	const raw = settingsStore.get<{ upstream?: { owner: string; repo: string } } | null>(
		'deliveryPlannerGithub',
		null
	);
	if (!raw?.upstream?.owner || !raw?.upstream?.repo) {
		return null;
	}
	return `${raw.upstream.owner}/${raw.upstream.repo}`;
}

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
	 * If provided, and an upstream is configured, the slug must not equal the
	 * protected upstream repository.
	 */
	repo?: string;
	/**
	 * The raw argument array that will be passed to the `gh` CLI binary.
	 * The guard scans for the `-R` / `--repo` flag and validates its value.
	 * A missing flag is treated as a violation when an upstream is configured,
	 * because the target repo cannot be determined statically without it.
	 */
	ghArgs?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Guard implementation
// ---------------------------------------------------------------------------

/**
 * Assert that the planned operation does not target the configured protected
 * upstream repository.
 *
 * When no upstream is configured in the settings store (`deliveryPlannerGithub.upstream`)
 * the function returns immediately without performing any check — the guard is
 * opt-in for installations that want to prevent accidental upstream writes.
 *
 * Accepts two forms — see module docblock for examples.
 *
 * @throws {ForkOnlyViolationError} if the repo slug matches the protected
 *   upstream, if `ghArgs` lacks `-R` / `--repo` when an upstream is configured,
 *   or if the flag value matches the protected upstream.
 * @throws {Error} if neither `repo` nor `ghArgs` is provided (programming
 *   error — caller must specify at least one).
 */
export function assertForkOnlyOperation(
	args: ForkOnlyGuardArgs,
	settingsStore: SettingsStoreInterface
): void {
	const { repo, ghArgs } = args;

	if (repo === undefined && ghArgs === undefined) {
		throw new Error(
			'assertForkOnlyOperation: caller must supply at least one of `repo` or `ghArgs`'
		);
	}

	const protectedUpstream = getProtectedUpstreamRepo(settingsStore);

	// No upstream configured → guard is a no-op for this installation.
	if (!protectedUpstream) {
		return;
	}

	// Validate the explicit repo slug when provided.
	if (repo !== undefined) {
		assertNotProtectedUpstream(repo, protectedUpstream);
	}

	// Validate the gh CLI args when provided.
	if (ghArgs !== undefined) {
		validateGhArgs(ghArgs, protectedUpstream);
	}
}

/**
 * Scan a `gh` CLI argument array for a `-R` / `--repo` flag and validate the
 * target repository against the protected upstream.
 *
 * @throws {ForkOnlyViolationError} if the flag is absent, has no value, or
 *   its value matches the protected upstream.
 */
function validateGhArgs(ghArgs: ReadonlyArray<string>, protectedUpstream: string): void {
	const repoFlagIndex = ghArgs.findIndex((arg) => arg === '-R' || arg === '--repo');

	if (repoFlagIndex === -1 || ghArgs[repoFlagIndex + 1] === undefined) {
		// No -R flag (or flag without a subsequent value) — cannot prove the
		// invocation does not target the protected upstream, so reject loudly.
		const err = new ForkOnlyViolationError('(missing)', '(missing)');
		Object.defineProperty(err, 'message', {
			value:
				`gh invocation missing -R <repo>: cannot verify the target is not protected upstream ` +
				`${protectedUpstream}. Add -R <repo> to every gh write invocation, or annotate ` +
				`with // fork-only-audit:allow if the line is intentionally un-guarded.`,
			writable: true,
			configurable: true,
		});
		throw err;
	}

	// The flag is present — validate its value.
	assertNotProtectedUpstream(ghArgs[repoFlagIndex + 1], protectedUpstream);
}

/**
 * Assert that `repository` is not the protected upstream slug.
 *
 * @throws {ForkOnlyViolationError} if they match.
 */
function assertNotProtectedUpstream(repository: string, protectedUpstream: string): void {
	if (repository === protectedUpstream) {
		const slashIndex = repository.indexOf('/');
		const owner = slashIndex > 0 ? repository.slice(0, slashIndex) : repository;
		const repo = slashIndex > 0 ? repository.slice(slashIndex + 1) : '';
		throw new ForkOnlyViolationError(owner, repo);
	}
}

// ---------------------------------------------------------------------------
// Non-throwing boolean wrapper
// ---------------------------------------------------------------------------

/**
 * Non-throwing convenience wrapper around `assertForkOnlyOperation`.
 *
 * Returns `true` only when the operation passes all fork-only checks (or when
 * no upstream is configured, in which case all operations are permitted).
 * Returns `false` for any violation or programming error.
 *
 * Prefer `assertForkOnlyOperation` at actual guard call sites so violations
 * are never silently swallowed.  Use this function only for conditional logic
 * (e.g. feature-flag checks, dashboard status indicators).
 */
export function isForkOnlyOperation(
	args: ForkOnlyGuardArgs,
	settingsStore: SettingsStoreInterface
): boolean {
	try {
		assertForkOnlyOperation(args, settingsStore);
		return true;
	} catch {
		return false;
	}
}
