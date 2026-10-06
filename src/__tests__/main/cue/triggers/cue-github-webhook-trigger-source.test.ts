/**
 * The GitHub trigger source with a `webhook` block: it registers on the shared
 * webhook listener next to the poller, slows the poller to a reconcile, and
 * sends webhook events down the same filter and SusFactor path as polled ones.
 *
 * What a delivery fires is decided in cue-github-webhook.ts (tested in
 * cue-github-webhook.test.ts); here it is stubbed so the wiring is the subject.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { pollerConfigs, mockPollNow, registrations, mockUnregister, handleMock } = vi.hoisted(
	() => ({
		pollerConfigs: [] as Array<Record<string, unknown>>,
		mockPollNow: vi.fn(),
		registrations: [] as Array<Record<string, unknown>>,
		mockUnregister: vi.fn(),
		handleMock: vi.fn(),
	})
);

vi.mock('../../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: (config: Record<string, unknown>) => {
		pollerConfigs.push(config);
		(config.onReady as (h: unknown) => void)?.({
			pollNow: mockPollNow,
			getRepo: () => 'foo/bar',
		});
		return vi.fn();
	},
}));

vi.mock('../../../../main/cue/cue-webhook-server', () => ({
	registerCueWebhook: (reg: Record<string, unknown>) => {
		registrations.push(reg);
		return mockUnregister;
	},
	buildCueWebhookUrl: (path: string) => `http://127.0.0.1:17997/cue/${path}`,
}));

vi.mock('../../../../main/cue/cue-github-webhook', () => ({
	GITHUB_SIGNATURE_HEADER: 'x-hub-signature-256',
	handleGitHubWebhookDelivery: (...args: unknown[]) => handleMock(...args),
}));

let susFactorAllows = true;
vi.mock('../../../../main/cue/cue-susfactor', () => ({
	guardGitHubEvent: vi.fn(async () => susFactorAllows),
	extractWebhookScorableText: vi.fn(),
	guardWebhookEvent: vi.fn(),
	wouldScoreText: vi.fn(),
}));

import {
	createCueGitHubPollerTriggerSource,
	DEFAULT_GITHUB_RECONCILE_MINUTES,
} from '../../../../main/cue/triggers/cue-github-poller-trigger-source';
import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type { CueEvent, CueEventType, CueSubscription } from '../../../../main/cue/cue-types';
import type { CueWebhookDelivery } from '../../../../main/cue/cue-webhook-server';

function makeSource(event: CueEventType, overrides: Partial<CueSubscription> = {}, enabled = true) {
	const onLog = vi.fn();
	const emit = vi.fn();
	const source = createCueGitHubPollerTriggerSource({
		session: {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
		},
		subscription: {
			name: 'Review PRs',
			event,
			enabled: true,
			prompt: 'review',
			repo: 'foo/bar',
			...overrides,
		},
		registry: createCueSessionRegistry(),
		enabled: () => enabled,
		onLog,
		emit,
	})!;
	return { source, onLog, emit };
}

function delivery(): CueWebhookDelivery {
	return {
		path: 'review-prs',
		event: 'pull_request',
		deliveryId: 'd-1',
		receivedAt: '2026-10-06T12:00:00.000Z',
		headers: {},
		body: {},
		rawBody: '{}',
	};
}

function event(): CueEvent {
	return {
		id: 'evt-1',
		type: 'github.pull_request',
		timestamp: '2026-10-06T12:00:00.000Z',
		triggerName: 'Review PRs',
		payload: { number: 42, state: 'open' },
	};
}

describe('GitHub trigger source with a webhook', () => {
	beforeEach(() => {
		pollerConfigs.length = 0;
		registrations.length = 0;
		vi.clearAllMocks();
		susFactorAllows = true;
		process.env.TEST_GH_SECRET = 'hunter2';
	});

	afterEach(() => {
		delete process.env.TEST_GH_SECRET;
	});

	it("registers on the webhook listener with GitHub's signature header and a path from the name", () => {
		const { source } = makeSource('github.pull_request', {
			webhook: { secret_env: 'TEST_GH_SECRET' },
		});
		source.start();

		expect(registrations).toHaveLength(1);
		expect(registrations[0]).toMatchObject({
			path: 'review-prs',
			secret: 'hunter2',
			signatureHeader: 'x-hub-signature-256',
		});
		source.stop();
		expect(mockUnregister).toHaveBeenCalledOnce();
	});

	it('keeps an explicit signature header and path', () => {
		const { source } = makeSource('github.issue', {
			webhook: {
				secret_env: 'TEST_GH_SECRET',
				path: 'Hooks/Issues',
				signature_header: 'X-Custom-Sig',
			},
		});
		source.start();
		expect(registrations[0]).toMatchObject({
			path: 'hooks-issues',
			signatureHeader: 'X-Custom-Sig',
		});
	});

	it('slows the poller to the reconcile interval only when a webhook is configured', () => {
		makeSource('github.pull_request', { webhook: { secret_env: 'TEST_GH_SECRET' } }).source.start();
		makeSource('github.pull_request').source.start();
		makeSource('github.label', {
			webhook: { secret_env: 'TEST_GH_SECRET' },
			poll_minutes: 12,
		}).source.start();

		expect(pollerConfigs.map((c) => c.pollMinutes)).toEqual([
			DEFAULT_GITHUB_RECONCILE_MINUTES,
			5,
			12,
		]);
		expect(DEFAULT_GITHUB_RECONCILE_MINUTES).toBe(30);
	});

	it('keeps polling and explains why when the secret does not resolve', () => {
		const { source, onLog } = makeSource('github.pull_request', {
			webhook: { secret_env: 'MISSING_SECRET_VAR' },
		});
		source.start();

		expect(registrations).toHaveLength(0);
		expect(pollerConfigs).toHaveLength(1);
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('MISSING_SECRET_VAR'));
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('polling continues'));
	});

	it('hands the subscription settings to the delivery handler and emits what it returns', async () => {
		handleMock.mockReturnValue({ events: [event()] });
		const { source, emit } = makeSource('github.pull_request', {
			webhook: { secret_env: 'TEST_GH_SECRET' },
			gh_state: 'all',
			retrigger_on_comments: true,
			max_notifications: 0,
		});
		source.start();

		(registrations[0].onDelivery as (d: CueWebhookDelivery) => void)(delivery());
		await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());

		expect(handleMock.mock.calls[0][0]).toMatchObject({
			eventType: 'github.pull_request',
			subscriptionId: 'session-1:Review PRs',
			repo: 'foo/bar',
			ghState: 'all',
			retriggerOnComments: true,
			cap: Infinity,
		});
	});

	it('sends webhook events through the SusFactor guard', async () => {
		susFactorAllows = false;
		handleMock.mockReturnValue({ events: [event()] });
		const { source, emit } = makeSource('github.pull_request', {
			webhook: { secret_env: 'TEST_GH_SECRET' },
		});
		source.start();

		(registrations[0].onDelivery as (d: CueWebhookDelivery) => void)(delivery());
		await new Promise((r) => setTimeout(r, 0));
		expect(emit).not.toHaveBeenCalled();
	});

	it('asks the poller to seed when the subscription has never been polled', () => {
		handleMock.mockReturnValue({ events: [], needsSeed: true });
		const { source } = makeSource('github.pull_request', {
			webhook: { secret_env: 'TEST_GH_SECRET' },
		});
		source.start();

		(registrations[0].onDelivery as (d: CueWebhookDelivery) => void)(delivery());
		expect(mockPollNow).toHaveBeenCalledOnce();
	});

	it('logs why a delivery fired nothing', () => {
		handleMock.mockReturnValue({ events: [], note: '#42 already fired' });
		const { source, onLog } = makeSource('github.pull_request', {
			webhook: { secret_env: 'TEST_GH_SECRET' },
		});
		source.start();

		(registrations[0].onDelivery as (d: CueWebhookDelivery) => void)(delivery());
		expect(onLog).toHaveBeenCalledWith('info', expect.stringContaining('#42 already fired'));
	});

	it('ignores deliveries while Cue is disabled', () => {
		const { source } = makeSource(
			'github.pull_request',
			{ webhook: { secret_env: 'TEST_GH_SECRET' } },
			false
		);
		source.start();

		(registrations[0].onDelivery as (d: CueWebhookDelivery) => void)(delivery());
		expect(handleMock).not.toHaveBeenCalled();
	});
});
