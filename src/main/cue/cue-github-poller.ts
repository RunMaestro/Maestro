/**
 * GitHub poller provider for Maestro Cue github.pull_request and github.issue subscriptions.
 *
 * Polls GitHub CLI (`gh`) for new PRs/issues, tracks "seen" state in SQLite,
 * and fires CueEvents for new items. Follows the same factory pattern as cue-file-watcher.ts.
 */

import { execFile as cpExecFile } from 'child_process';
import { createCueEvent, type CueEvent } from './cue-types';
import { isGitHubItemSeen, markGitHubItemSeen, hasAnyGitHubSeen, pruneGitHubSeen } from './cue-db';
import { resolveGhPath, getExpandedEnv } from '../utils/cliDetection';
import { captureException } from '../utils/sentry';
import type { CueLogPayload } from '../../shared/cue-log-types';

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
	const msg = (
		err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
			? err.message
			: String(err ?? '')
	).toLowerCase();
	const stderr =
		err &&
		typeof err === 'object' &&
		'stderr' in err &&
		typeof (err as { stderr: unknown }).stderr === 'string'
			? (err as { stderr: string }).stderr.toLowerCase()
			: '';
	const haystack = `${msg}\n${stderr}`;
	return (
		haystack.includes('api rate limit exceeded') ||
		haystack.includes('secondary rate limit') ||
		haystack.includes('rate limit has been reached') ||
		/\bhttp\s+(403|429)\b/.test(haystack)
	);
}

/** Expanded env so packaged Electron can find gh in /opt/homebrew/bin, /usr/local/bin, etc. */
const ghEnv = getExpandedEnv();

function execFileAsync(
	cmd: string,
	args: string[],
	opts?: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		cpExecFile(cmd, args, { ...opts, env: ghEnv }, (error, stdout, stderr) => {
			if (error) {
				reject(error);
			} else {
				resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
			}
		});
	});
}

export interface CueGitHubPollerConfig {
	eventType: 'github.pull_request' | 'github.issue';
	repo?: string;
	pollMinutes: number;
	projectRoot: string;
	onEvent: (event: CueEvent) => void;
	onLog: (level: string, message: string, data?: unknown) => void;
	triggerName: string;
	subscriptionId: string;
	/** GitHub state filter: "open" (default), "closed", "merged" (PRs only), or "all" */
	ghState?: string;
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
	} = config;
	const stateFilter = ghState ?? 'open';
	const isActive = config.isActive ?? (() => true);

	let stopped = false;
	let initialTimeout: ReturnType<typeof setTimeout> | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let pruneInterval: ReturnType<typeof setInterval> | null = null;

	// Cached state
	let ghCommand: string | null = null;
	let resolvedRepo: string | null = config.repo ?? null;
	/** Tracks whether a poll has been attempted (success or failure) to prevent event flooding on recovery */
	let firstPollAttempted = false;

	// Phase 12C — rate-limit backoff state
	const basePollMs = pollMinutes * 60 * 1000;
	let currentPollMs = basePollMs;

	async function resolveGh(): Promise<string | null> {
		if (ghCommand !== null) return ghCommand;
		try {
			const cmd = await resolveGhPath();
			await execFileAsync(cmd, ['--version']);
			ghCommand = cmd;
		} catch (err) {
			// `gh` not being installed is expected in some environments, so the
			// Sentry report fires for every shape EXCEPT ENOENT. Errors without
			// a `code` (e.g. unexpected throws from `resolveGhPath`) used to slip
			// through the old `code && code !== 'ENOENT'` guard silently.
			const code = (err as { code?: string } | undefined)?.code;
			onLog('warn', `[CUE] GitHub CLI (gh) not found — skipping "${triggerName}"`);
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
			const { stdout } = await execFileAsync(
				ghCommand!,
				['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
				{ cwd: projectRoot, timeout: 10000 }
			);
			resolvedRepo = stdout.trim();
			return resolvedRepo;
		} catch (err) {
			// Rate-limited repo detection must bubble up so doPoll's outer
			// catch can apply exponential backoff — swallowing + returning null
			// here would make every poll immediately short-circuit while the
			// limit lasts, without ever bumping currentPollMs.
			if (isGitHubRateLimitError(err)) {
				throw err;
			}
			onLog('warn', `[CUE] Could not auto-detect repo for "${triggerName}" — skipping poll`);
			void captureException(err, { operation: 'cue:github:resolveRepo', triggerName });
			return null;
		}
	}

	async function pollPRs(repo: string): Promise<void> {
		// For "merged" state, query closed PRs and filter by merge status client-side
		const ghStateArg = stateFilter === 'merged' ? 'closed' : stateFilter;
		const { stdout } = await execFileAsync(
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
			const itemKey = `pr:${repo}:${item.number}`;

			if (isFirstRun) {
				markGitHubItemSeen(subscriptionId, itemKey);
				continue;
			}

			if (isGitHubItemSeen(subscriptionId, itemKey)) continue;

			const event = createCueEvent('github.pull_request', triggerName, {
				type: 'pull_request',
				number: item.number,
				title: item.title,
				author: item.author?.login ?? 'unknown',
				url: item.url,
				body: (item.body ?? '').slice(0, 5000),
				state: item.mergedAt ? 'merged' : (item.state?.toLowerCase() ?? 'open'),
				draft: item.isDraft ?? false,
				labels: (item.labels ?? []).map((l: { name: string }) => l.name).join(','),
				head_branch: item.headRefName ?? '',
				base_branch: item.baseRefName ?? '',
				repo,
				created_at: item.createdAt ?? '',
				updated_at: item.updatedAt ?? '',
				merged_at: item.mergedAt ?? '',
			});

			onEvent(event);
			markGitHubItemSeen(subscriptionId, itemKey);
		}

		if (isFirstRun) {
			onLog('info', `[CUE] "${triggerName}" seeded ${items.length} existing pull_request(s)`);
		}
	}

	async function pollIssues(repo: string): Promise<void> {
		const { stdout } = await execFileAsync(
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
			const itemKey = `issue:${repo}:${item.number}`;

			if (isFirstRun) {
				markGitHubItemSeen(subscriptionId, itemKey);
				continue;
			}

			if (isGitHubItemSeen(subscriptionId, itemKey)) continue;

			const event = createCueEvent('github.issue', triggerName, {
				type: 'issue',
				number: item.number,
				title: item.title,
				author: item.author?.login ?? 'unknown',
				url: item.url,
				body: (item.body ?? '').slice(0, 5000),
				state: item.state?.toLowerCase() ?? 'open',
				labels: (item.labels ?? []).map((l: { name: string }) => l.name).join(','),
				assignees: (item.assignees ?? []).map((a: { login: string }) => a.login).join(','),
				repo,
				created_at: item.createdAt ?? '',
				updated_at: item.updatedAt ?? '',
			});

			onEvent(event);
			markGitHubItemSeen(subscriptionId, itemKey);
		}

		if (isFirstRun) {
			onLog('info', `[CUE] "${triggerName}" seeded ${items.length} existing issue(s)`);
		}
	}

	async function doPoll(): Promise<void> {
		if (stopped) return;
		// Visibility-aware pause: skip the gh CLI fetch when inactive. The
		// scheduleNextPoll loop keeps running so we resume cleanly when the
		// app becomes visible again.
		if (!isActive()) return;

		try {
			if (!(await resolveGh())) return;

			const repo = await resolveRepo();
			if (!repo) return;

			if (eventType === 'github.pull_request') {
				await pollPRs(repo);
			} else {
				await pollIssues(repo);
			}
			// Success — reset backoff to baseline.
			currentPollMs = basePollMs;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			if (isGitHubRateLimitError(err)) {
				// Exponential backoff capped at the max. Sentry is NOT called for
				// rate limits — they are expected operational conditions.
				currentPollMs = Math.min(currentPollMs * 2, GITHUB_RATE_LIMIT_MAX_BACKOFF_MS);
				const backoffMin = Math.round(currentPollMs / 60000);
				const payload: CueLogPayload = {
					type: 'rateLimitBackoff',
					triggerName,
					backoffMs: currentPollMs,
				};
				onLog(
					'warn',
					`[CUE] "${triggerName}" rate-limited by GitHub — backing off to ${backoffMin}m`,
					payload
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
						`[CUE] First poll for "${triggerName}" failed — seed marker set to prevent silent event loss on recovery`
					);
				} catch (seedErr) {
					// Non-fatal: DB may not be available. Surface to Sentry so we see
					// when the "loss prevention" itself fails — previously silent.
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
			// Guard the loop: if doPoll throws (it shouldn't — it has its own
			// try/catch — but an unexpected rethrow would silently end the
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
			pruneGitHubSeen(30 * 24 * 60 * 60 * 1000);
		},
		24 * 60 * 60 * 1000
	);

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
