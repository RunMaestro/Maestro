/**
 * GitHub webhook deliveries for `github.pull_request`, `github.issue` and
 * `github.label` subscriptions.
 *
 * A delivery is turned into the same item the poller reads from `gh`, then
 * run through the same decision against the same `cue_github_seen` rows (see
 * `cue-github-items.ts`). That is what lets a subscription take webhooks and
 * keep polling as a reconcile: a change seen both ways fires once.
 *
 * Which deliveries count:
 *  - pull requests: `pull_request`, `pull_request_review`,
 *    `pull_request_review_comment`, and `issue_comment` on a pull request
 *  - issues: `issues` and `issue_comment` on an issue
 *  - labels: `labeled` actions on `pull_request` and `issues`
 *
 * A comment payload (`issue_comment` on a pull request) does not carry the
 * pull request's branches or draft flag, which a subscription filter may test.
 * Such a delivery never fires or records anything: it asks the poller to run
 * now, and the poll fires the change with the whole pull request.
 */

import type { CueGitHubLabelTarget } from '../../shared/cue';
import {
	buildGitHubItemEvent,
	buildGitHubLabelEvent,
	decideGitHubItem,
	githubItemKey,
	GITHUB_ITEM_BODY_LIMIT,
	labelEventMatchesFilters,
	matchesGitHubStateFilter,
	recordLabelEventFired,
	claimLabelEventFiredByOtherSource,
	type GitHubComment,
	type GitHubItemEventType,
	type GitHubItemSnapshot,
	type GitHubLabelEventSnapshot,
} from './cue-github-items';
import { hasAnyGitHubSeen, markGitHubItemSeen, recordGitHubRetrigger } from './cue-db';
import type { CueEvent } from './cue-types';
import type { CueWebhookDelivery } from './cue-webhook-server';

/** Signature header GitHub signs deliveries with when a webhook has a secret. */
export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';

export interface GitHubWebhookSubscription {
	eventType: 'github.pull_request' | 'github.issue' | 'github.label';
	triggerName: string;
	subscriptionId: string;
	/** The repo items are keyed by: the configured one, or what the poller
	 *  auto-detected. Null until known, in which case the delivery's own
	 *  repository is used. */
	repo: string | null;
	/** Raw `gh_state`. */
	ghState?: string;
	labelTarget?: CueGitHubLabelTarget;
	watchLabels?: string[];
	retriggerOnComments: boolean;
	/** Re-fire cap, already resolved (Infinity for unlimited). */
	cap: number;
}

export interface GitHubWebhookResult {
	/** Events to dispatch, in order. */
	events: CueEvent[];
	/** Why the delivery fired nothing, for the log. */
	note?: string;
	/** True when the subscription has never been seeded: the poller should
	 *  run now so the items that already existed are recorded. */
	needsSeed?: boolean;
	/** True when the delivery reported a change it cannot fire itself (a
	 *  comment payload without branch data): the poller should run now. */
	pollNow?: boolean;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function login(user: unknown): string {
	return isRecord(user) ? str(user.login) : '';
}

function labelNames(labels: unknown): string[] {
	if (!Array.isArray(labels)) return [];
	return labels.map((l) => (isRecord(l) ? str(l.name) : '')).filter(Boolean);
}

/** A pull request object from a webhook payload, in the poller's item shape. */
function snapshotFromPullRequest(pr: Json): GitHubItemSnapshot {
	return {
		number: Number(pr.number),
		title: str(pr.title),
		author: login(pr.user) || 'unknown',
		url: str(pr.html_url),
		body: str(pr.body),
		state: str(pr.state).toLowerCase() || 'open',
		labels: labelNames(pr.labels),
		createdAt: str(pr.created_at),
		updatedAt: str(pr.updated_at),
		isDraft: pr.draft === true,
		headRef: isRecord(pr.head) ? str(pr.head.ref) : '',
		baseRef: isRecord(pr.base) ? str(pr.base.ref) : '',
		mergedAt: str(pr.merged_at),
	};
}

/** An issue object from a webhook payload, in the poller's item shape. */
function snapshotFromIssue(issue: Json): GitHubItemSnapshot {
	return {
		number: Number(issue.number),
		title: str(issue.title),
		author: login(issue.user) || 'unknown',
		url: str(issue.html_url),
		body: str(issue.body),
		state: str(issue.state).toLowerCase() || 'open',
		labels: labelNames(issue.labels),
		createdAt: str(issue.created_at),
		updatedAt: str(issue.updated_at),
		assignees: Array.isArray(issue.assignees) ? issue.assignees.map(login).filter(Boolean) : [],
	};
}

/** The comment a delivery adds, for a re-fire's `new_comments`. */
function commentFromDelivery(body: Json): GitHubComment[] {
	const comment = isRecord(body.comment)
		? body.comment
		: isRecord(body.review)
			? body.review
			: null;
	if (!comment || !str(body.action).match(/^(created|submitted)$/)) return [];
	const text = str(comment.body);
	if (!text) return [];
	return [
		{
			author: login(comment.user) || 'unknown',
			body: text.slice(0, GITHUB_ITEM_BODY_LIMIT),
			createdAt: str(comment.created_at) || str(comment.submitted_at),
			url: str(comment.html_url),
		},
	];
}

/**
 * The item a delivery is about, for a pull request or issue subscription.
 * `complete` is false when the payload lacks fields the poller would carry,
 * so the item may only re-fire, never fire for the first time.
 */
function itemFromDelivery(
	eventType: GitHubItemEventType,
	githubEvent: string,
	body: Json
): { item: GitHubItemSnapshot; complete: boolean } | null {
	if (eventType === 'github.pull_request') {
		if (
			(githubEvent === 'pull_request' ||
				githubEvent === 'pull_request_review' ||
				githubEvent === 'pull_request_review_comment') &&
			isRecord(body.pull_request)
		) {
			return { item: snapshotFromPullRequest(body.pull_request), complete: true };
		}
		if (
			githubEvent === 'issue_comment' &&
			isRecord(body.issue) &&
			isRecord(body.issue.pull_request)
		) {
			const item = snapshotFromIssue(body.issue);
			item.mergedAt = str(body.issue.pull_request.merged_at);
			return { item, complete: false };
		}
		return null;
	}
	if ((githubEvent === 'issues' || githubEvent === 'issue_comment') && isRecord(body.issue)) {
		// GitHub models a pull request as an issue too; those belong to the
		// pull request subscription.
		if (isRecord(body.issue.pull_request)) return null;
		return { item: snapshotFromIssue(body.issue), complete: true };
	}
	return null;
}

/** The label add a delivery reports, or null when it is not one. */
function labelEventFromDelivery(githubEvent: string, body: Json): GitHubLabelEventSnapshot | null {
	if (str(body.action) !== 'labeled' || !isRecord(body.label)) return null;
	let item: Json | null = null;
	let isPr = false;
	let merged = false;
	if (githubEvent === 'pull_request' && isRecord(body.pull_request)) {
		item = body.pull_request;
		isPr = true;
		merged = Boolean(str(item.merged_at));
	} else if (githubEvent === 'issues' && isRecord(body.issue)) {
		item = body.issue;
		isPr = isRecord(item.pull_request);
		merged = isPr && isRecord(item.pull_request) && Boolean(str(item.pull_request.merged_at));
	}
	if (!item) return null;
	const updatedAt = str(item.updated_at);
	return {
		label: str(body.label.name),
		actor: login(body.sender) || 'unknown',
		// GitHub stamps the item's updated_at with the moment the label lands.
		labeledAt: updatedAt,
		number: Number(item.number),
		title: str(item.title),
		url: str(item.html_url),
		body: str(item.body).slice(0, GITHUB_ITEM_BODY_LIMIT),
		state: str(item.state) || 'open',
		labels: labelNames(item.labels),
		isPr,
		merged,
		author: login(item.user) || 'unknown',
		itemCreatedAt: str(item.created_at),
		itemUpdatedAt: updatedAt,
	};
}

/**
 * Decide what one authenticated GitHub delivery fires for a subscription, and
 * record it in `cue_github_seen` exactly as the poller would.
 */
export function handleGitHubWebhookDelivery(
	sub: GitHubWebhookSubscription,
	delivery: CueWebhookDelivery
): GitHubWebhookResult {
	const githubEvent = delivery.event;
	if (githubEvent === 'ping') {
		return { events: [], note: 'GitHub webhook connected (ping received)' };
	}
	const body = delivery.body;
	if (!isRecord(body)) return { events: [], note: 'delivery is not a JSON payload' };

	const deliveredRepo = isRecord(body.repository) ? str(body.repository.full_name) : '';
	if (sub.repo && deliveredRepo && sub.repo.toLowerCase() !== deliveredRepo.toLowerCase()) {
		return {
			events: [],
			note: `delivery for ${deliveredRepo} ignored - this subscription watches ${sub.repo}`,
		};
	}
	// Keys must match the poller's, so the poller's repo string wins.
	const repo = sub.repo || deliveredRepo;
	if (!repo) return { events: [], note: 'delivery names no repository' };

	if (sub.eventType === 'github.label') {
		const ev = labelEventFromDelivery(githubEvent, body);
		if (!ev || !Number.isFinite(ev.number))
			return { events: [], note: `"${githubEvent}" is not a label add` };
		const watchedLabels = new Set(
			(sub.watchLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean)
		);
		const matches = labelEventMatchesFilters(ev, {
			labelTarget: sub.labelTarget ?? 'both',
			watchedLabels,
			ghState: sub.ghState,
		});
		if (!matches)
			return { events: [], note: `label "${ev.label}" does not match this subscription` };
		if (claimLabelEventFiredByOtherSource(sub.subscriptionId, repo, ev, 'webhook')) {
			return { events: [], note: `label "${ev.label}" on #${ev.number} already fired from a poll` };
		}
		recordLabelEventFired(sub.subscriptionId, repo, ev, 'webhook');
		return { events: [buildGitHubLabelEvent(sub.triggerName, repo, ev)] };
	}

	const found = itemFromDelivery(sub.eventType, githubEvent, body);
	if (!found || !Number.isFinite(found.item.number)) {
		return { events: [], note: `"${githubEvent}" does not apply to ${sub.eventType}` };
	}
	const { item, complete } = found;
	if (!matchesGitHubStateFilter(sub.eventType, item, sub.ghState ?? 'open')) {
		return {
			events: [],
			note: `#${item.number} is ${item.state}, outside this subscription's state filter`,
		};
	}

	const itemKey = githubItemKey(sub.eventType, repo, item.number);

	// A subscription the poller has not seeded yet: fire this change, but leave
	// it unrecorded. Recording it would make the poller treat its first run as
	// a later run and fire for every item that already existed; its seeding
	// pass records this item without firing it again.
	if (!hasAnyGitHubSeen(sub.subscriptionId)) {
		if (!complete)
			return { events: [], note: `#${item.number} is left to the first poll`, needsSeed: true };
		return {
			events: [buildGitHubItemEvent(sub.eventType, sub.triggerName, repo, item, null)],
			needsSeed: true,
		};
	}

	const decision = decideGitHubItem({
		subscriptionId: sub.subscriptionId,
		itemKey,
		updatedAt: item.updatedAt,
		isFirstRun: false,
		retrigger: sub.retriggerOnComments,
		cap: sub.cap,
	});

	if (!complete && decision.kind !== 'skip') {
		// Firing from this payload would test filters against empty branch and
		// draft fields, and recording it would make the poll skip the change.
		return {
			events: [],
			note: `#${item.number}: a comment payload has no branch data; polling for the full pull request`,
			pollNow: true,
		};
	}
	if (decision.kind === 'new') {
		markGitHubItemSeen(sub.subscriptionId, itemKey, item.updatedAt);
		return { events: [buildGitHubItemEvent(sub.eventType, sub.triggerName, repo, item, null)] };
	}
	if (decision.kind === 'retrigger') {
		recordGitHubRetrigger(sub.subscriptionId, itemKey, item.updatedAt);
		return {
			events: [
				buildGitHubItemEvent(sub.eventType, sub.triggerName, repo, item, {
					retriggerCount: decision.state.fireCount + 1,
					newComments: commentFromDelivery(body),
				}),
			],
		};
	}
	return { events: [], note: `#${item.number} already fired` };
}
