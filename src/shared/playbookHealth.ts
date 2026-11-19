/**
 * Playbook health: the popularity and reliability figures the Playbook
 * Exchange server aggregates from opt-in playbook telemetry, keyed by the
 * public playbook id, and the rules that turn them into badges and a sort.
 *
 * Node-free so the main process (fetch and cache), the renderer (badges,
 * sort, the run summary row), and the CLI (`marketplace list --sort popular`)
 * read one definition. The endpoint is optional: every consumer treats an
 * empty map as "no figures yet" and shows nothing extra.
 */

/** Where the Exchange server publishes the aggregate figures. */
export const PLAYBOOK_HEALTH_URL = 'https://runmaestro.ai/api/v1/playbooks/health';

/**
 * One playbook's figures over the last 30 days, in the server's wire names.
 * The two medians are optional: a playbook with no completed runs has none.
 */
export interface PlaybookHealthStats {
	installs_30d: number;
	runs_30d: number;
	/** Completed runs over finished runs, 0 to 1. */
	success_rate_30d: number;
	median_duration_ms?: number;
	median_cost_usd?: number;
	/** Failed runs in the most recent window the server reports. */
	recent_failures: number;
}

/** Figures by playbook id. Ids absent from the map have no figures. */
export type PlaybookHealthMap = Record<string, PlaybookHealthStats>;

/** What `marketplace:getHealth` returns (a type alias so IPC handlers accept it). */
export type GetPlaybookHealthResponse = {
	health: PlaybookHealthMap;
	fromCache: boolean;
};

/** On-disk cache of the last answer (`userData/marketplace-health-cache.json`). */
export interface PlaybookHealthCache {
	fetchedAt: number;
	health: PlaybookHealthMap;
}

/** How many playbooks can carry "Most popular" at once. */
export const MOST_POPULAR_LIMIT = 3;
/** Installs a playbook needs before it can be called popular at all. */
export const MOST_POPULAR_MIN_INSTALLS = 10;
/** Recent failures before "Recently broken" is considered. */
export const RECENTLY_BROKEN_MIN_FAILURES = 3;
/** ...and the success rate it must also fall below, so a busy playbook with a few failures is not flagged. */
export const RECENTLY_BROKEN_MAX_SUCCESS_RATE = 0.75;

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate the server's answer. Malformed entries are dropped one by one (a
 * bad row never hides the good ones), counts must be finite and non-negative,
 * and the success rate is clamped to 0..1. Anything that is not an object
 * yields an empty map.
 */
export function parsePlaybookHealth(raw: unknown): PlaybookHealthMap {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const health: PlaybookHealthMap = {};
	for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (!id || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const e = entry as Record<string, unknown>;
		if (
			!isCount(e.installs_30d) ||
			!isCount(e.runs_30d) ||
			!isCount(e.recent_failures) ||
			typeof e.success_rate_30d !== 'number' ||
			!Number.isFinite(e.success_rate_30d)
		) {
			continue;
		}
		const stats: PlaybookHealthStats = {
			installs_30d: e.installs_30d,
			runs_30d: e.runs_30d,
			success_rate_30d: Math.min(1, Math.max(0, e.success_rate_30d)),
			recent_failures: e.recent_failures,
		};
		if (isCount(e.median_duration_ms)) stats.median_duration_ms = e.median_duration_ms;
		if (isCount(e.median_cost_usd)) stats.median_cost_usd = e.median_cost_usd;
		health[id] = stats;
	}
	return health;
}

/** Popularity order: installs, then runs. */
function comparePopularity(a: PlaybookHealthStats, b: PlaybookHealthStats): number {
	return b.installs_30d - a.installs_30d || b.runs_30d - a.runs_30d;
}

/**
 * The ids that earn "Most popular": the top `MOST_POPULAR_LIMIT` of the given
 * playbooks by installs (runs break ties), each with at least
 * `MOST_POPULAR_MIN_INSTALLS`. Only ids in `playbookIds` compete, so a
 * playbook the manifest dropped cannot hold a slot.
 */
export function selectMostPopularPlaybookIds(
	health: PlaybookHealthMap,
	playbookIds: readonly string[]
): Set<string> {
	const ranked = [...new Set(playbookIds)]
		.filter((id) => (health[id]?.installs_30d ?? 0) >= MOST_POPULAR_MIN_INSTALLS)
		.sort((a, b) => comparePopularity(health[a], health[b]));
	return new Set(ranked.slice(0, MOST_POPULAR_LIMIT));
}

/** "Recently broken": enough recent failures AND a poor success rate. */
export function isPlaybookRecentlyBroken(stats: PlaybookHealthStats | undefined): boolean {
	return (
		!!stats &&
		stats.recent_failures >= RECENTLY_BROKEN_MIN_FAILURES &&
		stats.success_rate_30d < RECENTLY_BROKEN_MAX_SUCCESS_RATE
	);
}

/** How the Exchange orders its playbooks. `default` is the manifest's order. */
export type PlaybookBrowseSort = 'default' | 'popular';

export const PLAYBOOK_BROWSE_SORTS: readonly PlaybookBrowseSort[] = ['default', 'popular'];

export function isPlaybookBrowseSort(value: unknown): value is PlaybookBrowseSort {
	return (PLAYBOOK_BROWSE_SORTS as readonly unknown[]).includes(value);
}

/**
 * Order playbooks for the browse grid (or `marketplace list`). `popular` puts
 * playbooks with figures first by installs then runs, and keeps the rest in
 * manifest order after them; the sort is stable. `default` returns the input.
 */
export function sortPlaybooksByHealth<T extends { id: string }>(
	playbooks: readonly T[],
	sort: PlaybookBrowseSort,
	health: PlaybookHealthMap
): T[] {
	if (sort !== 'popular') return [...playbooks];
	return playbooks
		.map((playbook, index) => ({ playbook, index, stats: health[playbook.id] }))
		.sort((a, b) => {
			if (a.stats && b.stats) return comparePopularity(a.stats, b.stats) || a.index - b.index;
			if (a.stats) return -1;
			if (b.stats) return 1;
			return a.index - b.index;
		})
		.map(({ playbook }) => playbook);
}

/** True when the map holds figures for at least one of the given playbooks. */
export function hasPlaybookHealth(
	health: PlaybookHealthMap,
	playbookIds: readonly string[]
): boolean {
	return playbookIds.some((id) => id in health);
}
