/**
 * The standalone runner forwards notify actions and expired agent logins to
 * `--notify-webhook`, through the real router (`executeCueRunAction`) with the
 * executors mocked. A hung endpoint does not delay the run, and no prompt
 * text, event payload, run output or env value reaches the posted body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueEvent, CueRunResult } from '../../../shared/cue/contracts';

const SENTINEL = 'sentinel-webhook-do-not-leak';

const executeCuePrompt = vi.fn();
const executeCueNotify = vi.fn();
const detectCueAuthFailure = vi.fn<(...args: unknown[]) => string | null>(() => null);

vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers: vi.fn() }));
vi.mock('../../../main/cue/cue-executor', () => ({ executeCuePrompt, stopCueRun: vi.fn() }));
vi.mock('../../../main/cue/cue-shell-executor', () => ({ executeCueShell: vi.fn() }));
vi.mock('../../../main/cue/cue-cli-executor', () => ({ executeCueCli: vi.fn() }));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify }));
vi.mock('../../../main/cue/cue-auth-detector', () => ({ detectCueAuthFailure }));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{ id: 'agent-1', name: 'alpha', toolType: 'claude-code', cwd: '/p', projectRoot: '/p' },
	],
	readSshRemotes: () => [],
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSettings: () => ({}),
}));

import { buildStandaloneCueEngineDeps } from '../../../cli/services/cue-standalone-engine';
import {
	createCueNotifyWebhook,
	parseNotifyWebhookUrl,
	type CueExternalNotification,
} from '../../../main/cue/cue-notify-webhook';

const event: CueEvent = {
	id: 'evt-1',
	type: 'webhook.received',
	timestamp: new Date().toISOString(),
	triggerName: 'hook',
	payload: { body: SENTINEL, token: SENTINEL },
};

function result(overrides: Partial<CueRunResult>): CueRunResult {
	return {
		runId: 'run-1',
		sessionId: 'agent-1',
		sessionName: 'alpha',
		subscriptionName: 'sub',
		event,
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		...overrides,
	};
}

beforeEach(() => {
	process.env.MAESTRO_TEST_WEBHOOK_SECRET = SENTINEL;
	executeCueNotify.mockImplementation(async (params: { runId: string; message: string }) =>
		result({ runId: params.runId, subscriptionName: 'done', stdout: params.message })
	);
	executeCuePrompt.mockResolvedValue(
		result({ status: 'failed', exitCode: 1, stdout: SENTINEL, stderr: `401 ${SENTINEL}` })
	);
	detectCueAuthFailure.mockReturnValue(null);
});
afterEach(() => {
	delete process.env.MAESTRO_TEST_WEBHOOK_SECRET;
	vi.clearAllMocks();
});

describe('standalone runner -> --notify-webhook', () => {
	it('forwards a notify run as the toast the desktop would show', async () => {
		const forwarded: CueExternalNotification[] = [];
		const deps = buildStandaloneCueEngineDeps({
			onLog: vi.fn(),
			onExternalNotification: (n) => forwarded.push(n),
		});
		await deps.onCueRun({
			runId: 'run-n',
			sessionId: 'agent-1',
			prompt: 'Build finished',
			subscriptionName: 'done',
			event,
			timeoutMs: 1000,
			action: 'notify',
			notify: { message: 'Build finished', sticky: true },
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(forwarded).toEqual([
			{
				type: 'cue.notify',
				agent: { id: 'agent-1', name: 'alpha', toolType: 'claude-code' },
				subscription: 'done',
				pipeline: null,
				runId: 'run-n',
				title: 'alpha',
				message: 'Build finished',
				sticky: true,
			},
		]);
	});

	it('forwards an expired login with the classification, not the run output', async () => {
		detectCueAuthFailure.mockReturnValue('Invalid API key. Please re-authenticate.');
		const forwarded: CueExternalNotification[] = [];
		const deps = buildStandaloneCueEngineDeps({
			onLog: vi.fn(),
			onExternalNotification: (n) => forwarded.push(n),
		});
		executeCuePrompt.mockResolvedValue(
			result({
				runId: 'run-p',
				subscriptionName: 'review',
				status: 'failed',
				exitCode: 1,
				stdout: SENTINEL,
				stderr: `401 ${SENTINEL}`,
			})
		);
		await deps.onCueRun({
			runId: 'run-p',
			sessionId: 'agent-1',
			prompt: `Review this ${SENTINEL}`,
			subscriptionName: 'review',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);
		await vi.waitFor(() => expect(forwarded).toHaveLength(1));
		expect(forwarded[0]).toEqual({
			type: 'agent.auth_expired',
			agent: { id: 'agent-1', name: 'alpha', toolType: 'claude-code' },
			subscription: 'review',
			pipeline: null,
			runId: 'run-p',
			title: 'alpha: login expired',
			message: 'Invalid API key. Please re-authenticate.',
			sticky: true,
		});
	});

	it('a hung endpoint does not delay the run, and no sentinel reaches any posted body', async () => {
		detectCueAuthFailure.mockReturnValue('Invalid API key. Please re-authenticate.');
		const bodies: string[] = [];
		const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return new Promise<Response>(() => {}); // never answers
		});
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl('https://hooks.example.com/in'),
			onLog: vi.fn(),
			fetchImpl,
		});
		const deps = buildStandaloneCueEngineDeps({
			onLog: vi.fn(),
			onExternalNotification: (n) => webhook.send(n),
		});

		const notifyRun = deps.onCueRun({
			runId: 'run-n',
			sessionId: 'agent-1',
			prompt: 'Build finished',
			subscriptionName: 'done',
			event,
			timeoutMs: 1000,
			action: 'notify',
			notify: { message: 'Build finished' },
		} as Parameters<typeof deps.onCueRun>[0]);
		const promptRun = deps.onCueRun({
			runId: 'run-p',
			sessionId: 'agent-1',
			prompt: `Review this ${SENTINEL}`,
			subscriptionName: 'review',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);

		// Both settle although every POST hangs.
		await expect(notifyRun).resolves.toMatchObject({ status: 'completed' });
		await expect(promptRun).resolves.toMatchObject({ status: 'failed' });
		await vi.waitFor(() => expect(bodies).toHaveLength(2));
		for (const body of bodies) expect(body).not.toContain(SENTINEL);
	});
});
