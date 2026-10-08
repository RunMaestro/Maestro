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
 * A change one source has decided to fire whose "already fired" record is not
 * written yet, because its event is still on the way to the run manager
 * (SusFactor scoring in flight). The record is written only once the event
 * was dispatched or deliberately dropped (`commit`), so a crash in between
 * leaves the change unrecorded and the poller fires it after the restart.
 *
 * While it is in flight, the other source treats the change as handled, so a
 * webhook delivery and a poll of the same change still fire once. The map is
 * process memory on purpose: a crash empties it together with the work it
 * stood for.
 */
export interface GitHubChangeReservation {
	/** Write the record and release the reservation. A no-op once settled. */
	commit(): void;
	/** Release without writing (the event never reached the run manager). */
	release(): void;
	/** Resolves `true` once committed, `false` once released. */
	readonly settled: Promise<boolean>;
}

interface InFlightChange {
	settled: Promise<boolean>;
	/** Label adds only: the other source already paired an add with this one. */
	paired: boolean;
}

const inFlightChanges = new Map<string, InFlightChange>();

function inFlightKey(subscriptionId: string, itemKey: string): string {
	return `${subscriptionId}\u0000${itemKey}`;
}

/** Whether a source is firing this change right now. */
function isGitHubChangeInFlight(subscriptionId: string, itemKey: string): boolean {
	return inFlightChanges.has(inFlightKey(subscriptionId, itemKey));
}

/**
 * Reserve a change before its event leaves for the run manager. `write` is
 * the record `commit` writes. Call it synchronously after the decision that
 * chose to fire, with no await in between.
 */
export function reserveGitHubChange(
	subscriptionId: string,
	itemKey: string,
	write: () => void
): GitHubChangeReservation {
	const key = inFlightKey(subscriptionId, itemKey);
	let resolve!: (committed: boolean) => void;
	const entry: InFlightChange = {
		settled: new Promise<boolean>((r) => {
			resolve = r;
		}),
		paired: false,
	};
	inFlightChanges.set(key, entry);
	let done = false;
	const finish = (committed: boolean) => {
		if (done) return;
		done = true;
		if (inFlightChanges.get(key) === entry) inFlightChanges.delete(key);
		resolve(committed);
	};
	return {
		commit() {
			if (done) return;
			try {
				write();
			} finally {
				finish(true);
			}
		},
		release() {
			finish(false);
		},
		settled: entry.settled,
	};
}

/** Test-only: forget every reservation, as a crash would. */
export function resetGitHubChangeReservationsForTests(): void {
	inFlightChanges.clear();
}

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
/**
 * Whether `updatedAt` is a later revision than `lastRevision`. Webhooks can
 * arrive out of order, and a poll can overlap a delivery, so an older change
 * must neither fire nor move the stored revision back. Revisions that are not
 * timestamps fall back to "different".
 */
export function isNewerRevision(
	updatedAt: string,
	lastRevision: string | null | undefined
): boolean {
	if (!updatedAt) return false;
	if (!lastRevision) return true;
	const next = Date.parse(updatedAt);
	const previous = Date.parse(lastRevision);
	if (Number.isFinite(next) && Number.isFinite(previous)) return next > previous;
	return updatedAt !== lastRevision;
}

export function decideGitHubItem(options: {
	subscriptionId: string;
	itemKey: string;
	updatedAt: string;
	isFirstRun: boolean;
	retrigger: boolean;
	cap: number;
}): GitHubItemDecision {
	if (options.isFirstRun) return { kind: 'seed' };
	// The other source is firing this item right now; its record follows.
	if (isGitHubChangeInFlight(options.subscriptionId, options.itemKey)) return { kind: 'skip' };
	if (!isGitHubItemSeen(options.subscriptionId, options.itemKey)) return { kind: 'new' };
	if (!options.retrigger) return { kind: 'skip' };
	const state = getGitHubItemState(options.subscriptionId, options.itemKey);
	if (!state) return { kind: 'skip' };
	// No activity newer than the last fire (an older delivery arriving late included).
	if (!isNewerRevision(options.updatedAt, state.lastRevision)) return { kind: 'skip' };
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
 * How far apart (in seconds) the poller's and a webhook's timestamps for one
 * label add may be and still count as the same add. The issue-events feed
 * stamps the event itself, while a webhook payload carries the item's
 * `updated_at`, which GitHub sets in the same moment; a few seconds absorbs
 * rounding without merging a real remove-and-re-add.
 */
export const LABEL_EVENT_MATCH_TOLERANCE_S = 5;

/** A label add a source fired, not yet matched by the other source. */
const LABEL_FIRED = 'fired';
/** A label add the other source has since reported too; it matches nothing else. */
const LABEL_MATCHED = 'matched';

function labelSecond(labeledAt: string): number | null {
	const ms = Date.parse(labeledAt);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The `cue_github_seen` key for ONE label add a source fired: one row per add,
 * stamped with its second. Repeats within one source behave as they always
 * have (a label removed and re-added fires twice); only the same add reported
 * by both a webhook and a poll is collapsed into one fire.
 */
export function labelEventKey(
	source: GitHubLabelSource,
	repo: string,
	number: number,
	label: string,
	labeledAt: string
): string {
	const second = labelSecond(labeledAt);
	return `label-${source}:${repo}:${number}:${label.toLowerCase()}:${second ?? labeledAt}`;
}

/**
 * Whether the other source already fired this label add. A match is used up:
 * each add one source fired accounts for exactly one add from the other, so a
 * label removed and re-added still fires again.
 */
export function claimLabelEventFiredByOtherSource(
	subscriptionId: string,
	repo: string,
	ev: Pick<GitHubLabelEventSnapshot, 'number' | 'label' | 'labeledAt'>,
	source: GitHubLabelSource
): boolean {
	for (const key of otherSourceLabelKeys(repo, ev, source)) {
		if (getGitHubItemState(subscriptionId, key)?.lastRevision === LABEL_FIRED) {
			setGitHubItemRevision(subscriptionId, key, LABEL_MATCHED);
			// This source's own row too, so reading the add again (a poll whose
			// watermark did not move past it) finds it handled.
			setGitHubItemRevision(
				subscriptionId,
				labelEventKey(source, repo, ev.number, ev.label, ev.labeledAt),
				LABEL_MATCHED
			);
			return true;
		}
	}
	return false;
}

/** The other source's keys this add may pair with, nearest second first. */
function otherSourceLabelKeys(
	repo: string,
	ev: Pick<GitHubLabelEventSnapshot, 'number' | 'label' | 'labeledAt'>,
	source: GitHubLabelSource
): string[] {
	const other: GitHubLabelSource = source === 'poll' ? 'webhook' : 'poll';
	const second = labelSecond(ev.labeledAt);
	if (second === null) return [labelEventKey(other, repo, ev.number, ev.label, ev.labeledAt)];
	const keys: string[] = [];
	// Nearest second first, so two adds close together pair up in order.
	for (let delta = 0; delta <= LABEL_EVENT_MATCH_TOLERANCE_S; delta++) {
		for (const s of delta === 0 ? [second] : [second - delta, second + delta]) {
			keys.push(`label-${other}:${repo}:${ev.number}:${ev.label.toLowerCase()}:${s}`);
		}
	}
	return keys;
}

/**
 * Whether the other source is firing this label add right now. A match pairs
 * with that add (so a second add close by does not pair with it too) and
 * returns its `settled` promise, so a caller that must know the add really
 * fired (the poller, before it moves its watermark) can wait for it. Its
 * record is written as `fired`, as usual: if the poller has to read the add
 * again after a restart, it pairs with that row then. Null when nothing
 * unpaired is in flight.
 */
export function claimLabelEventInFlightForOtherSource(
	subscriptionId: string,
	repo: string,
	ev: Pick<GitHubLabelEventSnapshot, 'number' | 'label' | 'labeledAt'>,
	source: GitHubLabelSource
): Promise<boolean> | null {
	for (const key of otherSourceLabelKeys(repo, ev, source)) {
		const entry = inFlightChanges.get(inFlightKey(subscriptionId, key));
		if (entry && !entry.paired) {
			entry.paired = true;
			return entry.settled;
		}
	}
	return null;
}

/**
 * Whether this source already fired (or is firing) this label add. The poller
 * asks after a restart re-reads events its watermark had not passed yet.
 */
export function labelEventHandledBySource(
	subscriptionId: string,
	repo: string,
	ev: Pick<GitHubLabelEventSnapshot, 'number' | 'label' | 'labeledAt'>,
	source: GitHubLabelSource
): boolean {
	const key = labelEventKey(source, repo, ev.number, ev.label, ev.labeledAt);
	return (
		isGitHubChangeInFlight(subscriptionId, key) || getGitHubItemState(subscriptionId, key) !== null
	);
}

/** Reserve a label add this source is about to fire; `commit` records it as fired. */
export function reserveLabelEvent(
	subscriptionId: string,
	repo: string,
	ev: Pick<GitHubLabelEventSnapshot, 'number' | 'label' | 'labeledAt'>,
	source: GitHubLabelSource
): GitHubChangeReservation {
	const key = labelEventKey(source, repo, ev.number, ev.label, ev.labeledAt);
	return reserveGitHubChange(subscriptionId, key, () =>
		setGitHubItemRevision(subscriptionId, key, LABEL_FIRED)
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
