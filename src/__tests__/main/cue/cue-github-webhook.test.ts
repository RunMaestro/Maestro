/**
 * GitHub webhook deliveries for `github.*` subscriptions, and how they agree
 * with the poller.
 *
 * The `cue_github_seen` functions are backed by one in-memory map shared by
 * the webhook handler and a real poller (with `gh` faked), so the tests prove
 * the property the feature exists for: a change seen by both a webhook and a
 * poll fires once, whichever arrives first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { seen, mockExecFile } = vi.hoisted(() => ({
	seen: new Map<string, { lastRevision: string | null; fireCount: number }>(),
	mockExecFile: vi.fn(),
}));

function rowKey(subId: string, itemKey: string): string {
	return `${subId}\u0000${itemKey}`;
}

vi.mock('../../../main/cue/cue-db', () => ({
	isCueDbReady: () => true,
	isGitHubItemSeen: (subId: string, key: string) => seen.has(rowKey(subId, key)),
	markGitHubItemSeen: (subId: string, key: string, lastRevision?: string) => {
		if (!seen.has(rowKey(subId, key))) {
			seen.set(rowKey(subId, key), { lastRevision: lastRevision ?? null, fireCount: 0 });
		}
	},
	hasAnyGitHubSeen: (subId: string) => [...seen.keys()].some((k) => k.startsWith(`${subId}\u0000`)),
	getGitHubItemState: (subId: string, key: string) => seen.get(rowKey(subId, key)) ?? null,
	recordGitHubRetrigger: (subId: string, key: string, revision: string) => {
		const row = seen.get(rowKey(subId, key));
		if (row) seen.set(rowKey(subId, key), { lastRevision: revision, fireCount: row.fireCount + 1 });
	},
	setGitHubItemRevision: (subId: string, key: string, revision: string) => {
		const row = seen.get(rowKey(subId, key));
		seen.set(rowKey(subId, key), { lastRevision: revision, fireCount: row?.fireCount ?? 0 });
	},
	pruneGitHubSeen: () => {},
	pruneSusFactorBlocks: () => {},
}));

vi.mock('child_process', () => ({
	default: { execFile: mockExecFile },
	execFile: mockExecFile,
}));

vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn().mockResolvedValue('gh'),
	getExpandedEnv: vi.fn().mockReturnValue(process.env),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(() => Promise.resolve()),
}));

import { createCueGitHubPoller } from '../../../main/cue/cue-github-poller';
import {
	handleGitHubWebhookDelivery as handleGitHubWebhookDeliveryRaw,
	type GitHubWebhookSubscription,
} from '../../../main/cue/cue-github-webhook';
import {
	labelEventKey,
	resetGitHubChangeReservationsForTests,
} from '../../../main/cue/cue-github-items';
import type { CueWebhookDelivery } from '../../../main/cue/cue-webhook-server';
import type { CueEvent } from '../../../main/cue/cue-types';

const REPO = 'acme/widgets';
const SUB_ID = 'session-1:review-prs';

function delivery(event: string, body: unknown): CueWebhookDelivery {
	return {
		path: 'github',
		event,
		deliveryId: 'd-1',
		receivedAt: '2026-10-06T12:00:00.000Z',
		headers: {},
		body,
		rawBody: JSON.stringify(body),
	};
}

function sub(overrides: Partial<GitHubWebhookSubscription> = {}): GitHubWebhookSubscription {
	return {
		eventType: 'github.pull_request',
		triggerName: 'review-prs',
		subscriptionId: SUB_ID,
		repo: REPO,
		retriggerOnComments: false,
		cap: 10,
		...overrides,
	};
}

/** A pull request as GitHub's webhook payload carries it. */
function webhookPr(overrides: Record<string, unknown> = {}) {
	return {
		number: 42,
		title: 'Add caching',
		user: { login: 'octocat' },
		html_url: `https://github.com/${REPO}/pull/42`,
		body: 'Speeds up reads',
		state: 'open',
		draft: false,
		labels: [{ name: 'perf' }],
		head: { ref: 'feat/cache' },
		base: { ref: 'main' },
		created_at: '2026-10-06T11:00:00Z',
		updated_at: '2026-10-06T11:30:00Z',
		merged_at: null,
		...overrides,
	};
}

/** The same pull request as `gh pr list --json ...` reports it. */
function ghPr(overrides: Record<string, unknown> = {}) {
	return {
		number: 42,
		title: 'Add caching',
		author: { login: 'octocat' },
		url: `https://github.com/${REPO}/pull/42`,
		body: 'Speeds up reads',
		state: 'OPEN',
		isDraft: false,
		labels: [{ name: 'perf' }],
		headRefName: 'feat/cache',
		baseRefName: 'main',
		createdAt: '2026-10-06T11:00:00Z',
		updatedAt: '2026-10-06T11:30:00Z',
		mergedAt: null,
		...overrides,
	};
}

/** Answer `gh` commands by substring. The poller checks `gh --version` first. */
function setupGh(commandResponses: Record<string, string>) {
	const responses: Record<string, string> = {
		'--version': 'gh version 2.0.0',
		...commandResponses,
	};
	mockExecFile.mockImplementation(
		(
			cmd: string,
			args: string[],
			_opts: unknown,
			cb: (err: Error | null, stdout: string, stderr: string) => void
		) => {
			const key = `${cmd} ${args.join(' ')}`;
			for (const [pattern, stdout] of Object.entries(responses)) {
				if (key.includes(pattern)) {
					cb(null, stdout, '');
					return;
				}
			}
			cb(new Error(`unexpected gh call: ${key}`), '', '');
		}
	);
}

/**
 * Handle a delivery whose event is then dispatched at once, as the trigger
 * source does when no SusFactor scoring runs: the reservation is committed.
 */
function handleGitHubWebhookDelivery(
	...args: Parameters<typeof handleGitHubWebhookDeliveryRaw>
): ReturnType<typeof handleGitHubWebhookDeliveryRaw> {
	const result = handleGitHubWebhookDeliveryRaw(...args);
	result.reservation?.commit();
	return result;
}

/** Run one poll of a real poller and collect what it fired. */
async function pollOnce(
	eventType: 'github.pull_request' | 'github.issue' | 'github.label',
	extra: { retriggerOnComments?: boolean; triggerName?: string; subscriptionId?: string } = {}
): Promise<CueEvent[]> {
	const events: CueEvent[] = [];
	const stop = createCueGitHubPoller({
		eventType,
		repo: REPO,
		pollMinutes: 60,
		projectRoot: '/tmp/project',
		triggerName: extra.triggerName ?? 'review-prs',
		subscriptionId: extra.subscriptionId ?? SUB_ID,
		retriggerOnComments: extra.retriggerOnComments,
		onLog: () => {},
		onEvent: (e, onOutcome) => {
			events.push(e);
			onOutcome('emitted');
		},
	});
	await vi.advanceTimersByTimeAsync(2100);
	stop();
	return events;
}

/** Mark the subscription as seeded, as a previous poll would have. */
function seed(subId = SUB_ID): void {
	seen.set(rowKey(subId, `pr:${REPO}:1`), { lastRevision: '2026-01-01T00:00:00Z', fireCount: 0 });
}

describe('handleGitHubWebhookDelivery', () => {
	beforeEach(() => {
		seen.clear();
		resetGitHubChangeReservationsForTests();
		vi.useFakeTimers();
		mockExecFile.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('answers a ping without firing', () => {
		const result = handleGitHubWebhookDelivery(sub(), delivery('ping', { zen: 'hi' }));
		expect(result.events).toEqual([]);
		expect(result.note).toMatch(/ping/);
	});

	it('builds the same event the poller builds for the same pull request', async () => {
		seed();
		const fromWebhook = handleGitHubWebhookDelivery(
			sub(),
			delivery('pull_request', {
				action: 'opened',
				repository: { full_name: REPO },
				pull_request: webhookPr(),
			})
		).events;

		seen.clear();
		seed();
		setupGh({ 'pr list': JSON.stringify([ghPr()]) });
		const fromPoll = await pollOnce('github.pull_request');

		expect(fromWebhook).toHaveLength(1);
		expect(fromPoll).toHaveLength(1);
		expect(fromWebhook[0].payload).toEqual(fromPoll[0].payload);
		expect(fromWebhook[0].type).toBe(fromPoll[0].type);
	});

	it('fires once when the webhook arrives before the poll', async () => {
		seed();
		const first = handleGitHubWebhookDelivery(
			sub(),
			delivery('pull_request', {
				action: 'opened',
				repository: { full_name: REPO },
				pull_request: webhookPr(),
			})
		);
		expect(first.events).toHaveLength(1);

		setupGh({ 'pr list': JSON.stringify([ghPr()]) });
		expect(await pollOnce('github.pull_request')).toEqual([]);
	});

	it('fires once when the poll arrives before the webhook', async () => {
		seed();
		setupGh({ 'pr list': JSON.stringify([ghPr()]) });
		expect(await pollOnce('github.pull_request')).toHaveLength(1);

		const late = handleGitHubWebhookDelivery(
			sub(),
			delivery('pull_request', {
				action: 'opened',
				repository: { full_name: REPO },
				pull_request: webhookPr(),
			})
		);
		expect(late.events).toEqual([]);
		expect(late.note).toMatch(/already fired/);
	});

	it('fires but records nothing before the first poll, which then seeds without firing again', async () => {
		const result = handleGitHubWebhookDelivery(
			sub(),
			delivery('pull_request', {
				action: 'opened',
				repository: { full_name: REPO },
				pull_request: webhookPr(),
			})
		);
		expect(result.events).toHaveLength(1);
		expect(result.needsSeed).toBe(true);
		expect(seen.size).toBe(0);

		// The first poll treats everything it finds, this pull request included,
		// as already existing.
		setupGh({ 'pr list': JSON.stringify([ghPr(), ghPr({ number: 7, url: 'u7' })]) });
		expect(await pollOnce('github.pull_request')).toEqual([]);
		expect(seen.has(rowKey(SUB_ID, `pr:${REPO}:42`))).toBe(true);
	});

	it('leaves a comment on a known pull request to an immediate poll, which fires it with the whole pull request', async () => {
		seen.set(rowKey(SUB_ID, `pr:${REPO}:42`), {
			lastRevision: '2026-10-06T11:30:00Z',
			fireCount: 0,
		});
		const result = handleGitHubWebhookDelivery(
			sub({ retriggerOnComments: true }),
			delivery('issue_comment', {
				action: 'created',
				repository: { full_name: REPO },
				issue: {
					number: 42,
					title: 'Add caching',
					user: { login: 'octocat' },
					html_url: `https://github.com/${REPO}/pull/42`,
					body: 'Speeds up reads',
					state: 'open',
					labels: [],
					created_at: '2026-10-06T11:00:00Z',
					updated_at: '2026-10-06T12:05:00Z',
					pull_request: { merged_at: null },
				},
				comment: {
					user: { login: 'reviewer' },
					body: 'Please add a test',
					created_at: '2026-10-06T12:05:00Z',
					html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
				},
			})
		);

		// No branch or draft data in a comment payload: nothing fires or is recorded.
		expect(result).toMatchObject({ events: [], pollNow: true });
		expect(seen.get(rowKey(SUB_ID, `pr:${REPO}:42`))).toEqual({
			lastRevision: '2026-10-06T11:30:00Z',
			fireCount: 0,
		});

		setupGh({
			'pr list': JSON.stringify([ghPr({ updatedAt: '2026-10-06T12:05:00Z', baseRefName: 'main' })]),
			'pr view': JSON.stringify({
				comments: [
					{
						author: { login: 'reviewer' },
						body: 'Please add a test',
						createdAt: '2026-10-06T12:05:00Z',
						url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
					},
				],
			}),
		});
		const polled = await pollOnce('github.pull_request', { retriggerOnComments: true });
		expect(polled).toHaveLength(1);
		expect(polled[0].payload).toMatchObject({
			is_retrigger: true,
			base_branch: 'main',
			new_comments: [expect.objectContaining({ body: 'Please add a test' })],
		});
	});

	it('re-fires on a review comment, whose payload carries the pull request, and the poll then stays quiet', async () => {
		seen.set(rowKey(SUB_ID, `pr:${REPO}:42`), {
			lastRevision: '2026-10-06T11:30:00Z',
			fireCount: 0,
		});
		const result = handleGitHubWebhookDelivery(
			sub({ retriggerOnComments: true }),
			delivery('pull_request_review_comment', {
				action: 'created',
				repository: { full_name: REPO },
				pull_request: webhookPr({ updated_at: '2026-10-06T12:05:00Z' }),
				comment: {
					user: { login: 'reviewer' },
					body: 'Please add a test',
					created_at: '2026-10-06T12:05:00Z',
					html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
				},
			})
		);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].payload).toMatchObject({
			is_retrigger: true,
			retrigger_count: 1,
			new_comments: [
				{
					author: 'reviewer',
					body: 'Please add a test',
					createdAt: '2026-10-06T12:05:00Z',
					url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
				},
			],
		});
		expect(seen.get(rowKey(SUB_ID, `pr:${REPO}:42`))).toEqual({
			lastRevision: '2026-10-06T12:05:00Z',
			fireCount: 1,
		});

		setupGh({ 'pr list': JSON.stringify([ghPr({ updatedAt: '2026-10-06T12:05:00Z' })]) });
		expect(await pollOnce('github.pull_request', { retriggerOnComments: true })).toEqual([]);
	});

	it('ignores a delivery older than the change it already fired, and keeps the newer revision', () => {
		seen.set(rowKey(SUB_ID, `pr:${REPO}:42`), {
			lastRevision: '2026-10-06T12:05:00Z',
			fireCount: 1,
		});
		const late = handleGitHubWebhookDelivery(
			sub({ retriggerOnComments: true }),
			delivery('pull_request', {
				action: 'edited',
				repository: { full_name: REPO },
				pull_request: webhookPr({ updated_at: '2026-10-06T12:00:00Z' }),
			})
		);
		expect(late.events).toEqual([]);
		expect(seen.get(rowKey(SUB_ID, `pr:${REPO}:42`))).toEqual({
			lastRevision: '2026-10-06T12:05:00Z',
			fireCount: 1,
		});
	});

	it('leaves a comment on a pull request it never fired for to the next poll', () => {
		seed();
		const result = handleGitHubWebhookDelivery(
			sub({ retriggerOnComments: true }),
			delivery('issue_comment', {
				action: 'created',
				repository: { full_name: REPO },
				issue: { number: 99, state: 'open', updated_at: '2026-10-06T12:00:00Z', pull_request: {} },
				comment: { user: { login: 'x' }, body: 'hi' },
			})
		);
		expect(result.events).toEqual([]);
		expect(seen.has(rowKey(SUB_ID, `pr:${REPO}:99`))).toBe(false);
	});

	it('ignores a delivery for another repository', () => {
		seed();
		const result = handleGitHubWebhookDelivery(
			sub(),
			delivery('pull_request', {
				action: 'opened',
				repository: { full_name: 'someone/else' },
				pull_request: webhookPr(),
			})
		);
		expect(result.events).toEqual([]);
		expect(result.note).toMatch(/someone\/else/);
	});

	it('matches the repository case-insensitively and keys items by the subscription repo', () => {
		seed();
		const result = handleGitHubWebhookDelivery(
			sub(),
			delivery('pull_request', {
				action: 'opened',
				repository: { full_name: 'ACME/Widgets' },
				pull_request: webhookPr(),
			})
		);
		expect(result.events).toHaveLength(1);
		expect(seen.has(rowKey(SUB_ID, `pr:${REPO}:42`))).toBe(true);
	});

	it('applies the state filter: a closed pull request does not fire an open subscription', () => {
		seed();
		const closed = handleGitHubWebhookDelivery(
			sub(),
			delivery('pull_request', {
				action: 'closed',
				repository: { full_name: REPO },
				pull_request: webhookPr({ state: 'closed', merged_at: '2026-10-06T12:00:00Z' }),
			})
		);
		expect(closed.events).toEqual([]);

		const merged = handleGitHubWebhookDelivery(
			sub({ ghState: 'merged' }),
			delivery('pull_request', {
				action: 'closed',
				repository: { full_name: REPO },
				pull_request: webhookPr({ state: 'closed', merged_at: '2026-10-06T12:00:00Z' }),
			})
		);
		expect(merged.events).toHaveLength(1);
		expect(merged.events[0].payload.state).toBe('merged');
	});

	it('leaves pull requests to the pull request subscription when an issue subscription receives one', () => {
		seed();
		const result = handleGitHubWebhookDelivery(
			sub({ eventType: 'github.issue' }),
			delivery('issues', {
				action: 'opened',
				repository: { full_name: REPO },
				issue: { number: 5, state: 'open', pull_request: {} },
			})
		);
		expect(result.events).toEqual([]);
	});

	it('fires an opened issue with the issue event shape', () => {
		seed();
		const result = handleGitHubWebhookDelivery(
			sub({ eventType: 'github.issue' }),
			delivery('issues', {
				action: 'opened',
				repository: { full_name: REPO },
				issue: {
					number: 5,
					title: 'Crash on start',
					user: { login: 'pat' },
					html_url: `https://github.com/${REPO}/issues/5`,
					body: 'Steps...',
					state: 'open',
					labels: [{ name: 'bug' }],
					assignees: [{ login: 'sam' }],
					created_at: '2026-10-06T10:00:00Z',
					updated_at: '2026-10-06T10:00:00Z',
				},
			})
		);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].type).toBe('github.issue');
		expect(result.events[0].payload).toMatchObject({
			type: 'issue',
			number: 5,
			author: 'pat',
			labels: 'bug',
			assignees: 'sam',
			repo: REPO,
			is_retrigger: false,
		});
	});

	describe('label adds', () => {
		const labelSub = () =>
			sub({ eventType: 'github.label', triggerName: 'triage', subscriptionId: 'session-1:triage' });

		function labeledDelivery(label: string, updatedAt = '2026-10-06T12:00:00Z') {
			return delivery('issues', {
				action: 'labeled',
				repository: { full_name: REPO },
				label: { name: label },
				sender: { login: 'maintainer' },
				issue: {
					number: 8,
					title: 'Slow build',
					user: { login: 'pat' },
					html_url: `https://github.com/${REPO}/issues/8`,
					body: 'It is slow',
					state: 'open',
					labels: [{ name: label }],
					created_at: '2026-10-05T00:00:00Z',
					updated_at: updatedAt,
				},
			});
		}

		/** The issue-events feed entry for the same add. */
		function feedEvent(id: number, label: string, createdAt: string) {
			return {
				id,
				created_at: createdAt,
				label,
				actor: 'maintainer',
				number: 8,
				title: 'Slow build',
				url: `https://github.com/${REPO}/issues/8`,
				body: 'It is slow',
				state: 'open',
				labels: [label],
				is_pr: false,
				merged: false,
				author: 'pat',
				item_created_at: '2026-10-05T00:00:00Z',
				item_updated_at: createdAt,
			};
		}

		it('fires once when the webhook arrives before the poll', async () => {
			seen.set(rowKey('session-1:triage', '__label_watermark__'), {
				lastRevision: '100',
				fireCount: 0,
			});
			const result = handleGitHubWebhookDelivery(labelSub(), labeledDelivery('needs-review'));
			expect(result.events).toHaveLength(1);
			expect(result.events[0].payload).toMatchObject({
				label: 'needs-review',
				label_actor: 'maintainer',
				type: 'issue',
			});

			setupGh({
				'issues/events': JSON.stringify([feedEvent(101, 'needs-review', '2026-10-06T12:00:01Z')]),
			});
			expect(
				await pollOnce('github.label', {
					triggerName: 'triage',
					subscriptionId: 'session-1:triage',
				})
			).toEqual([]);
		});

		it('fires once when the poll arrives before the webhook', async () => {
			seen.set(rowKey('session-1:triage', '__label_watermark__'), {
				lastRevision: '100',
				fireCount: 0,
			});
			setupGh({
				'issues/events': JSON.stringify([feedEvent(101, 'needs-review', '2026-10-06T12:00:00Z')]),
			});
			expect(
				await pollOnce('github.label', {
					triggerName: 'triage',
					subscriptionId: 'session-1:triage',
				})
			).toHaveLength(1);
			expect(
				seen.has(
					rowKey(
						'session-1:triage',
						labelEventKey('poll', REPO, 8, 'needs-review', '2026-10-06T12:00:00Z')
					)
				)
			).toBe(true);

			const late = handleGitHubWebhookDelivery(labelSub(), labeledDelivery('needs-review'));
			expect(late.events).toEqual([]);
		});

		it('fires again for the same label added much later', () => {
			seen.set(rowKey('session-1:triage', '__label_watermark__'), {
				lastRevision: '100',
				fireCount: 0,
			});
			expect(
				handleGitHubWebhookDelivery(labelSub(), labeledDelivery('needs-review')).events
			).toHaveLength(1);
			expect(
				handleGitHubWebhookDelivery(
					labelSub(),
					labeledDelivery('needs-review', '2026-10-06T15:00:00Z')
				).events
			).toHaveLength(1);
		});

		it('keeps firing twice for a label removed and re-added, when only polling sees it', async () => {
			seen.set(rowKey('session-1:triage', '__label_watermark__'), {
				lastRevision: '100',
				fireCount: 0,
			});
			setupGh({
				'issues/events': JSON.stringify([
					feedEvent(102, 'needs-review', '2026-10-06T12:00:30Z'),
					feedEvent(101, 'needs-review', '2026-10-06T12:00:00Z'),
				]),
			});
			expect(
				await pollOnce('github.label', {
					triggerName: 'triage',
					subscriptionId: 'session-1:triage',
				})
			).toHaveLength(2);
		});

		it('keeps firing twice for a label removed and re-added, when only webhooks see it', () => {
			seen.set(rowKey('session-1:triage', '__label_watermark__'), {
				lastRevision: '100',
				fireCount: 0,
			});
			expect(
				handleGitHubWebhookDelivery(labelSub(), labeledDelivery('needs-review')).events
			).toHaveLength(1);
			expect(
				handleGitHubWebhookDelivery(
					labelSub(),
					labeledDelivery('needs-review', '2026-10-06T12:00:30Z')
				).events
			).toHaveLength(1);
		});

		it('fires a re-add a minute after the poll fired the first add', async () => {
			seen.set(rowKey('session-1:triage', '__label_watermark__'), {
				lastRevision: '100',
				fireCount: 0,
			});
			setupGh({
				'issues/events': JSON.stringify([feedEvent(101, 'needs-review', '2026-10-06T12:00:00Z')]),
			});
			expect(
				await pollOnce('github.label', {
					triggerName: 'triage',
					subscriptionId: 'session-1:triage',
				})
			).toHaveLength(1);
			// Removed and added again a minute later: a new add, not the same one.
			expect(
				handleGitHubWebhookDelivery(
					labelSub(),
					labeledDelivery('needs-review', '2026-10-06T12:01:00Z')
				).events
			).toHaveLength(1);
		});

		it('matches each webhook add once when the poll catches up on several', async () => {
			seen.set(rowKey('session-1:triage', '__label_watermark__'), {
				lastRevision: '100',
				fireCount: 0,
			});
			expect(
				handleGitHubWebhookDelivery(
					labelSub(),
					labeledDelivery('needs-review', '2026-10-06T12:00:00Z')
				).events
			).toHaveLength(1);
			expect(
				handleGitHubWebhookDelivery(
					labelSub(),
					labeledDelivery('needs-review', '2026-10-06T12:05:00Z')
				).events
			).toHaveLength(1);
			// The feed stamps each add a second off the payload's updated_at.
			setupGh({
				'issues/events': JSON.stringify([
					feedEvent(102, 'needs-review', '2026-10-06T12:05:01Z'),
					feedEvent(101, 'needs-review', '2026-10-06T12:00:01Z'),
				]),
			});
			expect(
				await pollOnce('github.label', {
					triggerName: 'triage',
					subscriptionId: 'session-1:triage',
				})
			).toEqual([]);
		});

		it('respects the watched labels', () => {
			const result = handleGitHubWebhookDelivery(
				{ ...labelSub(), watchLabels: ['ship-it'] },
				labeledDelivery('needs-review')
			);
			expect(result.events).toEqual([]);
		});

		it('ignores actions other than labeled', () => {
			const result = handleGitHubWebhookDelivery(
				labelSub(),
				delivery('issues', {
					action: 'opened',
					repository: { full_name: REPO },
					issue: { number: 1 },
				})
			);
			expect(result.events).toEqual([]);
		});
	});
});
