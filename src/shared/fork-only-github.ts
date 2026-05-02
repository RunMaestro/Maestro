/**
 * fork-only-github.ts
 *
 * Shared guard that centralises the fork's invariant: GitHub writes MUST only
 * target the configured fork repository, never the upstream or any other repo.
 *
 * Import this module from any sub-system (Delivery Planner, Living Wiki, …)
 * that makes GitHub API or `gh` CLI calls, and call `assertForkRepo` before
 * issuing any write operation.
 *
 * The fork repository is read from the settings store at runtime
 * (`deliveryPlannerGithub.owner` / `.repo`). When the settings store has not
 * been populated yet, `assertForkRepo`-style guards become no-ops and log a
 * warning instead of throwing — this prevents blocking installs that have not
 * run /PM-init yet.
 *
 * Legacy compile-time constants (`FORK_GITHUB_OWNER`, `FORK_GITHUB_REPO`,
 * `FORK_GITHUB_REPOSITORY`) are retained for callers that use them as string
 * references in doc-comments or example code; they now point to the
 * consolidated fallback values in `src/shared/legacy-humpftech-fallback.ts`.
 *
 * @see Cross-Major 006 – GitHub issue #165
 */

import {
	LEGACY_HUMPFTECH_OWNER,
	LEGACY_HUMPFTECH_REPO,
	LEGACY_HUMPFTECH_REPOSITORY,
} from './legacy-humpftech-fallback';

// ---------------------------------------------------------------------------
// ForkRepository interface
// ---------------------------------------------------------------------------

/**
 * Identifies a GitHub repository (owner + repo) that this fork is permitted
 * to write to.  At runtime this is read from the settings store
 * (`deliveryPlannerGithub.owner` / `.repo`).  When unset the guard becomes a
 * warning-only no-op to avoid breaking installs that haven't run /PM-init.
 */
export interface ForkRepository {
	owner: string;
	repo: string;
}

// ---------------------------------------------------------------------------
// Legacy constants (kept for backward compatibility — point to fallback)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use the `ForkRepository` interface populated from
 * `deliveryPlannerGithub` settings instead.  This constant refers to the
 * legacy HumpfTech/Maestro fallback value; it is retained only so that
 * existing `@example` blocks and cross-reference comments continue to compile.
 */
export const FORK_GITHUB_OWNER = LEGACY_HUMPFTECH_OWNER;

/**
 * @deprecated Use the `ForkRepository` interface populated from
 * `deliveryPlannerGithub` settings instead.
 */
export const FORK_GITHUB_REPO = LEGACY_HUMPFTECH_REPO;

/**
 * @deprecated Use the `ForkRepository` interface populated from
 * `deliveryPlannerGithub` settings instead.
 */
export const FORK_GITHUB_REPOSITORY = LEGACY_HUMPFTECH_REPOSITORY;

/** The upstream repo that must NEVER be targeted by this fork. */
export const UPSTREAM_GITHUB_REPOSITORY = 'RunMaestro/Maestro' as const;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when a GitHub operation attempts to target a repository other than
 * the configured fork repository.
 */
export class ForkOnlyViolationError extends Error {
	/** The owner that was passed to the guard. */
	readonly actualOwner: string;
	/** The repo that was passed to the guard. */
	readonly actualRepo: string;

	constructor(
		actualOwner: string,
		actualRepo: string,
		expectedRepository: string = FORK_GITHUB_REPOSITORY
	) {
		super(
			`Fork-only GitHub guard: writes must target ${expectedRepository}, ` +
				`but got "${actualOwner}/${actualRepo}". ` +
				`GitHub writes to ${UPSTREAM_GITHUB_REPOSITORY} or any other repository are not allowed from this fork.`
		);
		this.name = 'ForkOnlyViolationError';
		this.actualOwner = actualOwner;
		this.actualRepo = actualRepo;
	}
}

// ---------------------------------------------------------------------------
// Guard — static (legacy, uses compile-time fallback constants)
// ---------------------------------------------------------------------------

/**
 * Assert that `owner` and `repo` match the fork's canonical GitHub target.
 *
 * When the settings store is not available, prefer
 * {@link assertForkRepoWithConfig} which reads owner/repo at runtime instead.
 *
 * @throws {ForkOnlyViolationError} if the owner/repo pair does not match
 *   the configured fork repository.
 *
 * @example
 * ```ts
 * assertForkRepo('HumpfTech', 'Maestro'); // ok (matches legacy fallback)
 * assertForkRepo('RunMaestro', 'Maestro'); // throws ForkOnlyViolationError
 * ```
 */
export function assertForkRepo(owner: string, repo: string): void {
	if (owner === FORK_GITHUB_OWNER && repo === FORK_GITHUB_REPO) {
		return;
	}
	throw new ForkOnlyViolationError(owner, repo);
}

/**
 * Assert that the combined `owner/repo` slug matches the fork's canonical
 * GitHub target.  Convenience wrapper around {@link assertForkRepo} for callers
 * that already have the slug form (e.g. the `-R` flag value passed to `gh`).
 *
 * @throws {ForkOnlyViolationError} if the slug does not match the configured
 *   fork repository.
 */
export function assertForkRepository(repository: string): void {
	const parsed = parseRepoSlug(repository);
	assertForkRepo(parsed.owner, parsed.repo);
}

// ---------------------------------------------------------------------------
// Guard — config-driven (runtime, reads ForkRepository at call-site)
// ---------------------------------------------------------------------------

/**
 * Assert that `owner` and `repo` match the provided {@link ForkRepository}.
 *
 * When `forkRepo` is `null` (settings not populated yet) the check becomes a
 * no-op warning, allowing uninitialized installs to proceed without throwing.
 *
 * @param owner - GitHub owner of the target repository.
 * @param repo  - GitHub repository name.
 * @param forkRepo - The allowed fork coordinates from the settings store, or
 *   `null` if the user has not configured them yet.
 */
export function assertForkRepoWithConfig(
	owner: string,
	repo: string,
	forkRepo: ForkRepository | null
): void {
	if (forkRepo === null) {
		console.warn(
			`[fork-only-github] assertForkRepoWithConfig: fork repository not configured in ` +
				`settings (deliveryPlannerGithub). Skipping write guard for "${owner}/${repo}". ` +
				`Run /PM-init to persist proper mapping and enable the guard.`
		);
		return;
	}
	if (owner === forkRepo.owner && repo === forkRepo.repo) {
		return;
	}
	throw new ForkOnlyViolationError(owner, repo, `${forkRepo.owner}/${forkRepo.repo}`);
}

// ---------------------------------------------------------------------------
// Slug parser
// ---------------------------------------------------------------------------

/**
 * Parse an `owner/repo` string into its constituent parts.
 *
 * @throws {Error} if the string does not match the `owner/repo` pattern.
 *
 * @example
 * ```ts
 * parseRepoSlug('HumpfTech/Maestro'); // { owner: 'HumpfTech', repo: 'Maestro' }
 * parseRepoSlug('RunMaestro/Maestro'); // { owner: 'RunMaestro', repo: 'Maestro' }
 * ```
 */
export function parseRepoSlug(slug: string): { owner: string; repo: string } {
	const slashIndex = slug.indexOf('/');
	if (slashIndex <= 0 || slashIndex === slug.length - 1) {
		throw new Error(`Invalid repository slug "${slug}": expected "owner/repo" format`);
	}
	const owner = slug.slice(0, slashIndex);
	const repo = slug.slice(slashIndex + 1);
	// Reject slugs that contain additional slashes (e.g. "org/repo/extra")
	if (repo.includes('/')) {
		throw new Error(`Invalid repository slug "${slug}": expected "owner/repo" format`);
	}
	return { owner, repo };
}
