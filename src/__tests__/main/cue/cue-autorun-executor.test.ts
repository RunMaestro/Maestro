/**
 * Tests for cue-autorun-executor.
 *
 * The status this executor returns is load-bearing rather than cosmetic: a
 * `time.once` subscription is consumed on any terminal status, so `completed`
 * vs `failed` decides whether a scheduled run that did NOT start survives on
 * disk for the user to find. These tests pin that behavior, plus the fact that
 * the documents launched are the ones captured at schedule time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';

const launchCueAutoRunMock = vi.fn();
vi.mock('../../../main/cue/cue-autorun-bridge', () => ({
	launchCueAutoRun: (...args: unknown[]) => launchCueAutoRunMock(...args),
}));

import { executeCueAutoRun } from '../../../main/cue/cue-autorun-executor';

function createSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Nightly',
		toolType: 'claude-code',
		cwd: '/tmp/project',
		projectRoot: '/tmp/project',
	};
}

function createSubscription(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'run-at-6am',
		event: 'time.once',
		enabled: true,
		prompt: '',
		action: 'autorun',
		agent_id: 'session-1',
		auto_run: { documents: ['/proj/Auto Run Docs/ship.md'] },
		...overrides,
	} as CueSubscription;
}

const event = { type: 'time.once', payload: {} } as unknown as CueEvent;
const mainWindow = {} as BrowserWindow;

describe('executeCueAutoRun', () => {
	beforeEach(() => {
		launchCueAutoRunMock.mockReset();
	});

	it('launches the documents captured on the subscription', async () => {
		launchCueAutoRunMock.mockResolvedValue({ success: true });

		const result = await executeCueAutoRun({
			runId: 'run-1',
			session: createSession(),
			subscription: createSubscription(),
			event,
			autoRun: {
				documents: ['/proj/Auto Run Docs/a.md', '/proj/Auto Run Docs/b.md'],
				reset_on_completion: [false, true],
				prompt: 'Work the tasks',
				loop_enabled: true,
				max_loops: 2,
			},
			mainWindow,
			onLog: vi.fn(),
		});

		expect(launchCueAutoRunMock).toHaveBeenCalledWith(
			mainWindow,
			expect.objectContaining({
				sessionId: 'session-1',
				documents: [
					{ filename: '/proj/Auto Run Docs/a.md', resetOnCompletion: false },
					{ filename: '/proj/Auto Run Docs/b.md', resetOnCompletion: true },
				],
				prompt: 'Work the tasks',
				loopEnabled: true,
				maxLoops: 2,
			})
		);
		expect(result.status).toBe('completed');
		expect(result.exitCode).toBe(0);
	});

	it('defaults resetOnCompletion to false when no flags were captured', async () => {
		launchCueAutoRunMock.mockResolvedValue({ success: true });

		await executeCueAutoRun({
			runId: 'run-1',
			session: createSession(),
			subscription: createSubscription(),
			event,
			autoRun: { documents: ['/proj/a.md'] },
			mainWindow,
			onLog: vi.fn(),
		});

		expect(launchCueAutoRunMock.mock.calls[0][1].documents).toEqual([
			{ filename: '/proj/a.md', resetOnCompletion: false },
		]);
	});

	it('reports `failed` when the renderer does not accept the launch', async () => {
		// This is the case the status semantics exist for: paired with
		// `self_destruct_on_failure: false`, a `failed` status keeps the
		// subscription on disk instead of silently consuming the user's
		// scheduled run.
		launchCueAutoRunMock.mockResolvedValue({
			success: false,
			error: 'renderer webContents not available',
		});

		const result = await executeCueAutoRun({
			runId: 'run-1',
			session: createSession(),
			subscription: createSubscription(),
			event,
			autoRun: { documents: ['/proj/a.md'] },
			mainWindow,
			onLog: vi.fn(),
		});

		expect(result.status).toBe('failed');
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('renderer webContents not available');
	});

	it('logs an explanation when the launch fails so the failure is triageable', async () => {
		launchCueAutoRunMock.mockResolvedValue({ success: false, error: 'boom' });
		const onLog = vi.fn();

		await executeCueAutoRun({
			runId: 'run-1',
			session: createSession(),
			subscription: createSubscription(),
			event,
			autoRun: { documents: ['/proj/a.md'] },
			mainWindow,
			onLog,
		});

		const errorLogs = onLog.mock.calls.filter(([level]) => level === 'error');
		expect(errorLogs).toHaveLength(1);
		expect(errorLogs[0][1]).toContain('boom');
	});
});
