/**
 * Tests for the Cue auth-expiry detector.
 *
 * The behavior under test is the one that failed in the field: a pipeline whose
 * provider token expired kept failing silently because Cue spawns its agents
 * outside the ProcessManager, so nothing classified the output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	detectCueAuthFailure,
	reportCueAuthFailure,
	resetReportedAuthFailures,
} from '../../../main/cue/cue-auth-detector';
import type { CueRunResult } from '../../../shared/cue/contracts';

const markAuthRequired = vi.fn();

vi.mock('../../../main/agents/capability-snapshot', () => ({
	capabilitySnapshots: {
		markAuthRequired: (...args: unknown[]) => markAuthRequired(...args),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), cue: vi.fn() },
}));

function makeResult(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'run-1',
		sessionId: 'agent-1',
		sessionName: 'Nightly Triage',
		subscriptionName: 'triage',
		event: {
			id: 'evt-1',
			type: 'time.interval',
			timestamp: 1755000000000,
			triggerName: 'nightly',
			payload: {},
		} as unknown as CueRunResult['event'],
		status: 'failed',
		stdout: '',
		stderr: '',
		exitCode: 1,
		durationMs: 120,
		startedAt: '2026-08-18T00:00:00.000Z',
		endedAt: '2026-08-18T00:00:01.000Z',
		...overrides,
	};
}

describe('detectCueAuthFailure', () => {
	it('detects an expired OAuth token on stderr', () => {
		const message = detectCueAuthFailure(
			makeResult({ stderr: 'OAuth token has expired. Please run /login.' }),
			'claude-code'
		);
		expect(message).toBeTruthy();
		expect(message).toMatch(/re-authenticate|login/i);
	});

	it('detects an auth failure that only appears on stdout', () => {
		const message = detectCueAuthFailure(
			makeResult({ stdout: '{"type":"error","message":"authentication_error"}' }),
			'claude-code'
		);
		expect(message).toBeTruthy();
	});

	it('finds an auth failure at the tail of a long run', () => {
		const message = detectCueAuthFailure(
			makeResult({ stdout: `${'x'.repeat(50000)}\nOAuth token has expired` }),
			'claude-code'
		);
		expect(message).toBeTruthy();
	});

	it('ignores a completed run even when its output mentions authentication', () => {
		expect(
			detectCueAuthFailure(
				makeResult({ status: 'completed', stdout: 'I fixed the authentication_error in auth.ts' }),
				'claude-code'
			)
		).toBeNull();
	});

	it('returns null for an unrelated failure', () => {
		expect(
			detectCueAuthFailure(
				makeResult({ stderr: 'ENOENT: no such file or directory' }),
				'claude-code'
			)
		).toBeNull();
	});
});

describe('reportCueAuthFailure', () => {
	beforeEach(() => {
		markAuthRequired.mockClear();
		resetReportedAuthFailures();
	});

	function makeWindow() {
		return {
			isDestroyed: () => false,
			webContents: { isDestroyed: () => false, send: vi.fn() },
		};
	}

	it('marks the agent as needing auth and notifies the renderer', () => {
		const win = makeWindow();
		const detected = reportCueAuthFailure(
			win as never,
			makeResult({ stderr: 'OAuth token has expired' }),
			'claude-code'
		);

		expect(detected).toBe(true);
		expect(markAuthRequired).toHaveBeenCalledWith('claude-code', expect.any(String), undefined);
		expect(win.webContents.send).toHaveBeenCalledWith(
			'agent:authExpired',
			expect.objectContaining({ sessionId: 'agent-1', agentId: 'claude-code', fromPipeline: true })
		);
	});

	it('attributes the failure to the SSH remote when the run was remote', () => {
		const win = makeWindow();
		reportCueAuthFailure(
			win as never,
			makeResult({ stderr: 'OAuth token has expired' }),
			'claude-code',
			'remote-uuid'
		);
		expect(markAuthRequired).toHaveBeenCalledWith('claude-code', expect.any(String), 'remote-uuid');
	});

	it('does nothing for a run that did not fail on auth', () => {
		const win = makeWindow();
		expect(
			reportCueAuthFailure(win as never, makeResult({ stderr: 'timeout' }), 'claude-code')
		).toBe(false);
		expect(markAuthRequired).not.toHaveBeenCalled();
		expect(win.webContents.send).not.toHaveBeenCalled();
	});

	it('still reports detection when there is no renderer to notify', () => {
		expect(
			reportCueAuthFailure(null, makeResult({ stderr: 'OAuth token has expired' }), 'claude-code')
		).toBe(true);
		expect(markAuthRequired).toHaveBeenCalled();
	});

	it('prompts once per provider until a run succeeds again', () => {
		const win = makeWindow();
		const failure = makeResult({ stderr: 'OAuth token has expired' });

		expect(reportCueAuthFailure(win as never, failure, 'claude-code')).toBe(true);
		// A dismissed prompt must not be thrown back at the user on the next tick.
		expect(reportCueAuthFailure(win as never, failure, 'claude-code')).toBe(false);
		expect(win.webContents.send).toHaveBeenCalledTimes(1);

		// A successful run means the new credentials took, so a later expiry
		// prompts again.
		reportCueAuthFailure(win as never, makeResult({ status: 'completed' }), 'claude-code');
		expect(reportCueAuthFailure(win as never, failure, 'claude-code')).toBe(true);
		expect(win.webContents.send).toHaveBeenCalledTimes(2);
	});

	it('tracks a local and a remote install of the same agent separately', () => {
		const win = makeWindow();
		const failure = makeResult({ stderr: 'OAuth token has expired' });

		expect(reportCueAuthFailure(win as never, failure, 'claude-code')).toBe(true);
		expect(reportCueAuthFailure(win as never, failure, 'claude-code', 'remote-uuid')).toBe(true);
	});
});
