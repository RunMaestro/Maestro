/**
 * GitHub poller provider for Maestro Cue github.pull_request, github.issue,
 * and github.label subscriptions.
 *
 * Polls GitHub CLI (`gh`) for new PRs/issues (and for label-add events), tracks
 * "seen" state in SQLite, and fires CueEvents for new items. Follows the same
 * factory pattern as cue-file-watcher.ts.
 */

import { execFile as cpExecFile } from 'child_process';
import type { CueEvent } from './cue-types';
import { isFinalEmitOutcome, type CueEmitOutcome } from './triggers/cue-guarded-emit';
import {
	isCueDbReady,
	markGitHubItemSeen,
	hasAnyGitHubSeen,
	pruneGitHubSeen,
	pruneSusFactorBlocks,
	getGitHubItemState,
	recordGitHubRetrigger,
	setGitHubItemRevision,
} from './cue-db';
import type { CueGitHubLabelTarget } from '../../shared/cue';
import { resolveGhPath, getExpandedEnv } from '../utils/cliDetection';
import { ghErrorHaystack, isGitHubAuthError } from '../utils/ghErrors';
import { buildGhEnv, redactGhTokens } from './cue-gh-token';

// Re-exported: the auth predicate moved to utils/ghErrors so Send Feedback can
// share it, and existing importers still reach it here.
export { isGitHubAuthError };
import { captureException } from '../utils/sentry';
import type { CueLogPayload } from '../../shared/cue-log-types';
import {
	buildGitHubItemEvent,
	buildGitHubLabelEvent,
	decideGitHubItem,
	DEFAULT_MAX_NOTIFICATIONS,
	githubItemKey,
	isNewerRevision,
	labelEventMatchesFilters,
	claimLabelEventFiredByOtherSource,
	claimLabelEventInFlightForOtherSource,
	labelEventHandledBySource,
	reserveGitHubChange,
	reserveLabelEvent,
	type GitHubChangeReservation,
	type GitHubComment,
	type GitHubItemEventType,
	type GitHubItemSnapshot,
	type GitHubLabelEventSnapshot,
	type GitHubLabelFilters,
} from './cue-github-items';

export type { GitHubComment } from './cue-github-items';

export { DEFAULT_MAX_NOTIFICATIONS } from './cue-github-items';

/**
 * Sentinel value for `max_notifications` meaning "no cap". Chosen over `null`
 * so the field stays a single numeric type for schema validation. The poller
 * treats `0` and any negative value as unlimited.
 */
const UNLIMITED_NOTIFICATIONS = 0;

/**
 * `item_key` of the single row a `github.label` subscription keeps in
 * `cue_github_seen`. Its `last_revision` holds the highest GitHub issue-event
 * id already processed; everything newer fires. A watermark beats per-item
 * label-set diffing here because the events feed reports the label add itself
 * (with its actor and timestamp), so a label removed and re-added is two
 * distinct events instead of one indistinguishable set difference.
 */
const LABEL_WATERMARK_KEY = '__label_watermark__';

/**
 * Pages of 100 issue events fetched per poll. The feed is repo-wide and
 * newest-first, and it carries every issue event (subscribed, mentioned,
 * renamed, ...), not just label changes, so a busy repo can bury a label add
 * quickly. Three pages covers ~300 events between polls; past that the poller
 * warns rather than silently skipping.
 */
const MAX_LABEL_EVENT_PAGES = 3;

/** Per-page size for the issue-events feed. GitHub's maximum. */
const LABEL_EVENT_PAGE_SIZE = 100;

/** Raw label event projected out of `repos/{repo}/issues/events` by `--jq`. */
interface RawLabelEvent {
	id: number;
	created_at: string;
	label: string;
	actor: string;
	number: number;
	title: string;
	url: string;
	body: string;
	state: string;
	labels: string[];
	is_pr: boolean;
	merged: boolean;
	author: string;
	item_created_at: string;
	item_updated_at: string;
}

/** Raw shape of a comment returned by `gh pr view --json comments`. */
interface RawGitHubComment {
	author?: { login?: string };
	body?: string;
	createdAt?: string;
	url?: string;
}

/** Normalize one item from `gh pr list` / `gh issue list` JSON. */
function snapshotFromGh(item: any): GitHubItemSnapshot {
	return {
		number: item.number,
		title: item.title,
		author: item.author?.login ?? 'unknown',
		url: item.url,
		body: item.body ?? '',
		state: item.state?.toLowerCase() ?? 'open',
		labels: (item.labels ?? []).map((l: { name: string }) => l.name),
		createdAt: item.createdAt ?? '',
		updatedAt: item.updatedAt ?? '',
		isDraft: item.isDraft ?? false,
		headRef: item.headRefName ?? '',
		baseRef: item.baseRefName ?? '',
		mergedAt: item.mergedAt ?? '',
		assignees: (item.assignees ?? []).map((a: { login: string }) => a.login),
	};
}

/** Normalize one label add from the issue-events feed. */
function labelSnapshotFromFeed(ev: RawLabelEvent): GitHubLabelEventSnapshot {
	return {
		label: ev.label,
		actor: ev.actor,
		labeledAt: ev.created_at,
		number: ev.number,
		title: ev.title,
		url: ev.url,
		body: ev.body ?? '',
		state: ev.state ?? 'open',
		labels: ev.labels ?? [],
		isPr: ev.is_pr,
		merged: ev.merged,
		author: ev.author,
		itemCreatedAt: ev.item_created_at ?? '',
		itemUpdatedAt: ev.item_updated_at ?? '',
	};
}

/**
 * Render a comment list into the `{{CUE_NEW_COMMENTS}}` template variable.
 * Returns an empty string when there are no new comments so the prompt
 * substitution leaves a clean gap rather than emitting "no comments" filler.
 * Exported for the template context builder.
 */
export function formatNewCommentsForTemplate(comments: GitHubComment[]): string {
	if (comments.length === 0) return '';
	return comments.map((c) => `[@${c.author} at ${c.createdAt}]\n${c.body}`).join('\n\n---\n\n');
}

/** Max backoff for GitHub rate-limit recovery. One hour is the standard
 * window for primary rate limits on personal tokens; secondary limits expire
 * sooner but we don't get reliable signals to distinguish them. */
export const GITHUB_RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Heuristic rate-limit detector for `gh` CLI failures. GitHub surfaces rate
 * limits in stderr text rather than a structured error code, so we pattern
 * match the user-visible strings. Exported for tests.
 */
export function isGitHubRateLimitError(err: unknown): boolean {
	const haystack = ghErrorHaystack(err);
	return (
		haystack.includes('api rate limit exceeded') ||
		haystack.includes('secondary rate limit') ||
		haystack.includes('rate limit has been reached') ||
		/\bhttp\s+(403|429)\b/.test(haystack)
	);
}

/**
 * Detect connectivity failures from the GitHub CLI. These are operational
 * conditions (offline/VPN/DNS/GitHub unreachable), not app crashes.
 *
 * A 5xx from api.github.com counts: `HTTP 504: 504 Gateway Timeout` and friends
 * mean GitHub itself is degraded, which is the same "can't reach the API right
 * now" condition as a dropped socket. The poller retries on its own schedule, so
 * paging Sentry on every tick of a GitHub outage is pure noise (MAESTRO-KE).
 */
export function isGitHubConnectivityError(err: unknown): boolean {
	const haystack = ghErrorHaystack(err);
	return (
		haystack.includes('error connecting to api.github.com') ||
		haystack.includes('check your internet connection') ||
		haystack.includes('enotfound api.github.com') ||
		haystack.includes('econnreset') ||
		haystack.includes('etimedout') ||
		haystack.includes('network is unreachable') ||
		haystack.includes('could not resolve host: api.github.com') ||
		// `gh` is a Go binary, so a transport-level failure surfaces with Go's
		// wording rather than a libuv errno: `Post "https://api.github.com/graphql":
		// net/http: TLS handshake timeout`. Same unreachable-right-now condition as
		// the ECONNRESET/ETIMEDOUT spellings above, different vocabulary.
		haystack.includes('tls handshake timeout') ||
		haystack.includes('i/o timeout') ||
		haystack.includes('no such host') ||
		/\bhttp\s+5\d{2}\b/.test(haystack)
	);
}

/** Expanded env so packaged Electron can find gh in /opt/homebrew/bin, /usr/local/bin, etc. */
const ghEnv = getExpandedEnv();

/**
 * Run gh with the GitHub token from a secret file or the environment
 * (`buildGhEnv`), resolved per call so a rotated file is picked up. A failure
 * is rethrown with every token value scrubbed from its message and output, so
 * nothing downstream (logs, Sentry, the Cue database) can carry one.
 * `onTokenProblems` receives the unusable token files, by name and path.
 */
function execFileAsync(
	cmd: string,
	args: string[],
	opts?: { cwd?: string; timeout?: number },
	onTokenProblems?: (problems: string[]) => void
): Promise<{ stdout: string; stderr: string }> {
	const { env, tokens, problems } = buildGhEnv(ghEnv);
	onTokenProblems?.(problems);
	return new Promise((resolve, reject) => {
		cpExecFile(cmd, args, { ...opts, env }, (error, stdout, stderr) => {
			if (error) {
				reject(scrubGhError(error, tokens));
			} else {
				resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
			}
		});
	});
}

function scrubGhError(error: Error, tokens: string[]): Error {
	if (tokens.length === 0) return error;
	const fields = error as Error & { stdout?: unknown; stderr?: unknown; cmd?: unknown };
	error.message = redactGhTokens(error.message, tokens);
	if (error.stack) error.stack = redactGhTokens(error.stack, tokens);
	for (const key of ['stdout', 'stderr', 'cmd'] as const) {
		const value = fields[key];
		if (value !== undefined && value !== null) fields[key] = redactGhTokens(String(value), tokens);
	}
	return error;
}

export interface CueGitHubPollerConfig {
	eventType: 'github.pull_request' | 'github.issue' | 'github.label';
	repo?: string;
	pollMinutes: number;
	projectRoot: string;
	/**
	 * Hand an event on, and report how it ended by calling `onOutcome` exactly
	 * once (possibly later, after SusFactor). The poller writes its
	 * `cue_github_seen` record only on a final outcome, so an item whose event
	 * never reached the run manager is found again by the next poll.
	 */
	onEvent: (event: CueEvent, onOutcome: (outcome: CueEmitOutcome) => void) => void;
	onLog: (level: string, message: string, data?: unknown) => void;
	triggerName: string;
	subscriptionId: string;
	/** GitHub state filter: "open" (default), "closed", "merged" (PRs only), or "all" */
	ghState?: string;
	/**
	 * `github.label` only: which kind of item to watch. Defaults to `'both'`.
	 * The issue-events feed covers PRs and issues in one call, so this is a
	 * client-side narrowing rather than a different query.
	 */
	labelTarget?: CueGitHubLabelTarget;
	/**
	 * `github.label` only: labels that fire this subscription, matched
	 * case-insensitively against the label just added. Empty / omitted fires
	 * on ANY label add.
	 */
	watchLabels?: string[];
	/**
	 * When true, the poller re-fires this subscription on any post-discovery
	 * activity (comments, edits, reviews, label changes) detected via the
	 * item's `updatedAt` field. The re-fire payload includes the comments
	 * posted since the last fire so the agent receives the new context.
	 * Default false (legacy single-fire-per-item behavior).
	 */
	retriggerOnComments?: boolean;
	/**
	 * Per-item cap on re-trigger fires. Counts re-fires only - the initial
	 * discovery fire is always allowed regardless of this value. Omitted /
	 * undefined falls back to {@link DEFAULT_MAX_NOTIFICATIONS}. `0` (or any
	 * non-positive value) means unlimited.
	 */
	maxNotifications?: number;
	/**
	 * Invoked once during setup with a handle whose `pollNow()` triggers an
	 * immediate poll (in addition to the normal poll schedule). The caller
	 * stores the handle so it can fire on system wake / user request without
	 * re-spawning the poller. Calling `pollNow()` after the poller is stopped
	 * is a no-op. `getRepo()` is the repo the poller keys items by (the
	 * configured one, or what `gh` auto-detected), or null until it is known.
	 */
	onReady?: (handle: { pollNow: () => void; getRepo: () => string | null }) => void;
	/**
	 * Optional gate: when this returns `false`, doPoll skips the HTTP fetch
	 * to gh CLI. The 24h prune timer keeps running (cheap). Used by the
	 * visibility-aware pause; see CLAUDE-PERFORMANCE.md§"Visibility-Aware
	 * Operations". Defaults to always-active when omitted.
	 */
	isActive?: () => boolean;
}

/**
 * Creates a GitHub poller for a Cue subscription.
 * Returns a cleanup function to stop polling.
 */
export function createCueGitHubPoller(config: CueGitHubPollerConfig): () => void {
	const {
		eventType,
		pollMinutes,
		projectRoot,
		onEvent,
		onLog,
		triggerName,
		subscriptionId,
		ghState,
		retriggerOnComments,
		maxNotifications,
	} = config;
	const stateFilter = ghState ?? 'open';
	const labelTarget = config.labelTarget ?? 'both';
	// Lowercased once so the per-event check is a plain Set lookup.
	const watchedLabels = new Set(
		(config.watchLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean)
	);
	const isActive = config.isActive ?? (() => true);
	const retrigger = retriggerOnComments === true;
	// Treat undefined as "use default 10". 0/negative = unlimited (sentinel
	// already chosen at schema level so `0` round-trips through YAML).
	const rawMax = maxNotifications ?? DEFAULT_MAX_NOTIFICATIONS;
	const cap = rawMax <= UNLIMITED_NOTIFICATIONS ? Infinity : rawMax;

	let stopped = false;
	let initialTimeout: ReturnType<typeof setTimeout> | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let pruneInterval: ReturnType<typeof setInterval> | null = null;

	// Cached state
	let ghCommand: string | null = null;
	let resolvedRepo: string | null = config.repo ?? null;
	/** Tracks whether a poll has been attempted (success or failure) to prevent event flooding on recovery */
	let firstPollAttempted = false;

	// Phase 12C - rate-limit backoff state
	const basePollMs = pollMinutes * 60 * 1000;
	let currentPollMs = basePollMs;

	// A token secret file that exists but cannot be used is logged once per
	// change, not once per gh call.
	let lastTokenProblems = '';
	function reportTokenProblems(problems: string[]): void {
		const joined = problems.join('; ');
		if (joined === lastTokenProblems) return;
		lastTokenProblems = joined;
		if (joined) onLog('warn', `[CUE] "${triggerName}" cannot use the GitHub token: ${joined}`);
	}

	function runGh(
		cmd: string,
		args: string[],
		opts?: { cwd?: string; timeout?: number }
	): Promise<{ stdout: string; stderr: string }> {
		return execFileAsync(cmd, args, opts, reportTokenProblems);
	}

	async function resolveGh(): Promise<string | null> {
		if (ghCommand !== null) return ghCommand;
		try {
			const cmd = await resolveGhPath();
			await runGh(cmd, ['--version']);
			ghCommand = cmd;
		} catch (err) {
			// `gh` not being installed is expected in some environments, so the
			// Sentry report fires for every shape EXCEPT ENOENT. Errors without
			// a `code` (e.g. unexpected throws from `resolveGhPath`) used to slip
			// through the old `code && code !== 'ENOENT'` guard silently.
			const code = (err as { code?: string } | undefined)?.code;
			onLog('warn', `[CUE] GitHub CLI (gh) not found - skipping "${triggerName}"`);
			if (code !== 'ENOENT') {
				void captureException(err, { operation: 'cue:github:resolveGh', triggerName });
			}
			return null;
		}
		return ghCommand;
	}

	async function resolveRepo(): Promise<string | null> {
		if (resolvedRepo) return resolvedRepo;
		try {
			const { stdout } = await runGh(
				ghCommand!,
				['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
				{ cwd: projectRoot, timeout: 10000 }
			);
			resolvedRepo = stdout.trim();
			return resolvedRepo;
		} catch (err) {
			// Rate-limited repo detection must bubble up so doPoll's outer
			// catch can apply exponential backoff - swallowing + returning null
			// here would make every poll immediately short-circuit while the
			// limit lasts, without ever bumping currentPollMs.
			if (isGitHubRateLimitError(err)) {
				throw err;
			}
			// A stale token fails here first, before `doPoll` ever gets a repo to
			// poll, so the auth guidance has to be repeated at this call site -
			// otherwise an auto-detect trigger only ever says "could not auto-detect
			// repo", which reads like a project problem rather than a login one.
			if (isGitHubAuthError(err)) {
				const message = err instanceof Error ? err.message : String(err);
				onLog(
					'warn',
					`[CUE] GitHub poll skipped for "${triggerName}" - the GitHub CLI is not authenticated. Run \`gh auth login\` to reconnect, or provide GH_TOKEN as a secret file or environment variable: ${message}`
				);
				return null;
			}
			onLog('warn', `[CUE] Could not auto-detect repo for "${triggerName}" - skipping poll`);
			// GitHub being unreachable or degraded is the same expected operational
			// condition the doPoll catch below suppresses. Repo auto-detection runs
			// first, so without this a `gh repo view` 5xx during an outage would
			// still page Sentry once per tick for every auto-detect trigger
			// (MAESTRO-KE). Skipping the poll and returning null is unchanged.
			// A stale `gh` token is the same story with a different cause.
			if (!isGitHubConnectivityError(err) && !isGitHubAuthError(err)) {
				void captureException(err, { operation: 'cue:github:resolveRepo', triggerName });
			}
			return null;
		}
	}

	/**
	 * Fetch issue-style top-level comments for a single PR or issue, filtered
	 * to those created strictly after `sinceIso`. Returns at most 50 comments
	 * (the most recent if the API caps us). Inline review comments / thread
	 * replies on PRs are intentionally skipped for v1 - they require a
	 * different API surface and the top-level stream is enough to drive
	 * back-and-forth between agents.
	 *
	 * Errors are surfaced as `null` so callers can decide whether to suppress
	 * a re-fire. Rate limit errors bubble up so the outer doPoll can apply
	 * exponential backoff.
	 */
	async function fetchNewComments(
		itemType: 'pr' | 'issue',
		repo: string,
		itemNumber: number,
		sinceIso: string | null
	): Promise<GitHubComment[] | null> {
		try {
			const { stdout } = await runGh(
				ghCommand!,
				[itemType, 'view', String(itemNumber), '--repo', repo, '--json', 'comments'],
				{ cwd: projectRoot, timeout: 30000 }
			);
			const parsed = JSON.parse(stdout) as { comments?: RawGitHubComment[] };
			const rawComments = parsed.comments ?? [];
			const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
			const filtered = rawComments
				.filter((c) => {
					if (!c.createdAt) return false;
					if (!sinceMs) return true;
					const created = Date.parse(c.createdAt);
					return Number.isFinite(created) && created > sinceMs;
				})
				.slice(-50)
				.map<GitHubComment>((c) => ({
					author: c.author?.login ?? 'unknown',
					body: (c.body ?? '').slice(0, 5000),
					createdAt: c.createdAt ?? '',
					url: c.url ?? '',
				}));
			return filtered;
		} catch (err) {
			if (isGitHubRateLimitError(err)) throw err;
			const message = err instanceof Error ? err.message : String(err);
			onLog(
				'warn',
				`[CUE] "${triggerName}" failed to fetch comments for ${itemType}#${itemNumber}: ${message}`
			);
			return null;
		}
	}

	/**
	 * Run one pull request or issue through the shared decision and fire what
	 * it calls for. The webhook path makes the same decision against the same
	 * rows, so whichever source sees a change first fires it and the other
	 * skips it.
	 */
	async function processItem(
		itemEventType: GitHubItemEventType,
		repo: string,
		item: GitHubItemSnapshot,
		isFirstRun: boolean
	): Promise<void> {
		const itemKey = githubItemKey(itemEventType, repo, item.number);
		const updatedAt = item.updatedAt;
		const decision = decideGitHubItem({
			subscriptionId,
			itemKey,
			updatedAt,
			isFirstRun,
			retrigger,
			cap,
		});

		if (decision.kind === 'seed') {
			markGitHubItemSeen(subscriptionId, itemKey, updatedAt);
			return;
		}
		if (decision.kind === 'skip') return;

		if (decision.kind === 'retrigger') {
			// Held from the decision on, so a webhook cannot fire the same change
			// while the comments load or the event is scored.
			const reservation = reserveGitHubChange(subscriptionId, itemKey, () =>
				recordGitHubRetrigger(subscriptionId, itemKey, updatedAt)
			);
			let newComments: GitHubComment[] | null;
			try {
				newComments = await fetchNewComments(
					itemEventType === 'github.pull_request' ? 'pr' : 'issue',
					repo,
					item.number,
					decision.state.lastRevision
				);
			} catch (err) {
				reservation.release();
				throw err;
			}
			const current = getGitHubItemState(subscriptionId, itemKey);
			if (
				stopped ||
				!current ||
				!isNewerRevision(updatedAt, current.lastRevision) ||
				current.fireCount >= cap
			) {
				reservation.release();
				return;
			}
			fire(
				buildGitHubItemEvent(itemEventType, triggerName, repo, item, {
					retriggerCount: current.fireCount + 1,
					newComments: newComments ?? [],
				}),
				reservation
			);
			return;
		}

		fire(
			buildGitHubItemEvent(itemEventType, triggerName, repo, item, null),
			reserveGitHubChange(subscriptionId, itemKey, () =>
				markGitHubItemSeen(subscriptionId, itemKey, updatedAt)
			)
		);
	}

	/** Emit, then record the change only once the event reached a final outcome. */
	function fire(event: CueEvent, reservation: GitHubChangeReservation): void {
		try {
			onEvent(event, (outcome) => {
				if (isFinalEmitOutcome(outcome)) reservation.commit();
				else reservation.release();
			});
		} catch (err) {
			reservation.release();
			throw err;
		}
	}

	async function pollPRs(repo: string): Promise<void> {
		// For "merged" state, query closed PRs and filter by merge status client-side
		const ghStateArg = stateFilter === 'merged' ? 'closed' : stateFilter;
		const { stdout } = await runGh(
			ghCommand!,
			[
				'pr',
				'list',
				'--repo',
				repo,
				'--json',
				'number,title,author,url,body,state,isDraft,labels,headRefName,baseRefName,createdAt,updatedAt,mergedAt',
				'--state',
				ghStateArg,
				'--limit',
				'50',
			],
			{ cwd: projectRoot, timeout: 30000 }
		);

		let items: any[];
		try {
			items = JSON.parse(stdout);
		} catch {
			onLog('warn', `[CUE] "${triggerName}" received malformed JSON from gh pr list`);
			return;
		}

		// For "merged" state, filter to only merged PRs (have a mergedAt timestamp)
		if (stateFilter === 'merged') {
			items = items.filter((item: { mergedAt?: string }) => !!item.mergedAt);
		}

		const isFirstRun = !hasAnyGitHubSeen(subscriptionId);

		for (const item of items) {
			if (stopped) return;
			await processItem('github.pull_request', repo, snapshotFromGh(item), isFirstRun);
			if (stopped) return;
		}

		if (isFirstRun) {
			onLog('info', `[CUE] "${triggerName}" seeded ${items.length} existing pull_request(s)`);
		}
	}

	async function pollIssues(repo: string): Promise<void> {
		const { stdout } = await runGh(
			ghCommand!,
			[
				'issue',
				'list',
				'--repo',
				repo,
				'--json',
				'number,title,author,url,body,state,labels,assignees,createdAt,updatedAt',
				'--state',
				stateFilter === 'merged' ? 'open' : stateFilter, // "merged" not valid for issues, fall back
				'--limit',
				'50',
			],
			{ cwd: projectRoot, timeout: 30000 }
		);

		let items: any[];
		try {
			items = JSON.parse(stdout);
		} catch {
			onLog('warn', `[CUE] "${triggerName}" received malformed JSON from gh issue list`);
			return;
		}
		const isFirstRun = !hasAnyGitHubSeen(subscriptionId);

		for (const item of items) {
			if (stopped) return;
			await processItem('github.issue', repo, snapshotFromGh(item), isFirstRun);
			if (stopped) return;
		}

		if (isFirstRun) {
			onLog('info', `[CUE] "${triggerName}" seeded ${items.length} existing issue(s)`);
		}
	}

	/**
	 * Fetch one page of label-add events, newest first. Projected with `--jq`
	 * so the (very large) embedded issue objects never cross the pipe: a single
	 * unprojected page of 100 events runs to several megabytes of bodies,
	 * reactions, and user objects we would immediately discard.
	 */
	async function fetchLabelEventPage(repo: string, page: number): Promise<RawLabelEvent[]> {
		const { stdout } = await runGh(
			ghCommand!,
			[
				'api',
				`repos/${repo}/issues/events?per_page=${LABEL_EVENT_PAGE_SIZE}&page=${page}`,
				'--jq',
				`[.[] | select(.event == "labeled") | {
					id: .id,
					created_at: .created_at,
					label: (.label.name // ""),
					actor: (.actor.login // "unknown"),
					number: .issue.number,
					title: (.issue.title // ""),
					url: (.issue.html_url // ""),
					body: ((.issue.body // "")[0:5000]),
					state: (.issue.state // "open"),
					labels: [(.issue.labels // [])[].name],
					is_pr: (.issue.pull_request != null),
					merged: (.issue.pull_request.merged_at != null),
					author: (.issue.user.login // "unknown"),
					item_created_at: (.issue.created_at // ""),
					item_updated_at: (.issue.updated_at // "")
				}]`,
			],
			{ cwd: projectRoot, timeout: 30000 }
		);
		const trimmed = stdout.trim();
		if (!trimmed) return [];
		try {
			const parsed = JSON.parse(trimmed);
			return Array.isArray(parsed) ? (parsed as RawLabelEvent[]) : [];
		} catch {
			onLog('warn', `[CUE] "${triggerName}" received malformed JSON from gh api issues/events`);
			return [];
		}
	}

	const labelFilters: GitHubLabelFilters = { labelTarget, watchedLabels, ghState };

	/**
	 * Poll the repo-wide issue-events feed and fire for every `labeled` event
	 * newer than the stored watermark.
	 *
	 * Paginates backwards from the newest page until it reaches an event at or
	 * below the watermark, so a burst of unrelated issue activity between polls
	 * cannot hide a label add inside page 1. The first run only records the
	 * watermark - it never replays a repo's label history.
	 */
	async function pollLabelEvents(repo: string): Promise<void> {
		const watermarkState = getGitHubItemState(subscriptionId, LABEL_WATERMARK_KEY);
		const watermark = Number(watermarkState?.lastRevision ?? '');
		const isFirstRun = watermarkState?.lastRevision == null || !Number.isFinite(watermark);

		const collected = new Map<number, RawLabelEvent>();
		let highestId = Number.isFinite(watermark) ? watermark : 0;
		let reachedWatermark = false;

		for (let page = 1; page <= MAX_LABEL_EVENT_PAGES; page++) {
			if (stopped) return;
			const events = await fetchLabelEventPage(repo, page);
			for (const ev of events) {
				if (typeof ev.id !== 'number') continue;
				if (ev.id > highestId) highestId = ev.id;
				// Keyed by id: the feed is offset-paged, so events that land
				// mid-scan push the tail of one page onto the next.
				if (!isFirstRun && ev.id > watermark) collected.set(ev.id, ev);
			}
			// The first page alone establishes the watermark on a first run, and
			// a page that isn't full is the end of the feed either way.
			if (isFirstRun || events.length === 0) {
				reachedWatermark = true;
				break;
			}
			// `events` is the LABEL subset of the page, so an empty array does
			// not mean the page was empty. Stop only once a returned label event
			// sits at or below the watermark, which proves we crossed it.
			if (events.some((ev) => ev.id <= watermark)) {
				reachedWatermark = true;
				break;
			}
		}

		if (!reachedWatermark) {
			onLog(
				'warn',
				`[CUE] "${triggerName}" scanned ${MAX_LABEL_EVENT_PAGES} pages of GitHub events without reaching its last-seen point - some label events may have been skipped. Lower poll_minutes to keep up.`
			);
		}

		if (isFirstRun) {
			setGitHubItemRevision(subscriptionId, LABEL_WATERMARK_KEY, String(highestId));
			onLog('info', `[CUE] "${triggerName}" seeded GitHub label watermark at event ${highestId}`);
			return;
		}

		// Oldest first so a batch of label adds reaches the agent in the order
		// a human applied them.
		const ordered = [...collected.values()].sort((a, b) => a.id - b.id);

		// Each add this poll fires, or leaves to a webhook firing it right now,
		// with whether it reached a final outcome.
		const pending: Array<{ id: number; settled: Promise<boolean> }> = [];
		for (const raw of ordered) {
			if (stopped) break;
			const ev = labelSnapshotFromFeed(raw);
			if (!labelEventMatchesFilters(ev, labelFilters)) continue;
			// Fired by an earlier poll whose watermark did not get past it.
			if (labelEventHandledBySource(subscriptionId, repo, ev, 'poll')) continue;
			// A webhook may already have fired this add, or be firing it now.
			if (claimLabelEventFiredByOtherSource(subscriptionId, repo, ev, 'poll')) continue;
			const webhookInFlight = claimLabelEventInFlightForOtherSource(
				subscriptionId,
				repo,
				ev,
				'poll'
			);
			if (webhookInFlight) {
				pending.push({ id: raw.id, settled: webhookInFlight });
				continue;
			}
			const reservation = reserveLabelEvent(subscriptionId, repo, ev, 'poll');
			fire(buildGitHubLabelEvent(triggerName, repo, ev), reservation);
			pending.push({ id: raw.id, settled: reservation.settled });
		}

		// Advance past everything scanned, matched or not: an event filtered out
		// by kind/label must not be re-examined forever. But never past an add
		// that did not reach the run manager: the watermark stays just below
		// it, so the next poll (or the next start, after a crash) reads it
		// again, and the adds above it that did fire are skipped by their rows.
		let next = stopped ? watermark : highestId;
		for (const { id, settled } of pending) {
			if (!(await settled)) next = Math.min(next, id - 1);
		}
		if (next > watermark) {
			setGitHubItemRevision(subscriptionId, LABEL_WATERMARK_KEY, String(next));
		}
	}

	/**
	 * One poll at a time. A webhook can ask for a poll (`pollNow`) while the
	 * scheduled one is still running; two polls side by side could both read
	 * the label watermark and fire the same adds. A request made during a poll
	 * runs one more poll after it instead.
	 */
	let polling = false;
	let pollRequested = false;
	async function doPoll(): Promise<void> {
		if (polling) {
			pollRequested = true;
			return;
		}
		polling = true;
		try {
			await pollOnce();
		} finally {
			polling = false;
		}
		if (pollRequested && !stopped) {
			pollRequested = false;
			await doPoll();
		}
	}

	async function pollOnce(): Promise<void> {
		if (stopped) return;
		// Visibility-aware pause: skip the gh CLI fetch when inactive. The
		// scheduleNextPoll loop keeps running so we resume cleanly when the
		// app becomes visible again.
		if (!isActive()) return;
		if (!isCueDbReady()) {
			onLog('warn', `[CUE] Cue database not ready - skipping GitHub poll for "${triggerName}"`);
			return;
		}

		try {
			if (!(await resolveGh())) return;

			const repo = await resolveRepo();
			if (!repo) return;

			if (eventType === 'github.pull_request') {
				await pollPRs(repo);
			} else if (eventType === 'github.label') {
				await pollLabelEvents(repo);
			} else {
				await pollIssues(repo);
			}
			// Success - reset backoff to baseline.
			currentPollMs = basePollMs;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			if (isGitHubRateLimitError(err)) {
				// Exponential backoff capped at the max. Sentry is NOT called for
				// rate limits - they are expected operational conditions.
				currentPollMs = Math.min(currentPollMs * 2, GITHUB_RATE_LIMIT_MAX_BACKOFF_MS);
				const backoffMin = Math.round(currentPollMs / 60000);
				const payload: CueLogPayload = {
					type: 'rateLimitBackoff',
					triggerName,
					backoffMs: currentPollMs,
				};
				onLog(
					'warn',
					`[CUE] "${triggerName}" rate-limited by GitHub - backing off to ${backoffMin}m`,
					payload
				);
			} else if (isGitHubConnectivityError(err)) {
				onLog(
					'warn',
					`[CUE] GitHub poll skipped for "${triggerName}" because GitHub is unreachable: ${message}`
				);
			} else if (isGitHubAuthError(err)) {
				// Actionable by the user and only by the user, so say what to do
				// instead of filing a crash report on every tick (MAESTRO-KE).
				onLog(
					'warn',
					`[CUE] GitHub poll skipped for "${triggerName}" - the GitHub CLI is not authenticated. Run \`gh auth login\` to reconnect, or provide GH_TOKEN as a secret file or environment variable: ${message}`
				);
			} else {
				// Emit typed payload so the metric interceptor bumps the
				// githubPollErrors counter; the engine narrows on `type` rather
				// than log level.
				const payload: CueLogPayload = { type: 'githubPollError', triggerName };
				onLog('error', `[CUE] GitHub poll error for "${triggerName}": ${message}`, payload);
				void captureException(err, { operation: 'cue:github:doPoll', triggerName });
			}

			// If the first poll ever fails, place a seed marker so the next successful
			// poll doesn't treat ALL existing items as new (which would swallow items
			// created during the outage by seeding them as "already seen")
			if (!firstPollAttempted) {
				try {
					markGitHubItemSeen(subscriptionId, '__seed_marker__');
					onLog(
						'info',
						`[CUE] First poll for "${triggerName}" failed - seed marker set to prevent silent event loss on recovery`
					);
				} catch (seedErr) {
					// Non-fatal: DB may not be available. Surface to Sentry so we see
					// when the "loss prevention" itself fails - previously silent.
					void captureException(seedErr, {
						operation: 'cue:github:seedMarker',
						triggerName,
						subscriptionId,
					});
				}
			}
		} finally {
			firstPollAttempted = true;
		}
	}

	/**
	 * Self-rescheduling poll loop. Reads `currentPollMs` fresh at each tick so
	 * exponential backoff updates take effect immediately. Replaces the prior
	 * setInterval-based loop, which could not honor a growing delay.
	 */
	function scheduleNextPoll(): void {
		if (stopped) return;
		pollTimer = setTimeout(async () => {
			// Guard the loop: if doPoll throws (it shouldn't - it has its own
			// try/catch - but an unexpected rethrow would silently end the
			// schedule). try/finally here keeps the loop alive regardless.
			try {
				await doPoll();
			} catch (err) {
				onLog(
					'error',
					`[CUE] Unexpected error in poll loop for "${triggerName}": ${err instanceof Error ? err.message : String(err)}`
				);
				void captureException(err, { operation: 'cue:github:pollLoop', triggerName });
			} finally {
				scheduleNextPoll();
			}
		}, currentPollMs);
	}

	// Initial poll after 2-second delay, then enter the rescheduling loop.
	initialTimeout = setTimeout(() => {
		if (stopped) return;
		doPoll()
			.then(() => {
				if (stopped) return;
				scheduleNextPoll();
			})
			.catch((err) => {
				onLog(
					'error',
					`[CUE] Unexpected error in initial poll for "${triggerName}": ${err instanceof Error ? err.message : String(err)}`
				);
				void captureException(err, { operation: 'cue:github:initialPoll', triggerName });
				if (!stopped) scheduleNextPoll();
			});
	}, 2000);

	// Periodic prune every 24 hours (30-day retention)
	pruneInterval = setInterval(
		() => {
			if (!isCueDbReady()) return;
			pruneGitHubSeen(30 * 24 * 60 * 60 * 1000);
			// Same retention as the seen-set above: both are per-item poll dedup
			// state, so an item aging out of one must age out of the other or a
			// rediscovered issue would be re-fired while still silently blocked.
			pruneSusFactorBlocks(30 * 24 * 60 * 60 * 1000);
		},
		24 * 60 * 60 * 1000
	);

	// Expose pollNow so the engine can request an immediate poll (e.g. on
	// system wake) without waiting for the next scheduled tick. Errors are
	// logged but not rethrown - pollNow is fire-and-forget by contract.
	config.onReady?.({
		pollNow: () => {
			if (stopped) return;
			void doPoll().catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				onLog('error', `[CUE] pollNow failed for "${triggerName}": ${message}`);
				void captureException(err, { operation: 'cue:github:pollNow', triggerName });
			});
		},
		getRepo: () => resolvedRepo,
	});

	// Cleanup function
	return () => {
		stopped = true;
		if (initialTimeout) {
			clearTimeout(initialTimeout);
			initialTimeout = null;
		}
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		if (pruneInterval) {
			clearInterval(pruneInterval);
			pruneInterval = null;
		}
	};
}
