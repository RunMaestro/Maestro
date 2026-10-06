/**
 * One GitHub pull request, issue, or label add, and how a `github.*` Cue
 * subscription decides whether it fires.
 *
 * Shared by the poller (items from `gh pr list`, `gh issue list` and the
 * issue-events feed) and the webhook path (items from GitHub's webhook
 * payloads). Both build the event here and record what fired in the same
 * `cue_github_seen` rows, so a change that arrives both ways fires once,
 * whichever way it arrives first.
 */

import type { CueGitHubLabelTarget } from '../../shared/cue';
import {
	getGitHubItemState,
	isGitHubItemSeen,
	setGitHubItemRevision,
	type CueGitHubItemState,
} from './cue-db';
import { createCueEvent, type CueEvent } from './cue-types';

/** Normalized comment shape attached to re-trigger event payloads. */
export interface GitHubComment {
	author: string;
	body: string;
	createdAt: string;
	url: string;
}

/**
 * Default per-item re-trigger cap when `retrigger_on_comments` is enabled but
 * `max_notifications` is omitted. Counts re-fires only - the initial discovery
 * fire is always allowed. Set so a busy PR can't flood Cue indefinitely while
 * leaving plenty of room for legitimate back-and-forth between agents.
 */
export const DEFAULT_MAX_NOTIFICATIONS = 10;

/** Longest item body carried on an event. */
export const GITHUB_ITEM_BODY_LIMIT = 5000;

/**
 * A pull request or issue as both sources see it. Fields are already
 * normalized: `state` is lowercase GitHub state (`open` / `closed`) and a
 * merged PR carries `mergedAt`.
 */
export interface GitHubItemSnapshot {
	number: number;
	title: string;
	author: string;
	url: string;
	body: string;
	state: string;
	labels: string[];
	createdAt: string;
	updatedAt: string;
	/** Pull requests only. */
	isDraft?: boolean;
	headRef?: string;
	baseRef?: string;
	/** Pull requests only: set when merged, empty otherwise. */
	mergedAt?: string;
	/** Issues only. */
	assignees?: string[];
}

export type GitHubItemEventType = 'github.pull_request' | 'github.issue';

/** The `cue_github_seen` key for a pull request or issue. */
export function githubItemKey(
	eventType: GitHubItemEventType,
	repo: string,
	number: number
): string {
	return `${eventType === 'github.pull_request' ? 'pr' : 'issue'}:${repo}:${number}`;
}

/**
 * Whether an item passes the subscription's `gh_state` filter. Mirrors what
 * the poller asks `gh` for: `closed` includes merged pull requests, and
 * `merged` is not an issue state, so an issue subscription treats it as
 * `open`.
 */
export function matchesGitHubStateFilter(
	eventType: GitHubItemEventType,
	item: GitHubItemSnapshot,
	stateFilter: string
): boolean {
	const state = (item.state || 'open').toLowerCase();
	if (stateFilter === 'all') return true;
	if (eventType === 'github.pull_request') {
		if (stateFilter === 'merged') return Boolean(item.mergedAt);
		if (stateFilter === 'closed') return state === 'closed';
		return state === 'open';
	}
	if (stateFilter === 'closed') return state === 'closed';
	return state === 'open';
}

/** What happens to one item, given what this subscription already fired. */
export type GitHubItemDecision =
	| { kind: 'seed' }
	| { kind: 'new' }
	| { kind: 'retrigger'; state: CueGitHubItemState }
	| { kind: 'skip' };

/**
 * Decide an item against `cue_github_seen`.
 *
 * - `seed`: a subscription's first run records what already exists without
 *   firing, so it never replays a repository's history.
 * - `new`: never fired for this subscription.
 * - `retrigger`: fired before, `retrigger_on_comments` is on, the item changed
 *   since its last fire, and the re-fire cap is not reached.
 */
export function decideGitHubItem(options: {
	subscriptionId: string;
	itemKey: string;
	updatedAt: string;
	isFirstRun: boolean;
	retrigger: boolean;
	cap: number;
}): GitHubItemDecision {
	if (options.isFirstRun) return { kind: 'seed' };
	if (!isGitHubItemSeen(options.subscriptionId, options.itemKey)) return { kind: 'new' };
	if (!options.retrigger) return { kind: 'skip' };
	const state = getGitHubItemState(options.subscriptionId, options.itemKey);
	if (!state) return { kind: 'skip' };
	// No new activity since the last fire.
	if (!options.updatedAt || state.lastRevision === options.updatedAt) return { kind: 'skip' };
	// Cap reached: state stays frozen so raising the cap later resumes from here.
	if (state.fireCount >= options.cap) return { kind: 'skip' };
	return { kind: 'retrigger', state };
}

/** Build the event a pull request or issue fires, new or re-triggered. */
export function buildGitHubItemEvent(
	eventType: GitHubItemEventType,
	triggerName: string,
	repo: string,
	item: GitHubItemSnapshot,
	fire: { retriggerCount: number; newComments: GitHubComment[] } | null
): CueEvent {
	const common = {
		number: item.number,
		title: item.title,
		author: item.author || 'unknown',
		url: item.url,
		body: (item.body ?? '').slice(0, GITHUB_ITEM_BODY_LIMIT),
	};
	const retrigger = {
		is_retrigger: fire !== null,
		retrigger_count: fire?.retriggerCount ?? 0,
		new_comments: fire?.newComments ?? [],
	};
	if (eventType === 'github.pull_request') {
		return createCueEvent('github.pull_request', triggerName, {
			type: 'pull_request',
			...common,
			state: item.mergedAt ? 'merged' : (item.state?.toLowerCase() ?? 'open'),
			draft: item.isDraft ?? false,
			labels: item.labels.join(','),
			head_branch: item.headRef ?? '',
			base_branch: item.baseRef ?? '',
			repo,
			created_at: item.createdAt ?? '',
			updated_at: item.updatedAt,
			merged_at: item.mergedAt ?? '',
			...retrigger,
		});
	}
	return createCueEvent('github.issue', triggerName, {
		type: 'issue',
		...common,
		state: item.state?.toLowerCase() ?? 'open',
		labels: item.labels.join(','),
		assignees: (item.assignees ?? []).join(','),
		repo,
		created_at: item.createdAt ?? '',
		updated_at: item.updatedAt,
		...retrigger,
	});
}

// ============================================================================
// Label adds
// ============================================================================

/** One label being added to a pull request or issue. */
export interface GitHubLabelEventSnapshot {
	label: string;
	actor: string;
	/** When the label was added. */
	labeledAt: string;
	number: number;
	title: string;
	url: string;
	body: string;
	state: string;
	labels: string[];
	isPr: boolean;
	merged: boolean;
	author: string;
	itemCreatedAt: string;
	itemUpdatedAt: string;
}

/** Which path a label add arrived on. */
export type GitHubLabelSource = 'poll' | 'webhook';

/**
 * How far apart the poller's and a webhook's timestamps for one label add may
 * be and still count as the same add. The issue-events feed stamps the event
 * itself, while a webhook payload only carries the item's `updated_at`, which
 * GitHub sets in the same moment; the window absorbs rounding between the two.
 */
export const LABEL_EVENT_MATCH_WINDOW_MS = 2 * 60 * 1000;

/**
 * The `cue_github_seen` key recording the last add of one label on one item
 * that a source fired. Each source keeps its own key and checks only the
 * other's, so repeats within one source behave as they always have (a label
 * removed and re-added fires twice) and only the same add reported by both a
 * webhook and a poll is collapsed into one fire.
 */
export function labelEventKey(
	source: GitHubLabelSource,
	repo: string,
	number: number,
	label: string
): string {
	return `label-${source}:${repo}:${number}:${label.toLowerCase()}`;
}

/** Whether the other source already fired this label add. */
export function wasLabelEventFiredByOtherSource(
	subscriptionId: string,
	repo: string,
	ev: Pick<GitHubLabelEventSnapshot, 'number' | 'label' | 'labeledAt'>,
	source: GitHubLabelSource
): boolean {
	const other: GitHubLabelSource = source === 'poll' ? 'webhook' : 'poll';
	const state = getGitHubItemState(subscriptionId, labelEventKey(other, repo, ev.number, ev.label));
	if (!state?.lastRevision) return false;
	const previous = Date.parse(state.lastRevision);
	const current = Date.parse(ev.labeledAt);
	if (!Number.isFinite(previous) || !Number.isFinite(current)) {
		return state.lastRevision === ev.labeledAt;
	}
	return Math.abs(current - previous) <= LABEL_EVENT_MATCH_WINDOW_MS;
}

/** Record that a source fired this label add. */
export function recordLabelEventFired(
	subscriptionId: string,
	repo: string,
	ev: Pick<GitHubLabelEventSnapshot, 'number' | 'label' | 'labeledAt'>,
	source: GitHubLabelSource
): void {
	setGitHubItemRevision(
		subscriptionId,
		labelEventKey(source, repo, ev.number, ev.label),
		ev.labeledAt
	);
}

/** The filters a `github.label` subscription applies to a label add. */
export interface GitHubLabelFilters {
	labelTarget: CueGitHubLabelTarget;
	/** Lowercased label names; empty means any label. */
	watchedLabels: Set<string>;
	/** The raw `gh_state`, which is optional for labels. */
	ghState: string | undefined;
}

/** True when a label add matches the subscription's kind, label and state filters. */
export function labelEventMatchesFilters(
	ev: Pick<GitHubLabelEventSnapshot, 'isPr' | 'label' | 'merged' | 'state'>,
	filters: GitHubLabelFilters
): boolean {
	if (filters.labelTarget === 'pr' && !ev.isPr) return false;
	if (filters.labelTarget === 'issue' && ev.isPr) return false;
	if (
		filters.watchedLabels.size > 0 &&
		!filters.watchedLabels.has((ev.label ?? '').toLowerCase())
	) {
		return false;
	}
	// `gh_state` is optional here (unlike the PR/issue pollers, which default
	// to "open"): a label subscription with no explicit state fires wherever
	// the label lands.
	const stateFilter = filters.ghState ?? 'open';
	if (!filters.ghState || stateFilter === 'all') return true;
	if (stateFilter === 'merged') return ev.isPr && ev.merged;
	return (ev.state ?? '').toLowerCase() === stateFilter;
}

/** Build the event a label add fires. */
export function buildGitHubLabelEvent(
	triggerName: string,
	repo: string,
	ev: GitHubLabelEventSnapshot
): CueEvent {
	return createCueEvent('github.label', triggerName, {
		type: ev.isPr ? 'pull_request' : 'issue',
		label: ev.label,
		label_actor: ev.actor,
		labeled_at: ev.labeledAt,
		number: ev.number,
		title: ev.title,
		author: ev.author,
		url: ev.url,
		body: ev.body ?? '',
		state: ev.isPr && ev.merged ? 'merged' : (ev.state ?? 'open'),
		labels: ev.labels.join(','),
		repo,
		created_at: ev.itemCreatedAt ?? '',
		updated_at: ev.itemUpdatedAt ?? '',
		is_retrigger: false,
		retrigger_count: 0,
		new_comments: [],
	});
}
