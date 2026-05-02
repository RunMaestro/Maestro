import type { WorkItemGithubReference } from '../../shared/work-graph-types';
import type { SettingsStoreInterface } from '../stores/types';

// ---------------------------------------------------------------------------
// Config interface + lookup
// ---------------------------------------------------------------------------

export interface DeliveryPlannerGithubConfig {
	owner: string;
	repo: string;
	/** Optional upstream slug (e.g. 'RunMaestro/Maestro') to guard against
	 *  accidental writes.  When unset the upstream safety check is skipped. */
	upstream?: string;
}

/**
 * Read the Delivery Planner GitHub config from the settings store.
 *
 * Returns `null` when the user hasn't configured `deliveryPlannerGithub` yet
 * (both `owner` and `repo` are required).  Callers that receive `null` should
 * log a warning and skip safety assertions rather than crashing — this is an
 * opt-in guard, not a hard requirement for all installations.
 */
export function getDeliveryPlannerGithubConfig(
	settingsStore: SettingsStoreInterface
): DeliveryPlannerGithubConfig | null {
	const raw = settingsStore.get<{
		owner?: string;
		repo?: string;
		upstream?: { owner: string; repo: string };
	} | null>('deliveryPlannerGithub', null);
	if (!raw?.owner || !raw?.repo) {
		return null;
	}
	const upstreamSlug =
		raw.upstream?.owner && raw.upstream?.repo
			? `${raw.upstream.owner}/${raw.upstream.repo}`
			: undefined;
	return { owner: raw.owner, repo: raw.repo, upstream: upstreamSlug };
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class DeliveryPlannerGithubSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeliveryPlannerGithubSafetyError';
	}
}

// ---------------------------------------------------------------------------
// Config-driven assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that `repository` is allowed by the given config.
 *
 * - Rejects writes to `config.upstream` (if set).
 * - Rejects writes to any repository other than `owner/repo`.
 */
export function assertDeliveryPlannerGithubRepositoryWithConfig(
	repository: string,
	config: DeliveryPlannerGithubConfig
): void {
	if (config.upstream && repository === config.upstream) {
		throw new DeliveryPlannerGithubSafetyError(
			`Delivery Planner GitHub sync cannot target upstream ${config.upstream}`
		);
	}

	const expected = `${config.owner}/${config.repo}`;
	if (repository !== expected) {
		throw new DeliveryPlannerGithubSafetyError(
			`Delivery Planner GitHub sync must target ${expected}`
		);
	}
}

/**
 * Config-driven variant of `assertDeliveryPlannerGithubReference`.
 *
 * When `config` is `null` (not yet configured) the check is skipped — the
 * safety guard is opt-in for upstream shipping.
 */
export function assertDeliveryPlannerGithubReferenceWithConfig(
	reference: WorkItemGithubReference | undefined,
	config: DeliveryPlannerGithubConfig | null
): void {
	if (!reference || !config) {
		return;
	}

	assertDeliveryPlannerGithubRepositoryWithConfig(reference.repository, config);
	const expected = `${config.owner}/${config.repo}`;
	if (reference.owner !== config.owner || reference.repo !== config.repo) {
		throw new DeliveryPlannerGithubSafetyError(
			`Delivery Planner GitHub references must use ${expected}`
		);
	}
}

/**
 * Build a `WorkItemGithubReference` skeleton from the given config.
 */
export function makeDeliveryPlannerGithubReferenceWithConfig(
	config: DeliveryPlannerGithubConfig,
	input: {
		issueNumber?: number;
		pullRequestNumber?: number;
		url?: string;
		branch?: string;
		commitSha?: string;
	}
): WorkItemGithubReference {
	return {
		owner: config.owner,
		repo: config.repo,
		repository: `${config.owner}/${config.repo}`,
		...input,
	};
}

// ---------------------------------------------------------------------------
// Legacy zero-argument exports — kept for github-sync.ts (in-flight refactor,
// PR #447).  These are no-ops / identity functions so existing callers compile
// and run safely without crashing.  They will be removed once #447 lands.
// ---------------------------------------------------------------------------

/** @deprecated Use `getDeliveryPlannerGithubConfig` + config-driven helpers instead. */
export function assertDeliveryPlannerGithubRepository(_repository: string): void {
	// No-op: hardcoded owner/repo assertion removed. Migrate to
	// `assertDeliveryPlannerGithubRepositoryWithConfig` once #447 lands.
}

/** @deprecated Use `assertDeliveryPlannerGithubReferenceWithConfig` instead. */
export function assertDeliveryPlannerGithubReference(
	_reference: WorkItemGithubReference | undefined
): void {
	// No-op: hardcoded owner/repo assertion removed. Migrate to
	// `assertDeliveryPlannerGithubReferenceWithConfig` once #447 lands.
}

/** @deprecated Use `makeDeliveryPlannerGithubReferenceWithConfig` instead. */
export function makeDeliveryPlannerGithubReference(input: {
	issueNumber?: number;
	pullRequestNumber?: number;
	url?: string;
	branch?: string;
	commitSha?: string;
}): WorkItemGithubReference {
	// Returns a reference with placeholder values. github-sync.ts (PR #447)
	// will be updated to pass real config-driven coordinates.
	return {
		owner: '',
		repo: '',
		repository: '',
		...input,
	};
}

/** @deprecated Constant retained only for github-sync.ts; use config instead. */
export const DELIVERY_PLANNER_GITHUB_REPOSITORY = '' as string;
