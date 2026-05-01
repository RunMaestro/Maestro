/**
 * fork-only-github.ts
 *
 * Shared guard that centralises the fork's invariant: GitHub writes MUST only
 * target HumpfTech/Maestro, never RunMaestro/Maestro or any other repository.
 *
 * Import this module from any sub-system (Delivery Planner, Living Wiki, …)
 * that makes GitHub API or `gh` CLI calls, and call `assertForkRepo` before
 * issuing any write operation.
 *
 * @see Cross-Major 006 – GitHub issue #165
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The only GitHub owner that this fork is allowed to write to. */
export const FORK_GITHUB_OWNER = 'HumpfTech' as const;

/** The only GitHub repo that this fork is allowed to write to. */
export const FORK_GITHUB_REPO = 'Maestro' as const;

/** Convenience `owner/repo` slug. */
export const FORK_GITHUB_REPOSITORY = `${FORK_GITHUB_OWNER}/${FORK_GITHUB_REPO}` as const;

/** The upstream repo that must NEVER be targeted by this fork. */
export const UPSTREAM_GITHUB_REPOSITORY = 'RunMaestro/Maestro' as const;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when a GitHub operation attempts to target a repository other than
 * `HumpfTech/Maestro`.
 */
export class ForkOnlyViolationError extends Error {
	/** The owner that was passed to the guard. */
	readonly actualOwner: string;
	/** The repo that was passed to the guard. */
	readonly actualRepo: string;

	constructor(actualOwner: string, actualRepo: string) {
		super(
			`Fork-only GitHub guard: writes must target ${FORK_GITHUB_REPOSITORY}, ` +
				`but got "${actualOwner}/${actualRepo}". ` +
				`GitHub writes to ${UPSTREAM_GITHUB_REPOSITORY} or any other repository are not allowed from this fork.`
		);
		this.name = 'ForkOnlyViolationError';
		this.actualOwner = actualOwner;
		this.actualRepo = actualRepo;
	}
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * Assert that `owner` and `repo` match the fork's canonical GitHub target.
 *
 * @throws {ForkOnlyViolationError} if the owner/repo pair is not
 *   `HumpfTech/Maestro`.
 *
 * @example
 * ```ts
 * assertForkRepo('HumpfTech', 'Maestro'); // ok
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
 * @throws {ForkOnlyViolationError} if the slug is not `HumpfTech/Maestro`.
 */
export function assertForkRepository(repository: string): void {
	const parsed = parseRepoSlug(repository);
	assertForkRepo(parsed.owner, parsed.repo);
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
